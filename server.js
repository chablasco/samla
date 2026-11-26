// samla on your own computer or server. Needs Node 18 or newer, no packages.
// Events are saved as files in ~/samla-data (or DATA_DIR). The pages and rules live in lib/core.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, ID_RE, IMG_FILE_RE } from './lib/core.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18
const fsp = fs.promises;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
// Events live OUTSIDE the app folder (in your home folder) so replacing the app with a new version never loses them.
const DATA = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), 'samla-data'));
const EV_DIR = path.join(DATA, 'events');
const IMG_DIR = path.join(DATA, 'images');
const PUB = path.join(__dirname, 'public');

fs.mkdirSync(EV_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

// Earlier versions kept events in a "data" folder inside the app folder. Bring those over
// (from this folder and from any sibling "samla..." folders, e.g. "samla 2"), never overwriting.
function importOldData() {
  if (process.env.DATA_DIR) return;
  const parent = path.dirname(__dirname);
  let candidates = [path.join(__dirname, 'data')];
  try {
    candidates = candidates.concat(fs.readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^samla/i.test(d.name))
      .map((d) => path.join(parent, d.name, 'data')));
  } catch { /* parent not readable */ }
  let count = 0;
  for (const dir of new Set(candidates)) {
    for (const sub of ['events', 'images']) {
      const from = path.join(dir, sub);
      let files = [];
      try { files = fs.readdirSync(from); } catch { continue; }
      for (const f of files) {
        if (!/^[A-Za-z0-9_-]+\.(json|jpg|png|webp)$/.test(f)) continue;
        const to = path.join(DATA, sub, f);
        if (fs.existsSync(to)) continue;
        try { fs.copyFileSync(path.join(from, f), to); if (sub === 'events') count++; } catch { /* skip */ }
      }
    }
  }
  if (count) console.log(`Brought over ${count} event(s) saved by an earlier version.`);
}
importOldData();

// ---------- file storage: one JSON file per event (replies inside), pictures as files ----------
const evFile = (id) => path.join(EV_DIR, id + '.json');
async function readEvent(id) {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(await fsp.readFile(evFile(id), 'utf8')); } catch { return null; }
}
async function writeEvent(ev) {
  const f = evFile(ev.id);
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(ev));
  await fsp.rename(tmp, f);
}
const locks = new Map();
function withLock(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return next;
}

const store = {
  async getEvent(id) {
    const ev = await readEvent(id);
    if (!ev) return null;
    delete ev.rsvps;
    return ev;
  },
  saveEvent(ev) {
    return withLock(ev.id, async () => {
      const old = await readEvent(ev.id);
      await writeEvent({ ...ev, rsvps: (old && old.rsvps) || {} });
    });
  },
  deleteEvent(id) {
    return withLock(id, () => fsp.unlink(evFile(id)).catch(() => {}));
  },
  async listRsvps(id) {
    const ev = await readEvent(id);
    return Object.entries((ev && ev.rsvps) || {}).map(([token, r]) => ({ token, ...r }));
  },
  async getRsvp(id, token) {
    const ev = await readEvent(id);
    return !!(ev && ev.rsvps && ev.rsvps[token]);
  },
  async countRsvps(id) {
    const ev = await readEvent(id);
    return Object.keys((ev && ev.rsvps) || {}).length;
  },
  upsertRsvp(id, token, r) {
    return withLock(id, async () => {
      const ev = await readEvent(id);
      if (!ev) return;
      ev.rsvps = ev.rsvps || {};
      ev.rsvps[token] = r;
      await writeEvent(ev);
    });
  },
  async putImage(file, bytes) {
    if (!IMG_FILE_RE.test(file)) throw new Error('bad file name');
    await fsp.writeFile(path.join(IMG_DIR, file), bytes);
  },
  async getImage(file) {
    if (!IMG_FILE_RE.test(file)) return null;
    try { return { bytes: await fsp.readFile(path.join(IMG_DIR, file)) }; } catch { return null; }
  },
  async deleteImage(file) {
    if (IMG_FILE_RE.test(file)) await fsp.unlink(path.join(IMG_DIR, file)).catch(() => {});
  },
};

const STATIC = { 'styles.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'theme.js': 'text/javascript; charset=utf-8', 'icon.svg': 'image/svg+xml',
  'fonts/inter-latin.woff2': 'font/woff2', 'fonts/inter-latin-ext.woff2': 'font/woff2', 'fonts/OFL.txt': 'text/plain; charset=utf-8' };
async function assets(name) {
  if (!STATIC[name]) return null;
  const buf = await fsp.readFile(path.join(PUB, name));
  return new Response(buf, { headers: { 'Content-Type': STATIC[name], 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
}

const handle = createApp({
  siteName: process.env.SITE_NAME,
  credit: process.env.SITE_CREDIT,
  creditLink: process.env.SITE_CREDIT_LINK,
  creditUrl: process.env.SITE_CREDIT_URL,
  downloadUrl: process.env.DOWNLOAD_URL,
  baseUrl: process.env.BASE_URL,
}, store, assets);

// ---------- plain Node HTTP <-> web Request/Response ----------
const server = http.createServer(async (req, res) => {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 3 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(c); }
      body = Buffer.concat(chunks);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const response = await handle(new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something went wrong on the server');
  }
});
server.listen(PORT, HOST, () => {
  console.log(`${process.env.SITE_NAME || 'samla'} running on http://${HOST}:${PORT}`);
  console.log(`Events are saved in ${DATA}`);
});
