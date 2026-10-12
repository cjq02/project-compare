'use strict';
const crypto = require('crypto');
const { normalizeContent, applyContentAliases } = require('./normalizer');

const DEFAULTS = {
  maxFileSize: 5 * 1024 * 1024, // 超过 5MB 只做哈希比较
  similarityThreshold: 0.8,
  maxDiffLines: 200, // 每个文件内嵌 diff 的最大行数（仅看差异视图）
  maxFullDiffLines: 5000, // 完整对齐 diff 的最大行数（完整内容视图）
  // LCS DP 单元格上限。每格占 4 字节（Int32Array），2500 万格约 100MB 峰值内存。
  // 200 万太保守：1500 行级别的文件（如 1537x1490=229 万格）就会被放弃。
  // 2500 万可覆盖到约 5000x5000 行的文件对，当前对比集内最大仅 967 万格。
  lcsCellLimit: 25_000_000,
  // 路径别名：内容归一化后再做一次，使"只有包段叫法不同"的文件判为相同
  pathAliases: [],
};

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

/** 通过首个 8KB 是否含 \0 判断二进制 */
function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 解码为文本，并消除不承载代码语义的噪音：
 *  - 去掉开头的 UTF-8 BOM
 *  - CRLF -> LF
 * 两侧都经这一关，因此"仅 BOM / 换行风格不同"会被正确判为内容相同。
 * （源码里出现裸 \r 几乎必然是换行；字面量中的回车在源码里写作转义 \r）
 */
function toText(buf) {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s.replace(/\r\n/g, '\n');
}

/**
 * 基于 LCS 的统一 diff。返回 unified diff 文本（含 @@ hunk 头）。
 * 若规模超过 cellLimit，退化为返回近似说明。
 * @param {boolean} [fullContext] 为 true 时保留全部行（不裁剪上下文），
 *                               用于"完整内容"视图 —— 对齐且改动行高亮
 * @param {number} [cellLimit] LCS 单元格上限，超过则放弃（默认 DEFAULTS.lcsCellLimit）
 */
function unifiedDiff(textA, textB, labelA, labelB, maxLines, fullContext, cellLimit) {
  const limit = cellLimit || DEFAULTS.lcsCellLimit;
  const a = textA.split('\n');
  const b = textB.split('\n');

  // 裁掉公共前后缀，大幅缩小 LCS 规模
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const coreA = a.slice(start, endA + 1);
  const coreB = b.slice(start, endB + 1);

  let ops; // [{t:' '|'-'|'+', line}]
  if ((coreA.length + 1) * (coreB.length + 1) > limit) {
    return `@@ 文件过大，未生成逐行 diff（公共前缀 ${start} 行，A 共 ${a.length} 行，B 共 ${b.length} 行）`;
  }

  // LCS DP
  const n = coreA.length, m = coreB.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = coreA[i] === coreB[j]
        ? dp[at(i + 1, j + 1)] + 1
        : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (coreA[i] === coreB[j]) { ops.push({ t: ' ', line: coreA[i] }); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { ops.push({ t: '-', line: coreA[i] }); i++; }
    else { ops.push({ t: '+', line: coreB[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', line: coreA[i++] });
  while (j < m) ops.push({ t: '+', line: coreB[j++] });

  // 把裁掉的公共前后缀补回，使 ops 与原文件行号一一对应。
  // 否则 fullContext 视图会丢掉文件开头/结尾的未变更行，
  // 紧凑视图也会缺掉紧邻变更的上下文
  const prefixOps = a.slice(0, start).map((l) => ({ t: ' ', line: l }));
  const suffixOps = a.slice(endA + 1).map((l) => ({ t: ' ', line: l }));
  const allOps = prefixOps.concat(ops, suffixOps);

  // 组装 hunks（默认前后各 3 行上下文；fullContext 时保留全部行）
  const ctx = 3;
  const keep = new Array(allOps.length).fill(fullContext === true);
  if (!fullContext) {
    for (let k = 0; k < allOps.length; k++) {
      if (allOps[k].t !== ' ') {
        for (let c = Math.max(0, k - ctx); c <= Math.min(allOps.length - 1, k + ctx); c++) keep[c] = true;
      }
    }
  }
  const lines = [`--- ${labelA}`, `+++ ${labelB}`];
  // 逐行走 allOps 维护 A/B 各自行号：前面 hunk 有增删时，两者会错开，
  // 不能像原来那样对两个 hunk 都用同一个起始行
  let aLine = 1, bLine = 1, k = 0;
  while (k < allOps.length) {
    if (!keep[k]) {
      if (allOps[k].t !== '+') aLine++;
      if (allOps[k].t !== '-') bLine++;
      k++;
      continue;
    }
    const hunkStart = k;
    const aStart = aLine, bStart = bLine;
    while (k < allOps.length && keep[k]) {
      if (allOps[k].t !== '+') aLine++;
      if (allOps[k].t !== '-') bLine++;
      k++;
    }
    lines.push(`@@ -${aStart},${aLine - aStart} +${bStart},${bLine - bStart} @@`);
    for (const o of allOps.slice(hunkStart, k)) lines.push(o.t + o.line);
    if (lines.length >= maxLines * 2) {
      lines.push(`... (diff 已截断，共 ${maxLines} 行上限)`);
      break;
    }
  }
  return lines.join('\n');
}

/** 多集合行相似度（近似，用于超大文件） */
function multisetSimilarity(textA, textB) {
  const count = (t) => {
    const m = new Map();
    for (const line of t.split('\n')) m.set(line, (m.get(line) || 0) + 1);
    return m;
  };
  const ma = count(textA), mb = count(textB);
  let same = 0;
  for (const [line, c] of ma) {
    const c2 = mb.get(line);
    if (c2) same += Math.min(c, c2);
  }
  const maxLines = Math.max(textA.split('\n').length, textB.split('\n').length);
  return maxLines ? same / maxLines : 1;
}

/**
 * 比较一对同路径（归一化后）的文件
 * @returns {{status: string, similarity: number|null,
 *            diff: string|null, fullDiff: string|null,
 *            linesA: number, linesB: number, sizeA: number, sizeB: number,
 *            binary: boolean, noiseOnly: boolean}}
 */
function comparePair(fullA, fullB, formsA, formsB, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fs = require('fs');
  const bufA = fs.readFileSync(fullA);
  const bufB = fs.readFileSync(fullB);
  const base = { sizeA: bufA.length, sizeB: bufB.length, binary: false, noiseOnly: false, diff: null, fullDiff: null, similarity: null };

  if (bufA.length > o.maxFileSize || bufB.length > o.maxFileSize) {
    const same = md5(bufA) === md5(bufB);
    return { ...base, status: same ? 'IDENTICAL' : 'DIVERGED', linesA: null, linesB: null };
  }

  if (isBinaryBuffer(bufA) || isBinaryBuffer(bufB)) {
    const same = md5(bufA) === md5(bufB);
    return { ...base, binary: true, status: same ? 'IDENTICAL' : 'DIVERGED', linesA: null, linesB: null };
  }

  const rawA = toText(bufA), rawB = toText(bufB);
  if (md5(rawA) === md5(rawB)) {
    // 规范化后一致、原始字节却不同 —— 差异只在 BOM / 换行，记下来供报告说明
    const noiseOnly = md5(bufA) !== md5(bufB);
    return { ...base, status: 'IDENTICAL', noiseOnly, linesA: rawA.split('\n').length, linesB: rawB.split('\n').length };
  }

  const normA = applyContentAliases(normalizeContent(rawA, formsA), o.pathAliases, 'A');
  const normB = applyContentAliases(normalizeContent(rawB, formsB), o.pathAliases, 'B');
  if (md5(normA) === md5(normB)) {
    return { ...base, status: 'SAME_BY_RENAME', linesA: rawA.split('\n').length, linesB: rawB.split('\n').length };
  }

  const linesA = rawA.split('\n').length, linesB = rawB.split('\n').length;
  const tooLarge = (linesA + 1) * (linesB + 1) > o.lcsCellLimit;
  const similarity = tooLarge
    ? multisetSimilarity(normA, normB)
    : lineSimilarity(normA, normB, o.lcsCellLimit);
  const status = similarity >= o.similarityThreshold ? 'SIMILAR' : 'DIVERGED';
  // 紧凑 diff：只保留变更 hunk + 3 行上下文，用于"仅看差异"视图
  const diff = unifiedDiff(rawA, rawB, 'A', 'B', o.maxDiffLines, false, o.lcsCellLimit);
  // 完整对齐 diff：保留全部行，用于"完整内容"视图 —— 既能通读全文，又能高亮改动行。
  // 它本身已含两侧全部内容，故不再单独嵌 contentA/contentB，避免重复膨胀。
  // 超大文件 LCS 算不动，unifiedDiff 会返回说明文本，此处置 null 走降级展示
  const fullRaw = unifiedDiff(rawA, rawB, 'A', 'B', o.maxFullDiffLines, true, o.lcsCellLimit);
  const fullDiff = fullRaw.startsWith('@@ 文件过大') ? null : fullRaw;
  return { ...base, status, similarity, diff, fullDiff, linesA, linesB };
}

/** 归一化内容上的逐行相似度 = 1 - 变更行数 / 最大行数 */
function lineSimilarity(normA, normB, cellLimit) {
  const limit = cellLimit || DEFAULTS.lcsCellLimit;
  const a = normA.split('\n'), b = normB.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const coreA = a.slice(start, endA + 1), coreB = b.slice(start, endB + 1);
  if ((coreA.length + 1) * (coreB.length + 1) > limit) {
    return multisetSimilarity(normA, normB);
  }
  const n = coreA.length, m = coreB.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = coreA[i] === coreB[j]
        ? dp[at(i + 1, j + 1)] + 1
        : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  // 相同行数 = LCS 长度；变更行 = (n - lcs) + (m - lcs)
  const lcs = dp[at(0, 0)];
  const changed = (n - lcs) + (m - lcs);
  const maxLen = Math.max(a.length, b.length);
  return maxLen ? 1 - changed / maxLen : 1;
}

module.exports = { comparePair, unifiedDiff, DEFAULTS };
