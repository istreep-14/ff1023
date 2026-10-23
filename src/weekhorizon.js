/**
 * The window a projection number is answering: this week, the rest of the
 * season, or the full season (scored + rest of season).
 *
 * Used twice, unchanged: Node imports it, and the dashboard has its text
 * inlined at build time (see renderHtml), so the page parses and labels a
 * window with the code the tests run. No imports here for that reason.
 *
 * There used to be twenty-odd windows — "next 3 weeks", "playoffs 15–17", and
 * every week 1–18 on its own. Both remaining sources publish the current week
 * and a rest-of-season figure and nothing in between, so every one of those
 * windows rendered a page of blanks. The projection windows are the three
 * that have data; the game-log windows read points already scored, which every
 * player row carries for every played week.
 *
 * Encoded as a short key so it can live in localStorage and the URL:
 *   ovw     overview: rest of season, with this week's projection beside it
 *   w-7     week 7 (only ever the current week)
 *   ros     rest of season (now through 18)
 *   szn     full season (1 through 18)
 *   l3, l5  game log: the last 3 / 5 completed weeks
 *   std     game log: every completed week so far
 *
 * Any other key — an old bookmark's `n-3` or `p`, a past week — reads as the
 * current week rather than as an empty window.
 */

/** The last regular-season week. Everything that needs it imports it from here. */
export const LAST_WEEK = 18;

export function parseHorizon(raw, { now = 1, lastWeek = LAST_WEEK } = {}) {
  const cur = clampWeek(now, lastWeek);
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'ovw') return { kind: 'overview', from: cur, to: lastWeek, key: 'ovw' };
  const log = LOG_WINDOWS[s];
  if (log) {
    // Completed weeks only; in week 1 nothing has been played, so the window is empty (to < from).
    const to = cur - 1;
    return { kind: 'log', n: log.n, from: log.n ? Math.max(1, to - log.n + 1) : 1, to, key: s };
  }
  if (s === 'ros') return { kind: 'ros', from: cur, to: lastWeek, key: 'ros' };
  if (s === 'szn' || s === 'season') return { kind: 'season', from: 1, to: lastWeek, key: 'szn' };
  return { kind: 'week', from: cur, to: cur, key: `w-${cur}` };
}

/** Game-log windows: how many completed weeks each reads (0 = all of them). */
export const LOG_WINDOWS = { l3: { n: 3, label: 'Last 3 weeks' }, l5: { n: 5, label: 'Last 5 weeks' }, std: { n: 0, label: 'Season to date' } };

export function labelHorizon(horizon, { now = 1 } = {}) {
  if (!horizon) return '—';
  if (horizon.kind === 'overview') return 'Overview';
  if (horizon.kind === 'log') {
    const base = LOG_WINDOWS[horizon.key]?.label || 'Game log';
    return horizon.to >= horizon.from ? `${base} (wk ${horizon.from}–${horizon.to})` : base;
  }
  if (horizon.kind === 'ros') return now > 1 ? `Rest of season (wk ${horizon.from}–${horizon.to})` : 'Rest of season';
  if (horizon.kind === 'season') return 'Full season';
  return `Week ${horizon.from}`;
}

/** Dropdown options for a given "now". */
export function horizonOptions({ now = 1, lastWeek = LAST_WEEK } = {}) {
  const cur = clampWeek(now, lastWeek);
  const opts = [
    { value: 'ovw', label: 'Overview', group: 'Projections' },
    { value: `w-${cur}`, label: `Week ${cur} (this week)`, group: 'Projections' },
    { value: 'ros', label: 'Rest of season', group: 'Projections' },
    { value: 'szn', label: 'Full season', group: 'Projections' },
  ];
  // No game log before a week has been played.
  if (cur > 1) for (const [value, w] of Object.entries(LOG_WINDOWS)) opts.push({ value, label: w.label, group: 'Game log' });
  return opts;
}

function clampWeek(w, lastWeek) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 1;
  return Math.min(lastWeek, Math.max(1, Math.round(n)));
}
