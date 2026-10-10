'use strict';

/**
 * 把简易 glob 转为正则：
 *  - ** 跨目录（** / 表示零个或多个目录）
 *  - *  不跨目录
 *  - ?  单字符（不跨目录）
 *  - 模式命中目录时，其下所有文件一并命中：^(pattern)(/.*)?$
 */
function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^(?:${re})(?:/.*)?$`, 'i');
}

/**
 * 编译 include（白名单）+ exclude（黑名单）过滤器
 *
 * 语义：
 *  1. 若 include 非空 —— 文件必须命中至少一条 include 才保留；include 为空则不限制
 *  2. 命中任意一条 exclude 则剔除
 *
 * 每条规则同时对"原始相对路径"和"归一化路径（含 {PROJECT}）"做匹配，
 * 因此写 `{PROJECT}-vue/src/**` 可一次作用于两个项目；
 * 写具体项目名（如 `sport-asset-vue/...`）则只作用于该项目。
 *
 * @param {string[]} includePatterns
 * @param {string[]} excludePatterns
 */
function compileFilter(includePatterns, excludePatterns) {
  const toList = (arr) => (arr || []).map((p) => String(p).trim().replace(/\\/g, '/')).filter(Boolean);
  const inc = toList(includePatterns);
  const exc = toList(excludePatterns);
  const incRes = inc.map(globToRegex);
  const excRes = exc.map(globToRegex);

  const hitAny = (regexes, relPath, normKey) => {
    if (!regexes.length) return false;
    const rp = String(relPath).replace(/\\/g, '/');
    const nk = String(normKey || '').replace(/\\/g, '/');
    return regexes.some((re) => re.test(rp) || re.test(nk));
  };

  return {
    includePatterns: inc,
    excludePatterns: exc,
    /**
     * @returns {boolean} 是否保留该文件
     */
    keep(relPath, normKey) {
      if (incRes.length && !hitAny(incRes, relPath, normKey)) return false;
      if (hitAny(excRes, relPath, normKey)) return false;
      return true;
    },
  };
}

module.exports = { compileFilter, globToRegex };
