import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FPDIR } from './config.js';
import { pointsIndex, draftsharksIndex, dsFind } from './enrich.js';
import { loadActualsIndex, formatPoints } from './actuals.js';
import { SOURCE_ORDER } from './sourcetables.js';

/**
 * How each source's stored projection for a PLAYED week compares with what the
 * player actually scored.
 *
 * The point is to weigh sources against outcomes before weighting them in a
 * consensus: a source that reads well but runs 0.7 points low on average, or one
 * whose error is twice another's, is worth knowing before it gets an equal vote.
 *
 * What "the projection" is matters, and is a limit of the data rather than of
 * this code: nothing here archives a projection at kickoff. Each sync overwrites
 * that week's file, so what is compared is the LAST snapshot of that week, which
 * for a played week may have been pulled after some games had started. A source
 * that rewrote its numbers to results would show suspiciously little error; none
 * of the week-1 numbers do (correlations of 0.5–0.7, near-zero bias), which is
 * why they are treated as real projections. See the `note` in the result.
 *
 * Actuals are Sleeper's published fantasy points for that week (every player
 * who played), with the FantasyPros API's per-week figure filling a week the
 * stat file does not have.
 *
 * Each source is scored on the players IT covers (a broad source is not
 * penalised for a narrow one's easy universe) and also on the subset every
 * source covers, the only apples-to-apples comparison.
 */

/** n, mean absolute error, bias (projection minus actual, so positive = runs high), RMSE and correlation. */
export function accuracyStats(pairs) {
  const rows = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = rows.length;
  if (!n) return null;
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / n;
  const ma = mean(([a]) => a), mb = mean(([, b]) => b);
  const cov = rows.reduce((s, [a, b]) => s + (a - ma) * (b - mb), 0);
  const va = rows.reduce((s, [a]) => s + (a - ma) ** 2, 0);
  const vb = rows.reduce((s, [, b]) => s + (b - mb) ** 2, 0);
  const r2 = (x) => Number(x.toFixed(2));
  return {
    n,
    mae: r2(mean(([a, b]) => Math.abs(a - b))),
    bias: r2(mean(([a, b]) => a - b)),
    rmse: r2(Math.sqrt(mean(([a, b]) => (a - b) ** 2))),
    corr: va > 0 && vb > 0 ? Number((cov / Math.sqrt(va * vb)).toFixed(3)) : null,
  };
}

function fpWeekBoard(season, week, scoring) {
  const dir = join(FPDIR, String(season), `week-${week}`, 'rankings', String(scoring).toLowerCase());
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    for (const p of JSON.parse(readFileSync(join(dir, f), 'utf8')).players || []) {
      if (p.r2p_pts != null && p.r2p_pts !== '') out.set(p.player_id, Number(p.r2p_pts));
    }
  }
  return out;
}

/**
 * Per source, fpId -> that source's projection for one week. Same joins the
 * Sources tables use (name+position) so the two agree on who is who.
 */
function weekProjections({ season, week, scoring, pool, ds }) {
  const cell = (weeks, w) => weeks?.[w] ?? weeks?.[String(w)] ?? null;
  const fp = fpWeekBoard(season, week, scoring);

  const out = Object.fromEntries(SOURCE_ORDER.map((s) => [s, new Map()]));
  for (const r of pool) {
    const put = (src, v) => { if (v != null && Number.isFinite(Number(v))) out[src].set(r.i, Number(v)); };
    put('fp', fp.get(r.i));
    put('draftsharks', cell(dsFind(ds, { name: r.n, position: r.p, team: r.t })?.weeks, week)?.proj);
  }
  return out;
}

/**
 * One scoring format's backtest across every completed week (1 .. week-1).
 * Returns null when no week has finished or no actuals are stored.
 *
 * Draft Sharks is only fetched for the current week going forward (see
 * draftsharks.js), so a past week's board here is whatever was captured
 * WHILE it was the live week — the sync never deletes it, only stops
 * refreshing it once the week has passed. That is exactly the archive this
 * backtest needs; nothing here re-fetches anything.
 */
export function buildAccuracy({ season, week, scoring, pool }) {
  const played = [];
  for (let w = 1; w < week; w++) played.push(w);
  if (!played.length) return null;

  const points = pointsIndex(join(FPDIR, String(season)), scoring);
  const weekly = loadActualsIndex(season);
  const sleeperOf = new Map((pool || []).filter((r) => r.s).map((r) => [Number(r.i), String(r.s)]));
  const ds = draftsharksIndex(season, scoring);
  const actualAt = (id, w) => {
    const sid = sleeperOf.get(Number(id));
    const byWeek = sid ? weekly.get(sid) : null;
    const cell = byWeek?.[w] ?? byWeek?.[String(w)];
    const fromStats = formatPoints(cell, scoring);
    if (fromStats != null) return fromStats;
    const fp = points.get(Number(id));
    const v = fp?.weeks?.[w] ?? fp?.weeks?.[String(w)];
    return v == null || v === '' ? null : Number(v);
  };

  // source -> [[projection, actual, key]] pooled over the played weeks
  const pairs = Object.fromEntries(SOURCE_ORDER.map((s) => [s, []]));
  const weeksWithActuals = [];
  for (const w of played) {
    const proj = weekProjections({ season, week: w, scoring, pool, ds });
    let any = false;
    for (const src of SOURCE_ORDER) {
      for (const [id, v] of proj[src]) {
        const actual = actualAt(id, w);
        if (actual == null) continue;
        pairs[src].push([v, Number(actual), `${w}:${id}`]);
        any = true;
      }
    }
    if (any) weeksWithActuals.push(w);
  }
  if (!weeksWithActuals.length) return null;

  const sources = {};
  for (const src of SOURCE_ORDER) sources[src] = accuracyStats(pairs[src]);

  // The subset every source that has any data covers, keyed player-week.
  const live = SOURCE_ORDER.filter((s) => pairs[s].length);
  const sets = live.map((s) => new Set(pairs[s].map((r) => r[2])));
  const shared = sets.length ? [...sets[0]].filter((k) => sets.every((st) => st.has(k))) : [];
  const sharedSet = new Set(shared);
  const common = { n: shared.length, sources: {} };
  for (const src of live) common.sources[src] = accuracyStats(pairs[src].filter((r) => sharedSet.has(r[2])));

  return {
    weeks: weeksWithActuals,
    sources,
    common,
    note: 'Compared against the last snapshot each source’s sync stored for the week, not a kickoff-time archive — a played week may have been pulled after some games started. Actuals are Sleeper’s published points for that week, for every player who played.',
  };
}
