import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    name = name.replace(/^\/Kakuseigar(?=\/|$)/, '') || '/';
    if (name === '/') name = '/index.html';
    if (!/^\/(index\.html|styles\.css|(?:src|data|assets)\/[a-zA-Z0-9_./-]+)$/.test(name) || name.includes('..')) {
      res.writeHead(404).end('Not found'); return;
    }
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(root)) { res.writeHead(404).end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Kakuseigar: http://127.0.0.1:${port}/Kakuseigar/`));
