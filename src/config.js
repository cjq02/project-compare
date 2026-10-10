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
      ...cli.include,
    ],
    exclude: [
      ...splitList(env.EXCLUDE),
      ...splitList(env.EXCLUDE_DIRS),
      ...splitList(env.EXCLUDE_FILES),
      ...cli.exclude,
    ],
  };
}

module.exports = { parseEnv, splitList, loadEnvFile, resolveOptions };
