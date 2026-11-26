'use strict';
// samla: a small, link-based event and RSVP app. No dependencies, Node 18+.
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
// Events live OUTSIDE the app folder (in your home folder) so replacing the app with a new version never loses them.
const DATA = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), 'samla-data'));
const EV_DIR = path.join(DATA, 'events');
const IMG_DIR = path.join(DATA, 'images');
const PUB = path.join(__dirname, 'public');
const SITE = process.env.SITE_NAME || 'samla: the f*ck facebook event app';
const [SITE_SHORT, SITE_TAG] = SITE.includes(': ') ? [SITE.slice(0, SITE.indexOf(': ')), SITE.slice(SITE.indexOf(': ') + 2)] : [SITE, ''];
const DOWNLOAD_URL = /^https:\/\//.test(process.env.DOWNLOAD_URL || '') ? process.env.DOWNLOAD_URL : 'https://github.com/chablasco/samla';
const CREDIT = process.env.SITE_CREDIT ?? 'created by Cha Blasco';
const SLUG = SITE_SHORT.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'events';
const MAX_GUESTS = 1000;

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

// ---------- helpers ----------
const ID_RE = /^[A-Za-z0-9_-]{10,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const newId = (n = 9) => crypto.randomBytes(n).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

function clean(s, max, multiline = false) {
  let v = String(s ?? '').replace(/\r\n?/g, '\n');
  if (!multiline) v = v.replace(/\s+/g, ' ');
  return v.trim().slice(0, max);
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- storage (one JSON file per event, writes serialised per event) ----------
async function loadEvent(id) {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(await fsp.readFile(path.join(EV_DIR, id + '.json'), 'utf8')); }
  catch { return null; }
}
async function saveEvent(ev) {
  const f = path.join(EV_DIR, ev.id + '.json');
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

async function saveImage(id, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw fail(400, 'The picture must be a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw fail(413, 'The picture is too large (max 8 MB)');
  const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8)
    || (m[1] === 'png' && buf.subarray(0, 4).toString('hex') === '89504e47')
    || (m[1] === 'webp' && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP');
  if (!ok) throw fail(400, 'That file does not look like an image');
  const file = `${id}-${newId(4)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  await fsp.writeFile(path.join(IMG_DIR, file), buf);
  return { file };
}
async function removeImage(img) {
  if (img && img.file) await fsp.unlink(path.join(IMG_DIR, img.file)).catch(() => {});
}

function validate(b) {
  const o = {
    title: clean(b.title, 120),
    date: String(b.date || ''),
    time: String(b.time || ''),
    endTime: String(b.endTime || ''),
    place: clean(b.place, 200),
    description: clean(b.description, 4000, true),
    hostName: clean(b.hostName, 80),
    showGuests: b.showGuests !== false,
  };
  if (!o.title) throw fail(400, 'Give your event a name');
  if (!DATE_RE.test(o.date) || Number.isNaN(Date.parse(o.date))) throw fail(400, 'Pick a date');
  if (o.time && !TIME_RE.test(o.time)) throw fail(400, 'Check the start time');
  if (o.endTime && !TIME_RE.test(o.endTime)) throw fail(400, 'Check the end time');
  if (!o.time) o.endTime = '';
  return o;
}

function view(ev, forHost) {
  const list = Object.values(ev.rsvps || {}).sort((a, b) => a.at - b.at);
  const going = list.filter((r) => r.status === 'going');
  const no = list.filter((r) => r.status === 'no');
  const showNames = forHost || ev.showGuests;
  return {
    id: ev.id, title: ev.title, date: ev.date, time: ev.time, endTime: ev.endTime,
    place: ev.place, description: ev.description, hostName: ev.hostName,
    showGuests: ev.showGuests, image: ev.image ? '/img/' + ev.image.file : null,
    counts: { going: going.length, no: no.length },
    going: showNames ? going.map((r) => (forHost ? { name: r.name, at: r.at } : { name: r.name })) : [],
    no: forHost ? no.map((r) => ({ name: r.name, at: r.at })) : [],
  };
}

// ---------- dates ----------
function parts(date) { const [y, m, d] = date.split('-').map(Number); return { y, m, d, dt: new Date(Date.UTC(y, m - 1, d)) }; }
function fmtDate(date) {
  const { y, d, dt } = parts(date);
  const opts = { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return {
    long: new Intl.DateTimeFormat('en-GB', opts).format(dt),
    mon: new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(dt),
    day: d,
  };
}
const fmtTime = (ev) => ev.time ? (ev.endTime ? `${ev.time} to ${ev.endTime}` : ev.time) : '';

// ---------- calendar file ----------
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
function fold(line) { const out = []; while (line.length > 73) { out.push(line.slice(0, 73)); line = ' ' + line.slice(73); } out.push(line); return out.join('\r\n'); }
function stamp(ms) { const t = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}T${p(t.getUTCHours())}${p(t.getUTCMinutes())}00`; }
function ics(ev, url) {
  const { y, m, d } = parts(ev.date);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${SITE}//EN`, 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${ev.id}@${SLUG}`, `DTSTAMP:${stamp(Date.now())}Z`];
  if (ev.time) {
    const [h, mi] = ev.time.split(':').map(Number);
    const start = Date.UTC(y, m - 1, d, h, mi);
    let end = start + 2 * 3600e3;
    if (ev.endTime) {
      const [eh, em] = ev.endTime.split(':').map(Number);
      end = Date.UTC(y, m - 1, d, eh, em);
      if (end <= start) end += 24 * 3600e3;
    }
    lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${stamp(Date.UTC(y, m - 1, d + 1)).slice(0, 8)}`);
  }
  lines.push(`SUMMARY:${icsEscape(ev.title)}`);
  if (ev.place) lines.push(`LOCATION:${icsEscape(ev.place)}`);
  lines.push(`DESCRIPTION:${icsEscape([ev.description, url].filter(Boolean).join('\n\n'))}`, `URL:${url}`, 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- HTML ----------
const ICON = {
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  img: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5.5-5.5 4 4L16 14l4 4"/></svg>',
};

function baseUrl(req) {
  if (BASE_URL) return BASE_URL;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const THEME_BTN = `<button class="theme-btn" type="button" aria-label="Switch between light and dark mode" title="Light or dark mode">
<svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>
<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg></button>`;

function layout({ title, page, body, head = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="application-name" content="${esc(SITE)}">
<meta name="theme-color" content="#00874c">
<script src="/static/theme.js?v=2"></script>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="preload" href="/static/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/styles.css?v=2">
${head}
</head>
<body data-page="${page}">
<header class="top">
  <div class="brand"><span class="name"><a class="mark" href="/" aria-label="${esc(SITE)}">${esc(SITE_SHORT)}</a>${SITE_TAG ? `<span class="tag">${esc(SITE_TAG)}</span>` : ''}</span>${CREDIT ? `<span class="credit">${esc(CREDIT)}</span>` : ''}</div>
  <nav class="tools"><a href="/about">How it works</a>${THEME_BTN}</nav>
</header>
${body}
<footer class="footer"><span>${esc(SITE)}${CREDIT ? ' · ' + esc(CREDIT) : ''}</span><span>No tracking, no cookies, no ads.</span><a href="/about#privacy">What is stored</a></footer>
<script src="/static/app.js?v=2" defer></script>
</body>
</html>`;
}

function formHTML(ev) {
  const e = ev || {};
  const v = (k) => esc(e[k] || '');
  const editing = !!ev;
  return `<form class="ev-form" data-mode="${editing ? 'edit' : 'create'}"${editing ? ` data-id="${esc(e.id)}"` : ''}>
  <input class="sr" id="f-image" type="file" accept="image/*">
  <label class="drop${e.image ? ' has' : ''}" for="f-image">
    <img alt=""${e.image ? ` src="/img/${esc(e.image.file)}"` : ''}>
    <span class="drop-empty">${ICON.img}<b>Add a picture</b><small>Drop an image here, or tap to choose one</small></span>
    <span class="drop-change">Change picture</span>
  </label>
  <button type="button" class="link remove-img">Remove picture</button>
  <div class="field"><label for="f-title">Event name</label>
    <input id="f-title" name="title" required maxlength="120" value="${v('title')}" placeholder="Winter listening session"></div>
  <div class="row3">
    <div class="field"><label for="f-date">Date</label><input id="f-date" name="date" type="date" required value="${v('date')}"></div>
    <div class="field"><label for="f-time">Starts</label><input id="f-time" name="time" type="time" value="${v('time')}"></div>
    <div class="field"><label for="f-end">Ends <span class="opt">optional</span></label><input id="f-end" name="endTime" type="time" value="${v('endTime')}"></div>
  </div>
  <div class="field"><label for="f-place">Place</label>
    <input id="f-place" name="place" maxlength="200" value="${v('place')}" placeholder="Address or venue"></div>
  <div class="field"><label for="f-desc">Details</label>
    <textarea id="f-desc" name="description" rows="5" maxlength="4000" placeholder="What should people know? What to bring, door code, dress code…">${v('description')}</textarea></div>
  <div class="field"><label for="f-host">Hosted by</label>
    <input id="f-host" name="hostName" maxlength="80" autocomplete="name" value="${v('hostName')}" placeholder="Your name"></div>
  <label class="check"><input type="checkbox" name="showGuests"${e.showGuests === false ? '' : ' checked'}><span>Let guests see who else is going</span></label>
  <p class="err" role="alert"></p>
  <button class="btn primary big" type="submit">${editing ? 'Save changes' : 'Create event'}</button>
</form>`;
}

function eventCard(ev, url) {
  const d = fmtDate(ev.date);
  const time = fmtTime(ev);
  const cover = ev.image
    ? `<div class="cover"><img src="/img/${esc(ev.image.file)}" alt=""></div>`
    : `<div class="cover fb fb${hash(ev.id) % 5}" aria-hidden="true"><span>${d.day}</span></div>`;
  return `<article class="event">
  ${cover}
  <div class="info">
    <div class="when"><div class="stub"><span>${esc(d.mon)}</span><b>${d.day}</b></div>
      <div><p class="date">${esc(d.long)}</p>${time ? `<p class="time">${esc(time)}</p>` : ''}</div></div>
    <h1>${esc(ev.title)}</h1>
    ${ev.hostName ? `<p class="hostby">Hosted by ${esc(ev.hostName)}</p>` : ''}
    ${ev.place ? `<p class="place">${ICON.pin}<a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(ev.place)}" rel="noopener" target="_blank">${esc(ev.place)}</a></p>` : ''}
    ${ev.description ? `<div class="desc">${esc(ev.description)}</div>` : ''}
    <section id="rsvp" class="rsvp" aria-live="polite"></section>
    <section id="guests" class="guests" hidden></section>
    <a class="calendar" href="/e/${esc(ev.id)}/calendar.ics">${ICON.cal}Add to calendar</a>
  </div>
</article>`;
}

const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

function homePage() {
  return layout({
    title: `New event · ${SITE}`, page: 'home',
    body: `<main class="wrap narrow">
  <h1 class="page-title">New event</h1>
  <p class="lede">Make the event, send the link to the people you want there, and watch the replies come in. Guests need no account.</p>
  ${formHTML(null)}
  <section class="mine" hidden><h2>Your events</h2><ul id="mine"></ul><p class="note">Saved in this browser only.</p></section>
</main>`,
  });
}

function guestPage(ev, base) {
  const url = `${base}/e/${ev.id}`;
  const d = fmtDate(ev.date);
  const desc = [d.long, fmtTime(ev), ev.place].filter(Boolean).join(' · ');
  const head = `<meta property="og:type" content="website">
<meta property="og:title" content="${esc(ev.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
${ev.image ? `<meta property="og:image" content="${esc(base + '/img/' + ev.image.file)}"><meta name="twitter:card" content="summary_large_image">` : ''}
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex">`;
  return layout({
    title: ev.title, page: 'event', head,
    body: `<main class="wrap">${eventCard(ev, url)}</main>
<script type="application/json" id="ev-data">${json({ id: ev.id })}</script>`,
  });
}

function hostPage(ev, base) {
  const share = `${base}/e/${ev.id}`;
  const hostUrl = `${base}/h/${ev.id}/${ev.hostKey}`;
  return layout({
    title: `${ev.title} · host`, page: 'host', head: '<meta name="robots" content="noindex">',
    body: `<main class="wrap">
  <div class="host-grid">
    <section class="panel share">
      <h2>Invite people</h2>
      <p>Send this link to the people you want to invite. The event is unlisted, so only people who have the link can find it.</p>
      <div class="copy-row"><input readonly id="share-url" value="${esc(share)}" aria-label="Invite link"><button class="btn primary" data-copy="#share-url">Copy link</button></div>
      <button class="btn ghost native-share" hidden>Share…</button>
      <details class="hostlink"><summary>Your private host link</summary>
        <p>Bookmark this. Anyone who has it can see the replies and edit the event, so keep it to yourself.</p>
        <div class="copy-row"><input readonly id="host-url" value="${esc(hostUrl)}" aria-label="Host link"><button class="btn ghost" data-copy="#host-url">Copy</button></div>
      </details>
      <div class="actions"><a class="btn ghost" href="/e/${esc(ev.id)}">View as guest</a><button class="btn ghost" id="edit-btn" aria-expanded="false" aria-controls="edit">Edit event</button><button class="btn ghost danger" id="del-btn">Delete</button></div>
    </section>
    <section class="panel replies">
      <div class="tally"><div><b id="n-going">0</b><span>Going</span></div><div><b id="n-no">0</b><span>Can't go</span></div></div>
      <h3>Going</h3><ul id="list-going" class="people"></ul>
      <h3>Can't go</h3><ul id="list-no" class="people"></ul>
      <p class="note" id="updated"></p>
    </section>
  </div>
  <section id="edit" class="edit narrow" hidden><h2>Edit event</h2>${formHTML(ev)}</section>
  <h2 class="preview-h">What your guests see</h2>
  <div class="preview">${eventCard(ev, share)}</div>
  <dialog id="del-dialog"><form method="dialog">
    <h2>Delete this event?</h2><p>The event, its picture and all replies will be removed. This can't be undone.</p>
    <div class="actions"><button class="btn ghost" value="cancel">Keep it</button><button class="btn primary danger" value="delete" id="del-confirm">Delete event</button></div>
  </form></dialog>
</main>
<script type="application/json" id="ev-data">${json({ id: ev.id, key: ev.hostKey, title: ev.title, date: ev.date })}</script>`,
  });
}

function aboutPage(base) {
  return layout({
    title: `How it works · ${SITE}`, page: 'about',
    body: `<main class="wrap narrow about">
  <h1 class="page-title">How it works</h1>
  <p class="lede">A simple way to invite people to something and see who's coming. No accounts, no feed, no algorithm.</p>

  <h2>If you're hosting</h2>
  <ol>
    <li>Go to <a href="/">New event</a>. Add a picture, a name, date and time, the place and any details.</li>
    <li>Press <b>Create event</b>. You land on your host page.</li>
    <li>Copy the invite link and send it to the people you want there, by text, email, WhatsApp or any other way.</li>
    <li>Follow the replies on your host page. Bookmark it: the host link is your key to edit or delete the event.</li>
  </ol>

  <h2>If you're invited</h2>
  <ol>
    <li>Open the link you were sent.</li>
    <li>Write your name and tap <b>Going</b> or <b>Can't go</b>.</li>
    <li>Changed your mind? Open the same link again in the same browser and tap <b>Change my reply</b>.</li>
  </ol>

  <section class="promise" id="privacy">
    <h2>What this app stores, and what it doesn't</h2>
    <p><b>It does not collect anything about you.</b> There are no accounts, no email addresses or phone numbers, no cookies, no tracking, no analytics and no ads. Nothing is loaded from other companies: the fonts and code all come from this server. Nothing is sold or shared.</p>
  </section>
  <ul class="facts">
    <li><b>Only what you type in is saved:</b> the event details and picture, and for each reply the name the guest writes, Going or Can't go, and when they answered.</li>
    <li><b>Who can see it:</b> anyone with the invite link sees the event and, if the host allows it, the names of people going. Only the host sees the full list.</li>
    <li><b>Deleting:</b> when the host deletes an event, its picture and all replies are removed from the server.</li>
    <li><b>In your own browser:</b> your name and the events you host are remembered on your device so you don't have to type them again. Clearing your browser's site data removes them.</li>
    <li><b>Maps:</b> the address opens Google Maps only if you tap it.</li>
  </ul>

  <h2>Do I need to download anything?</h2>
  <p><b>No, not to use it.</b> Hosts and guests only need a web browser and the address of a copy that is online, like this one. Nothing to install, no zip file, no app store.</p>
  <p>You only need the app's files if you want to <b>run your own copy</b>, on your own computer or server.${DOWNLOAD_URL
    ? ` <a href="${esc(DOWNLOAD_URL)}" rel="noopener">Download the files on GitHub</a> (green <b>Code</b> button, then <b>Download ZIP</b>).`
    : ' Ask the person who runs this site for the files.'}</p>

  <h2>Run your own copy</h2>
  <p>The app needs <b>Node.js version 18 or newer</b> and nothing else. First check if you already have it: open a terminal and type</p>
  <pre><code>node --version</code></pre>
  <p>If it shows <code>v18</code> or a higher number, skip to "Start the app". If it says the command is not found, or shows a lower number, install Node first.</p>

  <h3>Install Node on a Mac</h3>
  <ol>
    <li>Go to <a href="https://nodejs.org" rel="noopener">nodejs.org</a> and download the <b>LTS</b> version for macOS.</li>
    <li>Open the downloaded <code>.pkg</code> file and click through the installer.</li>
    <li>Open Terminal (Cmd + Space, type "Terminal") and check with <code>node --version</code>.</li>
  </ol>
  <p class="note">If you use Homebrew, <code>brew install node</code> also works.</p>

  <h3>Install Node on Windows</h3>
  <ol>
    <li>Go to <a href="https://nodejs.org" rel="noopener">nodejs.org</a> and download the <b>LTS</b> version for Windows.</li>
    <li>Open the downloaded <code>.msi</code> file and click through the installer with the default choices.</li>
    <li>Open a new Terminal or PowerShell window and check with <code>node --version</code>.</li>
  </ol>

  <h3>Install Node on Linux</h3>
  <p>Your package manager may offer an older version, so check the number after installing. If it is below 18, use the Linux download or the instructions for your distribution on <a href="https://nodejs.org" rel="noopener">nodejs.org</a>.</p>

  <h3>Start the app</h3>
  <ol>
    <li>Unzip the files. You get a folder called <code>samla</code>.</li>
    <li>In the terminal, go into that folder. Tip: type <code>cd</code> and a space, drag the folder into the window, and press Enter.</li>
    <li>Start it:</li>
  </ol>
  <pre><code>node server.js</code></pre>
  <p>Then open <code>http://127.0.0.1:3000</code> in your browser. Keep the terminal open while you use it; press Ctrl + C to stop. This copy only works on your own computer. To let other people open your events, it has to be put online, which the README file in the folder explains.</p>
  <p class="note">This copy runs at <code>${esc(base)}</code>.</p>
</main>`,
  });
}

function notFoundPage() {
  return layout({ title: `Not found · ${SITE}`, page: 'missing', body: `<main class="wrap narrow missing"><h1 class="page-title">This event isn't here</h1><p class="lede">The link may be mistyped, or the host may have deleted the event.</p><a class="btn primary" href="/">Make your own event</a></main>` });
}

// ---------- HTTP ----------
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SEC, ...extra });
  res.end(body);
}
const sendHtml = (res, html, status = 200, extra = {}) => send(res, status, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(fail(413, 'That is too large to upload')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(fail(400, 'Bad request')); }
    });
    req.on('error', reject);
  });
}

const STATIC = { 'styles.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'theme.js': 'text/javascript; charset=utf-8', 'icon.svg': 'image/svg+xml',
  'fonts/archivo-latin.woff2': 'font/woff2', 'fonts/archivo-latin-ext.woff2': 'font/woff2', 'fonts/OFL.txt': 'text/plain; charset=utf-8' };
const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function route(req, res) {
  const u = new URL(req.url, 'http://local');
  const p = u.pathname, m = req.method;
  let mm;

  if (m === 'GET' && p === '/') return sendHtml(res, homePage());
  if (m === 'GET' && (p === '/about' || p === '/about/')) return sendHtml(res, aboutPage(baseUrl(req)));

  if (m === 'GET' && (mm = /^\/static\/([A-Za-z0-9./-]+)$/.exec(p)) && STATIC[mm[1]]) {
    const buf = await fsp.readFile(path.join(PUB, mm[1]));
    return send(res, 200, buf, STATIC[mm[1]], { 'Cache-Control': 'public, max-age=3600' });
  }

  if (m === 'GET' && (mm = /^\/img\/([A-Za-z0-9_-]+\.(jpg|png|webp))$/.exec(p))) {
    try {
      const buf = await fsp.readFile(path.join(IMG_DIR, mm[1]));
      return send(res, 200, buf, IMG_TYPES[mm[2]], { 'Cache-Control': 'public, max-age=31536000, immutable' });
    } catch { return send(res, 404, 'Not found', 'text/plain'); }
  }

  if (m === 'GET' && (mm = /^\/e\/([A-Za-z0-9_-]+)\/?$/.exec(p))) {
    const ev = await loadEvent(mm[1]);
    return ev ? sendHtml(res, guestPage(ev, baseUrl(req))) : sendHtml(res, notFoundPage(), 404);
  }

  if (m === 'GET' && (mm = /^\/e\/([A-Za-z0-9_-]+)\/calendar\.ics$/.exec(p))) {
    const ev = await loadEvent(mm[1]);
    if (!ev) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, ics(ev, `${baseUrl(req)}/e/${ev.id}`), 'text/calendar; charset=utf-8',
      { 'Content-Disposition': 'attachment; filename="event.ics"', 'Cache-Control': 'no-store' });
  }

  if (m === 'GET' && (mm = /^\/h\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(p))) {
    const ev = await loadEvent(mm[1]);
    if (!ev || !safeEq(mm[2], ev.hostKey)) return sendHtml(res, notFoundPage(), 404);
    return sendHtml(res, hostPage(ev, baseUrl(req)));
  }

  // ----- API -----
  if (m === 'POST' && p === '/api/events') {
    const b = await readJson(req, 12e6);
    const ev = { id: newId(9), hostKey: newId(18), ...validate(b), image: null, rsvps: {}, createdAt: Date.now(), updatedAt: Date.now() };
    if (b.image) ev.image = await saveImage(ev.id, b.image);
    await saveEvent(ev);
    return sendJson(res, 201, { id: ev.id, hostKey: ev.hostKey });
  }

  if ((mm = /^\/api\/events\/([A-Za-z0-9_-]+)$/.exec(p))) {
    const id = mm[1];
    const key = req.headers['x-host-key'];
    if (m === 'GET') {
      const ev = await loadEvent(id);
      if (!ev) throw fail(404, 'Event not found');
      return sendJson(res, 200, view(ev, safeEq(key, ev.hostKey)));
    }
    if (m === 'PUT') {
      const b = await readJson(req, 12e6);
      const out = await withLock(id, async () => {
        const ev = await loadEvent(id);
        if (!ev || !safeEq(key, ev.hostKey)) throw fail(404, 'Event not found');
        Object.assign(ev, validate(b), { updatedAt: Date.now() });
        if (b.image) { const old = ev.image; ev.image = await saveImage(ev.id, b.image); await removeImage(old); }
        else if (b.removeImage) { await removeImage(ev.image); ev.image = null; }
        await saveEvent(ev);
        return view(ev, true);
      });
      return sendJson(res, 200, out);
    }
    if (m === 'DELETE') {
      await withLock(id, async () => {
        const ev = await loadEvent(id);
        if (!ev || !safeEq(key, ev.hostKey)) throw fail(404, 'Event not found');
        await removeImage(ev.image);
        await fsp.unlink(path.join(EV_DIR, id + '.json'));
      });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (m === 'POST' && (mm = /^\/api\/events\/([A-Za-z0-9_-]+)\/rsvp$/.exec(p))) {
    const id = mm[1];
    const b = await readJson(req, 4096);
    const name = clean(b.name, 60);
    const status = b.status === 'going' ? 'going' : b.status === 'no' ? 'no' : null;
    if (!name) throw fail(400, 'Write your name so the host knows who you are');
    if (!status) throw fail(400, 'Choose Going or Can\'t go');
    const out = await withLock(id, async () => {
      const ev = await loadEvent(id);
      if (!ev) throw fail(404, 'Event not found');
      ev.rsvps = ev.rsvps || {};
      let token = typeof b.token === 'string' && ID_RE.test(b.token) && ev.rsvps[b.token] ? b.token : null;
      if (!token) {
        if (Object.keys(ev.rsvps).length >= MAX_GUESTS) throw fail(409, 'This event has reached its reply limit');
        token = newId(12);
      }
      ev.rsvps[token] = { name, status, at: Date.now() };
      await saveEvent(ev);
      return { token, event: view(ev, false) };
    });
    return sendJson(res, 200, out);
  }

  if (p.startsWith('/api/')) throw fail(404, 'Not found');
  return sendHtml(res, notFoundPage(), 404);
}

const server = http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server' : e.message });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`${SITE} running on http://${HOST}:${PORT}`);
  console.log(`Events are saved in ${DATA}`);
});
