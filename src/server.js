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
 *   GET  /api/live-diff?key=  现读磁盘计算对比（弹窗用，非快照）
 *   GET  /api/diff-tools      可用的 IDE 对比工具及默认值
 *   POST /api/refresh   重跑对比并生成报告
 *   POST /api/sync      单文件同步 { key, direction: 'A2B' | 'B2A' }
 *   POST /api/open-diff 拉起 IDE diff 窗口 { key, tool? }
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { buildOptions } = require('./compare');
const { runCompare } = require('./engine');
const { comparePair } = require('./comparator');
const { createNameForms } = require('./normalizer');
const { normalizeDiffTool } = require('./config');

const DEFAULT_PORT = 18899;
const IGNORE_DIR_RE = /(^|\/)(node_modules|target|dist|\.git|\.idea|output)(\/|$)/;
/** 只允许这些状态同步：其余状态同步无意义或有风险 */
const SYNCABLE = new Set(['SIMILAR', 'DIVERGED']);

const { opts, envFile } = buildOptions({
  dirs: [], out: null, threshold: null, maxDiffLines: null, include: [], exclude: [], envFile: null,
  diffTool: null, ideaExe: null, vscodeExe: null,
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

/* ---------- 按需实时对比：现读磁盘，不依赖报告快照 ---------- */
/** 项目名形态由目录名决定，进程内不变，缓存避免重复构造 */
let _formsCache = null;
function getForms(meta) {
  if (_formsCache && _formsCache.dirA === meta.dirA && _formsCache.dirB === meta.dirB) return _formsCache;
  _formsCache = {
    dirA: meta.dirA, dirB: meta.dirB,
    a: createNameForms(path.basename(meta.dirA)),
    b: createNameForms(path.basename(meta.dirB)),
  };
  return _formsCache;
}

/** 拼出绝对路径并校验仍在项目目录内（防路径穿越） */
function safePath(baseDir, rel) {
  const base = path.resolve(baseDir) + path.sep;
  const full = path.resolve(path.join(baseDir, rel));
  return full.startsWith(base) ? full : null;
}

/**
 * 现场读取两侧文件并计算对比，返回最新的 diff / fullDiff。
 * 报告里内嵌的 fullDiff 是上次对比的快照，这里是实时的。
 * @param {string} key 归一化后的文件 key
 */
function liveDiff(key) {
  const d = ensureReport();
  const entry = (d.files || []).find((f) => f.key === key);
  if (!entry) return { ok: false, error: '未找到该文件: ' + key };
  if (!entry.relA || !entry.relB) return { ok: false, error: '该文件缺少一侧，无对比意义' };
  const fA = safePath(d.meta.dirA, entry.relA);
  const fB = safePath(d.meta.dirB, entry.relB);
  if (!fA || !fB) return { ok: false, error: '路径越界，已拒绝' };
  if (!fs.existsSync(fA)) return { ok: false, error: 'A 侧文件不存在: ' + entry.relA };
  if (!fs.existsSync(fB)) return { ok: false, error: 'B 侧文件不存在: ' + entry.relB };
  const forms = getForms(d.meta);
  const r = comparePair(fA, fB, forms.a, forms.b, {
    similarityThreshold: d.meta.threshold != null ? d.meta.threshold : opts.threshold,
    maxDiffLines: opts.maxDiffLines,
  });
  return {
    ok: true, key,
    status: r.status, similarity: r.similarity,
    diff: r.diff, fullDiff: r.fullDiff,
    sizeA: r.sizeA, sizeB: r.sizeB, linesA: r.linesA, linesB: r.linesB,
    at: Date.now(),
  };
}

/* ---------- IDE 对比：调用 IDE 自带的 diff 窗口 ---------- */
const isWin = process.platform === 'win32';
const _exeCache = new Map();

/** 裸命令名是否能在 PATH 中找到（用于把"找不到工具"变成同步可返回的错误） */
function isOnPath(name) {
  const exts = isWin ? String(process.env.PATHEXT || '.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { if (fs.existsSync(path.join(dir, name + ext))) return true; } catch (_) { /* 忽略不可读目录 */ }
    }
    try { if (fs.existsSync(path.join(dir, name))) return true; } catch (_) { /* 同上 */ }
  }
  return false;
}

/**
 * 探测 IDE 可执行文件。优先级：.env 显式配置 > 安装目录扫描 > PATH。
 * 一律取 .exe / .sh —— 绕开 .bat/.cmd，spawn 时无需 shell，参数原样传递不涉及引号。
 * @returns {string|null} 找不到返回 null
 */
function detectExe(tool) {
  const explicit = tool === 'intellij' ? opts.ideaExe : opts.vscodeExe;
  const cands = [];
  if (explicit) cands.push(explicit);

  if (tool === 'intellij') {
    for (const h of [process.env.INTELLIJ_HOME, process.env.IDEA_HOME].filter(Boolean)) {
      cands.push(path.join(h, 'bin', isWin ? 'idea64.exe' : 'idea.sh'));
    }
    const roots = isWin
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'JetBrains'),
         path.join(process.env.LOCALAPPDATA || '', 'JetBrains')]
      : ['/opt', '/usr/local', '/Applications'];
    for (const r of roots) {
      if (!r || !fs.existsSync(r)) continue;
      let entries = [];
      try { entries = fs.readdirSync(r); } catch (_) { continue; }
      // 同一目录下多版本并存时取字典序最大的（如 2026 > 2024）
      for (const n of entries.filter((x) => /^intellij|^idea/i.test(x)).sort().reverse()) {
        cands.push(path.join(r, n, 'bin', isWin ? 'idea64.exe' : 'idea.sh'));
      }
    }
    cands.push(isWin ? 'idea64.exe' : 'idea.sh');
  } else {
    const roots = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
      path.join(process.env.ProgramFiles || '', 'Microsoft VS Code'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code'),
      '/usr/share/code', '/snap/bin',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin',
    ].filter((r) => r && fs.existsSync(r));
    for (const r of roots) cands.push(isWin ? path.join(r, 'Code.exe') : path.join(r, 'code'));
    cands.push(isWin ? 'Code.exe' : 'code');
  }

  for (const c of cands) {
    if (!c) continue;
    if (path.isAbsolute(c) || /[\\/]/.test(c)) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* 忽略 */ }
    } else if (isOnPath(c)) {
      return c; // 裸命令名，交给 CreateProcess 按 PATH 解析
    }
  }
  return null;
}

function exeFor(tool) {
  if (!_exeCache.has(tool)) _exeCache.set(tool, detectExe(tool));
  return _exeCache.get(tool);
}

const TOOL_LABEL = { intellij: 'IntelliJ IDEA', vscode: 'VSCode' };

/** 可用工具清单，供前端右键菜单展示 */
function listTools() {
  const out = {};
  for (const t of ['intellij', 'vscode']) {
    const exe = exeFor(t);
    out[t] = { available: !!exe, exe: exe || null, label: TOOL_LABEL[t] };
  }
  return { default: opts.diffTool, tools: out };
}

/**
 * 拉起 IDE 自带的 diff 窗口。
 * detached + stdio:ignore + unref：IDEA 冷启动十几秒，不能阻塞 HTTP 响应，
 * 也不能让它退出前一直挂住请求；进程独立于服务存活。
 */
function openDiff(body) {
  const key = String((body && body.key) || '');
  const d = ensureReport();
  const entry = (d.files || []).find((f) => f.key === key);
  if (!entry) return { ok: false, error: '未找到该文件: ' + key };
  if (!entry.relA || !entry.relB) return { ok: false, error: '该文件缺少一侧，无法对比' };

  const tool = normalizeDiffTool(body.tool || opts.diffTool);
  if (tool === 'none') return { ok: false, error: '未配置对比工具（DIFF_TOOL=none）' };

  // 路径只从报告数据推导，客户端传不进任意路径
  const fA = safePath(d.meta.dirA, entry.relA);
  const fB = safePath(d.meta.dirB, entry.relB);
  if (!fA || !fB) return { ok: false, error: '路径越界，已拒绝' };
  if (!fs.existsSync(fA)) return { ok: false, error: 'A 侧文件不存在: ' + entry.relA };
  if (!fs.existsSync(fB)) return { ok: false, error: 'B 侧文件不存在: ' + entry.relB };

  const exe = exeFor(tool);
  if (!exe) {
    return { ok: false, error: '未找到 ' + TOOL_LABEL[tool] + '，请在 .env 配置 '
      + (tool === 'intellij' ? 'IDEA_EXE' : 'VSCODE_EXE') };
  }
  const args = tool === 'intellij' ? ['diff', fA, fB] : ['--diff', fA, fB];
  // IDEA 旧版要求 cwd 为 bin 目录；路径都是绝对的，切过去无副作用
  const cwd = path.dirname(exe);
  try {
    const child = cp.spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => log('拉起失败:', TOOL_LABEL[tool], e.message));
    child.unref();
  } catch (e) {
    return { ok: false, error: '拉起失败: ' + e.message };
  }
  log(`打开 ${TOOL_LABEL[tool]} 对比: ${entry.relA} <-> ${entry.relB}`);
  return { ok: true, tool, label: TOOL_LABEL[tool], exe, args };
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

    if (req.method === 'GET' && p === '/api/live-diff') {
      const key = url.searchParams.get('key') || '';
      return sendJson(res, 200, liveDiff(key));
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

    if (req.method === 'GET' && p === '/api/diff-tools') {
      return sendJson(res, 200, Object.assign({ ok: true }, listTools()));
    }

    if (req.method === 'POST' && p === '/api/open-diff') {
      const body = await readBody(req);
      return sendJson(res, 200, openDiff(body));
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
