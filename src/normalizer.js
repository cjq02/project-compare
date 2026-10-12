'use strict';

const PLACEHOLDER = '{PROJECT}';

/**
 * 由项目名生成各种命名形态的替换规则
 * 例如 "lottery-fund" -> kebab/camel/pascal/snake/upper/dot/slash
 * dot 形态用于 Java 包名与 import（com.jiujie.lottery.fund.*），
 * slash 形态用于 Java 源文件的相对路径（com/jiujie/lottery/fund/...）
 * @param {string} name
 */
function createNameForms(name) {
  const kebab = name;
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const camel = parts.length
    ? parts[0].toLowerCase() + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('')
    : name;
  const pascal = camel ? camel[0].toUpperCase() + camel.slice(1) : name;
  const snake = parts.map((p) => p.toLowerCase()).join('_');
  const upper = snake.toUpperCase();
  const dot = parts.map((p) => p.toLowerCase()).join('.');
  const slash = parts.map((p) => p.toLowerCase()).join('/');
  // 按长度降序，避免短形态先替换造成截断
  const forms = [...new Set([kebab, camel, pascal, snake, upper, dot, slash].filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return { kebab, camel, pascal, snake, upper, dot, slash, forms };
}

/**
 * 路径归一化：
 *  1. 包路径段（斜杠形态）跨目录，先整体替换：com/jiujie/lottery/fund/x -> com/jiujie/{pkgpath}/x
 *  2. 再做模块前缀（连字符形态）替换：lottery-fund-vue -> {PROJECT}-vue
 * @param {string} relPath 相对路径（/ 分隔）
 * @param {{kebab: string, slash: string}} nameForms createNameForms() 的返回值
 */
function normalizePathKey(relPath, nameForms) {
  let p = relPath;
  if (nameForms.slash) p = p.split(nameForms.slash).join('{pkgpath}');
  const name = nameForms.kebab;
  const lower = name.toLowerCase();
  return p
    .split('/')
    .map((seg) => {
      let s = seg.split(name).join(PLACEHOLDER);
      if (lower !== name) s = s.split(lower).join(PLACEHOLDER);
      return s;
    })
    .join('/');
}

/**
 * 解析 PATH_ALIAS 规则
 * 语法：侧别(A|B)  锚点前缀  旧段 => 新段
 * 例：  A com/jiujie/{pkgpath}/  common => base
 *
 * 为什么必须带侧别和锚点：
 *  - A 项目同时存在 common/ 与 base/ 两个包，做全局段替换必然在 A 内部撞车
 *  - {PROJECT}-vue/src/common/ 也含 common 段，全局替换还会误伤前端目录
 * 故规则须指明作用于哪一侧、以及从哪个锚点之后才生效。
 *
 * @param {string[]} lines splitList() 的返回值
 * @returns {{side:'A'|'B', anchor:string, from:string, to:string}[]}
 */
function parsePathAliases(lines) {
  const out = [];
  for (const raw of lines || []) {
    const s = String(raw).trim();
    if (!s) continue;
    const m = /^([ABab])\s+(.+?)\s*=>\s*(\S+)$/.exec(s);
    if (!m) {
      throw new Error(`PATH_ALIAS 格式错误，应为 "A 锚点前缀 旧段 => 新段"，实际: ${raw}`);
    }
    const left = m[2].trim();
    const sp = left.search(/\s+\S+$/);          // 最后一个空白分隔符之前是锚点
    if (sp === -1) {
      throw new Error(`PATH_ALIAS 缺少锚点前缀，应为 "A 锚点前缀 旧段 => 新段"，实际: ${raw}`);
    }
    out.push({
      side: m[1].toUpperCase(),
      anchor: left.slice(0, sp).trim(),
      from: left.slice(sp).trim(),
      to: m[3].trim(),
    });
  }
  return out;
}

/**
 * 对单个已归一化的路径 key 施加别名
 * 只在 anchor 之后命中 from 这一整段时才替换，避免误伤前缀相同的段
 * @param {string} key 归一化后的 key
 * @param {{side:string, anchor:string, from:string, to:string}[]} aliases
 * @param {'A'|'B'} side 当前文件属于哪一侧
 */
function applyPathAliases(key, aliases, side) {
  if (!aliases || !aliases.length) return key;
  let p = key;
  for (const a of aliases) {
    if (a.side !== side) continue;
    const at = p.indexOf(a.anchor);            // 锚点在路径中段，不能用 startsWith
    if (at === -1) continue;
    const head = p.slice(0, at + a.anchor.length);
    const rest = p.slice(at + a.anchor.length);
    if (rest === a.from || rest.startsWith(a.from + '/')) {
      p = head + a.to + rest.slice(a.from.length);
    }
  }
  return p;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 对已归一化的内容施加路径别名
 *
 * 路径别名原本只改配对键，于是"只有包段叫法不同"的两个文件
 * （A 的 ...common.annotation 与 B 的 ...base.annotation）配上了，
 * 内容归一化后 package / import 行却仍不同，状态停在 SIMILAR。
 * 故内容也要做同样的别名替换。
 *
 * 锚点用占位符形式（内容归一化已把项目名换成 {pkg} / {pkgpath}）：
 *   路径锚点 com/jiujie/{pkgpath}/  ->  包名锚点 com.jiujie.{pkg}
 * 同时覆盖包名与导入（点分）和注释里的路径（斜杠分）两种写法。
 *
 * @param {string} text 已经过 normalizeContent 的文本
 * @param {{side:string, anchor:string, from:string, to:string}[]} aliases
 * @param {'A'|'B'} side
 */
function applyContentAliases(text, aliases, side) {
  if (!aliases || !aliases.length) return text;
  let out = text;
  for (const a of aliases) {
    if (a.side !== side) continue;
    const slashAnchor = a.anchor.replace(/\/+$/, '');
    const dotAnchor = slashAnchor.split('/').join('.').split('{pkgpath}').join('{pkg}');
    // 分隔符本身是段边界，故边界只排除标识符字符，不排 . 与 /
    for (const [anchor, sep] of [[slashAnchor, '/'], [dotAnchor, '.']]) {
      const re = new RegExp(escapeRegExp(anchor + sep + a.from) + '(?![A-Za-z0-9_$])', 'g');
      out = out.replace(re, anchor + sep + a.to);
    }
  }
  return out;
}

/**
 * 内容归一化：把文件内容中的项目名各形态替换为占位符，并统一换行符
 * 例：lotteryFundApi -> {camel}Api
 * @param {string} text
 * @param {{forms: string[]}} nameForms createNameForms() 的返回值
 */
function normalizeContent(text, nameForms) {
  let out = text.replace(/\r\n/g, '\n');
  for (const form of nameForms.forms) {
    out = out.split(form).join(`{${formPlaceholderSuffix(form)}}`);
  }
  return out;
}

/** 根据形态判断占位符名称 */
function formPlaceholderSuffix(form) {
  if (form.includes('.')) return 'pkg';                // lottery.fund（Java 包名/import）
  if (form.includes('/')) return 'pkgpath';            // lottery/fund（源文件相对路径）
  if (/^[A-Z0-9_]+$/.test(form)) return 'UPPER';      // LOTTERY_FUND
  if (/^[a-z0-9_]+$/.test(form) && form.includes('_')) return 'snake'; // lottery_fund
  if (/^[a-z0-9-]+$/.test(form)) return 'kebab';      // lottery-fund
  if (/^[a-z][a-zA-Z0-9]*$/.test(form)) return 'camel'; // lotteryFund
  return 'pascal';                                     // LotteryFund
}

module.exports = { PLACEHOLDER, createNameForms, normalizePathKey, normalizeContent, parsePathAliases, applyPathAliases, applyContentAliases };
