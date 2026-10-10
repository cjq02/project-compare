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
 *  2. exclude 按书写顺序逐条求值，命中即剔除，最后由命中的规则决定去留；
 *     以 `!` 开头的规则为例外，命中则撤销先前的排除
 *
 * 每条规则同时对"原始相对路径"和"归一化路径（含 {PROJECT}）"做匹配，
 * 因此写 `{PROJECT}-vue/src/**` 可一次作用于两个项目；
 * 写具体项目名（如 `sport-asset-vue/...`）则只作用于该项目。
 *
 * 注意 include 不能"救回"被 exclude 的文件 —— 要保留被排除目录中的个别文件，
 * 需用 `!` 例外（如 `dir/*` 后跟 `!dir/keep.ts`）。
 *
 * @param {string[]} includePatterns
 * @param {string[]} excludePatterns
 */
function compileFilter(includePatterns, excludePatterns) {
  const toList = (arr) => (arr || []).map((p) => String(p).trim().replace(/\\/g, '/')).filter(Boolean);
  const inc = toList(includePatterns);
  const exc = toList(excludePatterns);
  const incRes = inc.map(globToRegex);
  // `!` 前缀为例外规则，用于撤销先前的排除
  const excRes = exc.map((p) => {
    const neg = p.startsWith('!');
    return { neg, re: globToRegex(neg ? p.slice(1) : p) };
  });

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
      // 黑名单按书写顺序求值，`!` 规则可撤销先前的排除
      // （如先排除整个目录，再单独放行其中某个文件）
      const rp = String(relPath).replace(/\\/g, '/');
      const nk = String(normKey || '').replace(/\\/g, '/');
      let excluded = false;
      for (const r of excRes) {
        if (r.re.test(rp) || r.re.test(nk)) excluded = !r.neg;
      }
      return !excluded;
    },
  };
}

module.exports = { compileFilter, globToRegex };
