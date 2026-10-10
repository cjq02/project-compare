'use strict';
const fs = require('fs');
const path = require('path');
const { scan } = require('./scanner');
const { createNameForms, normalizePathKey } = require('./normalizer');
const { comparePair } = require('./comparator');
const { compileFilter } = require('./exclude');
const { writeReport } = require('./reporter');

/**
 * 执行一次完整对比并写出报告。
 * CLI 与 server 共用此入口。
 *
 * @param {object} opts resolveOptions() 的返回值（含 dirA/dirB/out/threshold 等）
 * @param {string|null} [envFile] 仅用于写进报告 meta
 * @param {(msg:string)=>void} [log] 进度输出，传 null 则静默
 * @returns {{reportData: object, jsonPath: string, htmlPath: string}}
 */
function runCompare(opts, envFile, log) {
  const say = typeof log === 'function' ? log : () => {};

  const dirA = opts.dirA && path.resolve(opts.dirA);
  const dirB = opts.dirB && path.resolve(opts.dirB);
  if (!dirA || !dirB) throw new Error('未指定项目目录：请在 .env 中设置 PROJECT_A / PROJECT_B');
  for (const d of [dirA, dirB]) {
    if (!fs.existsSync(d)) throw new Error(`目录不存在: ${d}`);
  }

  const nameA = path.basename(dirA);
  const nameB = path.basename(dirB);
  const formsA = createNameForms(nameA);
  const formsB = createNameForms(nameB);
  const filter = compileFilter(opts.include, opts.exclude);
  const outDir = path.resolve(opts.out || './output');

  say(`项目A: ${nameA}  (${dirA})`);
  say(`项目B: ${nameB}  (${dirB})`);
  if (filter.includePatterns.length) {
    say(`白名单 ${filter.includePatterns.length} 条:`);
    filter.includePatterns.forEach((p) => say(`  + ${p}`));
  } else {
    say('白名单: 未设置（全量对比）');
  }
  if (filter.excludePatterns.length) {
    say(`黑名单 ${filter.excludePatterns.length} 条:`);
    filter.excludePatterns.forEach((p) => say(`  - ${p}`));
  }

  say('[1/3] 扫描文件...');
  const relsA0 = scan(dirA);
  const relsB0 = scan(dirB);
  say(`  A: ${relsA0.length} 个文件, B: ${relsB0.length} 个文件（过滤前）`);

  say('[2/3] 路径归一化并比较...');
  let excludedCount = 0;
  const keep = (rels, nameForms) => rels.filter((rel) => {
    const drop = !filter.keep(rel, normalizePathKey(rel, nameForms));
    if (drop) excludedCount++;
    return !drop;
  });
  const relsA = keep(relsA0, formsA);
  const relsB = keep(relsB0, formsB);
  say(`  排除 ${excludedCount} 个文件 -> A: ${relsA.length}, B: ${relsB.length}`);

  const mapA = new Map(relsA.map((rel) => [normalizePathKey(rel, formsA), { full: path.join(dirA, rel), rel }]));
  const mapB = new Map(relsB.map((rel) => [normalizePathKey(rel, formsB), { full: path.join(dirB, rel), rel }]));

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
      fullDiff: r.fullDiff,
    });
    if (++done % 200 === 0) say(`  已比较 ${done}/${commonKeys.length}`);
  }
  for (const key of onlyA) {
    const e = mapA.get(key);
    files.push({ key, relA: e.rel, status: 'ONLY_A', sizeA: fs.statSync(e.full).size, sizeB: null, linesA: null, linesB: null, similarity: null, diff: null, fullDiff: null });
  }
  for (const key of onlyB) {
    const e = mapB.get(key);
    files.push({ key, relB: e.rel, status: 'ONLY_B', sizeA: null, sizeB: fs.statSync(e.full).size, linesA: null, linesB: null, similarity: null, diff: null, fullDiff: null });
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
      envFile: envFile || null,
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

  say('[3/3] 生成报告...');
  const { jsonPath, htmlPath } = writeReport(reportData, outDir);
  return { reportData, jsonPath, htmlPath };
}

module.exports = { runCompare };
