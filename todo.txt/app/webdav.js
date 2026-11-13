// WebDAV UI (desktop app): server list + login (Settings -> WebDAV) and the file browser overlay
// (choose / create files and folders on a server). The Rust side (src-tauri, cli/src/webdav.rs) does the
// HTTP and keeps the passwords in the OS keyring; this module never stores a password.
//
// A server is an entry `USER@URL` (todo.cfg key `webdav=["USER@URL"]`).

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const icon = (name) => el('i', { className: `fa-solid fa-${name}` });

export const isRemote = (p) => /^https?:\/\//i.test(p || '');

/** `USER@URL` -> {user, url} (url with trailing slash), or null. */
export function parseServer(entry) {
  const m = /^(.*?)@(https?:\/\/.*)$/i.exec((entry || '').trim());
  if (!m) return null;
  return { user: m[1], url: m[2].endsWith('/') ? m[2] : m[2] + '/' };
}

/** The configured entry whose base URL is a prefix of `url` (the longest wins). */
export function serverFor(entries, url) {
  const u = url.endsWith('/') ? url : url + '/';
  let best = null;
  for (const e of entries) {
    const s = parseServer(e);
    if (s && u.startsWith(s.url) && (!best || s.url.length > best.url.length)) best = { entry: e, ...s };
  }
  return best;
}

export const davName = (url) => decodeURIComponent(url.replace(/\/+$/, '').split('/').pop() || '');
export const davJoin = (base, name) => `${base.endsWith('/') ? base : base + '/'}${encodeURIComponent(name)}`;
export function davParent(url) {
  const t = url.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i > t.indexOf('://') + 2 ? t.slice(0, i + 1) : t + '/';
}

/**
 * ctx: { invoke, servers(): string[], setServers(list), canSaveHere(): bool,
 *        openUrl(url): Promise, saveAs(url): Promise, currentUrl(): string|null }
 */
export function createWebdav(ctx) {
  const say = (box, msg, bad = true) => { box.textContent = msg; box.className = 'dav-msg' + (bad ? ' bad' : ''); };

  // ---------------------------------------------------------- settings pane
  function renderPane(pane) {
    pane.replaceChildren();
    const msg = el('div', { className: 'dav-msg' });
    const list = el('div', { className: 'dav-servers' });
    const servers = ctx.servers();
    if (!servers.length) list.append(el('div', { className: 'side-empty' }, 'No WebDAV server yet.'));
    for (const entry of servers) {
      const s = parseServer(entry);
      const row = el('div', { className: 'dav-server' },
        icon('cloud'),
        el('span', { className: 'dav-url', title: entry }, el('b', {}, s ? s.user : '?'), ' @ ', s ? s.url : entry),
        el('button', { type: 'button', textContent: 'Browse…', onclick: () => { pane.closest('#settings').hidden = true; openBrowser(entry); } }),
        el('button', { type: 'button', className: 'danger', title: 'Remove server and delete its password from the keyring', onclick: async () => {
          if (!(await ctx.ui.confirm(`Remove ${entry}? The stored password is deleted from the keyring.`))) return;
          try { await ctx.invoke('webdav_logout', { entry }); } catch (e) { say(msg, String(e)); return; }
          ctx.setServers(ctx.servers().filter((x) => x !== entry));
          renderPane(pane);
        } }, icon('trash')));
      list.append(row);
      ctx.invoke('webdav_has_password', { entry }).then((ok) => {
        if (!ok) row.append(el('small', { className: 'bad', textContent: 'no password' }));
      }).catch(() => {});
    }
    const url = el('input', { type: 'url', placeholder: 'https://cloud.example.com/remote.php/dav/files/alice/', spellcheck: false });
    const user = el('input', { type: 'text', placeholder: 'User name', autocomplete: 'username', spellcheck: false });
    const pass = el('input', { type: 'password', placeholder: 'Password (stored in the OS keyring)', autocomplete: 'current-password' });
    const go = el('button', { type: 'submit', className: 'primary', textContent: 'Log in and add' });
    const form = el('form', { className: 'dav-form', autocomplete: 'off' },
      el('h3', {}, 'Add server'),
      el('label', {}, 'Folder URL', url), el('label', {}, 'User', user), el('label', {}, 'Password', pass),
      el('div', { className: 'dav-row' }, go));
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const entry = `${user.value.trim()}@${url.value.trim()}`;
      const s = parseServer(entry);
      if (!s || !user.value.trim()) return say(msg, 'Enter the folder URL (https://…), the user name and the password.');
      go.disabled = true;
      say(msg, 'Connecting…', false);
      try {
        await ctx.invoke('webdav_login', { entry: `${s.user}@${s.url}`, password: pass.value });
        const e = `${s.user}@${s.url}`;
        if (!ctx.servers().includes(e)) ctx.setServers([...ctx.servers(), e]);
        pass.value = '';
        renderPane(pane);
      } catch (err) { say(msg, String(err)); } finally { go.disabled = false; }
    };
    const cache = el('input', { type: 'checkbox', checked: ctx.cacheOn() !== false });
    cache.onchange = () => ctx.setCache(cache.checked);
    const cacheRow = el('label', { className: 'set-check', title: 'Saves go to ~/.todo.txt/cache/webdav first and are synced in the background; changes on the server are noticed within seconds' },
      cache, ' Fast local cache (~/.todo.txt/cache/webdav, synced in the background)');
    pane.append(cacheRow);
    pane.append(el('p', { className: 'set-hint' }, 'Todo files can live on a WebDAV server (Nextcloud, ownCloud, …). Passwords are kept in the OS keyring, never in a file.'),
      list, form, msg);
  }

  // ---------------------------------------------------------- browser overlay
  function openBrowser(startEntry) {
    if (document.getElementById('davDlg')) return;
    const servers = ctx.servers();
    if (!servers.length) return ctx.ui.alert('Add a WebDAV server first (Settings → WebDAV).');
    const cur = ctx.currentUrl();
    const hit = cur ? serverFor(servers, cur) : null;
    let entry = startEntry || (hit ? hit.entry : servers[0]);
    let url = (cur && hit && hit.entry === entry) ? davParent(cur) : parseServer(entry).url;

    const sel = el('select', { title: 'Server' }, ...servers.map((e) => el('option', { value: e, textContent: e, selected: e === entry })));
    const crumb = el('div', { className: 'dav-crumb' });
    const up = el('button', { type: 'button', className: 'icon', title: 'Up', 'aria-label': 'Up' }, icon('arrow-up'));
    const body = el('div', { className: 'dav-list', role: 'list' });
    const msg = el('div', { className: 'dav-msg' });
    const name = el('input', { type: 'text', placeholder: 'name (e.g. todo.txt)', spellcheck: false });
    const bNew = el('button', { type: 'button', title: 'Create an empty todo file here and open it' }, icon('file-circle-plus'), ' New file');
    const bDir = el('button', { type: 'button', title: 'Create a folder here' }, icon('folder-plus'), ' New folder');
    const bSave = el('button', { type: 'button', title: 'Write the open list to this folder under that name' }, icon('cloud-arrow-up'), ' Save list here');
    const bFolder = el('button', { type: 'button', title: 'Use this server folder as the todo folder (all its .txt files, notes in notes/)' }, icon('folder-open'), ' Use as folder');
    const close = () => ov.remove();

    const load = async () => {
      crumb.textContent = url;
      up.disabled = url === parseServer(entry).url || !url.startsWith(parseServer(entry).url);
      body.replaceChildren(el('div', { className: 'side-empty' }, 'Loading…'));
      try {
        const items = await ctx.invoke('webdav_list', { entry, url });
        body.replaceChildren();
        const shown = items.filter((i) => i.is_dir || /\.txt$/i.test(i.name));
        for (const it of shown) {
          const b = el('button', { type: 'button', className: 'dav-item' }, icon(it.is_dir ? 'folder' : 'file-lines'), ' ', it.name);
          b.onclick = async () => {
            if (it.is_dir) { url = it.url; load(); return; }
            try { await ctx.openUrl(it.url); close(); } catch (e) { say(msg, String(e)); }
          };
          body.append(b);
        }
        if (!shown.length) body.append(el('div', { className: 'side-empty' }, 'No folders or .txt files here.'));
        say(msg, '', false);
      } catch (e) { body.replaceChildren(); say(msg, String(e)); }
    };
    const fileUrl = () => {
      let n = name.value.trim();
      if (!n || /[\\/]/.test(n)) { say(msg, 'Enter a file name without slashes.'); name.focus(); return null; }
      if (!/\.[A-Za-z0-9]+$/.test(n)) n += '.txt';
      return davJoin(url, n);
    };
    bNew.onclick = async () => {
      const u = fileUrl();
      if (!u) return;
      try {
        const have = await ctx.invoke('webdav_get', { entry, url: u });
        if (!have.missing) { if (!(await ctx.ui.confirm(`${name.value} exists already. Open it?`))) return; }
        else await ctx.invoke('webdav_put', { entry, url: u, text: '', etag: null });
        await ctx.openUrl(u);
        close();
      } catch (e) { say(msg, String(e)); }
    };
    bSave.onclick = async () => {
      const u = fileUrl();
      if (!u) return;
      try {
        const have = await ctx.invoke('webdav_get', { entry, url: u });
        if (!have.missing && !(await ctx.ui.confirm(`${name.value} exists on the server. Overwrite it with the open list?`))) return;
        await ctx.saveAs(u);
        close();
      } catch (e) { say(msg, String(e)); }
    };
    bSave.disabled = !ctx.canSaveHere();
    bFolder.onclick = async () => {
      try { await ctx.openFolderUrl(url); close(); } catch (e) { if (String(e.message || e) !== 'cancelled') say(msg, String(e)); }
    };
    bDir.onclick = async () => {
      const n = name.value.trim();
      if (!n || /[\\/]/.test(n)) { say(msg, 'Enter a folder name without slashes.'); name.focus(); return; }
      try { await ctx.invoke('webdav_mkcol', { entry, url: davJoin(url, n) + '/' }); name.value = ''; load(); } catch (e) { say(msg, String(e)); }
    };
    up.onclick = () => { url = davParent(url); load(); };
    sel.onchange = () => { entry = sel.value; url = parseServer(entry).url; load(); };

    const ov = el('div', { id: 'davDlg', className: 'help' },
      el('div', { className: 'help-box dav-box', role: 'dialog', 'aria-label': 'WebDAV' },
        el('div', { className: 'set-head' }, el('h2', {}, icon('cloud'), ' WebDAV'),
          el('button', { type: 'button', className: 'icon', title: 'Close (Esc)', 'aria-label': 'Close', onclick: close }, icon('xmark'))),
        el('div', { className: 'dav-top' }, sel, up, crumb),
        body, msg,
        el('div', { className: 'dav-foot' }, name, bNew, bDir, bSave, bFolder)));
    ov.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    document.body.append(ov);
    load();
    name.focus();
  }

  return { renderPane, openBrowser };
}
