'use strict';
const fs = require('fs');

/**
 * 极简 .env 解析（零依赖）
 *  - # 开头为注释；行内 ` #` 也视为注释（引号内除外）
 *  - KEY=VALUE，值可用单/双引号包裹
 *  - 列表值用逗号分隔（如 EXCLUDE_DIRS=a,b/**,c）
 */
function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if (!/^["']/.test(val)) {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
        (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
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
