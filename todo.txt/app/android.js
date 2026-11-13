// Android specifics (the Tauri app on a phone). Nothing here runs on the desktop or in a browser.
//  - storage locations: private app storage, device storage and SD card(s) (Kotlin `StorageBridge`, no permissions needed)
//  - "Files" overlay: list / open / create / move between storages / delete the .txt files
//  - the Android back button closes overlays (history entries), instead of leaving the app

export const isAndroid = !!(window.__TAURI__ && /Android/i.test(navigator.userAgent));

/** [{id, label, path, removable}] – app storage first. */
export function storageDirs() {
  try {
    const b = window.TodoAndroid;
    if (b && b.storageDirs) {
      const a = JSON.parse(b.storageDirs());
      if (Array.isArray(a) && a.length) return a;
    }
  } catch { /* fall through */ }
  return [];
}

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

/** Which storage a path belongs to (longest matching directory). */
export function storageOf(path, dirs = storageDirs()) {
  const p = (path || '').replace(/\\/g, '/');
  let best = null;
  for (const d of dirs) {
    const base = d.path.replace(/\/+$/, '');
    if (p.startsWith(base + '/') && (!best || base.length > best.path.length)) best = d;
  }
  return best;
}

const join = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;
const baseName = (p) => p.replace(/\\/g, '/').split('/').pop();

/**
 * Files overlay.
 * deps: { invoke, state, switchFile(path), createFile(path) -> opens a new empty list, onGone(path), confirmDiscard }
 */
export function openFiles(deps, { focusNew = false } = {}) {
  if (document.getElementById('filesDlg')) return;
  const dirs = storageDirs();
  const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const list = el('div', { className: 'files-list' });
  const msg = el('div', { className: 'set-hint' });
  let newDir = dirs[0] ? dirs[0].path : '';

  const say = (t) => { msg.textContent = t || ''; };

  async function refresh() {
    list.replaceChildren();
    for (const d of dirs) {
      let names = [];
      try { names = await deps.invoke('list_txt_files', { dir: d.path }); } catch { /* empty / missing */ }
      list.append(el('h3', { className: 'files-head' },
        el('i', { className: 'fa-solid ' + (d.removable ? 'fa-sd-card' : d.id === 'app' ? 'fa-lock' : 'fa-mobile-screen') }), ' ' + d.label));
      if (!names.length) list.append(el('div', { className: 'side-empty', textContent: 'No .txt files' }));
      for (const name of names) {
        const path = join(d.path, name);
        const cur = path === deps.state.path;
        const row = el('div', { className: 'files-row' + (cur ? ' cur' : '') });
        row.append(el('button', { className: 'files-open', title: path, onclick: async () => { close(); await deps.switchFile(path); } },
          el('i', { className: 'fa-solid ' + (cur ? 'fa-check' : 'fa-file-lines') }), ' ' + name));
        const others = dirs.filter((x) => x.path !== d.path);
        if (others.length) {
          row.append(el('button', { className: 'files-act', title: 'Move to another storage', onclick: () => moveMenu(path, name, others) },
            el('i', { className: 'fa-solid fa-right-left' })));
        }
        row.append(el('button', { className: 'files-act danger', title: 'Delete', onclick: () => del(path, name) },
          el('i', { className: 'fa-solid fa-trash' })));
        list.append(row);
      }
    }
  }

  function moveMenu(path, name, others) {
    const dlg = el('div', { className: 'files-pick' }, el('div', {}, `Move ${name} to:`),
      ...others.map((o) => el('button', { onclick: async () => { dlg.remove(); await move(path, name, o); } }, o.label)),
      el('button', { onclick: () => dlg.remove() }, 'Cancel'));
    box.append(dlg);
  }

  async function move(path, name, to) {
    const dest = join(to.path, name);
    try {
      const wasCurrent = path === deps.state.path;
      if (wasCurrent && !(await deps.confirmDiscard())) return;
      await deps.invoke('move_file', { from: path, to: dest });
      say(`Moved ${name} to ${to.label}.`);
      deps.onMoved(path, dest, wasCurrent);
    } catch (e) { say(`Could not move: ${e.message || e}`); }
    await refresh();
  }

  async function del(path, name) {
    if (!(await deps.ui.confirm(`Delete ${name}? This cannot be undone.`))) return;
    try {
      await deps.invoke('delete_file', { path });
      deps.onGone(path);
    } catch (e) { say(`Could not delete: ${e.message || e}`); }
    await refresh();
  }

  const nameInput = el('input', { type: 'text', placeholder: 'New list name (e.g. shopping)', autocapitalize: 'none', spellcheck: false });
  const where = el('select', {}, ...dirs.map((d) => el('option', { value: d.path, textContent: d.label })));
  where.onchange = () => { newDir = where.value; };
  const create = async () => {
    let n = nameInput.value.trim().replace(/[\\/:*?"<>|]+/g, '-');
    if (!n) return say('Enter a name.');
    if (!/\.txt$/i.test(n)) n += '.txt';
    if (n.startsWith('.')) return say('The name must not start with a dot.');
    const path = join(newDir || dirs[0].path, n);
    try {
      await deps.invoke('list_txt_files', { dir: newDir });
    } catch { /* folder not readable: createFile reports it */ }
    try {
      await deps.createFile(path);
      close();
    } catch (e) { say(`Could not create: ${e.message || e}`); }
  };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };

  const box = el('div', { className: 'help-box set-box files-box', role: 'dialog', 'aria-label': 'Files' },
    el('div', { className: 'set-head' }, el('h2', { textContent: 'Lists' }),
      el('button', { type: 'button', className: 'icon', 'aria-label': 'Close', onclick: close }, el('i', { className: 'fa-solid fa-xmark' }))),
    el('div', { className: 'files-new' }, nameInput, where, el('button', { type: 'button', className: 'primary', onclick: create }, 'Create')),
    msg, list);
  const ov = el('div', { id: 'filesDlg', className: 'help', onmousedown: (e) => { if (e.target === ov) close(); } }, box);
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  refresh();
  if (focusNew) nameInput.focus();
}

/** The Android back button closes the topmost overlay instead of leaving the app. */
export function initBackButton() {
  let depth = 0;
  let internal = 0;
  const open = () => document.querySelectorAll('.help:not([hidden])').length;
  const sync = () => {
    const n = open();
    while (depth < n) { history.pushState({ overlay: true }, ''); depth++; }
    while (depth > n) { depth--; internal++; history.back(); }
  };
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('popstate', () => {
    if (internal > 0) { internal--; return; }
    if (depth > 0) {
      depth--;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
  });
}
