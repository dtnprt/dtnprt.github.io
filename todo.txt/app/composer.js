// The bottom input: one field for adding tasks and searching.
//  - syntax highlighting (overlay behind a transparent-text input)
//  - autocomplete for +tags and @contexts, and a date picker for `due:`
import * as T from './todotxt.js';
import { buildCalendar } from './calendar.js';

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const icon = (name) => el('i', { className: `fa-solid fa-${name}` });

const MAX_ITEMS = 8;


// ---------- undo / redo for text fields ----------
// Setting input.value from code (word removal, suggestion picks, ...) wipes the browser's own
// undo stack, so text fields keep their own: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo.

const histories = new WeakMap();
const MAX_HISTORY = 200;
const snap = (input) => ({
  v: input.value,
  s: input.selectionStart ?? input.value.length,
  e: input.selectionEnd ?? input.value.length,
});

/** Forget the history (e.g. after the field was cleared or switched to other content). */
export function resetHistory(input) {
  const h = histories.get(input);
  if (h) { h.stack = [snap(input)]; h.i = 0; h.t = 0; }
}

/** Record the current state as a new undo step (drops any redo steps). */
export function record(input) {
  const h = histories.get(input);
  if (!h) return;
  h.stack.length = h.i + 1;
  h.stack.push(snap(input));
  if (h.stack.length > MAX_HISTORY) h.stack.shift();
  h.i = h.stack.length - 1;
  h.t = 0;
}

/** Call before changing input.value from code: remembers the caret so undo restores it too. */
export function checkpoint(input) {
  const h = histories.get(input);
  if (!h) return;
  const top = h.stack[h.i];
  if (top.v !== input.value) record(input);
  else { top.s = input.selectionStart ?? top.s; top.e = input.selectionEnd ?? top.e; }
}

export function attachHistory(input) {
  if (histories.has(input)) return;
  const h = { stack: [snap(input)], i: 0, t: 0, applying: false };
  histories.set(input, h);

  input.addEventListener('input', (e) => {
    if (h.applying) return;
    // Native typing is merged into one step while it continues; anything else is its own step.
    const typing = /^(insertText|insertCompositionText|deleteContent(Backward|Forward))$/.test(e.inputType || '');
    const now = Date.now();
    if (typing && h.t && now - h.t < 800 && h.i === h.stack.length - 1 && h.i > 0) h.stack[h.i] = snap(input);
    else record(input);
    h.t = typing ? now : 0;
  });

  input.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const redo = (k === 'z' && e.shiftKey) || k === 'y';
    const undo = k === 'z' && !e.shiftKey;
    if (!undo && !redo) return;
    e.preventDefault();
    const target = h.i + (undo ? -1 : 1);
    if (target < 0 || target >= h.stack.length) return;
    h.i = target;
    const st = h.stack[h.i];
    input.value = st.v;
    input.setSelectionRange(st.s, st.e);
    h.applying = true;                       // let listeners (highlight, search, popups) update without re-recording
    input.dispatchEvent(new Event('input', { bubbles: true }));
    h.applying = false;
    h.t = 0;
  });
}

/**
 * Ctrl+Backspace / Ctrl+Delete: remove the whole word under (or next to) the caret.
 * For a +tag or @context only the name is cleared, leaving the bare "+" / "@" so a new
 * name can be entered right away (a second press removes the marker).
 * Returns 'project' | 'context' | 'removed', or null if the key was not handled.
 */
export function deleteWord(e, input) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  const dir = e.key === 'Backspace' ? -1 : e.key === 'Delete' ? 1 : 0;
  if (!dir || input.selectionStart !== input.selectionEnd) return null;
  const v = input.value;
  const isSpace = (k) => /\s/.test(v[k]);
  let i = dir < 0 ? input.selectionStart - 1 : input.selectionStart;
  if (dir < 0) { while (i >= 0 && isSpace(i)) i--; if (i < 0) return null; }
  else { while (i < v.length && isSpace(i)) i++; if (i >= v.length) return null; }
  let start = i;
  let end = i + 1;
  while (start > 0 && !isSpace(start - 1)) start--;
  while (end < v.length && !isSpace(end)) end++;
  const token = v.slice(start, end);

  e.preventDefault();
  checkpoint(input);
  let from = start;
  let to = end;
  let keep = '';
  let result = 'removed';
  if (token.length > 1 && /^[+@]/.test(token)) {
    keep = token[0];
    result = keep === '+' ? 'project' : 'context';
  } else {
    let k = end;
    while (k < v.length && isSpace(k)) k++;
    if (k > end) to = k;                                   // also drop the following spaces
    else while (from > 0 && isSpace(from - 1)) from--;     // last word: drop the preceding spaces
  }
  input.value = v.slice(0, from) + keep + v.slice(to);
  const caret = from + keep.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return result;
}

// ---------- syntax highlighting (shared with the task edit field) ----------

/** Colour-coded spans for priority, done marker, dates, +tags, @contexts, due and key:value words. */
export function highlight(text) {
  const frag = document.createDocumentFragment();
  // sub-entry prefix `- ` .. `---- ` (same width as typed, only coloured)
  const lm = /^(-{1,4}) /.exec(text);
  if (lm) {
    frag.append(el('span', { className: 'tk-date', textContent: lm[1] }), ' ');
    text = text.slice(lm[0].length);
  }
  // `code` spans (may contain spaces): colour only, so the overlay keeps the input's font metrics
  text.split(/(`[^`\n]+`)/).forEach((seg, k) => {
    if (k % 2) frag.append(el('span', { className: 'tk-code', textContent: seg }));
    else if (seg) highlightWords(frag, seg, k === 0);
  });
  return frag;
}

function highlightWords(frag, text, atStart) {
  text.split(/(\s+)/).forEach((p, idx, parts) => {
    if (!p) return;
    const nextIsSpace = /^\s/.test(parts[1] || '');
    let cls = '';
    if (!atStart) idx = 1;
    if (idx === 0 && /^\([A-Z]\)$/.test(p) && nextIsSpace) cls = `tk-pri tk-p${p[1]}`;
    else if (idx === 0 && /^\([A-Za-z]?\)?$/.test(p)) cls = `tk-pri tk-p${p[1] ? p[1].toUpperCase() : ''}`; // priority being typed
    else if (idx === 0 && p === 'x' && nextIsSpace) cls = 'tk-done';
    else if (/^\d{4}-\d{2}-\d{2}$/.test(p) || /^\d{1,2}\.\d{1,2}\.(?:\d{4})?$/.test(p)) cls = 'tk-date';
    else if (/^\+\S/.test(p)) cls = 'tk-project';
    else if (/^@\S/.test(p)) cls = 'tk-context';
    else if (p === 'due' || p.startsWith('due:')) cls = 'tk-due';
    else if (/^[^\s:]+:[^\s:]+$/.test(p) && !p.includes('://')) cls = 'tk-meta';
    frag.append(cls ? el('span', { className: cls, textContent: p }) : p);
  });
}

/**
 * Wrap a text input in a highlighting overlay. Append `.el` where the input should go.
 * Call `.sync()` after changing `input.value` from code.
 */
export function attachHighlight(input) {
  const wrap = el('div', { className: 'field edit-field' });
  const hl = el('div', { className: 'hl' });
  hl.setAttribute('aria-hidden', 'true');
  wrap.append(hl, input);
  attachHistory(input);
  attachAutoDate(input);
  attachPriorityCase(input);
  const sync = () => {
    hl.replaceChildren(highlight(input.value));
    hl.scrollLeft = input.scrollLeft;
  };
  for (const ev of ['input', 'scroll', 'keyup', 'click', 'focus']) input.addEventListener(ev, sync);
  sync();
  return { el: wrap, sync };
}

/** Multi-line variant of attachHighlight for a textarea (note editor): same colours, follows the theme. */
export function attachNoteHighlight(ta) {
  const wrap = el('div', { className: 'note-field' });
  const hl = el('div', { className: 'hl' });
  hl.setAttribute('aria-hidden', 'true');
  wrap.append(hl, ta);
  const sync = () => {
    hl.replaceChildren(highlight(ta.value + '\n'));
    hl.scrollTop = ta.scrollTop;
  };
  for (const ev of ['input', 'scroll', 'keyup', 'click', 'focus']) ta.addEventListener(ev, sync);
  sync();
  return { el: wrap, sync };
}

/** Call `open(input)` when the user has just typed the word `note:` (caret right behind it). */
export function attachNoteTrigger(input, open) {
  input.addEventListener('input', (e) => {
    if (e.inputType !== 'insertText' || e.data !== ':') return;
    const caret = input.selectionStart ?? 0;
    const before = input.value.slice(0, caret);
    if (!/(^|\s)note:$/.test(before)) return;
    if (/^\S/.test(input.value.slice(caret))) return;
    open(input);
  });
}

/**
 * Tolerant parse of a partially typed date ("2026", "2026-1", "2026-12-0").
 * Returns the parts understood so far; `date` is set only when all three are valid.
 */
function parsePartialDate(s) {
  const m = /^(\d{0,4})(?:-(\d{0,2})(?:-(\d{0,2}))?)?$/.exec(s);
  if (!m) return {};
  const year = m[1].length === 4 && +m[1] >= 1000 ? +m[1] : null;
  const month = m[2] && +m[2] >= 1 && +m[2] <= 12 ? +m[2] - 1 : null;
  let day = null;
  let date = null;
  if (m[3] && +m[3] >= 1) {
    day = +m[3];
    if (year !== null && month !== null) {
      const d = new Date(year, month, day);
      date = d.getMonth() === month ? d : null; // rejects day 31 in a 30-day month
    }
  }
  return { year, month, day, date };
}

/** The whitespace-delimited word around the caret. */
export function wordAt(input) {
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const start = v.slice(0, caret).search(/\S*$/);
  const end = caret + /^\S*/.exec(v.slice(caret))[0].length;
  return { start, end, word: v.slice(start, end) };
}

/**
 * Should the calendar show for this word? Returns {selected, year, month} (year/month = what the
 * typed text points at so far) or null. Triggers: `due`, `due:<anything>`, and bare dates
 * (2026-12-01, 01.12.2026, 01.12.) outside the leading "x" / priority / creation-date prefix.
 */
export function dateAssist(value, start, word, today = new Date()) {
  if (word === 'due' || word.startsWith('due:')) {
    const expr = word.slice(4);
    const d = T.parseDateExpr(expr, today);
    if (d) return { selected: d, year: d.getFullYear(), month: d.getMonth() };
    const p = parsePartialDate(expr);
    return { selected: p.date || null, year: p.year ?? null, month: p.month ?? null };
  }
  const prefix = /^(?:x |\([A-Z]\) )?(?:\d{4}-\d{2}-\d{2} ){0,2}/.exec(value)[0].length;
  if (start >= prefix) {
    const d = T.parseDateExpr(word, today, { bare: true });
    if (d) return { selected: d, year: d.getFullYear(), month: d.getMonth() };
  }
  return null;
}

/** Replace [start, end) with `text` (+ a space) as one undoable step; caret goes after it. */
export function replaceWordAt(input, start, end, text) {
  checkpoint(input);
  const v = input.value;
  const after = v.slice(end);
  const pad = /^\s/.test(after) ? '' : ' ';
  input.value = v.slice(0, start) + text + pad + after;
  const caret = start + text.length + 1;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/** Typing a space after `due:tomorrow`, `due:15.03.`, `due:+3days`, ... turns it into `due:YYYY-MM-DD`. */
/** Typing a lower-case priority at the start, `(a)`, turns it into `(A)`. */
export function attachPriorityCase(input) {
  input.addEventListener('input', () => {
    const v = input.value;
    const fixed = T.fixPriorityCase(v);
    if (fixed === v) return;
    const s = input.selectionStart, e = input.selectionEnd;
    input.value = fixed;
    input.setSelectionRange(s, e);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function attachAutoDate(input) {
  input.addEventListener('input', (e) => {
    if (e.inputType !== 'insertText' || !/^\s$/.test(e.data || '')) return;
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const fixed = T.normalizeDue(before);
    if (fixed === before) return;
    input.value = fixed + input.value.slice(caret);
    input.setSelectionRange(fixed.length, fixed.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));   // recorded as its own undo step
  });
}

/**
 * @param {object} o
 * @param {HTMLFormElement} o.form        wrapper; gets class "search" in search mode
 * @param {HTMLInputElement} o.input
 * @param {HTMLElement} o.hl              highlight overlay
 * @param {HTMLElement} o.ac              popup container
 * @param {HTMLElement} o.modeBtn         icon button toggling the mode
 * @param {(kind:'project'|'context') => [string, number][]} o.getWords  existing tags/contexts
 * @param {(text:string) => void} o.onAdd
 * @param {(text:string) => void} o.onSearch
 * @param {() => boolean} [o.calendarEnabled]  whether typing `due` opens the date picker
 */
export function createComposer({ form, input, hl, ac, modeBtn, getWords, onAdd, onSearch, onNote, calendarEnabled = () => true }) {
  attachHistory(input);
  attachAutoDate(input);
  attachPriorityCase(input);
  if (onNote) attachNoteTrigger(input, onNote);
  let mode = 'add';
  let addDraft = '';
  let searchText = '';
  let assist = null;      // {kind:'list', start,end, items, index} | {kind:'cal', start,end, month, selected}
  let dismissed = null;   // `${start}:${word}` of a popup closed with Esc
  let calMonth = null;

  // ---------- highlighting ----------

  function syncOverlay() {
    hl.replaceChildren(highlight(input.value));
    hl.scrollLeft = input.scrollLeft;
  }

  // ---------- current word under the caret ----------

  function currentWord() {
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const start = before.search(/\S*$/);
    const end = caret + (/^\S*/.exec(v.slice(caret))[0].length);
    return { start, end, word: v.slice(start, end) };
  }

  function replaceWord(start, end, text) {
    checkpoint(input);
    const v = input.value;
    const after = v.slice(end);
    const pad = /^\s/.test(after) ? '' : ' ';
    input.value = v.slice(0, start) + text + pad + after;
    const caret = start + text.length + 1;
    input.setSelectionRange(caret, caret);
    record(input);
    changed();
    input.focus();
  }

  // ---------- popup ----------

  /** Open the popup above the input if it fits there, otherwise below it. */
  function place() {
    ac.classList.remove('below');
    ac.style.maxHeight = '';
    const box = ac.parentElement.getBoundingClientRect();
    const topbar = document.querySelector('.topbar');
    const status = document.querySelector('.status');
    const margin = 10;
    const spaceAbove = box.top - (topbar ? topbar.getBoundingClientRect().bottom : 0) - margin;
    const spaceBelow = (status ? status.getBoundingClientRect().top : window.innerHeight) - box.bottom - margin;
    const h = ac.offsetHeight;
    if (h <= spaceAbove) return;
    const below = h <= spaceBelow || spaceBelow > spaceAbove;
    if (below) ac.classList.add('below');
    const room = below ? spaceBelow : spaceAbove;
    if (h > room) ac.style.maxHeight = `${Math.max(room, 80)}px`;
  }

  function closeAssist() {
    assist = null;
    ac.hidden = true;
    ac.replaceChildren();
  }

  function updateAssist() {
    if (document.activeElement !== input) return closeAssist();
    const { start, end, word } = currentWord();
    const key = `${start}:${word}`;
    if (dismissed && dismissed !== key) dismissed = null;
    if (dismissed === key) return closeAssist();

    if (/^[+@]/.test(word) || (word[0] === '(' && start === 0)) {
      const kind = word[0] === '+' ? 'project' : word[0] === '@' ? 'context' : 'priority';
      const prefix = (kind === 'priority' ? word.slice(1).replace(/\)$/, '') : word.slice(1)).toLowerCase();
      const items = getWords(kind)
        .filter(([name]) => name.toLowerCase().startsWith(prefix))
        .map(([name, count]) => (kind === 'priority'
          ? { value: `(${name})`, count, cls: `tk-p${name}` }
          : { value: word[0] + name, count }))
        .filter((it) => it.value !== word)
        .slice(0, MAX_ITEMS);
      if (!items.length) return closeAssist();
      const prev = assist && assist.kind === 'list' ? assist : null;
      assist = { kind: 'list', start, end, items, index: prev ? Math.min(prev.index, items.length - 1) : 0 };
      return drawList();
    }

    const hit = calendarEnabled() ? dateAssist(input.value, start, word) : null;
    if (hit) {
      // Follow the date while it is typed: year, then month, then day (also 15.03. / tomorrow / +3d).
      if (!calMonth) calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      if (hit.year != null || hit.month != null) {
        calMonth = new Date(hit.year ?? calMonth.getFullYear(), hit.month ?? calMonth.getMonth(), 1);
      }
      assist = { kind: 'cal', start, end, selected: hit.selected || null };
      return drawCalendar();
    }

    calMonth = null;
    closeAssist();
  }

  function drawList() {
    ac.className = 'ac list';
    ac.hidden = false;
    ac.replaceChildren(...assist.items.map((it, i) =>
      el('button', {
        type: 'button',
        className: 'ac-item' + (i === assist.index ? ' sel' : ''),
        onclick: () => accept(i),
      }, el('span', { className: it.cls || '', textContent: it.value }), el('span', { className: 'n', textContent: it.count }))));
    place();
  }

  function accept(i) {
    const a = assist;
    if (!a || a.kind !== 'list') return;
    replaceWord(a.start, a.end, a.items[i].value);
  }

  function pickDate(d) {
    const a = assist;
    if (!a || a.kind !== 'cal') return;
    calMonth = null;
    replaceWord(a.start, a.end, `due:${T.isoDate(d)}`);
  }

  function drawCalendar() {
    ac.className = 'ac cal';
    ac.hidden = false;
    ac.replaceChildren(buildCalendar({
      month: calMonth,
      selected: assist.selected,
      onPick: pickDate,
      onMonth: (first) => { calMonth = first; drawCalendar(); },
    }));
    place();
  }

  // Keep focus in the input when clicking inside the popup.
  ac.onmousedown = (e) => e.preventDefault();

  // ---------- input handling ----------

  function changed() {
    // A leading "/" in add mode switches to search mode (the "/" itself is dropped).
    if (mode === 'add' && input.value.startsWith('/')) {
      searchText = input.value.slice(1);
      input.value = '';
      addDraft = '';
      setMode('search');
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (mode === 'search') {
      searchText = input.value;
      onSearch(searchText);
    } else {
      addDraft = input.value;
    }
    syncOverlay();
    updateAssist();
  }

  input.addEventListener('input', changed);
  input.addEventListener('focus', () => { syncOverlay(); updateAssist(); });
  input.addEventListener('blur', closeAssist);
  input.addEventListener('click', updateAssist);
  input.addEventListener('scroll', () => { hl.scrollLeft = input.scrollLeft; });
  input.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateAssist();
    hl.scrollLeft = input.scrollLeft;
  });

  input.addEventListener('keydown', (e) => {
    const wasDismissed = dismissed;
    dismissed = null;                      // let the tag/context menu open right after clearing a name
    if (deleteWord(e, input)) return;
    dismissed = wasDismissed;
    if (assist && assist.kind === 'list') {
      const n = assist.items.length;
      if (e.key === 'ArrowDown') { assist.index = (assist.index + 1) % n; drawList(); return e.preventDefault(); }
      if (e.key === 'ArrowUp') { assist.index = (assist.index - 1 + n) % n; drawList(); return e.preventDefault(); }
      if (e.key === 'Enter' || e.key === 'Tab') { accept(assist.index); return e.preventDefault(); }
    }
    if (e.key === 'Escape') {
      if (assist) {
        const { start, word } = currentWord();
        dismissed = `${start}:${word}`;
        closeAssist();
      } else if (mode === 'search') {
        setMode('add');
      }
      e.preventDefault();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (mode !== 'add') return;
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    resetHistory(input);
    addDraft = '';
    calMonth = null;
    syncOverlay();
    closeAssist();
    onAdd(v);
  });

  // ---------- modes ----------

  function setMode(next, { focus = true } = {}) {
    if (mode === 'add') addDraft = input.value; else searchText = input.value;
    mode = next;
    input.value = mode === 'add' ? addDraft : searchText;
    resetHistory(input);
    form.classList.toggle('search', mode === 'search');
    modeBtn.replaceChildren(icon(mode === 'add' ? 'plus' : 'magnifying-glass'));
    modeBtn.title = mode === 'add'
      ? 'Adding tasks. Click or press / to search'
      : 'Searching. Click or press Esc to add tasks';
    input.placeholder = mode === 'add'
      ? ''
      : 'Search tasks…   (Esc to go back to adding)';
    input.setAttribute('aria-label', mode === 'add' ? 'New task' : 'Search tasks');
    closeAssist();
    syncOverlay();
    if (focus) input.focus();
  }

  modeBtn.addEventListener('click', () => setMode(mode === 'add' ? 'search' : 'add'));
  setMode('add', { focus: false });

  return {
    get mode() { return mode; },
    /** Text currently typed in the add bar (also while the search mode is active). */
    get addText() { return mode === 'add' ? input.value : addDraft; },
    setMode,
    /** Reset the search text (e.g. after loading another file). */
    clearSearch() {
      searchText = '';
      if (mode === 'search') { input.value = ''; syncOverlay(); }
      onSearch('');
    },
  };
}
