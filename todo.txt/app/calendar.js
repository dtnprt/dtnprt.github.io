// Month calendar used by the add/search bar and the task edit helper.
import * as T from './todotxt.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Parse YYYY-MM-DD into a local Date, or null if it is not a real date. */
export function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return T.isoDate(d) === s ? d : null;
}

/**
 * Build the calendar DOM (header, day grid, quick buttons).
 * @param {object} o
 * @param {Date} o.month            any date in the month to show
 * @param {Date|null} o.selected    highlighted day
 * @param {(d: Date) => void} o.onPick
 * @param {(firstOfMonth: Date) => void} o.onMonth   called for prev/next; caller re-renders
 */
export function buildCalendar({ month, selected, onPick, onMonth }) {
  const y = month.getFullYear();
  const m = month.getMonth();
  const today = T.isoDate();
  const sel = selected ? T.isoDate(selected) : null;
  const chevron = (name) => el('i', { className: `fa-solid fa-${name}` });

  const head = el('div', { className: 'cal-head' },
    el('button', { type: 'button', title: 'Previous month', onclick: () => onMonth(new Date(y, m - 1, 1)) }, chevron('chevron-left')),
    el('span', { textContent: `${MONTHS[m]} ${y}` }),
    el('button', { type: 'button', title: 'Next month', onclick: () => onMonth(new Date(y, m + 1, 1)) }, chevron('chevron-right')));

  const grid = el('div', { className: 'cal-grid' });
  WEEKDAYS.forEach((w) => grid.append(el('span', { className: 'dow', textContent: w })));
  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
  for (let i = 0; i < offset; i++) grid.append(el('span'));
  const days = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const date = new Date(y, m, d);
    const iso = T.isoDate(date);
    const cls = ['day', iso === today && 'today', iso === sel && 'sel'].filter(Boolean).join(' ');
    grid.append(el('button', { type: 'button', className: cls, textContent: d, onclick: () => onPick(date) }));
  }

  const now = new Date();
  const quick = el('div', { className: 'cal-quick' },
    el('button', { type: 'button', textContent: 'Today', onclick: () => onPick(now) }),
    el('button', { type: 'button', textContent: 'Tomorrow', onclick: () => onPick(addDays(now, 1)) }),
    el('button', { type: 'button', textContent: 'Next week', onclick: () => onPick(addDays(now, 7)) }));

  const frag = document.createDocumentFragment();
  frag.append(head, grid, quick);
  return frag;
}
