'use strict';
const fs = require('fs');

/** 行内注释：值里出现 ` #` 即视为注释起点 */
function stripInlineComment(val) {
  const hash = val.indexOf(' #');
  return hash === -1 ? val : val.slice(0, hash).trim();
}

/** 一行是否形如 `KEY=`，且 KEY 是大写风格变量名 —— 用来界定多行块的结束 */
function looksLikeKeyLine(line) {
  const eq = line.indexOf('=');
  if (eq === -1) return false;
  return /^[A-Z_][A-Z0-9_]*$/.test(line.slice(0, eq).trim().replace(/^export\s+/, ''));
}

/** 把一个条目追加到逗号列表尾部 */
function appendItem(acc, item) {
  const base = String(acc || '').replace(/,\s*$/, '');
  return base ? base + ',' + item : item;
}

/**
 * 极简 .env 解析（零依赖）
 *  - # 开头为注释；行内 ` #` 也视为注释（引号内除外）
 *  - KEY=VALUE，值可用单/双引号包裹
 *  - 列表值用逗号分隔（如 EXCLUDE_DIRS=a,b/**,c）
 *
 * 多行续行（列表项一条一行，便于逐条配注释）：
 *      EXCLUDE_FILES=
 *        {PROJECT}-vue/src/common/*    # 码表、枚举等按业务生成
 *        .env*                         # 各环境地址配置
 *        *.png                         # 二进制资源
 *  - `KEY=` 值为空即进入多行模式，后续每行都是该键的一个条目，自动以逗号拼接
 *  - 块内空行与整行注释被忽略，不影响块
 *  - 遇到形如 `KEY=` 的行（KEY 为大写风格变量名）则结束当前块并按新键处理；
 *    以此界定块的边界，含 `=` 的规则（如 a=b）不会被误当成新键
 *  - 行尾 `\` 表示"这一条还没写完"，下一行接在同一条目上
 */
function parseEnv(text) {
  const env = {};
  let cur = null;                            // 当前处于多行模式的 KEY
  let part = '';                             // 因行尾 \ 而尚未写完的那一条目
  const flush = () => { if (cur && part) env[cur] = appendItem(env[cur], part); part = ''; };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (cur !== null && !looksLikeKeyLine(raw)) {
      const more = /\\\s*$/.test(line);      // 行尾 \ → 这一条目还没写完
      const chunk = stripInlineComment(more ? line.slice(0, line.lastIndexOf('\\')) : line).trim();
      if (chunk) part = part ? part + chunk : chunk;   // 拼接时不加空格，便于把一条长规则折行
      if (!more) flush();
      continue;
    }
    flush();                                 // 遇到新键：先结算挂着的那一条
    cur = null;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if (!/^["']/.test(val)) val = stripInlineComment(val);
    if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
        (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      val = val.slice(1, -1);
    }
    if (val === '' || /\\\s*$/.test(val)) {  // 空值或行尾 \ → 转入多行模式
      env[key] = val.replace(/\\\s*$/, '').replace(/,\s*$/, '').trim();
      cur = key;
    } else {
      env[key] = val;
    }
  }
  flush();                                   // 文件以 \ 结尾时收尾
  return env;
}

/** 逗号分隔列表 -> 数组 */
function splitList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

/** 读取 .env 文件，不存在返回空对象 */
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

/**
 * 汇总最终配置：默认值 < .env < CLI 参数
 * include 为空表示不限制（全量），非空则先按白名单圈定范围
 * @param {object} env .env 内容
 * @param {object} cli CLI 解析结果
 */
function resolveOptions(env, cli) {
  const dirs = cli.dirs.slice();
  const dirA = dirs[0] || env.PROJECT_A || '';
  const dirB = dirs[1] || env.PROJECT_B || '';
  const num = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));
  return {
    dirA: dirA.replace(/\\/g, '/'),
    dirB: dirB.replace(/\\/g, '/'),
    out: cli.out || env.OUT_DIR || './output',
    threshold: cli.threshold != null ? cli.threshold : num(env.THRESHOLD, 0.8),
    maxDiffLines: cli.maxDiffLines != null ? cli.maxDiffLines : num(env.MAX_DIFF_LINES, 300),
    include: [
      ...splitList(env.INCLUDE),
      ...splitList(env.INCLUDE_DIRS),
      ...splitList(env.INCLUDE_FILES),
      ...cli.include.flatMap(splitList),
    ],
    exclude: [
      ...splitList(env.EXCLUDE),
      ...splitList(env.EXCLUDE_DIRS),
      ...splitList(env.EXCLUDE_FILES),
      ...cli.exclude.flatMap(splitList),
    ],
    // 单击文件行时拉起的 IDE 对比工具：intellij | vscode | none
    diffTool: normalizeDiffTool(cli.diffTool != null ? cli.diffTool : env.DIFF_TOOL),
    // 两个 IDE 的可执行文件覆盖（留空 = 自动探测）
    ideaExe: cli.ideaExe || env.IDEA_EXE || '',
    vscodeExe: cli.vscodeExe || env.VSCODE_EXE || '',
  };
}

/** DIFF_TOOL 归一化：别名并入正式名，未知值回落默认 intellij */
function normalizeDiffTool(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (t === '' || t === 'idea' || t === 'intellij' || t === 'ij' || t === 'idea64') return 'intellij';
  if (t === 'vscode' || t === 'code' || t === 'vs') return 'vscode';
  if (t === 'none' || t === 'off' || t === 'false' || t === 'disabled') return 'none';
  return 'intellij';
}

module.exports = { parseEnv, splitList, loadEnvFile, resolveOptions, normalizeDiffTool };
