// samla on Cloudflare Workers. Events, replies and pictures are kept in a D1 database
// (binding "DB"); the files in public/ are served as static assets (binding "ASSETS").
// The pages and rules live in lib/core.js, shared with the Node server.
import { createApp, IMG_FILE_RE } from '../lib/core.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS rsvps (event_id TEXT NOT NULL, token TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (event_id, token))',
  'CREATE TABLE IF NOT EXISTS images (file TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL)',
];

let ready = null; // tables are created on the first request, so there is no separate setup step
function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map((q) => db.prepare(q))).catch((e) => { ready = null; throw e; });
  return ready;
}

function d1Store(db) {
  return {
    async getEvent(id) {
      const row = await db.prepare('SELECT data FROM events WHERE id = ?').bind(id).first();
      return row ? JSON.parse(row.data) : null;
    },
    async saveEvent(ev) {
      await db.prepare('INSERT INTO events (id, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2')
        .bind(ev.id, JSON.stringify(ev), ev.createdAt || Date.now()).run();
    },
    async deleteEvent(id) {
      await db.batch([
        db.prepare('DELETE FROM rsvps WHERE event_id = ?').bind(id),
        db.prepare('DELETE FROM events WHERE id = ?').bind(id),
      ]);
    },
    async listRsvps(id) {
      const { results } = await db.prepare('SELECT token, name, status, at FROM rsvps WHERE event_id = ?').bind(id).all();
      return results || [];
    },
    async getRsvp(id, token) {
      return !!(await db.prepare('SELECT 1 AS x FROM rsvps WHERE event_id = ? AND token = ?').bind(id, token).first());
    },
    async countRsvps(id) {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM rsvps WHERE event_id = ?').bind(id).first();
      return row ? row.n : 0;
    },
    async upsertRsvp(id, token, r) {
      await db.prepare('INSERT INTO rsvps (event_id, token, name, status, at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(event_id, token) DO UPDATE SET name = ?3, status = ?4, at = ?5')
        .bind(id, token, r.name, r.status, r.at).run();
    },
    async putImage(file, bytes, type) {
      if (!IMG_FILE_RE.test(file)) throw new Error('bad file name');
      await db.prepare('INSERT OR REPLACE INTO images (file, type, bytes) VALUES (?, ?, ?)').bind(file, type, bytes).run();
    },
    async getImage(file) {
      if (!IMG_FILE_RE.test(file)) return null;
      const row = await db.prepare('SELECT bytes FROM images WHERE file = ?').bind(file).first();
      if (!row) return null;
      const b = row.bytes;
      return { bytes: b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? b : new Uint8Array(b) };
    },
    async deleteImage(file) {
      await db.prepare('DELETE FROM images WHERE file = ?').bind(file).run();
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Pictures are read straight from the database every time (no copy is kept on Cloudflare's
    // servers), so a deleted event's picture is really gone.
    await ensureSchema(env.DB);
    const app = createApp({
      siteName: env.SITE_NAME,
      credit: env.SITE_CREDIT,
      creditLink: env.SITE_CREDIT_LINK,
      creditUrl: env.SITE_CREDIT_URL,
      downloadUrl: env.DOWNLOAD_URL,
      baseUrl: env.BASE_URL,
    }, d1Store(env.DB), async (name) => {
      const r = await env.ASSETS.fetch(new Request(new URL('/' + name, url.origin)));
      if (!r.ok) return null;
      const res = new Response(r.body, r);
      res.headers.set('Cache-Control', 'public, max-age=3600');
      res.headers.set('X-Content-Type-Options', 'nosniff');
      return res;
    });

    return app(request);
  },
};
