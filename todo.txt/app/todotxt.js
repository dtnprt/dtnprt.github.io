// todo.txt format: parsing and line manipulation.
// Pure functions, no DOM or platform APIs, so the same module can be reused by
// the terminal and desktop apps.
// Spec: ../description/README.md

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITY_RE = /^\(([A-Z])\) /;
const PRI_TAG_RE = /(?:^|\s)pri:[A-Z](?=\s|$)/;
const TAG_RE = /^([^\s:]+):([^\s:]+)$/;

// Sub-entries: one to four dashes and a space between the dates and the text
// (`(A) 2026-01-01 -- sub-sub`, `x 2026-01-02 2026-01-01 - sub`, `-- sub` without prefix). max `----`.
// Old files with the dashes in front of everything (`-- (A) text`) are still read and rewritten in the new form.
const LEVEL_RE = /^(-{1,4}) /;
const HEAD_RE = /^(?:x (?:\d{4}-\d{2}-\d{2} (?:\d{4}-\d{2}-\d{2} )?)?|(?:\([A-Z]\) )?(?:\d{4}-\d{2}-\d{2} )?)/;
export const MAX_LEVEL = 4;

/** Split a raw line into the head (`x`/priority/dates incl. trailing space), nesting level (0-4) and the text after it. */
export function splitParts(raw) {
  let lead = 0;
  let s = raw;
  const m = LEVEL_RE.exec(raw);
  if (m) { lead = m[1].length; s = raw.slice(m[0].length); }
  const head = HEAD_RE.exec(s)[0];
  const rest = s.slice(head.length);
  const m2 = LEVEL_RE.exec(rest);
  return m2 ? { head, level: m2[1].length, body: rest.slice(m2[0].length) } : { head, level: lead, body: rest };
}
export const levelOf = (raw) => splitParts(raw).level;
/** `'-- '` for level 2, `''` for level 0. */
export const levelPrefix = (n) => (n > 0 ? '-'.repeat(Math.min(MAX_LEVEL, n)) + ' ' : '');
/** The line at another nesting level (0 removes the dashes). */
export function withLevel(raw, n) {
  const p = splitParts(raw);
  return p.head + levelPrefix(n) + p.body;
}
/** Index of the last line that belongs to the sub-tree of line `i` (the lines below it with a deeper level). */
export function subtreeEnd(lines, i) {
  const lv = levelOf(lines[i]);
  let end = i;
  for (let j = i + 1; j < lines.length && levelOf(lines[j]) > lv; j++) end = j;
  return end;
}
/** For every line the index of the top-level line its group starts with (an orphaned sub-entry starts its own group). */
export function groupHeads(lines) {
  const heads = [];
  let head = 0;
  lines.forEach((l, i) => {
    if (i === 0 || levelOf(l) === 0) head = i;
    heads.push(head);
  });
  return heads;
}

/** Format a Date as YYYY-MM-DD in local time. */
export function isoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Parse one line into its parts.
 * `text` is the description with priority, `x` and dates removed.
 */
export function parse(raw) {
  const task = {
    raw,
    done: false,
    priority: null,
    completed: null,
    created: null,
    text: '',
    level: 0,
    projects: [],
    contexts: [],
    tags: {},
  };

  const { head, level, body } = splitParts(raw);
  task.level = level;
  const toks = head.split(' ').filter(Boolean);
  if (toks[0] === 'x') {
    task.done = true;
    toks.shift();
    task.completed = toks[0] || null;
    task.created = toks[1] || null;
  } else {
    if (toks[0] && toks[0][0] === '(') task.priority = toks.shift()[1];
    task.created = toks[0] || null;
  }
  const rest = body;
  task.text = rest;

  for (const word of rest.split(/\s+/)) {
    if (word.length > 1 && word[0] === '+') task.projects.push(word.slice(1));
    else if (word.length > 1 && word[0] === '@') task.contexts.push(word.slice(1));
    else {
      const m = TAG_RE.exec(word);
      if (m && !m[2].startsWith('//')) task.tags[m[1]] = m[2];
    }
  }
  // Completed tasks keep their priority in a pri:X tag.
  if (task.done && task.tags.pri && /^[A-Z]$/.test(task.tags.pri)) {
    task.priority = task.tags.pri;
  }
  return task;
}

/** Mark a task complete: `x DONE CREATED text [pri:X]`. */
export function complete(raw, today = isoDate()) {
  const t = parse(raw);
  if (t.done) return raw;
  let out = `x ${today} `;
  if (t.created) out += `${t.created} `;
  out += levelPrefix(t.level) + t.text;
  if (t.priority && !t.tags.pri) out += ` pri:${t.priority}`;
  return out;
}

/** Undo `complete`: restore priority from pri:X and drop the completion date. */
export function reopen(raw) {
  const t = parse(raw);
  if (!t.done) return raw;
  const text = t.text.replace(PRI_TAG_RE, '').trim();
  let out = '';
  if (t.priority) out += `(${t.priority}) `;
  if (t.created) out += `${t.created} `;
  return out + levelPrefix(t.level) + text;
}

/** Set (letter A-Z) or clear (null) the priority of an open task. */
export function setPriority(raw, priority) {
  const t = parse(raw);
  if (t.done) return raw;
  const head = splitParts(raw).head.replace(PRIORITY_RE, '');
  return (priority ? `(${priority}) ` : '') + head + levelPrefix(t.level) + t.text;
}

/** Prepend a creation date after the priority, unless one is present. */
export function withCreationDate(raw, today = isoDate()) {
  const t = parse(raw);
  if (t.done || t.created) return raw;
  return (t.priority ? `(${t.priority}) ` : '') + `${today} ${levelPrefix(t.level)}${t.text}`;
}

/** Days before the due date from which a task counts as 'soon' due. */
export const SOON_DAYS = 3;

/** 'overdue' | 'today' | 'soon' (within SOON_DAYS) | 'upcoming' | null for the task's due: date. */
export function dueStatus(task, today = isoDate()) {
  const due = task.tags.due;
  if (!due || !DATE_RE.test(due)) return null;
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  const days = Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  return days <= SOON_DAYS ? 'soon' : 'upcoming';
}

/** A lower-case priority letter at the very start, `(a) text`, becomes `(A) text`. */
export function fixPriorityCase(text) {
  return text.replace(/^(-{1,4} )?\(([a-z])\)/, (_, pre, c) => `${pre || ''}(${c.toUpperCase()})`);
}

/** All note names of a task (`note:NAME` words, without extension), in order: a task can have several notes. */
export function noteNames(task) {
  const out = [];
  for (const w of task.text.split(/\s+/)) {
    const m = /^note:([\w.-]+)$/.exec(w);
    if (m && !m[1].startsWith('.')) out.push(m[1]);
  }
  return out;
}

/** All pasted-image file names of a task (`image:FILE.png` words). */
export function imageNames(task) {
  const out = [];
  for (const w of task.text.split(/\s+/)) {
    const m = /^image:([\w.-]+\.(?:png|jpe?g|gif|webp|bmp))$/i.exec(w);
    if (m && !m[1].startsWith('.')) out.push(m[1]);
  }
  return out;
}

/** Name of the first note file of a task, or null. */
export function noteName(task) {
  return noteNames(task)[0] || null;
}

/** `Note-1`, `Note-2`, ... : the first name not in `used` (compared case-insensitively). */
export function nextNoteName(used) {
  const low = new Set([...used].map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) {
    const cand = `Note-${i}`;
    if (!low.has(cand.toLowerCase())) return cand;
  }
}

/** File-name-safe short name derived from a task description. */
export function slugify(text) {
  const s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[+@]\S+|\S+:\S+/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'note';
}

/** Split file contents into task lines (blank lines dropped). */
export function parseFile(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '');
}

export function serializeFile(lines) {
  return lines.length ? lines.join('\n') + '\n' : '';
}


// ---------- date expressions (for due:) ----------

function validDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/**
 * Resolve a typed date expression to a local Date (or null):
 *   2026-12-01, 01.12.2026, 1.12. / 1.12 (next occurrence, this or next year),
 *   today, tomorrow (heute, morgen, übermorgen), next week (+7 days),
 *   +3d, +3days, +2w, +2weeks, +1m, +1month.
 * With `bare: true` only unambiguous literal dates are accepted (ISO, dd.mm.yyyy, dd.mm.),
 * for dates that are not behind `due:` (so "1.5" or "+3d" are left alone).
 */
export function parseDateExpr(expr, today = new Date(), { bare = false } = {}) {
  const s = String(expr).trim().toLowerCase();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  m = (bare ? /^(\d{1,2})\.(\d{1,2})\.$/ : /^(\d{1,2})\.(\d{1,2})\.?$/).exec(s);
  if (m) {
    for (let k = 0; k < 5; k++) {          // next occurrence; skips Feb 29 in non-leap years
      const d = validDate(t0.getFullYear() + k, +m[2], +m[1]);
      if (d && d >= t0) return d;
    }
    return null;
  }
  if (bare) return null;

  const plus = (n) => new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + n);
  if (s === 'today' || s === 'heute') return plus(0);
  if (s === 'tomorrow' || s === 'morgen') return plus(1);
  if (s === 'übermorgen') return plus(2);
  if (/^next\s*week$/.test(s)) return plus(7);
  m = /^\+(\d+)\s*(d|days?|w|weeks?|m|mo|months?)$/.exec(s);
  if (m) {
    const n = +m[1];
    const unit = m[2][0] === 'w' ? 'w' : m[2][0] === 'd' ? 'd' : 'm';
    if (unit === 'd') return plus(n);
    if (unit === 'w') return plus(7 * n);
    return new Date(t0.getFullYear(), t0.getMonth() + n, t0.getDate());
  }
  return null;
}

/** Replace every `due:<expression>` that can be resolved with `due:YYYY-MM-DD`. */
export function normalizeDue(text, today = new Date()) {
  const re = /(^|\s)due:(next\s+week|\+\d+\s*(?:days?|d|weeks?|w|months?|mo|m)|\S+)(?=\s|$)/g;
  return text.replace(re, (all, pre, expr) => {
    const d = parseDateExpr(expr, today);
    return d ? `${pre}due:${isoDate(d)}` : all;
  });
}


// ---------- filter terms and moving tasks between files ----------

/**
 * Does a task match a filter expression like `+Home @phone (A) word`? Every term must match:
 * `+x` project, `@x` context, `(A)` priority, anything else a case-insensitive substring of the line.
 */
export function matchesTerms(raw, terms) {
  const t = parse(raw);
  const ci = (list, n) => list.some((x) => x.toLowerCase() === n.toLowerCase());
  return terms.every((term) => {
    if (term.length > 1 && term[0] === '+') return ci(t.projects, term.slice(1));
    if (term.length > 1 && term[0] === '@') return ci(t.contexts, term.slice(1));
    if (/^\([A-Za-z]\)$/.test(term)) return t.priority === term[1].toUpperCase();
    return raw.toLowerCase().includes(term.toLowerCase());
  });
}

/** Split an expression into terms (whitespace separated). */
export const filterTerms = (expr) => String(expr).split(/\s+/).filter(Boolean);

/**
 * Indices of the lines to move for a filter: every matching line together with its sub-entries.
 * Blank lines never match; they do not end a sub-tree.
 */
export function selectForMove(lines, terms) {
  const picked = new Set();
  if (!terms.length) return [];
  lines.forEach((l, i) => {
    if (!l.trim() || picked.has(i) || !matchesTerms(l, terms)) return;
    const lv = levelOf(l);
    picked.add(i);
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (levelOf(lines[j]) <= lv) break;
      picked.add(j);
    }
  });
  return [...picked].sort((a, b) => a - b);
}
