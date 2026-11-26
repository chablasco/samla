// samla core: pages, rules and routes, shared by the Node server (server.js)
// and the Cloudflare Worker (src/worker.js). Uses only web-standard APIs
// (Request, Response, crypto.getRandomValues), so it runs in both places.

export const ID_RE = /^[A-Za-z0-9_-]{10,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_GUESTS = 1000;
export const MAX_IMAGE_BYTES = 1800 * 1024; // pictures are resized in the browser; this keeps them small enough for every host
const IMG_TYPES = { jpeg: 'jpg', png: 'png', webp: 'webp' };
export const IMG_CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const IMG_FILE_RE = /^[A-Za-z0-9_-]+\.(jpg|png|webp)$/;

export function newId(n = 9) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

function clean(s, max, multiline = false) {
  let v = String(s ?? '').replace(/\r\n?/g, '\n');
  if (!multiline) v = v.replace(/\s+/g, ' ');
  return v.trim().slice(0, max);
}
// Compares secrets in constant time, so the host key can't be guessed by timing.
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

function view(ev, rsvps, forHost) {
  const list = rsvps.slice().sort((a, b) => a.at - b.at);
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

// Works out the picture type from its first bytes, never from what the browser claims.
function sniffImage(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  const s = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  return null;
}

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const reply = (body, status, type, extra = {}) => new Response(body, { status, headers: { 'Content-Type': type, ...SEC, ...extra } });
const html = (body, status = 200) => reply(body, status, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
const jsonReply = (obj, status = 200) => reply(JSON.stringify(obj), status, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

async function readBody(request, limit) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limit) throw fail(413, 'That is too large to upload');
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength > limit) throw fail(413, 'That is too large to upload');
  return buf;
}
async function readJson(request, limit) {
  const buf = await readBody(request, limit);
  try { return JSON.parse(new TextDecoder().decode(buf) || '{}'); }
  catch { throw fail(400, 'Bad request'); }
}

/**
 * createApp(config, store, assets) returns handle(request) -> Response.
 *  config: { siteName, credit, creditLink, creditUrl, downloadUrl, baseUrl }
 *  store:  getEvent, saveEvent, deleteEvent, listRsvps, getRsvp, countRsvps, upsertRsvp, putImage, getImage, deleteImage
 *  assets: async (path) -> Response | null, for files under /static/
 */
export function createApp(config, store, assets) {
  const SITE = config.siteName || 'samla: the f*ck facebook event app';
  const [SITE_SHORT, SITE_TAG] = SITE.includes(': ') ? [SITE.slice(0, SITE.indexOf(': ')), SITE.slice(SITE.indexOf(': ') + 2)] : [SITE, ''];
  const DOWNLOAD_URL = /^https:\/\//.test(config.downloadUrl ?? '') ? config.downloadUrl : (config.downloadUrl === '' ? '' : 'https://github.com/chablasco/samla');
  const CREDIT = config.credit ?? 'created by Cha Blasco';
  const CREDIT_LINK = config.creditLink ?? 'Cha Blasco';
  const CREDIT_URL = /^https:\/\//.test(config.creditUrl ?? 'https://chablasco.com') ? (config.creditUrl ?? 'https://chablasco.com') : '';
  const SLUG = SITE_SHORT.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'events';
  const BASE_URL = (config.baseUrl || '').replace(/\/$/, '');
  // The credit line, with the name linked to the creator's website
  function creditHTML() {
    const text = esc(CREDIT);
    if (!CREDIT_URL || !CREDIT_LINK || !CREDIT.includes(CREDIT_LINK)) return text;
    return text.replace(esc(CREDIT_LINK), `<a href="${esc(CREDIT_URL)}" rel="noopener" target="_blank">${esc(CREDIT_LINK)}</a>`);
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
      month: new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(dt),
      weekday: new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(dt),
      year: y,
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
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };


  const THEME_BTN = `<button class="theme-btn" type="button" aria-label="Switch between light and dark mode" title="Light or dark mode">
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path class="half" d="M12 3.75a8.25 8.25 0 0 1 0 16.5Z"/></svg></button>`;

  function layout({ title, page, body, head = '' }) {
    return `<!DOCTYPE html>
  <html lang="en">
  <head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="application-name" content="${esc(SITE)}">
  <meta name="theme-color" content="#ffd60a">
  <script src="/static/theme.js?v=4"></script>
  <link rel="icon" href="/static/icon.svg?v=4" type="image/svg+xml">
  <link rel="preload" href="/static/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/static/styles.css?v=8">
  ${head}
  </head>
  <body data-page="${page}">
  <header class="top">
    <div class="brand"><a class="mark" href="/" aria-label="${esc(SITE)}">${esc(SITE_SHORT)}</a>${SITE_TAG ? `<span class="tag">${esc(SITE_TAG)}</span>` : ''}</div>
    <nav class="nav" aria-label="Main"><a href="/"${page === 'home' ? ' aria-current="page"' : ''}>New event</a><a href="/about"${page === 'about' ? ' aria-current="page"' : ''}>How it works</a></nav>
    <div class="right">${THEME_BTN}</div>
  </header>
  ${body}
  <footer class="footer">
    <span>${esc(SITE)}</span><span>No tracking, no cookies, no ads. <a href="/about#privacy">What is stored</a></span>${CREDIT ? `<span class="credit-line">${creditHTML()}</span>` : ''}
  </footer>
  <script src="/static/app.js?v=8" defer></script>
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
      <span class="drop-empty">${ICON.plus}<b>Add a picture</b><small>Drop an image here, or tap to choose one</small></span>
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
      ? `<figure class="cover reveal"><img src="/img/${esc(ev.image.file)}" alt="" data-parallax></figure>`
      : `<figure class="cover fb fb${hash(ev.id) % 4} reveal" aria-hidden="true"><span class="fb-top">${esc(d.month)} ${d.year}<br>${esc(d.weekday)}</span><span class="fb-num" data-parallax>${d.day}</span></figure>`;
    const map = ev.place ? `<a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(ev.place)}" rel="noopener" target="_blank">${esc(ev.place)}</a>` : '';
    return `<article class="event">
    <header class="ev-head">
      <p class="when reveal"><time datetime="${esc(ev.date)}${ev.time ? 'T' + esc(ev.time) : ''}">${esc(d.long)}${time ? ` · ${esc(time)}` : ''}</time></p>
      <h1 class="title" data-split>${esc(ev.title)}</h1>
    </header>
    <div class="visual">
      ${cover}
    </div>
    <div class="body">
      <section class="details reveal">
        <h2>Event details</h2>
        <dl class="meta">
          <div><dt>Date</dt><dd>${esc(d.long)}</dd></div>
          ${time ? `<div><dt>Time</dt><dd>${esc(time)}</dd></div>` : ''}
          ${ev.place ? `<div><dt>Place</dt><dd>${map}</dd></div>` : ''}
          ${ev.hostName ? `<div><dt>Host</dt><dd>${esc(ev.hostName)}</dd></div>` : ''}
        </dl>
      </section>
      ${ev.description ? `<div class="desc reveal">${esc(ev.description)}</div>` : ''}
      <section id="rsvp" class="rsvp reveal" aria-live="polite"></section>
      <section id="guests" class="guests reveal" hidden></section>
      <a class="calendar reveal" href="/e/${esc(ev.id)}/calendar.ics">Add to calendar ${ICON.arrow}</a>
    </div>
  </article>`;
  }

  const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

  function homePage() {
    return layout({
      title: `New event · ${SITE}`, page: 'home',
      body: `<main class="wrap split">
    <div class="intro">
      <h1 class="page-title" data-split>New event</h1>
      <p class="lede reveal">Make the event, send the link to the people you want there, and watch the replies come in. Guests need no account.</p>
    </div>
    <div class="col">
    ${formHTML(null)}
    <section class="mine" hidden>
      <div class="mine-head"><h2>Your events</h2><button class="btn ghost danger small" type="button" id="del-past" hidden>Delete all past events</button></div>
      <ul id="mine"></ul>
      <p class="note">This list is saved in this browser only. Deleting an event removes it, its picture and all replies from the server for good.</p>
    </section>
    <dialog id="del-dialog"><form method="dialog">
      <h2 id="del-title">Delete this event?</h2><p id="del-text">The event, its picture and all replies will be removed. This can't be undone.</p>
      <div class="actions"><button class="btn ghost" value="cancel">Keep</button><button class="btn primary danger" value="delete">Delete</button></div>
    </form></dialog>
    </div>
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
    <h1 class="page-title" data-split>How it works</h1>
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

  <h3>Put your copy online</h3>
  <p>To let people open your events on their own phones, put your copy online. The easiest way is Cloudflare's free plan: with a free Cloudflare account, run these two commands in the <code>samla</code> folder and you get a public address.</p>
  <pre><code>npx wrangler login
npx wrangler deploy</code></pre>
  <p>The README file in the folder explains each step.</p>
    <p class="note">This copy runs at <code>${esc(base)}</code>.</p>
  </main>`,
    });
  }

  function notFoundPage() {
    return layout({ title: `Not found · ${SITE}`, page: 'missing', body: `<main class="wrap narrow missing"><h1 class="page-title">This event isn't here</h1><p class="lede">The link may be mistyped, or the host may have deleted the event.</p><a class="btn primary" href="/">Make your own event</a></main>` });
  }


  async function route(request) {
    const u = new URL(request.url);
    const p = u.pathname, m = request.method;
    const base = BASE_URL || u.origin;
    let mm;

    if (m === 'GET' && p === '/') return html(homePage());
    if (m === 'GET' && (p === '/about' || p === '/about/')) return html(aboutPage(base));

    if (m === 'GET' && (mm = /^\/static\/([A-Za-z0-9./-]+)$/.exec(p)) && !mm[1].includes('..')) {
      const r = await assets(mm[1]);
      if (r) return r;
      return reply('Not found', 404, 'text/plain');
    }

    if (m === 'GET' && (mm = /^\/img\/([A-Za-z0-9_-]+\.(jpg|png|webp))$/.exec(p))) {
      const img = await store.getImage(mm[1]);
      if (!img) return reply('Not found', 404, 'text/plain');
      return reply(img.bytes, 200, IMG_CONTENT_TYPES[mm[2]], { 'Cache-Control': 'private, max-age=86400' });
    }

    if (m === 'GET' && (mm = /^\/e\/([A-Za-z0-9_-]+)\/?$/.exec(p))) {
      const ev = await store.getEvent(mm[1]);
      return ev ? html(guestPage(ev, base)) : html(notFoundPage(), 404);
    }

    if (m === 'GET' && (mm = /^\/e\/([A-Za-z0-9_-]+)\/calendar\.ics$/.exec(p))) {
      const ev = await store.getEvent(mm[1]);
      if (!ev) return reply('Not found', 404, 'text/plain');
      return reply(ics(ev, `${base}/e/${ev.id}`), 200, 'text/calendar; charset=utf-8',
        { 'Content-Disposition': 'attachment; filename="event.ics"', 'Cache-Control': 'no-store' });
    }

    if (m === 'GET' && (mm = /^\/h\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(p))) {
      const ev = await store.getEvent(mm[1]);
      if (!ev || !safeEq(mm[2], ev.hostKey)) return html(notFoundPage(), 404);
      return html(hostPage(ev, base));
    }

    // ----- API -----
    if (m === 'POST' && p === '/api/events') {
      const b = await readJson(request, 64 * 1024);
      const ev = { id: newId(9), hostKey: newId(18), ...validate(b), image: null, createdAt: Date.now(), updatedAt: Date.now() };
      await store.saveEvent(ev);
      return jsonReply({ id: ev.id, hostKey: ev.hostKey }, 201);
    }

    if ((mm = /^\/api\/events\/([A-Za-z0-9_-]+)$/.exec(p))) {
      const id = mm[1];
      const key = request.headers.get('x-host-key');
      const ev = await store.getEvent(id);
      if (m === 'GET') {
        if (!ev) throw fail(404, 'Event not found');
        return jsonReply(view(ev, await store.listRsvps(id), safeEq(key, ev.hostKey)));
      }
      if (!ev || !safeEq(key, ev.hostKey)) throw fail(404, 'Event not found');
      if (m === 'PUT') {
        const b = await readJson(request, 64 * 1024);
        Object.assign(ev, validate(b), { updatedAt: Date.now() });
        if (b.removeImage && ev.image) { await store.deleteImage(ev.image.file); ev.image = null; }
        await store.saveEvent(ev);
        return jsonReply(view(ev, await store.listRsvps(id), true));
      }
      if (m === 'DELETE') {
        await store.deleteEvent(id);
        if (ev.image) await store.deleteImage(ev.image.file);
        return jsonReply({ ok: true });
      }
    }

    // The picture is sent on its own, as plain bytes, after the event is created or edited.
    if (m === 'PUT' && (mm = /^\/api\/events\/([A-Za-z0-9_-]+)\/image$/.exec(p))) {
      const ev = await store.getEvent(mm[1]);
      if (!ev || !safeEq(request.headers.get('x-host-key'), ev.hostKey)) throw fail(404, 'Event not found');
      const bytes = await readBody(request, MAX_IMAGE_BYTES);
      if (!bytes.byteLength) throw fail(400, 'The picture is empty');
      const kind = sniffImage(bytes);
      if (!kind) throw fail(400, 'That file does not look like a JPEG, PNG or WebP picture');
      const ext = IMG_TYPES[kind];
      const file = `${ev.id}-${newId(4)}.${ext}`;
      await store.putImage(file, bytes, IMG_CONTENT_TYPES[ext]);
      const old = ev.image;
      ev.image = { file };
      ev.updatedAt = Date.now();
      await store.saveEvent(ev);
      if (old) await store.deleteImage(old.file);
      return jsonReply({ image: '/img/' + file });
    }

    if (m === 'POST' && (mm = /^\/api\/events\/([A-Za-z0-9_-]+)\/rsvp$/.exec(p))) {
      const id = mm[1];
      const b = await readJson(request, 4096);
      const name = clean(b.name, 60);
      const status = b.status === 'going' ? 'going' : b.status === 'no' ? 'no' : null;
      if (!name) throw fail(400, 'Write your name so the host knows who you are');
      if (!status) throw fail(400, 'Choose Going or Can\'t go');
      const ev = await store.getEvent(id);
      if (!ev) throw fail(404, 'Event not found');
      let token = typeof b.token === 'string' && ID_RE.test(b.token) && await store.getRsvp(id, b.token) ? b.token : null;
      if (!token) {
        if (await store.countRsvps(id) >= MAX_GUESTS) throw fail(409, 'This event has reached its reply limit');
        token = newId(12);
      }
      await store.upsertRsvp(id, token, { name, status, at: Date.now() });
      return jsonReply({ token, event: view(ev, await store.listRsvps(id), false) });
    }

    if (p.startsWith('/api/')) throw fail(404, 'Not found');
    return html(notFoundPage(), 404);
  }

  return async function handle(request) {
    try { return await route(request); }
    catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return jsonReply({ error: status === 500 ? 'Something went wrong on the server' : e.message }, status);
    }
  };
}
