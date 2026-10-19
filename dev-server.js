// Local dev server: serves the static app and runs the /api functions the way
// Vercel does, so the WooCommerce integration can be exercised without
// deploying. Reads secrets from .env.local (git-ignored).
//
//   npm run dev        → http://localhost:3000
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 3000;

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
// Same rewrites as vercel.json.
const REWRITES = { '/': '/tracker.html', '/landing': '/landing.html' };

// Without local keys (.env.local), forward /api to the deployed site so the
// Integrations tab still works locally against the real connection — the
// secrets stay in Vercel. Set API_PROXY= (empty) to disable.
const API_PROXY = process.env.WOO_CONSUMER_KEY
  ? ''
  : (process.env.API_PROXY ?? 'https://lptracker-five.vercel.app');

async function proxyApi(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = await fetch(API_PROXY + req.url, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function handleApi(req, res, pathname) {
  if (API_PROXY) return proxyApi(req, res);
  const file = join(ROOT, normalize(pathname + '.js'));
  if (!file.startsWith(join(ROOT, 'api')) || !existsSync(file)) {
    res.writeHead(404).end('Not found'); return;
  }
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
  const handler = mod[req.method];
  if (!handler) { res.writeHead(405).end('Method not allowed'); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    const path = REWRITES[pathname] || pathname;
    const file = join(ROOT, normalize(path));
    if (!file.startsWith(ROOT) || !(await stat(file).catch(() => null))?.isFile()) {
      res.writeHead(404).end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    res.writeHead(500).end(String(err.message || err));
  }
}).listen(PORT, () => console.log(
  `LP Tracker dev server → http://localhost:${PORT}` + (API_PROXY ? `  (/api → ${API_PROXY})` : '')
));
