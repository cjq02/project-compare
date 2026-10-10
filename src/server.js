#!/usr/bin/env node
'use strict';
/**
 * 实时对比服务：SSE 提示变更（手动刷新）+ 弹窗内单文件同步。
 *
 *   node src/server.js            # 默认 8899 端口，可用 .env 的 PORT 改
 *
 * 路由:
 *   GET  /              报告页面
 *   GET  /api/state     摘要 + 是否有未刷新的变更
 *   GET  /api/report    完整对比数据（report.json 内容）
 *   GET  /api/events    SSE：项目文件变更提示
 *   POST /api/refresh   重跑对比并生成报告
 *   POST /api/sync      单文件同步 { key, direction: 'A2B' | 'B2A' }
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildOptions } = require('./compare');
const { runCompare } = require('./engine');

const DEFAULT_PORT = 18899;
const IGNORE_DIR_RE = /(^|\/)(node_modules|target|dist|\.git|\.idea|output)(\/|$)/;
/** 只允许这些状态同步：其余状态同步无意义或有风险 */
const SYNCABLE = new Set(['SIMILAR', 'DIVERGED']);

const { opts, envFile } = buildOptions({
  dirs: [], out: null, threshold: null, maxDiffLines: null, include: [], exclude: [], envFile: null,
});
const port = Number(process.env.PORT) || Number(loadPortFromEnv()) || DEFAULT_PORT;
const outDir = path.resolve(opts.out || './output');
const htmlPath = path.join(outDir, 'report.html');
const jsonPath = path.join(outDir, 'report.json');

function loadPortFromEnv() {
  const f = path.join(process.cwd(), '.env');
  if (!fs.existsSync(f)) return null;
  const m = /^PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1] : null;
}

let reportData = null;
let dirty = false;
let comparing = false;
let lastError = null;
const sseClients = new Set();

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify(Object.assign({ type, at: Date.now() }, payload))}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) { sseClients.delete(res); }
  }
}

/** 载入报告：优先读已生成的 json，避免每次启动都跑一遍对比 */
function ensureReport() {
  if (reportData) return reportData;
  if (fs.existsSync(jsonPath)) {
    try {
      reportData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      return reportData;
    } catch (e) {
      log('report.json 解析失败，将重新对比:', e.message);
    }
  }
  return refresh();
}

/** 重跑对比。comparing 为真时跳过，避免并发重复计算 */
function refresh() {
  if (comparing) return reportData;
  comparing = true;
  try {
    const t0 = Date.now();
    const r = runCompare(opts, envFile, null);
    reportData = r.reportData;
    dirty = false;
    lastError = null;
    log(`对比完成，用时 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    broadcast('refreshed', { summary: reportData.summary, generatedAt: reportData.meta.generatedAt });
    return reportData;
  } catch (e) {
    lastError = e.message;
    log('对比失败:', e.message);
    broadcast('error', { message: e.message });
    throw e;
  } finally {
    comparing = false;
  }
}

/* ---------- 文件监听：变更后延迟提示，由用户手动刷新 ---------- */
let dirtyTimer = null;
function markDirty() {
  dirty = true;
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    if (dirty) { log('检测到项目变更，已通知浏览器'); broadcast('changed', {}); }
  }, 1000);
}

function watchProject(dir) {
  let w;
  try {
    w = fs.watch(dir, { recursive: true }, (event, filename) => {
      // 忽略构建产物与依赖目录，避免噪音把提示刷爆
      if (filename && IGNORE_DIR_RE.test('/' + String(filename).replace(/\\/g, '/') + '/')) return;
      markDirty();
    });
    w.on('error', (e) => log('监听异常（实时提示不可用）:', path.basename(dir), e.message));
    log('已监听:', dir);
    return w;
  } catch (e) {
    log('无法监听目录（实时提示不可用）:', dir, e.message);
    return null;
  }
}

/* ---------- HTTP ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/** 同步：把源侧文件复制到目标侧。不做删除。 */
function handleSync(body) {
  const data = ensureReport();
  const { key, direction } = body || {};
  if (direction !== 'A2B' && direction !== 'B2A') return { ok: false, error: 'direction 必须是 A2B 或 B2A' };
  const entry = (data.files || []).find((f) => f.key === key);
  if (!entry) return { ok: false, error: '未找到该文件: ' + key };
  if (!SYNCABLE.has(entry.status)) {
    return { ok: false, error: `该文件状态为「${entry.status}」，不支持同步（仅支持漂移/差异大的公共代码）` };
  }
  // 目标路径必须由服务端从报告数据推导，不接受客户端传路径
  const relSrc = direction === 'A2B' ? entry.relA : entry.relB;
  const relDst = direction === 'A2B' ? entry.relB : entry.relA;
  if (!relSrc || !relDst) return { ok: false, error: '该文件缺少一侧路径，无法确定目标位置' };
  const dirSrc = direction === 'A2B' ? data.meta.dirA : data.meta.dirB;
  const dirDst = direction === 'A2B' ? data.meta.dirB : data.meta.dirA;
  const from = path.join(dirSrc, relSrc);
  const to = path.join(dirDst, relDst);

  // 路径穿越防护：目标必须落在项目目录内
  const base = path.resolve(dirDst) + path.sep;
  if (!path.resolve(to).startsWith(base)) return { ok: false, error: '目标路径越界，已拒绝' };
  if (!fs.existsSync(from)) return { ok: false, error: '源文件不存在: ' + from };

  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const size = fs.statSync(from).size;
    fs.copyFileSync(from, to);
    log(`同步 ${direction}: ${relSrc} -> ${relDst} (${size}B)`);
    // 同步后报告已过期，标记并通知
    dirty = true;
    broadcast('changed', { reason: 'sync' });
    return { ok: true, from, to, size, direction };
  } catch (e) {
    return { ok: false, error: '复制失败: ' + e.message };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!fs.existsSync(htmlPath)) {
        try { ensureReport(); } catch (e) { /* 保持下面的错误提示 */ }
      }
      if (!fs.existsSync(htmlPath)) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('报告尚未生成。请先运行 node src/compare.js，或查看服务端日志。');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(htmlPath).pipe(res);
    }

    if (req.method === 'GET' && p === '/api/state') {
      const d = ensureReport();
      return sendJson(res, 200, {
        ok: true, dirty, comparing, error: lastError,
        summary: d && d.summary, generatedAt: d && d.meta && d.meta.generatedAt,
        projectA: d && d.meta && d.meta.projectA, projectB: d && d.meta && d.meta.projectB,
      });
    }

    if (req.method === 'GET' && p === '/api/report') {
      const d = ensureReport();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(d));
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 25000);
      req.on('close', () => { clearInterval(keep); sseClients.delete(res); });
      return;
    }

    if (req.method === 'POST' && p === '/api/refresh') {
      try {
        const d = refresh();
        return sendJson(res, 200, { ok: true, summary: d.summary, generatedAt: d.meta.generatedAt });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (req.method === 'POST' && p === '/api/sync') {
      const body = await readBody(req);
      return sendJson(res, 200, handleSync(body));
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

/* ---------- 启动 ---------- */
try {
  ensureReport();
} catch (e) {
  log('初始对比失败（服务仍会启动，可在页面上手动刷新）:', e.message);
}

watchProject(opts.dirA);
watchProject(opts.dirB);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${port} 已被占用。可换端口启动：PORT=8900 node src/server.js`);
  } else {
    log('服务启动失败:', e.message);
  }
  process.exit(1);
});

server.listen(port, () => {
  log('='.repeat(50));
  log(`对比服务已启动: http://localhost:${port}`);
  log(`  项目A: ${opts.dirA}`);
  log(`  项目B: ${opts.dirB}`);
  log('  实时提示: 监听到变更后通知，需手动刷新报告');
  log('='.repeat(50));
});
