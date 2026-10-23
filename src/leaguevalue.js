/**
 * League Value: one number per player, priced for ONE league's size, lineup
 * and bench — the only place in the app where sources are combined.
 *
 * Why not average the sources' values: every value source prices players
 * against its own assumed league (12 teams, 1QB, a flex, its own bench) and
 * its own curve. Scaling each by its top player fixes the units, not
 * the assumptions — a source built for 1QB still says a QB is worth little in
 * a superflex league. So the sources are used only for what they agree on
 * regardless of league: the ORDER of players within a position. The league
 * itself then sets the price:
 *
 *   1. Order. Every signal — a rest-of-season projection or an expert ROS
 *      rank (valuescale.js) — ranks the players it covers within each
 *      position. Trade values are deliberately not signals: each is already
 *      a price for someone else's league, which is the thing this file
 *      computes for this one. A player a deep source
 *      leaves out is ranked just past its last player, at half weight — being
 *      absent from an 80-deep RB board is evidence. With four or more ranks,
 *      the best and worst are dropped. The weighted mean is the consensus
 *      position rank.
 *   2. Points. The projection sources' rest-of-season totals, in this
 *      league's scoring format, sorted per position, give the points the k-th
 *      best player at a position scores. The consensus k-th player gets those.
 *      With `games` (rest of season), the curve is PER GAME instead — each
 *      projection is read by its per-game rate (`rate`), ranked and curved on
 *      that — and the k-th player's points are that rate times HIS OWN games
 *      left. A total curve handed RB12 the twelfth-best total whether or not
 *      his bye was still to come, so a player with 11 games left got the
 *      points of one with 12, and the agreed ROS points simply mirrored the
 *      rank. Replacement is then a per-game rate too, and value is (rate −
 *      replacement) × games: a bye week is a week the replacement plays.
 *      The position rank shown is then re-read off the totals (and, in
 *      lvValues, off the value), so a rank never sits beside a smaller number
 *      than the rank after it.
 *   3. Replacement. Every team's lineup is filled league-wide (fixed slots,
 *      then flex from narrowest to widest, by points — so a superflex slot
 *      takes quarterbacks when they outscore the alternatives). How deep each
 *      position is ROSTERED is read off the league's real rosters when the
 *      caller passes them; otherwise benches are shared out by starters,
 *      weighted by how much depth a position needs (plain proportion to
 *      starters gave a 16-team 1QB league 32 rostered QBs; it holds 30, and
 *      the RB room was 4 short). Replacement sits halfway between the last
 *      starter and the first player past that depth — see
 *      LV_REPLACEMENT_BLEND for why not either end.
 *   4. Value = points over replacement, rest of season, floored at 0. `index`
 *      is the same on 0–100, where 100 is this league's most valuable player.
 *
 * K and DST are left out: their replacement level is the waiver wire every
 * week.
 *
 * Used twice, unchanged: Node imports it for the tests, and the page has its
 * text inlined (see renderHtml). No imports here — the caller passes signals
 * as functions — and every name carries an `lv` prefix.
 */

export const LV_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * Where replacement sits between the league's worst starter (1) and its best
 * free agent (0) at a position.
 *
 * Waiver level alone (0) prices a deep, scarce position as if losing a player
 * meant starting the waiver wire — but a superflex team that loses its second
 * QB starts a receiver in that slot, not a backup QB. Measured (2026-10-20):
 * against waiver level, a 12-team superflex league whose rosters hold 39 QBs
 * put replacement at a backup's 8 points and ranked Jared Goff over Jahmyr
 * Gibbs. Last starter alone (1) gives bench depth no value at all. Halfway
 * puts Gibbs and Allen one-two in that league, where the superflex markets
 * have them.
 */
export const LV_REPLACEMENT_BLEND = 0.5;

/** Within-position ranks for one signal: id -> rank, plus how deep it goes at each position. */
function lvSignalRanks(players, signal, positions = LV_POSITIONS) {
  const ranks = new Map(), depth = {};
  for (const pos of positions) {
    const scored = players.filter((p) => p.pos === pos).map((p) => ({ id: p.id, v: lvRead(signal, p.row) }))
      .filter((x) => x.v != null && Number.isFinite(Number(x.v)))
      .sort((a, b) => b.v - a.v);
    scored.forEach((x, i) => ranks.set(x.id, i + 1));
    depth[pos] = scored.length;
  }
  return { ranks, depth };
}

/** A signal's number for a row: its per-game rate when the window is priced per game, else its score. */
const lvRead = (signal, row) => (signal.perGame ? signal.rate(row) : signal.score(row));

/** Points the k-th best player at a position scores, averaged over the projection sources that reach k. */
function lvCurves(players, pointSignals, positions = LV_POSITIONS) {
  const curves = {};
  for (const pos of positions) {
    const lists = pointSignals.map((s) => players.filter((p) => p.pos === pos).map((p) => lvRead(s, p.row))
      .filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => b - a)).filter((l) => l.length);
    const n = Math.max(0, ...lists.map((l) => l.length));
    const curve = [];
    for (let k = 0; k < n; k++) {
      const at = lists.filter((l) => k < l.length).map((l) => l[k]);
      curve.push(at.reduce((s, v) => s + v, 0) / at.length);
    }
    // A shallow source dropping out can make the mean tick up; points never rise with rank.
    for (let k = 1; k < curve.length; k++) curve[k] = Math.min(curve[k], curve[k - 1]);
    curves[pos] = curve;
  }
  return curves;
}

const lvAt = (curve, rank) => (curve.length ? curve[Math.min(rank, curve.length) - 1] : 0);

/**
 * How many players at each position the league starts and rosters.
 *
 * `slots` is the parsed lineup (powerrank.js `prSlots`): each slot the
 * positions it accepts. `supply` is { pos: [points desc] } — the players the
 * league would actually start, in order.
 */
/** Bench depth a position needs per starter, when the real rosters are not known: two-way RB/WR depth, a spare QB/TE. */
export const LV_BENCH_NEED = { QB: 0.35, RB: 1.3, WR: 1.1, TE: 0.35 };

export function lvDemand(slots, teams, benchSpots, supply, actual = null) {
  const taken = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const next = (pos) => (supply[pos] || [])[taken[pos]] ?? -Infinity;
  const order = slots.map((s) => s.filter((p) => LV_POSITIONS.includes(p))).filter((s) => s.length)
    .sort((a, b) => a.length - b.length);
  for (const s of order) {
    for (let t = 0; t < teams; t++) {
      const pos = s.slice().sort((a, b) => next(b) - next(a))[0];
      taken[pos]++;
    }
  }
  const starters = { ...taken };
  const need = (p) => starters[p] * LV_BENCH_NEED[p];
  const all = LV_POSITIONS.reduce((n, p) => n + need(p), 0) || 1;
  const rostered = {};
  for (const p of LV_POSITIONS) {
    rostered[p] = actual && actual[p] != null
      ? Math.max(starters[p], actual[p])
      : starters[p] + Math.round((teams * benchSpots * need(p)) / all);
  }
  return { starters, rostered };
}

/**
 * Value every player for one league.
 *
 * `rows`: the pool's slim rows. `signals`: [{ id, label, points?: true,
 * weight?: number, score: (row) => number | null }], higher score = better;
 * `points` marks the projection totals that set the curve. Every signal
 * counts the same unless it carries a `weight`. `league`: { teams, slots,
 * benchSpots, rostered } — `rostered`
 * is { QB: n, … } counted off the league's real rosters, when known.
 *
 * Returns { players: Map(id -> row), replacement, starters, rostered, curves }.
 */
/**
 * The agreed order and points for one window, with no league in it: each
 * signal's within-position ranks, their weighted consensus, and the points the
 * projection curve gives that consensus rank. This is steps 1 and 2 above, and
 * the whole of the page's weekly and rest-of-season "agreed" columns; League
 * Value adds the league's replacement level on top.
 *
 * `positions` defaults to League Value's four; the page's tables pass K and
 * DST too, which League Value leaves out only because their replacement is
 * the waiver wire.
 *
 * Returns { players: Map(id -> { posRank, consensus, points, n, spread, inputs }),
 * curves, signals }.
 */
export function lvConsensus(rows, signals, positions = LV_POSITIONS, { games = null } = {}) {
  const { players, curves, signals: used } = lvOrder(rows, signals, positions, games);
  return {
    players: new Map(players.filter((p) => p.posRank != null).map((p) => [p.id, {
      posRank: p.posRank, consensus: p.consensus, points: p.points, rate: p.rate, games: p.games, n: p.n, spread: p.spread, inputs: p.inputs,
    }])),
    curves,
    perGame: !!games,
    signals: used,
  };
}

/** lvConsensus's working: every player with its inputs, consensus, position rank and points. */
function lvOrder(rows, signals, positions = LV_POSITIONS, games = null) {
  const players = rows.filter((r) => positions.includes(r.p)).map((r) => ({ id: r.i, pos: r.p, row: r }));
  const live = signals.map((s) => ({ ...s, perGame: !!(games && s.points && s.rate) }))
    .map((s) => ({ ...s, ...lvSignalRanks(players, s, positions) })).filter((s) => s.ranks.size);
  const total = live.reduce((n, s) => n + (s.weight ?? 1), 0) || 1;
  for (const s of live) s.w = (s.weight ?? 1) / total;

  const curves = lvCurves(players, live.filter((s) => s.points), positions);
  // How deep a board must be at a position for absence from it to mean anything.
  const needDepth = {};
  for (const pos of positions) needDepth[pos] = Math.max(12, Math.round((curves[pos].length || 24) / 2));

  for (const p of players) {
    const obs = [];
    for (const s of live) {
      const r = s.ranks.get(p.id);
      if (r != null) obs.push({ id: s.id, rank: r, w: s.w, imputed: false });
      else if (s.depth[p.pos] >= needDepth[p.pos]) obs.push({ id: s.id, rank: s.depth[p.pos] + 1, w: s.w / 2, imputed: true });
    }
    p.inputs = obs;
    p.n = obs.filter((o) => !o.imputed).length;
    let use = obs.slice().sort((a, b) => a.rank - b.rank);
    if (use.length >= 4) use = use.slice(1, -1);
    const W = use.reduce((s, o) => s + o.w, 0);
    p.consensus = W ? use.reduce((s, o) => s + o.rank * o.w, 0) / W : null;
    const real = obs.filter((o) => !o.imputed).map((o) => o.rank);
    p.spread = real.length > 1 ? Math.max(...real) - Math.min(...real) : null;
  }

  for (const pos of positions) {
    const ranked = players.filter((p) => p.pos === pos && p.consensus != null && p.n > 0).sort((a, b) => a.consensus - b.consensus || a.id - b.id);
    ranked.forEach((p, i) => {
      p.rateRank = i + 1;
      p.rate = curves[pos].length ? lvAt(curves[pos], i + 1) : null;
      p.games = games ? games(p.row) ?? null : null;
      p.points = p.rate == null ? null : !games ? p.rate : p.games == null ? null : Math.round(p.rate * p.games * 10) / 10;
    });
    // Rest of season the position rank is the order of the totals shown beside
    // it: ranked per game, RB2 with a bye still to come showed fewer points
    // (227.2) than RB3 (235.8).
    const byTotal = games
      ? ranked.slice().sort((a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity) || a.rateRank - b.rateRank)
      : ranked;
    byTotal.forEach((p, i) => { p.posRank = i + 1; });
  }
  return { players, curves, signals: live.map((s) => ({ id: s.id, label: s.label, points: !!s.points, weight: s.w })) };
}

export function lvValues(rows, signals, { teams, slots, benchSpots, rostered: actual = null, games = null } = {}) {
  const agreed = lvOrder(rows, signals, LV_POSITIONS, games);
  const { curves, players } = agreed;
  // Who starts is a per-week question, so the supply is read off the curve, not off totals that differ by byes.
  const supply = {};
  for (const pos of LV_POSITIONS) {
    supply[pos] = players.filter((p) => p.pos === pos && p.rateRank != null).sort((a, b) => a.rateRank - b.rateRank).map((p) => p.rate);
  }
  const { starters, rostered } = lvDemand(slots, teams, benchSpots, supply, actual);
  const replacement = {}, lastStarter = {}, waiver = {};
  for (const pos of LV_POSITIONS) {
    if (!curves[pos].length) { replacement[pos] = lastStarter[pos] = waiver[pos] = null; continue; }
    lastStarter[pos] = lvAt(curves[pos], Math.max(1, starters[pos]));
    waiver[pos] = lvAt(curves[pos], rostered[pos] + 1);
    replacement[pos] = LV_REPLACEMENT_BLEND * lastStarter[pos] + (1 - LV_REPLACEMENT_BLEND) * waiver[pos];
  }

  const valued = players.filter((p) => p.posRank != null);
  for (const p of valued) {
    p.replacement = replacement[p.pos] == null ? null : games ? (p.games == null ? null : replacement[p.pos] * p.games) : replacement[p.pos];
    p.value = p.replacement == null || p.points == null ? null : Math.max(0, p.points - p.replacement);
  }
  // In a league the position rank is the order of the value beside it. Per
  // game, value is (rate − replacement) × games, which can order two players
  // differently from their totals (a bye still to come costs a replacement's
  // week): RB3 was worth 153 to RB2's 151.
  for (const pos of LV_POSITIONS) {
    valued.filter((p) => p.pos === pos)
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || (b.points ?? -Infinity) - (a.points ?? -Infinity) || a.posRank - b.posRank)
      .forEach((p, i) => { p.posRank = i + 1; });
  }
  const top = Math.max(0, ...valued.map((p) => p.value ?? 0)) || 1;
  valued.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.consensus - b.consensus);
  valued.forEach((p, i) => {
    p.rank = i + 1;
    p.index = p.value == null ? null : Math.round((p.value / top) * 1000) / 10;
  });

  const out = new Map(valued.map((p) => [p.id, {
    value: p.value, index: p.index, rank: p.rank, posRank: p.posRank, consensus: p.consensus,
    points: p.points, rate: p.rate, games: p.games, replacement: p.replacement, n: p.n, spread: p.spread, inputs: p.inputs,
  }]));
  return { players: out, replacement, lastStarter, waiver, starters, rostered, curves, perGame: !!games, signals: agreed.signals };
}

/**
 * Any one score's within-position ranks over a pool: id -> rank. The same
 * ranking League Value reads a signal by, so a source's column and its input
 * to League Value can never disagree.
 */
export function lvRanksBy(rows, score) {
  const players = rows.filter((r) => LV_POSITIONS.includes(r.p)).map((r) => ({ id: r.i, pos: r.p, row: r }));
  return lvSignalRanks(players, { score }).ranks;
}

/**
 * What a position rank is worth in this league: the points the curve gives
 * that rank, over replacement, floored at 0.
 *
 * This is how every source is put on ONE axis without averaging anything:
 * each source keeps its own opinion of where a player ranks, and the league
 * decides what that rank is worth. "ESPN has him RB8" becomes "ESPN's view is
 * worth 61 points here", next to League Value's own number. It is League
 * Value's formula with one source's rank in place of the consensus. Priced per
 * game (`lv.perGame`), it needs the player's `games` left.
 */
export function lvWorth(lv, pos, rank, games = null) {
  const curve = lv?.curves?.[pos];
  const repl = lv?.replacement?.[pos];
  if (!curve || !curve.length || repl == null || rank == null) return null;
  const perGame = Math.max(0, lvAt(curve, rank) - repl);
  if (!lv.perGame) return perGame;
  return games == null ? null : perGame * games;
}
