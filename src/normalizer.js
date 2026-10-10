'use strict';

const PLACEHOLDER = '{PROJECT}';

/**
 * 由项目名生成各种命名形态的替换规则
 * 例如 "lottery-fund" -> kebab/camel/pascal/snake/upper
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
  // 按长度降序，避免短形态先替换造成截断
  const forms = [...new Set([kebab, camel, pascal, snake, upper].filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return { kebab, camel, pascal, snake, upper, forms };
}

/**
 * 路径归一化：把相对路径中的项目名（模块前缀）替换为 {PROJECT}
 * 例：lottery-fund-vue/src/main.ts -> {PROJECT}-vue/src/main.ts
 * @param {string} relPath 相对路径（/ 分隔）
 * @param {string} name 项目名
 */
function normalizePathKey(relPath, name) {
  const lower = name.toLowerCase();
  return relPath
    .split('/')
    .map((seg) => {
      let s = seg.split(name).join(PLACEHOLDER);
      if (lower !== name) s = s.split(lower).join(PLACEHOLDER);
      return s;
    })
    .join('/');
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
  if (/^[A-Z0-9_]+$/.test(form)) return 'UPPER';      // LOTTERY_FUND
  if (/^[a-z0-9_]+$/.test(form) && form.includes('_')) return 'snake'; // lottery_fund
  if (/^[a-z0-9-]+$/.test(form)) return 'kebab';      // lottery-fund
  if (/^[a-z][a-zA-Z0-9]*$/.test(form)) return 'camel'; // lotteryFund
  return 'pascal';                                     // LotteryFund
}

module.exports = { PLACEHOLDER, createNameForms, normalizePathKey, normalizeContent };
