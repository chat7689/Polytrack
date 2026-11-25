// A tiny static file server for testing the game (no npm needed):
//   node tools/serve.js C:\Users\malon\skyframe 8935
// POST /shot?name=x.jpg with a data-URL body saves a picture into tools/shots/
// (how renders are checked when the browser pane is hidden: draw with
// App.renderer, canvas.toDataURL, then fetch('/shot?name=...', { method: 'POST', body })).
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2] || process.cwd(), port = +(process.argv[3] || 8935);
const shots = path.join(__dirname, 'shots');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/shot')) {
    const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'shot.jpg').replace(/[^a-z0-9_.-]/gi, '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        fs.mkdirSync(shots, { recursive: true });
        fs.writeFileSync(path.join(shots, name), Buffer.from(body.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
        res.writeHead(200); res.end('ok');
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(d);
  });
}).listen(port, () => console.log('serving ' + root + ' on ' + port));
