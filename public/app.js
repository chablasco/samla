{
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const hashNum = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const initials = (n) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const avatar = (n) => `<span class="av c${hashNum(n) % 6}" aria-hidden="true">${esc(initials(n))}</span>`;
  const shortDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  const ago = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  async function api(method, url, body, headers = {}) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  // Hosted events remembered in this browser
  const hosted = {
    all: () => store.get('samla:hosted', []),
    put(e) { const list = hosted.all().filter((x) => x.id !== e.id); list.unshift(e); store.set('samla:hosted', list.slice(0, 50)); },
    drop(id) { store.set('samla:hosted', hosted.all().filter((x) => x.id !== id)); },
  };

  // Resize big photos in the browser before upload
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('Please choose an image file.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1800;
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s);
        c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }

  function setupForm(form, ctx) {
    const input = $('#f-image', form);
    const drop = $('.drop', form);
    const prev = $('img', drop);
    const err = $('.err', form);
    let imageData = null, removeImage = false;

    async function useFile(f) {
      if (!f) return;
      err.textContent = '';
      try {
        imageData = await resizeImage(f);
        prev.src = imageData;
        drop.classList.add('has');
        removeImage = false;
      } catch (e) { err.textContent = e.message; }
    }
    input.addEventListener('change', () => useFile(input.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); useFile(e.dataTransfer.files[0]); });
    $('.remove-img', form).addEventListener('click', () => {
      imageData = null; removeImage = true; input.value = '';
      prev.removeAttribute('src'); drop.classList.remove('has');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const f = form.elements;
      const body = {
        title: f.title.value, date: f.date.value, time: f.time.value, endTime: f.endTime.value,
        place: f.place.value, description: f.description.value, hostName: f.hostName.value,
        showGuests: f.showGuests.checked,
      };
      if (imageData) body.image = imageData;
      else if (removeImage) body.removeImage = true;
      const btn = $('button[type=submit]', form);
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (form.dataset.mode === 'create') {
          const r = await api('POST', '/api/events', body);
          hosted.put({ id: r.id, key: r.hostKey, title: body.title, date: body.date });
          if (body.hostName) store.set('samla:name', body.hostName);
          location.href = `/h/${r.id}/${r.hostKey}`;
        } else {
          await api('PUT', `/api/events/${ctx.id}`, body, { 'X-Host-Key': ctx.key });
          hosted.put({ id: ctx.id, key: ctx.key, title: body.title, date: body.date });
          location.reload();
        }
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  // Light / dark switch (theme.js sets the starting value)
  $$('.theme-btn').forEach((b) => b.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* storage blocked */ }
  }));

  const page = document.body.dataset.page;

  // ---------- home ----------
  if (page === 'home') {
    const form = $('.ev-form');
    const hostField = form.elements.hostName;
    if (!hostField.value) hostField.value = store.get('samla:name', '');
    setupForm(form, {});
    const mineList = $('#mine');
    const pastBtn = $('#del-past');
    const dlg = $('#del-dialog');
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const isPast = (e) => e.date < today;
    let pending = [];

    function drawMine() {
      const list = hosted.all().slice().sort((a, b) => (isPast(a) - isPast(b)) || (isPast(a) ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));
      $('.mine').hidden = !list.length;
      const past = list.filter((e) => isPast(e) && !e.missing);
      pastBtn.hidden = !past.length;
      pastBtn.textContent = past.length === 1 ? 'Delete the past event' : `Delete all ${past.length} past events`;
      mineList.innerHTML = list.map((e) => e.missing
        ? `<li class="gone"><span class="d">${esc(shortDate(e.date))}</span><span><b>${esc(e.title)}</b><small>Not found on this server. It was deleted, or saved by an older copy of the app.</small></span><button class="link" type="button" data-forget="${esc(e.id)}">Remove</button></li>`
        : `<li class="${isPast(e) ? 'past' : ''}"><a href="/h/${encodeURIComponent(e.id)}/${encodeURIComponent(e.key)}"><span class="d">${esc(shortDate(e.date))}</span><b>${esc(e.title)}</b>${isPast(e) ? '<span class="tag-past">Past</span>' : ''}</a><button class="link danger" type="button" data-del="${esc(e.id)}" aria-label="Delete ${esc(e.title)}">Delete</button></li>`).join('');
      $$('[data-forget]', mineList).forEach((b) => b.addEventListener('click', () => { hosted.drop(b.dataset.forget); drawMine(); }));
      $$('[data-del]', mineList).forEach((b) => b.addEventListener('click', () => {
        const ev = hosted.all().find((x) => x.id === b.dataset.del);
        if (!ev) return;
        pending = [ev];
        $('#del-title').textContent = `Delete “${ev.title}”?`;
        $('#del-text').textContent = 'The event, its picture and all replies will be removed from the server. This can’t be undone.';
        dlg.showModal();
      }));
    }

    pastBtn.addEventListener('click', () => {
      pending = hosted.all().filter((e) => isPast(e) && !e.missing);
      if (!pending.length) return;
      $('#del-title').textContent = pending.length === 1 ? 'Delete the past event?' : `Delete ${pending.length} past events?`;
      $('#del-text').textContent = 'These events, their pictures and all replies will be removed from the server. This can’t be undone.';
      dlg.showModal();
    });

    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'delete' || !pending.length) return;
      const todo = pending; pending = [];
      for (const e of todo) {
        try {
          const r = await fetch(`/api/events/${encodeURIComponent(e.id)}`, { method: 'DELETE', headers: { 'X-Host-Key': e.key } });
          if (r.ok || r.status === 404) hosted.drop(e.id);
        } catch { /* keep it in the list so it can be tried again */ }
      }
      drawMine();
    });

    drawMine();
    // Check that each remembered event still exists, and pick up any edits to name or date
    Promise.all(hosted.all().map(async (e) => {
      try {
        const r = await fetch(`/api/events/${encodeURIComponent(e.id)}`, { headers: { 'X-Host-Key': e.key } });
        if (r.status === 404) return { ...e, missing: true };
        if (!r.ok) return e;
        const d = await r.json();
        return { ...e, title: d.title, date: d.date, missing: false };
      } catch { return e; }
    })).then((checked) => { store.set('samla:hosted', checked); drawMine(); });
  }

  // ---------- guest page ----------
  if (page === 'event') {
    const ev = JSON.parse($('#ev-data').textContent);
    const key = 'samla:rsvp:' + ev.id;
    let mine = store.get(key, null);
    const box = $('#rsvp');
    const guests = $('#guests');

    function drawGuests(data) {
      const n = data.counts.going;
      if (!n) { guests.hidden = true; return; }
      const names = data.going.map((g) => g.name);
      guests.innerHTML = `<h2>${n} going</h2>` + (names.length
        ? `<div class="faces">${names.slice(0, 14).map(avatar).join('')}</div><p class="names">${esc(names.join(', '))}</p>`
        : '');
      guests.hidden = false;
    }

    function draw(editing) {
      if (mine && !editing) {
        const going = mine.status === 'going';
        box.innerHTML = `<div class="answered ${going ? 'going' : 'no'}">
          <span class="badge">${going ? 'You’re going' : 'You can’t make it'}</span>
          <p>Thanks, ${esc(mine.name)}. ${going ? 'See you there.' : 'Your reply is saved.'}</p>
          <button class="link" type="button" id="change">Change my reply</button></div>`;
        $('#change').addEventListener('click', () => draw(true));
        return;
      }
      box.innerHTML = `<h2>Will you come?</h2>
        <label for="r-name">Your name</label>
        <input id="r-name" maxlength="60" autocomplete="name" placeholder="So the host knows who you are" value="${esc(mine?.name || store.get('samla:name', ''))}">
        <div class="choice"><button class="btn primary" type="button" data-s="going">Going</button><button class="btn ghost" type="button" data-s="no">Can’t go</button></div>
        <p class="err" role="alert"></p>`;
      $$('[data-s]', box).forEach((b) => b.addEventListener('click', () => send(b.dataset.s)));
    }

    async function send(status) {
      const nameEl = $('#r-name');
      const err = $('.err', box);
      const name = nameEl.value.trim();
      if (!name) { err.textContent = 'Write your name so the host knows who you are.'; nameEl.focus(); return; }
      const btns = $$('[data-s]', box);
      btns.forEach((b) => { b.disabled = true; });
      try {
        const r = await api('POST', `/api/events/${ev.id}/rsvp`, { name, status, token: mine?.token });
        mine = { token: r.token, name, status };
        store.set(key, mine);
        store.set('samla:name', name);
        draw(false);
        drawGuests(r.event);
      } catch (e) {
        err.textContent = e.message;
        btns.forEach((b) => { b.disabled = false; });
      }
    }

    draw(false);
    api('GET', `/api/events/${ev.id}`).then(drawGuests).catch(() => {});
  }

  // ---------- host page ----------
  if (page === 'host') {
    const ev = JSON.parse($('#ev-data').textContent);
    hosted.put({ id: ev.id, key: ev.key, title: ev.title, date: ev.date });
    const hdr = { 'X-Host-Key': ev.key };

    $$('[data-copy]').forEach((b) => {
      const orig = b.textContent;
      b.addEventListener('click', async () => {
        const inp = $(b.dataset.copy);
        try { await navigator.clipboard.writeText(inp.value); b.textContent = 'Copied'; }
        catch { inp.select(); b.textContent = 'Press Ctrl+C'; }
        setTimeout(() => { b.textContent = orig; }, 1800);
      });
    });
    const shareBtn = $('.native-share');
    if (navigator.share) {
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', () => navigator.share({ title: ev.title, url: $('#share-url').value }).catch(() => {}));
    }

    const people = (list) => list.length
      ? list.map((p) => `<li>${avatar(p.name)}<span class="nm">${esc(p.name)}</span><small>${esc(ago(p.at))}</small></li>`).join('')
      : '<li class="empty">No one yet</li>';
    async function load() {
      try {
        const d = await api('GET', `/api/events/${ev.id}`, null, hdr);
        $('#n-going').textContent = d.counts.going;
        $('#n-no').textContent = d.counts.no;
        $('#list-going').innerHTML = people(d.going);
        $('#list-no').innerHTML = people(d.no);
        $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '. Refreshes by itself.';
      } catch (e) { $('#updated').textContent = 'Could not load replies right now.'; }
    }
    load();
    setInterval(() => { if (!document.hidden) load(); }, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

    const edit = $('#edit');
    const editBtn = $('#edit-btn');
    editBtn.addEventListener('click', () => {
      edit.hidden = !edit.hidden;
      editBtn.setAttribute('aria-expanded', String(!edit.hidden));
      if (!edit.hidden) edit.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    setupForm($('.ev-form', edit), ev);

    const dlg = $('#del-dialog');
    $('#del-btn').addEventListener('click', () => dlg.showModal());
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'delete') return;
      try {
        await api('DELETE', `/api/events/${ev.id}`, null, hdr);
        hosted.drop(ev.id);
        location.href = '/';
      } catch (e) { $('#updated').textContent = e.message; }
    });
  }
}
