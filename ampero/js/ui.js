// Overlays (instead of confirm()/prompt()) and context menus.

const $ = (id) => document.getElementById(id);

/**
 * Show an overlay element until close(result) is called. Only the dialog's buttons (and Esc = Cancel)
 * close it – a click outside the box does nothing, so a half-typed name is not lost.
 */
function modal(overlay, focus, cancelValue) {
  return new Promise((resolve) => {
    const onKey = (e) => {
      if (e.key === 'Escape') close(cancelValue);
    };
    const close = (result) => {
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    document.addEventListener('keydown', onKey);
    overlay.hidden = false;
    focus?.focus();
    modal.close = close;
  });
}

/**
 * Confirmation with a table of slots: rows = [{slot, now, next}] ("now" -> "next").
 * Returns true if confirmed.
 */
export function confirmSlots({ title, text, rows, ok, columns = ['Slot', 'Now on the pedal', '', 'New'] }) {
  $('dlgTitle').textContent = title;
  $('dlgText').textContent = text;
  const head = $('dlgHead');
  head.innerHTML = '';
  for (const c of columns) head.insertCell().outerHTML = `<th>${c}</th>`;
  const tb = $('dlgRows');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = tb.insertRow();
    tr.className = r.now === r.next ? 'same' : '';
    tr.innerHTML = '<td></td><td class="old"></td><td class="arrow">→</td><td class="new"></td>';
    tr.cells[0].textContent = r.slot;
    tr.cells[1].textContent = r.now;
    tr.cells[3].textContent = r.next;
  }
  document.querySelector('#dialog .dlg-table').hidden = !rows.length;
  $('dlgOk').textContent = ok;
  const p = modal($('dialog'), $('dlgCancel'), false);
  $('dlgOk').onclick = () => modal.close(true);
  $('dlgCancel').onclick = () => modal.close(false);
  return p;
}

/** Text input dialog. validate(text) returns an error message or ''. Returns the text or null. */
export function promptText({ title, text, value = '', maxLength = 64, ok = 'OK', validate = () => '' }) {
  $('promptTitle').textContent = title;
  $('promptText').textContent = text;
  const input = $('promptInput');
  input.value = value;
  input.maxLength = maxLength;
  const err = $('promptError');
  const check = () => {
    const msg = validate(input.value);
    err.textContent = msg;
    $('promptOk').disabled = !!msg;
    return !msg;
  };
  input.oninput = check;
  check();
  $('promptOk').textContent = ok;
  const p = modal($('promptDialog'), input, null);
  input.select();
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && check()) modal.close(input.value);
  };
  $('promptOk').onclick = () => check() && modal.close(input.value);
  $('promptCancel').onclick = () => modal.close(null);
  return p;
}

// ------------------------------------------------------------------ context menu

let openMenu = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Show a context menu at (x, y). items: [{label, action, disabled, title, items (submenu), checked}] or '-'.
 */
export function contextMenu(x, y, items) {
  closeMenu();
  const root = build(items);
  document.body.appendChild(root);
  // keep it inside the window
  const r = root.getBoundingClientRect();
  root.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  root.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  openMenu = root;
}

function build(items) {
  const ul = document.createElement('ul');
  ul.className = 'ctx-menu';
  for (const it of items) {
    const li = document.createElement('li');
    if (it === '-') {
      li.className = 'sep';
      ul.appendChild(li);
      continue;
    }
    li.textContent = it.label;
    if (it.title) li.title = it.title;
    if (it.checked) li.classList.add('checked');
    if (it.disabled) li.classList.add('disabled');
    if (it.items) {
      li.classList.add('sub');
      const sub = build(it.items);
      li.appendChild(sub);
      li.onmouseenter = () => {
        // open the submenu to the left if there is no room on the right, move it up if it would leave the window
        sub.classList.toggle('left', li.getBoundingClientRect().right + 180 > window.innerWidth);
        sub.style.top = '-5px';
        requestAnimationFrame(() => {
          const over = sub.getBoundingClientRect().bottom - window.innerHeight + 4;
          if (over > 0) sub.style.top = `${-5 - over}px`;
        });
      };
    } else if (!it.disabled) {
      li.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        it.action();
      };
    }
    ul.appendChild(li);
  }
  return ul;
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);
