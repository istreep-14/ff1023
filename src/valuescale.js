/**
 * The sources a player is valued from, and how to read one: the "agreed"
 * week and rest-of-season numbers every player table shows, and League Value.
 *
 * Few sites, one vote each. Only FantasyPros and Draft Sharks are INPUTS
 * (`input: true`); a site with two signals splits its vote between them
 * (`vsSignals`). ESPN, FanDuel and FantasyGuys' ROS ranks, which Dynasty
 * Daddy carries, are shown beside them for comparison and go into nothing.
 *
 *   week  FantasyPros' expert consensus (ECR) rank and its projections model
 *         — two different products, half a vote each — and Draft Sharks'
 *         week projection.
 *   ROS   FantasyPros once: its ROS points are the points its ROS rankings
 *         board implies (it publishes no ROS projections model), so points
 *         and rank are one opinion — on 2026-10-21 the two orders never
 *         disagreed in the top 40 at any position. Draft Sharks' ROS
 *         projection and its 3D Value, half a vote each: 3D Value is Draft
 *         Sharks' own ROS judgement (injury risk, role), not a scarcity
 *         formula over a consensus — it sat ~1.3 position spots from its ROS
 *         projection's order in the top 24 (up to 9), against ~2.5 between
 *         the two sites.
 *
 * Market trade values (Dynasty Daddy's boards, FantasyPros' trade market) are
 * not sources: each is a price someone has already shaped for their own idea
 * of a league, several lagged by days.
 *
 * A source's `kind` says what its number is: `points` (higher is better),
 * `value` (a 0–100 scale, higher is better) or `rank` (lower is better).
 * `vsRaw` is the number as published; `vsScore` turns it so that higher is
 * always better, which is what ordering reads. `points` sources set the
 * points curve. A ROS points source also has a `rate`, its per-game number:
 * games left differ by player (a bye still to come), so the ROS curve is per
 * game and each player's agreed points are that rate times `vsGames` — his
 * team's games left, one count for every source.
 *
 * `feed` is the Sources tab that holds the number (`sourcefeeds.js`
 * FEED_SITES site id + feed key). `role` is `input` (votes), `compare`
 * (shown, never counted) or `display` (a published number tables already
 * show that must not vote — FantasyPros' merged week points, its
 * rankings-implied week points).
 *
 * Used twice, unchanged: the tests import it, and the page has its text
 * inlined (see renderHtml). No imports, and every name carries a `vs` prefix
 * so it cannot collide with the page's own.
 */

export const VS_SOURCES = [
  { id: 'fp:ros', group: 'fp', input: true, role: 'input', feed: { site: 'fp', key: 'ros' }, label: 'FantasyPros ROS (rankings-implied points)', short: 'FantasyPros', kind: 'points', points: true, raw: (r) => r.ros ?? null, rate: (r) => r.rosPg ?? null },
  { id: 'ds:ros', group: 'ds', input: true, role: 'input', feed: { site: 'draftsharks', key: 'ros' }, label: 'Draft Sharks ROS projection', short: 'DS proj', kind: 'points', points: true, raw: (r) => r.ds?.ros ?? null, rate: (r) => r.ds?.rosW ?? null },
  { id: 'ds:3d', group: 'ds', input: true, role: 'input', feed: { site: 'draftsharks', key: 'value' }, label: 'Draft Sharks 3D Value', short: 'DS 3D', kind: 'value', raw: (r) => r.ds?.val ?? null },
  { id: 'espn:ros', group: 'other', input: false, role: 'compare', feed: { site: 'dd', key: 'players' }, label: 'ESPN ROS rank', short: 'ESPN', kind: 'rank', raw: (r) => r.dd?.r?.[0] ?? null },
  { id: 'fd:ros', group: 'other', input: false, role: 'compare', feed: { site: 'dd', key: 'players' }, label: 'FanDuel ROS rank', short: 'FanDuel', kind: 'rank', raw: (r) => r.dd?.r?.[1] ?? null },
  { id: 'fg:ros', group: 'other', input: false, role: 'compare', feed: { site: 'dd', key: 'players' }, label: 'FantasyGuys ROS rank', short: 'FantasyGuys', kind: 'rank', raw: (r) => r.dd?.r?.[2] ?? null },
];

/** This week. A player on bye has no Draft Sharks number rather than a 0. */
export const VS_WEEK_SOURCES = [
  { id: 'fp:ecr', group: 'fp', input: true, role: 'input', feed: { site: 'fp', key: 'week' }, label: 'FantasyPros week rank (ECR)', short: 'FP ECR', kind: 'rank', raw: (r) => r.rk ?? null },
  { id: 'fp:proj', group: 'fp', input: true, role: 'input', feed: { site: 'fp', key: 'proj' }, label: 'FantasyPros week projection', short: 'FP proj', kind: 'points', points: true, raw: (r) => r.wkP ?? null },
  { id: 'ds:wk', group: 'ds', input: true, role: 'input', feed: { site: 'draftsharks', key: 'week' }, label: 'Draft Sharks week projection', short: 'DS proj', kind: 'points', points: true, raw: (r) => (r.ds && !r.ds.bye ? r.ds.wk ?? null : null) },
];

/**
 * Published week numbers tables already show that are not a second FantasyPros
 * vote. `fp:week` is the merged "as published" cell (projections model, else
 * rankings-implied) the FantasyPros column uses; `fp:expert` is the rankings
 * board's implied points, on the Sources week-rankings tab.
 */
export const VS_DISPLAY = [
  { id: 'fp:week', group: 'fp', input: false, role: 'display', feed: { site: 'fp', key: 'proj' }, label: 'FantasyPros week points (proj, else expert)', short: 'FP week', kind: 'points', points: true, raw: (r) => r.wk ?? null },
  { id: 'fp:expert', group: 'fp', input: false, role: 'display', feed: { site: 'fp', key: 'week' }, label: 'FantasyPros week rankings-implied points', short: 'FP expert', kind: 'points', points: true, raw: (r) => r.wkX ?? null },
];

/**
 * The input sources as League Value signals: higher-is-better scores, one
 * vote per site, split evenly among that site's signals.
 */
export function vsSignals(sources) {
  const inputs = sources.filter((s) => s.input);
  const perSite = {};
  for (const s of inputs) perSite[s.group] = (perSite[s.group] || 0) + 1;
  return inputs.map((s) => ({
    id: s.id, label: s.label, points: !!s.points, weight: 1 / perSite[s.group],
    score: (r) => vsScore(r, s), rate: s.rate ? (r) => vsRate(r, s) : null,
  }));
}

/** A ROS points source's per-game number for a player, or null. */
export function vsRate(row, src) {
  if (!row || !src?.rate) return null;
  const v = src.rate(row);
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** The games a player's team has left this season, bye removed: what a per-game rate is multiplied by. */
export const vsGames = (row) => (row?.rosG == null ? null : Number(row.rosG));

/** The sources a pool of slim rows can answer for: one nobody in it is covered by is left out rather than shown as a column of dashes. */
export function vsSources(pool, sources = VS_SOURCES) {
  return sources.filter((s) => (pool || []).some((r) => vsRaw(r, s) != null));
}

/** The source's own number for a player, as it published it: points, a 0–100 value, or a rank. */
export function vsRaw(row, src) {
  if (!row || !src) return null;
  const v = src.raw(row);
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** The same opinion, higher-is-better: what a within-position order is read from. */
export function vsScore(row, src) {
  const v = vsRaw(row, src);
  return v == null ? null : src.kind === 'rank' ? -v : v;
}
