#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { scan } = require('./scanner');
const { createNameForms, normalizePathKey } = require('./normalizer');
const { comparePair } = require('./comparator');
const { compileFilter } = require('./exclude');
const { loadEnvFile, resolveOptions } = require('./config');
const { writeReport } = require('./reporter');

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

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const envFile = cli.envFile || (fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : null);
  const env = loadEnvFile(envFile);
  const opts = resolveOptions(env, cli);

  const dirA = opts.dirA && path.resolve(opts.dirA);
  const dirB = opts.dirB && path.resolve(opts.dirB);
  if (!dirA || !dirB) {
    console.error('未指定项目目录：请在 .env 中设置 PROJECT_A / PROJECT_B，或用命令行传入两个目录\n');
    console.error(HELP);
    process.exit(1);
  }
  for (const d of [dirA, dirB]) {
    if (!fs.existsSync(d)) { console.error(`目录不存在: ${d}`); process.exit(1); }
  }

  const nameA = path.basename(dirA);
  const nameB = path.basename(dirB);
  const formsA = createNameForms(nameA);
  const formsB = createNameForms(nameB);
  const filter = compileFilter(opts.include, opts.exclude);
  const outDir = path.resolve(opts.out);

  console.log(`项目A: ${nameA}  (${dirA})`);
  console.log(`项目B: ${nameB}  (${dirB})`);
  console.log(`配置文件: ${envFile || '（无，使用默认值）'}`);
  if (filter.includePatterns.length) {
    console.log(`白名单 ${filter.includePatterns.length} 条（只对比命中范围）:`);
    filter.includePatterns.forEach((p) => console.log(`  + ${p}`));
  } else {
    console.log(`白名单: 未设置（全量对比）`);
  }
  if (filter.excludePatterns.length) {
    console.log(`黑名单 ${filter.excludePatterns.length} 条:`);
    filter.excludePatterns.forEach((p) => console.log(`  - ${p}`));
  }
  console.log('');

  console.log('[1/3] 扫描文件...');
  const relsA0 = scan(dirA);
  const relsB0 = scan(dirB);
  console.log(`  A: ${relsA0.length} 个文件, B: ${relsB0.length} 个文件（过滤前）`);

  console.log('[2/3] 路径归一化并比较...');
  let excludedCount = 0;
  const keep = (rels, name) => rels.filter((rel) => {
    const drop = !filter.keep(rel, normalizePathKey(rel, name));
    if (drop) excludedCount++;
    return !drop;
  });
  const relsA = keep(relsA0, nameA);
  const relsB = keep(relsB0, nameB);
  console.log(`  排除 ${excludedCount} 个文件 -> A: ${relsA.length}, B: ${relsB.length}`);

  const mapA = new Map(relsA.map((rel) => [normalizePathKey(rel, nameA), { full: path.join(dirA, rel), rel }]));
  const mapB = new Map(relsB.map((rel) => [normalizePathKey(rel, nameB), { full: path.join(dirB, rel), rel }]));

  const commonKeys = [...mapA.keys()].filter((k) => mapB.has(k));
  const onlyA = [...mapA.keys()].filter((k) => !mapB.has(k)).sort();
  const onlyB = [...mapB.keys()].filter((k) => !mapA.has(k)).sort();

  const files = [];
  const cmpOpts = { similarityThreshold: opts.threshold, maxDiffLines: opts.maxDiffLines };
  let done = 0;
  for (const key of commonKeys) {
    const a = mapA.get(key), b = mapB.get(key);
    const r = comparePair(a.full, b.full, formsA, formsB, cmpOpts);
    files.push({
      key,
      relA: a.rel,
      relB: b.rel,
      status: r.status,
      similarity: r.similarity,
      sizeA: r.sizeA,
      sizeB: r.sizeB,
      linesA: r.linesA,
      linesB: r.linesB,
      diff: r.diff,
    });
    if (++done % 200 === 0) console.log(`  已比较 ${done}/${commonKeys.length}`);
  }
  for (const key of onlyA) {
    const e = mapA.get(key);
    files.push({ key, relA: e.rel, status: 'ONLY_A', sizeA: fs.statSync(e.full).size, sizeB: null, linesA: null, linesB: null, similarity: null, diff: null });
  }
  for (const key of onlyB) {
    const e = mapB.get(key);
    files.push({ key, relB: e.rel, status: 'ONLY_B', sizeA: null, sizeB: fs.statSync(e.full).size, linesA: null, linesB: null, similarity: null, diff: null });
  }
  files.sort((x, y) => x.key.localeCompare(y.key));

  const count = (status) => files.filter((f) => f.status === status).length;
  const reportData = {
    meta: {
      projectA: nameA, projectB: nameB, dirA, dirB,
      generatedAt: new Date().toISOString(),
      threshold: opts.threshold,
      includePatterns: filter.includePatterns,
      excludePatterns: filter.excludePatterns,
      excludedCount,
      envFile,
    },
    summary: {
      common: commonKeys.length,
      identical: count('IDENTICAL'),
      sameByRename: count('SAME_BY_RENAME'),
      similar: count('SIMILAR'),
      diverged: count('DIVERGED'),
      onlyA: onlyA.length,
      onlyB: onlyB.length,
    },
    files,
  };

  console.log('[3/3] 生成报告...');
  const { jsonPath, htmlPath } = writeReport(reportData, outDir);

  const s = reportData.summary;
  console.log('');
  console.log('========== 对比结果 ==========');
  console.log(`归一化后共有文件 : ${s.common}`);
  console.log(`  完全相同       : ${s.identical}`);
  console.log(`  仅项目名不同   : ${s.sameByRename}`);
  console.log(`  相似(有漂移)   : ${s.similar}`);
  console.log(`  差异较大       : ${s.diverged}`);
  console.log(`仅 ${nameA} 独有   : ${s.onlyA}`);
  console.log(`仅 ${nameB} 独有   : ${s.onlyB}`);
  console.log(`（已按白/黑名单过滤掉 : ${excludedCount}）`);
  console.log('');
  console.log(`报告: ${htmlPath}`);
  console.log(`数据: ${jsonPath}`);

  if (s.similar > 0) {
    console.log('');
    console.log('漂移最严重的公共代码 Top 15:');
    files.filter((f) => f.status === 'SIMILAR').sort((x, y) => x.similarity - y.similarity).slice(0, 15)
      .forEach((f) => console.log(`  ${(f.similarity * 100).toFixed(1)}%  ${f.key}`));
  }
}

main();
