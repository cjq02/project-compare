'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 生成 report.json 与自包含 report.html
 * @param {object} data 报告数据（见 compare.js 中组装逻辑）
 * @param {string} outDir 输出目录
 */
function writeReport(data, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

  const templatePath = path.join(__dirname, '..', 'templates', 'report.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  // 转义 < 防止数据中出现 </script> 提前闭合
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // 必须用函数形式替换：字符串形式会把 json 里的 $& $' $` 当特殊模式展开，
  // 而 diff 内容含 ${...} / $' 等代码片段，会把模板 HTML 注入进 <script> 导致语法错误
  const html = template.replace('/*__DATA__*/null', () => json);
  const htmlPath = path.join(outDir, 'report.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  return { jsonPath, htmlPath };
}

module.exports = { writeReport };
