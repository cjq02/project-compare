'use strict';
const crypto = require('crypto');
const { normalizeContent } = require('./normalizer');

const DEFAULTS = {
  maxFileSize: 5 * 1024 * 1024, // 超过 5MB 只做哈希比较
  similarityThreshold: 0.8,
  maxDiffLines: 200, // 每个文件内嵌 diff 的最大行数
  maxContentBytes: 100 * 1024, // 弹窗"完整内容"视图每侧最多嵌入的字节数
  lcsCellLimit: 2_000_000, // LCS DP 单元格上限，超过则退化为多集合近似
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

function toText(buf) {
  return buf.toString('utf8');
}

/**
 * 基于 LCS 的统一 diff。返回 unified diff 文本（含 @@ hunk 头）。
 * 若规模超过 lcsCellLimit，退化为返回近似说明。
 */
function unifiedDiff(textA, textB, labelA, labelB, maxLines) {
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
  if ((coreA.length + 1) * (coreB.length + 1) > DEFAULTS.lcsCellLimit) {
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

  // 组装 hunks（前后各 3 行上下文）
  const ctx = 3;
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t !== ' ') {
      for (let c = Math.max(0, k - ctx); c <= Math.min(ops.length - 1, k + ctx); c++) keep[c] = true;
    }
  }
  const lines = [`--- ${labelA}`, `+++ ${labelB}`];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) { k++; continue; }
    const hunkStart = k;
    while (k < ops.length && keep[k]) k++;
    const slice = ops.slice(hunkStart, k);
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    lines.push(`@@ -${start + hunkStart + 1},${aCount} +${start + hunkStart + 1},${bCount} @@`);
    for (const o of slice) lines.push(o.t + o.line);
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
 * 按字节截断文本（尽量在行边界截断，避免切断多字节字符/半行）
 * @returns {{text: string, truncated: boolean}}
 */
function capText(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let cut = buf.slice(0, maxBytes).toString('utf8');
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  return { text: cut, truncated: true };
}

/**
 * 比较一对同路径（归一化后）的文件
 * @returns {{status: string, similarity: number|null, diff: string|null,
 *            linesA: number, linesB: number, sizeA: number, sizeB: number, binary: boolean,
 *            contentA: string|null, contentB: string|null,
 *            truncatedA: boolean, truncatedB: boolean}}
 */
function comparePair(fullA, fullB, formsA, formsB, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fs = require('fs');
  const bufA = fs.readFileSync(fullA);
  const bufB = fs.readFileSync(fullB);
  const base = { sizeA: bufA.length, sizeB: bufB.length, binary: false, diff: null, similarity: null,
    contentA: null, contentB: null, truncatedA: false, truncatedB: false };

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
    return { ...base, status: 'IDENTICAL', linesA: rawA.split('\n').length, linesB: rawB.split('\n').length };
  }

  const normA = normalizeContent(rawA, formsA);
  const normB = normalizeContent(rawB, formsB);
  if (md5(normA) === md5(normB)) {
    return { ...base, status: 'SAME_BY_RENAME', linesA: rawA.split('\n').length, linesB: rawB.split('\n').length };
  }

  const linesA = rawA.split('\n').length, linesB = rawB.split('\n').length;
  const tooLarge = (linesA + 1) * (linesB + 1) > DEFAULTS.lcsCellLimit;
  const similarity = tooLarge
    ? multisetSimilarity(normA, normB)
    : lineSimilarity(normA, normB);
  const status = similarity >= o.similarityThreshold ? 'SIMILAR' : 'DIVERGED';
  // SIMILAR 与 DIVERGED 都生成 diff（报告弹窗展示用），超大文件由 unifiedDiff 内部退化处理
  const diff = unifiedDiff(rawA, rawB, 'A', 'B', o.maxDiffLines);
  // 弹窗默认展示完整内容，故同时嵌入两侧正文（按 maxContentBytes 截断）
  const capA = capText(rawA, o.maxContentBytes);
  const capB = capText(rawB, o.maxContentBytes);
  return { ...base, status, similarity, diff, linesA, linesB,
    contentA: capA.text, contentB: capB.text,
    truncatedA: capA.truncated, truncatedB: capB.truncated };
}

/** 归一化内容上的逐行相似度 = 1 - 变更行数 / 最大行数 */
function lineSimilarity(normA, normB) {
  const a = normA.split('\n'), b = normB.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const coreA = a.slice(start, endA + 1), coreB = b.slice(start, endB + 1);
  if ((coreA.length + 1) * (coreB.length + 1) > DEFAULTS.lcsCellLimit) {
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
