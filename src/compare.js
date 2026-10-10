#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEnvFile, resolveOptions } = require('./config');
const { runCompare } = require('./engine');

const HELP = `用法: node src/compare.js [项目A目录 项目B目录] [选项]

配置优先级：CLI 参数 > .env > 默认值（默认自动加载 ./​.env）

选项:
  -e, --env <file>           .env 配置文件（默认 ./​.env）
  -o, --out <dir>            输出目录（默认 ./output）
  -t, --threshold <0~1>      SIMILAR 相似度阈值（默认 0.8）
      --include <pattern>    白名单规则（可多次使用，与 .env 合并；非空则只对比命中文件）
      --exclude <pattern>    黑名单规则（可多次使用，与 .env 合并）
      --max-diff-lines <n>   每个文件内嵌 diff 最大行数（默认 300）
  -h, --help                 显示帮助

.env 支持的键:
  PROJECT_A / PROJECT_B   两个项目目录
  OUT_DIR                 输出目录
  PORT                    server.js 监听端口（默认 18899）
  THRESHOLD               相似度阈值
  MAX_DIFF_LINES          diff 最大行数
  INCLUDE_DIRS            白名单，逗号分隔（非空则只对比命中范围，推荐用于只看框架层）
  INCLUDE_FILES           白名单，逗号分隔（与上合并）
  EXCLUDE_DIRS            黑名单，逗号分隔（命中目录则排除其下全部）
  EXCLUDE_FILES           黑名单，逗号分隔（与上合并）

过滤顺序: 先按 INCLUDE 圈定范围（为空 = 不限制），再按 EXCLUDE 剔除

规则语法（简易通配符）:
  *  不跨目录任意字符   ** 跨目录   ? 单字符
  规则同时作用于两个项目 —— {PROJECT} 为项目名占位符
  例: {PROJECT}-vue/src/utils/**              两个项目的前端 utils 目录
      {PROJECT}-vue/src/components/**         两个项目的前端公共组件
      sport-asset-vue/temp                    只排除 sport-asset 的该目录

示例:
  node src/compare.js                              # 全部参数取自 .env
  node src/compare.js A B --include "{PROJECT}-vue/src/utils/**"
  node src/server.js                               # 起服务：实时提示 + 弹窗内同步
`;

function parseArgs(argv) {
  const cli = { dirs: [], out: null, threshold: null, maxDiffLines: null, include: [], exclude: [], envFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-e' || a === '--env') cli.envFile = path.resolve(argv[++i]);
    else if (a === '-o' || a === '--out') cli.out = path.resolve(argv[++i]);
    else if (a === '-t' || a === '--threshold') cli.threshold = parseFloat(argv[++i]);
    else if (a === '--include') cli.include.push(argv[++i]);
    else if (a === '--exclude') cli.exclude.push(argv[++i]);
    else if (a === '--max-diff-lines') cli.maxDiffLines = parseInt(argv[++i], 10);
    else if (a.startsWith('-')) { console.error(`未知参数: ${a}\n${HELP}`); process.exit(1); }
    else cli.dirs.push(path.resolve(a));
  }
  return cli;
}

/** 读取 .env 并合并 CLI 参数；用于 server.js 与本 CLI */
function buildOptions(cli) {
  const envFile = cli.envFile || (fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : null);
  const env = loadEnvFile(envFile);
  return { opts: resolveOptions(env, cli), envFile };
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const { opts, envFile } = buildOptions(cli);

  console.log(`配置文件: ${envFile || '（无，使用默认值）'}`);

  let result;
  try {
    result = runCompare(opts, envFile, console.log);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const { reportData, jsonPath, htmlPath } = result;
  const s = reportData.summary;
  const nameA = reportData.meta.projectA, nameB = reportData.meta.projectB;
  console.log('');
  console.log('========== 对比结果 ==========');
  console.log(`归一化后共有文件 : ${s.common}`);
  console.log(`  完全相同       : ${s.identical}`);
  console.log(`  仅项目名不同   : ${s.sameByRename}`);
  console.log(`  相似(有漂移)   : ${s.similar}`);
  console.log(`  差异较大       : ${s.diverged}`);
  console.log(`仅 ${nameA} 独有   : ${s.onlyA}`);
  console.log(`仅 ${nameB} 独有   : ${s.onlyB}`);
  console.log(`（已按白/黑名单过滤掉 : ${reportData.meta.excludedCount}）`);
  console.log('');
  console.log(`报告: ${htmlPath}`);
  console.log(`数据: ${jsonPath}`);

  if (s.similar > 0) {
    console.log('');
    console.log('漂移最严重的公共代码 Top 15:');
    reportData.files.filter((f) => f.status === 'SIMILAR').sort((x, y) => x.similarity - y.similarity).slice(0, 15)
      .forEach((f) => console.log(`  ${(f.similarity * 100).toFixed(1)}%  ${f.key}`));
  }
}

module.exports = { parseArgs, buildOptions };

if (require.main === module) main();
