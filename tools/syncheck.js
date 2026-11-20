// Checks every inline <script> of an HTML file parses: node tools/syncheck.js index.html (or admin.html).
// (admin.html's second script is a module with top-level await; that one is checked inside an async function.)
const fs = require('fs');
const f = process.argv[2] || 'C:/Users/malon/skyframe/index.html';
const s = fs.readFileSync(f, 'utf8');
const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(s))) {
  i++;
  const attrs = m[1] || '';
  if (/src=/.test(attrs)) continue;
  const body = m[2];
  try {
    if (/type=["']?module/.test(attrs)) new Function('return async function(){' + body.replace(/^\s*import .*$/gm, '') + '}');
    else new Function(body);
  } catch (e) {
    bad++;
    console.log('script', i, e.message);
  }
}
console.log(bad ? 'BAD' : 'syntax ok', i, 'scripts');
