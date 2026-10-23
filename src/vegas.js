import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, post } from './http.js';
import { DATA, config } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';
import { scoringsInUse } from './fpapi.js';

/**
 * VegasEdgeFantasy — this week's projections implied by sportsbook player
 * props, and the spread around them. Current week only; the site has no
 * rest-of-season board.
 *
 * Three requests a sync, plus one per extra scoring format:
 *   /qb/rankings, /flex/rankings   the expected stat line per player (QB; RB/WR/TE)
 *   /inseason/boombust/batch       percentiles p5..p95 and boom/bust % from the
 *                                  site's 10K-sample simulation, for every name
 *                                  at once, at a scoring we send
 *
 * It was dropped once (expiring cookie, a scoring setting other visitors can
 * change) and brought back on request for its spread. Both lessons are kept:
 * the token is checked before anything is asked, and points are scored HERE
 * from the stat line, never read off the board (see `scoreLine`).
 *
 * Auth is the `access_token` cookie (a JWT, ~30 days) from a logged-in
 * browser, in VEGAS_TOKEN. Players are keyed by Sleeper id.
 */

const BASE = 'https://vegasedgefantasy.com';
const dir = (season) => join(DATA, 'vegas', String(season));
export const filePath = (season, week) => join(dir(season), `week-${week}.json`);

/** The site's own scoring parameters, per format this project uses. */
export const SCORING = {
  PPR:  { ppr: 1,   pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
  HALF: { ppr: 0.5, pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
  STD:  { ppr: 0,   pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
};

export class VegasAuthError extends Error {
  constructor(msg) {
    super(`${msg}\n  VEGAS_TOKEN is the \`access_token\` cookie from a logged-in vegasedgefantasy.com session.\n`
      + '  Copy it from DevTools > Application > Cookies into .env. It expires roughly monthly.');
    this.name = 'VegasAuthError';
  }
}

/** The JWT's payload, unverified: only to say when it expires before asking the site. */
export function tokenInfo(token = config.vegasToken) {
  if (!token) return null;
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return { expiresAt: new Date(p.exp * 1000), expired: p.exp * 1000 <= Date.now() };
  } catch {
    return null;
  }
}

function headers() {
  if (!config.vegasToken) throw new VegasAuthError('VEGAS_TOKEN is not set.');
  return { Cookie: `access_token=${config.vegasToken}`, Referer: `${BASE}/inseason` };
}

async function ask(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new VegasAuthError('VegasEdge rejected the token.');
    throw err;
  }
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * One board row, reduced to what is kept: the stat line, whether every prop
 * priced, and the site's own tags. The QB board has no Position field; the
 * board is the position.
 */
export function boardRow(p, board) {
  const missing = p.missing_props || [];
  return {
    sid: String(p.PlayerID),
    n: p.Player,
    p: p.Position || String(board).toUpperCase(),
    t: p.Team || null,
    st: {
      passYds: num(p.PassYds), passTds: num(p.PassTds), ints: num(p.INTs),
      rushYds: num(p.RushingYds), rushTds: num(p.ExpectedRushTds ?? p.RushTDs),
      recYds: num(p.ReceivingYds), rec: num(p.Receptions), tds: num(p.ExpectedTds), tdProb: num(p.TD_Prob),
    },
    // A player without a full market is projected off a TD price alone, which
    // reads as a huge disagreement when it is really missing data.
    complete: !p.no_odds && !p.missing_from_book && !missing.length,
    missing,
    vol: p.volatility_tag || null,
    // How the expected TDs were priced: each book's 1+/2+/3+ ladder, the
    // averaged ladder, or a Poisson guess off the anytime price alone.
    tdm: p.TdMethod || null,
    inj: p.InjuryStatus || null,
    // What the site printed, at whatever scoring it held. Never the projection.
    site: num(p.FantasyPoints),
  };
}

/**
 * Points for a stat line at one of our scoring formats.
 *
 * The board's FantasyPoints is not used: the site keeps ONE scoring setting
 * for the whole server process, and any visitor saving a scoring change
 * re-scores the board for everyone (measured 2026-09-19: Bijan 34.3 one pull,
 * 23.4 the next morning, off identical props). The stat line does not move
 * with that setting, so scoring it here gives the market's number at a
 * scoring we control. Null when the line is incomplete.
 */
export function scoreLine(row, scoring = 'PPR') {
  const s = SCORING[String(scoring).toUpperCase()];
  const st = row && row.st;
  if (!s || !st) return null;
  let pts;
  if (row.p === 'QB') {
    if ([st.passYds, st.passTds, st.ints, st.rushYds, st.rushTds].some((v) => v == null)) return null;
    pts = st.passYds * s.pts_per_pass_yd + st.passTds * s.pass_td_points + st.ints * s.int_points
      + st.rushYds * s.pts_per_rush_yd + st.rushTds * s.td_points;
  } else {
    if ([st.rushYds, st.recYds, st.rec, st.tds].some((v) => v == null)) return null;
    pts = st.rushYds * s.pts_per_rush_yd + st.recYds * s.pts_per_rec_yd + st.rec * s.ppr + st.tds * s.td_points;
  }
  return Math.round(pts * 100) / 100;
}

/**
 * Which way the distribution leans: upside room (p90 - p50) against downside
 * room (p50 - p10), as (up - down) / (up + down). +1 is all upside, -1 all
 * downside. Fantasy points lean up for nearly everyone (a zero is a floor, a
 * long TD is not a ceiling), so it reads against other players, not against 0.
 */
export function skewOf(d) {
  if (!d || d.p10 == null || d.p50 == null || d.p90 == null) return null;
  const up = d.p90 - d.p50, down = d.p50 - d.p10;
  return up + down > 0 ? Math.round(((up - down) / (up + down)) * 100) / 100 : null;
}

/** A batch entry, kept only when the site simulated it in full. */
export function distRow(d) {
  if (!d || d.status !== 'ok') return d && d.status ? { status: d.status } : null;
  const out = { status: 'ok' };
  for (const k of ['p5', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95']) out[k] = num(d[k]);
  out.boom = num(d.boom_pct);
  out.bust = num(d.bust_pct);
  return out;
}

export async function fetchConfig() {
  const c = await ask(() => get(`${BASE}/config`, { headers: headers() }));
  return {
    season: num(c?.inseason_season),
    week: num(c?.inseason_week),
    generatedAt: c?.inseason_generated_at ?? null,
  };
}

export async function fetchBoard(board) {
  const data = await ask(() => get(`${BASE}/${board}/rankings?bookmaker=Average`, { headers: headers() }));
  return Array.isArray(data) ? data.map((p) => boardRow(p, board)) : [];
}

/** Percentiles for every name in one request (the site caps a batch at 600). */
export async function fetchDistributions(names, scoring) {
  const out = {};
  let meta = null;
  for (let i = 0; i < names.length; i += 600) {
    const j = await ask(() => post(`${BASE}/inseason/boombust/batch`,
      { players: names.slice(i, i + 600), scoring: SCORING[scoring] }, { headers: headers() }));
    Object.assign(out, j?.players || {});
    meta ||= j;
  }
  return { players: out, week: num(meta?.week), oddsAsOf: meta?.odds_as_of ?? null };
}

export function readVegas(season, week) {
  const p = filePath(season, week);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * This week's board and distributions, for every scoring format in use, into
 * data/vegas/<season>/week-<week>.json. The file is filed under the week the
 * SITE says it is serving; enrich only joins it when that is the current week.
 */
export async function vegasSync({ season, week, scorings = null, log = console.log } = {}) {
  const want = resolveWeek({ season, week });
  const info = tokenInfo();
  if (!config.vegasToken) throw new VegasAuthError('VEGAS_TOKEN is not set.');
  if (info?.expired) throw new VegasAuthError(`VEGAS_TOKEN expired ${info.expiresAt.toISOString().slice(0, 10)}.`);
  const formats = (scorings || scoringsInUse()).map((s) => String(s).toUpperCase()).filter((s) => SCORING[s]);
  if (info) log(`VegasEdge — token valid to ${info.expiresAt.toISOString().slice(0, 10)}`);

  const cfg = await fetchConfig();
  const yr = cfg.season ?? want.season, wk = cfg.week ?? want.week;
  log(`  site is serving season ${yr} week ${wk}, odds as of ${cfg.generatedAt ?? 'an unstated time'}`);
  if (cfg.week != null && cfg.week !== want.week) log(`  WARNING requested week ${want.week}; the site is serving week ${wk}. Filed under ${wk}, joined only when it is the current week.`);

  const ok = [], failed = [];
  const rows = [];
  for (const b of ['qb', 'flex']) {
    try {
      const r = await fetchBoard(b);
      rows.push(...r);
      ok.push(`${b} (${r.length})`);
      log(`  ok   ${b.toUpperCase().padEnd(4)} ${String(r.length).padStart(4)} players`);
    } catch (err) {
      if (err instanceof VegasAuthError) throw err;
      failed.push({ label: b, error: err.message });
      log(`  FAIL ${b} — ${err.message.split('\n')[0]}`);
    }
  }
  if (!rows.length) {
    record('vegas', { ok, failed, sourceAt: cfg.generatedAt, season: yr, week: wk, items: 0, note: 'no board rows' });
    return { ok, failed };
  }

  const players = {};
  for (const r of rows) players[r.sid] = { ...r, dist: {} };
  const byName = new Map(rows.map((r) => [r.n, r.sid]));
  for (const sc of formats) {
    try {
      const d = await fetchDistributions([...byName.keys()], sc);
      if (d.week != null && d.week !== wk) {
        log(`  WARNING ${sc} distributions are for week ${d.week}, not ${wk}; dropped`);
        failed.push({ label: `${sc} distributions`, error: `week ${d.week}` });
        continue;
      }
      let n = 0;
      for (const [name, x] of Object.entries(d.players)) {
        const sid = byName.get(name), row = distRow(x);
        if (!sid || !row) continue;
        players[sid].dist[sc] = row;
        if (row.status === 'ok') n++;
      }
      ok.push(`${sc} distributions (${n})`);
      log(`  ok   ${sc.padEnd(4)} ${String(n).padStart(4)} distributions`);
    } catch (err) {
      if (err instanceof VegasAuthError) throw err;
      failed.push({ label: `${sc} distributions`, error: err.message });
      log(`  FAIL ${sc} distributions — ${err.message.split('\n')[0]}`);
    }
  }

  mkdirSync(dir(yr), { recursive: true });
  writeJsonAtomic(filePath(yr, wk), {
    season: yr, week: wk, fetchedAt: new Date().toISOString(), generatedAt: cfg.generatedAt, formats, players,
  }, { indent: 0 });
  const rep = record('vegas', {
    ok, failed, sourceAt: cfg.generatedAt ?? null, season: yr, week: wk, items: rows.length,
    note: `week ${wk} · ${formats.join(', ')}` + (cfg.week != null && cfg.week !== want.week ? ` · site serving ${wk}, asked ${want.week}` : ''),
  });
  log(`  ${rows.length} players -> ${filePath(yr, wk)}`);
  return rep;
}
