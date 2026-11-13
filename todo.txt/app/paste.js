// Pasting several lines into the add bar: analyse them and let the user decide how they are added.
// Pure helpers (pasteLines, classify, entryItems, noteSplit) + the panel that grows above the input.
import * as T from './todotxt.js';
import { highlight } from './composer.js';

const DASH_RE = /^-{1,4} /;
// A line that is recognisably a todo.txt entry: priority, done marker + date, creation date, or a sub-entry dash.
const ENTRY_RE = /^(?:\([A-Z]\) |x \d{4}-\d{2}-\d{2} |\d{4}-\d{2}-\d{2} |-{1,4} )/;

/** Non-empty lines of pasted text (line ends of any kind, trailing blanks removed). */
export function pasteLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
}

/**
 * 'single' (0-1 lines) | 'tree' (first line + only dash lines below: an entry with sub-entries) |
 * 'entries' (every line looks like an entry) | 'plain' (anything else).
 */
export function classify(lines) {
  if (lines.length < 2) return 'single';
  const t = lines.map((l) => l.trim());
  if (!DASH_RE.test(t[0]) && t.slice(1).every((l) => DASH_RE.test(l))) return 'tree';
  if (t.every((l) => ENTRY_RE.test(l))) return 'entries';
  return 'plain';
}

/** Every line as an entry: {level, text}; the dashes (`- `, `-- `, also the form behind the dates) give the level. */
export function entryItems(lines) {
  return lines.map((l) => {
    const t = l.trim();
    return { level: T.levelOf(t), text: T.withLevel(t, 0) };
  });
}

/** First line as the entry, all other lines (as pasted, indentation kept) as the text of its note. */
export function noteSplit(lines) {
  return { first: entryItems([lines[0]])[0], note: lines.slice(1).join('\n') + '\n' };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * Show the paste panel above the input (inside `host`, the composer box). The panel grows upwards.
 *   onEntries(items)        add every line as an entry (items: {level, text})
 *   onNote(first, noteText) add the first line as an entry and the rest as a note
 *   onClose()               the panel is gone (any way)
 */
export function openPastePanel({ host, lines, onEntries, onNote, onClose }) {
  host.querySelector('.paste-panel')?.remove();
  const kind = classify(lines);
  const items = entryItems(lines);
  const panel = el('div', 'paste-panel');
  panel.setAttribute('role', 'dialog');
  panel.append(el('div', 'paste-title', `${lines.length} lines pasted`));

  const prev = el('div', 'paste-prev');
  items.forEach((it, i) => {
    const row = el('div', 'paste-row');
    row.style.paddingLeft = `${it.level * 20}px`;
    row.append(highlight(kind === 'plain' ? lines[i].trim() : it.text));
    prev.append(row);
  });
  panel.append(prev);

  const question = {
    tree: `The first line has ${lines.length - 1} sub-entries below it. Add it with its sub-entries, or as one entry with the rest as a note?`,
    entries: `All ${lines.length} lines look like entries. Add them as they are, or as one entry with the rest as a note?`,
    plain: 'Add every line as its own entry, or the first line as an entry and the rest as its note?',
  }[kind];
  panel.append(el('div', 'paste-q', question));

  const close = () => { panel.remove(); if (onClose) onClose(); };
  const btn = (label, cls, fn) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = fn;
    return b;
  };
  const bar = el('div', 'paste-actions');
  const label = kind === 'tree' ? `Entry with ${lines.length - 1} sub-entries` : kind === 'entries' ? `Add ${lines.length} entries` : 'Each line as an entry';
  const first = btn(label, 'primary', () => { panel.remove(); onEntries(items); if (onClose) onClose(); });
  bar.append(first,
    btn('First line as entry, rest as note', '', () => { panel.remove(); const s = noteSplit(lines); onNote(s.first, s.note); if (onClose) onClose(); }),
    btn('Cancel', '', close));
  panel.append(bar);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  host.append(panel);
  first.focus();
  return panel;
}
