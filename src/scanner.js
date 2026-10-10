'use strict';
const fs = require('fs');
const path = require('path');

/** 默认排除的目录（任意层级命中即跳过整个目录） */
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  '.git',
  '.idea',
  '.svn',
  '.qoder',
  'output',
]);

/** 默认排除的文件（精确文件名） */
const DEFAULT_EXCLUDE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
]);

/**
 * 递归扫描目录，返回相对路径列表（统一使用 / 分隔）
 * @param {string} root 扫描根目录
 * @param {object} [opts]
 * @param {Set<string>} [opts.excludeDirs]
 * @param {Set<string>} [opts.excludeFiles]
 * @returns {string[]} 相对路径数组
 */
function scan(root, opts = {}) {
  const excludeDirs = opts.excludeDirs || DEFAULT_EXCLUDE_DIRS;
  const excludeFiles = opts.excludeFiles || DEFAULT_EXCLUDE_FILES;
  const result = [];

  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return; // 无权限等异常直接跳过
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (excludeFiles.has(entry.name)) continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        result.push(rel);
      }
    }
  })(root);

  return result;
}

module.exports = { scan, DEFAULT_EXCLUDE_DIRS, DEFAULT_EXCLUDE_FILES };
