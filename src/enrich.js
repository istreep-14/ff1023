import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, FPDIR } from './config.js';
import { nameKey } from './sleeper.js';
import { LEAGUE_SCORING_TO_API } from './fpapi.js';
import { resolve as resolveWeek, LAST_WEEK } from './week.js';
import { loadSignals } from './signals.js';
import { readDraftSharks } from './draftsharks.js';
import { readVegas, scoreLine, skewOf } from './vegas.js';
import { readSchedule, byeWeek, teamWeek } from './schedule.js';
import { normTeam, normPos } from './teams.js';
import { loadTradeMarket } from './trademarket.js';
import { loadActualsIndex, mergeWeekPoints } from './actuals.js';
import { loadIdMap } from './idmap.js';
import { loadDDPlayers } from './dynastydaddy.js';

/**
 * Joins FantasyPros and Draft Sharks onto the scraped league rosters, so every
 * rostered player carries this week's rank/projection, its rest-of-season
 * rank/projection, current injury status, and Draft Sharks' own current-week +
 * ROS numbers as a second opinion, and Dynasty Daddy's trade value in every
 * market it republishes (joined by Sleeper / ESPN / Yahoo id, never by name).
 *
 * Degrades cleanly: whatever slice of data/fp/ exists gets joined, the rest is null.
 */

const POINTS_KEY = { PPR: 'points_ppr', HALF: 'points_half', STD: 'points' };

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f))).filter(Boolean);
}

/**
 * fpId -> rank for one scoring format.
 *
 * Also carries `points` from `r2p_pts` when present: the public ranking boards
 * embed projected points directly, so a scraped sync needs no separate
 * projections file. The API sync leaves r2p_pts absent and supplies projections
 * separately; both paths are handled.
 */
function rankIndex(dir) {
  const idx = new Map();
  for (const board of readDir(dir)) {
    for (const p of board.players || []) {
      const id = Number(p.player_id);
      const prev = idx.get(id);
      // Positional boards don't overlap, but guard anyway: keep the better rank.
      if (!prev || Number(p.rank_ecr) < prev.rank) {
        idx.set(id, {
          rank: Number(p.rank_ecr),
          tier: p.tier ?? null,
          position: p.player_position_id,
          points: p.r2p_pts != null && p.r2p_pts !== '' ? Number(p.r2p_pts) : null,
          posRank: p.pos_rank ?? null,
          startSitGrade: p.start_sit_grade ?? null,
          tag: p.tag ?? null,
          opponent: p.player_opponent ?? null,
          rankMin: p.rank_min != null ? Number(p.rank_min) : null,
          rankMax: p.rank_max != null ? Number(p.rank_max) : null,
          rankAve: p.rank_ave != null ? Number(p.rank_ave) : null,
          trend: p.player_ecr_delta != null && p.player_ecr_delta !== '' ? Number(p.player_ecr_delta) : null,
          rankStd: p.rank_std != null ? Number(p.rank_std) : null,
          owned: p.player_owned_avg ?? null,
          bye: p.player_bye_week != null && p.player_bye_week !== '' ? Number(p.player_bye_week) : null,
          note: p.note ?? null,
        });
      }
    }
  }
  return idx;
}

/** fpId -> projection stat block. */
function projIndex(dir) {
  const idx = new Map();
  for (const board of readDir(dir)) {
    for (const p of board.players || []) {
      const stats = Array.isArray(p.stats) ? p.stats[0] : p.stats;
      idx.set(Number(p.fpid), { name: p.name, team: p.team_id, position: p.position_id, stats: stats || {} });
    }
  }
  return idx;
}

function injuryIndex(weekDir) {
  const idx = new Map();
  const data = readJson(join(weekDir, 'injuries.json'));
  for (const i of data?.injuries || data?.players || []) {
    const id = Number(i.player_id ?? i.fpid);
    if (id) idx.set(id, { status: i.status ?? null, type: i.injury_type ?? null, comment: i.comment ?? null, updated: i.injury_update_date ?? null });
  }
  return idx;
}

/** fpId -> actual fantasy points scored so far (API only; no scraped equivalent). */
export function pointsIndex(root, scoring) {
  const idx = new Map();
  const data = readJson(join(root, 'points', `${String(scoring).toLowerCase()}.json`));
  for (const p of data?.players || []) {
    idx.set(Number(p.player_id), { games: p.games ?? null, points: p.points ?? null, average: p.average ?? null, weeks: p.weeks ?? null });
  }
  return idx;
}

/** fpId -> host-site player ids (API only). Lets you cross-reference ESPN/Yahoo. */
function externalIdIndex(root) {
  const idx = new Map();
  const data = readJson(join(root, 'players.json'));
  for (const p of data?.players || []) {
    if (!p.espn_id && !p.yahoo_id && !p.cbs_id) continue;
    idx.set(Number(p.player_id), { espn: p.espn_id ?? null, yahoo: p.yahoo_id ?? null, cbs: p.cbs_id ?? null });
  }
  return idx;
}

function newsIndex(root) {
  const idx = new Map();
  const data = readJson(join(root, 'news.json'));
  for (const n of data?.news || data?.items || []) {
    const id = Number(n.fpid ?? n.player_id);
    if (!id) continue;
    if (!idx.has(id)) idx.set(id, []);
    if (idx.get(id).length < 3) idx.get(id).push({ title: n.title || n.headline, date: n.created || n.updated, url: n.url });
  }
  return idx;
}

/**
 * VegasEdge for one week and scoring, keyed by Sleeper id: points scored here
 * from the stat line, the position rank by those points, and the spread. A
 * player whose market is incomplete keeps his points but is not ranked — a
 * projection built off a TD price alone would rank him on missing data.
 */
export function vegasIndex(season, week, scoring) {
  const store = readVegas(season, week);
  const idx = new Map();
  if (!store || Number(store.week) !== Number(week)) return idx;
  const rows = Object.values(store.players || {}).map((r) => ({ r, pts: scoreLine(r, scoring) }));
  const byPos = new Map();
  for (const x of rows) {
    if (x.pts == null || !x.r.complete) continue;
    if (!byPos.has(x.r.p)) byPos.set(x.r.p, []);
    byPos.get(x.r.p).push(x);
  }
  const rank = new Map();
  for (const list of byPos.values()) list.sort((a, b) => b.pts - a.pts).forEach((x, i) => rank.set(x.r.sid, i + 1));
  for (const { r, pts } of rows) {
    const d = r.dist?.[scoring];
    const ok = d && d.status === 'ok';
    idx.set(String(r.sid), {
      points: pts,
      posRank: rank.get(r.sid) ?? null,
      complete: !!r.complete,
      missing: r.missing?.length ? r.missing : null,
      volatility: r.vol,
      tdMethod: r.tdm ?? null,
      stats: r.st,
      floor: ok ? d.p10 : null,
      median: ok ? d.p50 : null,
      ceiling: ok ? d.p90 : null,
      boom: ok ? d.boom : null,
      bust: ok ? d.bust : null,
      skew: ok ? skewOf(d) : null,
      distStatus: d?.status ?? null,
      sourceAt: store.generatedAt ?? null,
    });
  }
  return idx;
}

/** Draft Sharks, keyed by name+position — every week the source has been asked for. */
export function draftsharksIndex(season, scoring) {
  const store = readDraftSharks(season, scoring);
  const idx = new Map();
  if (!store) return idx;
  for (const rec of Object.values(store.players || {})) {
    const row = {
      id: rec.id ?? null,
      n: rec.n,
      p: rec.p,
      t: rec.t ?? null,
      ros: rec.ros?.proj ?? null,
      rosWeekly: rec.ros?.weekly ?? null,
      // Draft Sharks publishes a floor/ceiling for BOTH the current week and
      // the ROS board, not just the week — both are carried through.
      rosFloor: rec.ros?.floor ?? null,
      rosCeiling: rec.ros?.ceiling ?? null,
      rosConsensus: rec.ros?.consensus ?? null,
      rosD3: rec.ros?.d3 ?? null,
      rosGames: rec.ros?.games ?? null,
      rosRank: rec.ros?.rank ?? null,
      rosPosRank: rec.ros?.posRank ?? null,
      rosTier: rec.ros?.tier ?? null,
      rosStats: rec.ros?.stats ?? null,
      injuryRisk: rec.ros?.injuryRisk ?? null,
      value: rec.ros?.value ?? null,
      valueDelta: rec.ros?.valueDelta ?? null,
      marketValue: rec.ros?.marketValue ?? null,
      rookie: !!rec.rookie,
      weeks: rec.w || {},
    };
    idx.set(nameKey(rec.n, rec.p), row);
    if (normPos(rec.p) !== rec.p) idx.set(nameKey(rec.n, normPos(rec.p)), row);
  }
  return idx;
}

const nameParts = (name) => {
  const toks = nameKey(name).split('|')[0].split(' ').filter(Boolean);
  return { first: toks[0] || '', last: toks[toks.length - 1] || '' };
};
const byLastCache = new WeakMap();
// Nicknames that share no prefix with the given name.
const NICKNAMES = { tank: 'nathaniel', hollywood: 'marquise', scotty: 'scott', bucky: 'robert' };

/**
 * One player's Draft Sharks row. Exact name+position first; failing that, the
 * same last name, position and team with a first name that shares its first
 * three letters. FantasyPros names players by their nickname (Kenny Gainwell,
 * Cam Skattebo, Chig Okonkwo, Andy Borregales) where Draft Sharks prints the
 * full name, and exact-only matching left those rows without a Draft Sharks
 * number. `NICKNAMES` covers the ones with no shared prefix (Tank Dell is
 * Nathaniel Dell). The fallback takes a candidate only when it is the ONE such row.
 */
export function dsFind(idx, { name, position, team }) {
  const hit = idx.get(nameKey(name, position)) || idx.get(nameKey(name, normPos(position)));
  if (hit || !team) return hit || null;
  let byLast = byLastCache.get(idx);
  if (!byLast) {
    byLast = new Map();
    for (const row of new Set(idx.values())) {
      const k = `${nameParts(row.n).last}|${normPos(row.p)}|${normTeam(row.t)}`;
      byLast.set(k, [...(byLast.get(k) || []), row]);
    }
    byLastCache.set(idx, byLast);
  }
  const { first, last } = nameParts(name);
  if (first.length < 3) return null;
  const given = NICKNAMES[first] || first;
  const cands = (byLast.get(`${last}|${normPos(position)}|${normTeam(team)}`) || [])
    .filter((row) => nameParts(row.n).first.slice(0, 3) === given.slice(0, 3));
  return cands.length === 1 ? cands[0] : null;
}

/** Games a team has left, this week included: the weeks through LAST_WEEK, less a bye still to come. */
export function gamesLeft(week, bye, lastWeek = LAST_WEEK) {
  const weeks = Math.max(0, lastWeek - week + 1);
  return bye != null && bye >= week && bye <= lastWeek ? weeks - 1 : weeks;
}

/**
 * FantasyPros' ROS rankings board prints one per-game rate times every week
 * left — the same multiplier for every player. Measured 2026-10-22 (week 7):
 * all 471 r2p_pts across the six ROS boards are multiples of 1.2, i.e. rate ×
 * 12, byes ignored, so a player with his bye still to come was credited a game
 * he will not play. The rate times his own games left is his total.
 */
export function fpRosFromBoard(boardPoints, week, games, lastWeek = LAST_WEEK) {
  const weeks = Math.max(0, lastWeek - week + 1);
  if (boardPoints == null || !weeks || games == null) return null;
  return Math.round((boardPoints / weeks) * games * 10) / 10;
}

/** A Dynasty Daddy row as the `fp.dd` block: who it matched, and its player data. */
const ddRow = (r) => (r ? {
  nameId: r.nameId, age: r.age, exp: r.exp, inj: r.inj, adp: r.adp, owned: r.owned, started: r.started, ros: r.ros,
} : null);

/**
 * Everything the dashboard knows about one player, built ONE way.
 *
 * Rostered players and free agents used to be built by different code (this file
 * for rosters, a thinner copy in dashboard.js for the pool), which is how a
 * player could carry a different projection, rank, injury flag or roster % on
 * My Team than on Players. Both now call `fpFor`.
 *
 * `player` needs {fpId, name, position, team}; the result is the `fp` block.
 */
export function createEnricher({ season, week, idMap = null } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const root = join(FPDIR, String(yr));
  const weekDir = join(root, `week-${wk}`);
  const rosDir = join(root, 'ros');

  const have = existsSync(root);
  const weekProj = projIndex(join(weekDir, 'projections'));
  const rosProj = projIndex(join(rosDir, 'projections'));
  const injuries = injuryIndex(weekDir);
  const news = newsIndex(root);
  const externalIds = externalIdIndex(root);
  // Demand-side signal: who the rest of fantasy football is adding, right now.
  const signals = loadSignals({ season: yr });
  const nflSchedule = readSchedule(yr);
  const fpToSleeper = idMap?.fpToSleeper || {};
  // Every player's points for every stored week, keyed by Sleeper id.
  // Matchup lineups do not cover the pool; this does.
  const weeklyActuals = loadActualsIndex(yr);
  // Dynasty Daddy's player rows: ids, ADP, and three more sites' ROS ranks.
  // Format-independent.
  const dd = loadDDPlayers(yr);

  const apiOf = (scoring) => LEAGUE_SCORING_TO_API[String(scoring || '').toUpperCase()] || 'PPR';
  // One set of per-format indexes, built on first use.
  const perFormat = new Map();
  const formatOf = (scoring) => {
    const sc = apiOf(scoring);
    if (!perFormat.has(sc)) {
      perFormat.set(sc, {
        sc,
        ptsKey: POINTS_KEY[sc],
        scored: pointsIndex(root, sc),
        ds: draftsharksIndex(yr, sc),
        vegas: vegasIndex(yr, wk, sc),
        // What FantasyPros' trade analyzer users actually pay for each player.
        trade: loadTradeMarket(yr, sc),
        ranks: {
          week: rankIndex(join(weekDir, 'rankings', sc.toLowerCase())),
          ros: rankIndex(join(rosDir, 'rankings', sc.toLowerCase())),
        },
      });
    }
    return perFormat.get(sc);
  };

  const cache = new Map();
  function fpFor(p, scoring) {
    const F = formatOf(scoring);
    const id = Number(p.fpId);
    const key = `${F.sc}|${id}`;
    if (cache.has(key)) return cache.get(key);

    const wp = weekProj.get(id);
    const rp = rosProj.get(id);
    const wr = F.ranks.week.get(id);
    const rr = F.ranks.ros.get(id);
    const sid = fpToSleeper[id]?.sleeperId ?? null;

    const teamAbbr = normTeam(p.team);
    // The stored schedule can be missing a team's bye (ESPN serves some weeks
    // empty); FantasyPros prints every player's bye week on its board.
    const bye = byeWeek(nflSchedule, teamAbbr) ?? wr?.bye ?? rr?.bye ?? (p.byeWeek != null && p.byeWeek !== '' ? Number(p.byeWeek) : null);
    const schedThis = teamWeek(nflSchedule, teamAbbr, wk);
    const onBye = schedThis?.bye === true || bye === wk;
    const rosGames = teamAbbr ? gamesLeft(wk, onBye ? wk : bye) : null;
    const rosPoints = rp?.stats?.[F.ptsKey] ?? fpRosFromBoard(rr?.points ?? null, wk, rosGames);

    const fp = {
      weekRank: wr?.rank ?? null,
      weekPosRank: wr?.posRank ?? null,
      weekTier: wr?.tier ?? null,
      weekTrend: wr?.trend ?? null,
      rosRank: rr?.rank ?? null,
      rosPosRank: rr?.posRank ?? null,
      rosTier: rr?.tier ?? null,
      // Dedicated projections win; ranking-board r2p_pts is the fallback.
      weekPoints: wp?.stats?.[F.ptsKey] ?? wr?.points ?? null,
      rosPoints,
      rosGames,
      rosPerGame: rosPoints != null && rosGames ? Math.round((rosPoints / rosGames) * 100) / 100 : null,
      // The two current-week figures kept SEPARATE, not merged into weekPoints
      // above — rankings-implied points (r2p_pts, a byproduct of the expert
      // panel's rank order) and FantasyPros' own projections model are
      // different products (see scrapefp.js) and the Sources page shows both.
      weekExpertPoints: wr?.points ?? null,
      weekProjPoints: wp?.stats?.[F.ptsKey] ?? null,
      weekStats: wp?.stats ?? null,
      opponent: wr?.opponent ?? null,
      startSitGrade: wr?.startSitGrade ?? null,
      tag: wr?.tag ?? null,
      expertSpread: wr ? { min: wr.rankMin, max: wr.rankMax, ave: wr.rankAve, std: wr.rankStd } : null,
      // The same spread on the rest-of-season board, which is what a ROS range column reads.
      rosSpread: rr ? { min: rr.rankMin, max: rr.rankMax, ave: rr.rankAve, std: rr.rankStd } : null,
      trade: F.trade?.byId.get(id) ?? null,
      ownedPct: wr?.owned ?? rr?.owned ?? null,
      // A blank week note is not a note. The ROS blurb still belongs on the sheet.
      note: wr?.note || rr?.note || null,
      scored: F.scored.get(id) ?? null,
      // Per-week points for this scoring format. Sleeper's stat file covers
      // anyone who played; FantasyPros' weeks fill a hole in that file.
      actualWeeks: mergeWeekPoints(
        sid ? weeklyActuals.get(String(sid)) : null,
        F.scored.get(id)?.weeks,
        F.sc,
      ),
      externalIds: externalIds.get(id) ?? null,
      sleeperId: sid,
      thumb: fpToSleeper[id]?.thumb ?? null,
      dd: ddRow(dd?.find({ sleeperId: sid, espnId: externalIds.get(id)?.espn, yahooId: externalIds.get(id)?.yahoo })),
      injury: injuries.get(id) ?? null,
      news: news.get(id) ?? null,
      signal: signals.signalFor({
        sleeperId: sid,
        yahooId: externalIds.get(id)?.yahoo,
        name: p.name,
        position: p.position,
      }),
    };

    // Draft Sharks' current-week cell + its ROS total — nothing further out.
    const dsRec = dsFind(F.ds, p);
    const dsCell = dsRec?.weeks?.[wk] ?? dsRec?.weeks?.[String(wk)] ?? null;
    fp.draftsharks = dsRec ? {
      week: onBye ? null : (dsCell?.proj ?? null),
      d3: onBye ? null : (dsCell?.d3 ?? null),
      floor: dsCell?.floor ?? null,
      ceiling: dsCell?.ceiling ?? null,
      opponent: onBye ? null : (dsCell?.opp ?? schedThis?.opp ?? null),
      sos: dsCell?.sos ?? null,
      rank: dsCell?.rank ?? null,
      bye: onBye,
      rosTotal: dsRec.ros ?? null,
      rosWeekly: dsRec.rosWeekly ?? null,
      rosFloor: dsRec.rosFloor ?? null,
      rosCeiling: dsRec.rosCeiling ?? null,
      consensus: onBye ? null : (dsCell?.consensus ?? null),
      posRank: dsCell?.posRank ?? null,
      tier: dsCell?.tier ?? null,
      stats: onBye ? null : (dsCell?.stats ?? null),
      rosConsensus: dsRec.rosConsensus,
      rosD3: dsRec.rosD3,
      rosGames: dsRec.rosGames,
      rosRank: dsRec.rosRank,
      rosPosRank: dsRec.rosPosRank,
      rosTier: dsRec.rosTier,
      rosStats: dsRec.rosStats,
      injuryRisk: dsRec.injuryRisk,
      value: dsRec.value,
      valueDelta: dsRec.valueDelta,
      marketValue: dsRec.marketValue,
      rookie: dsRec.rookie,
    } : null;

    // VegasEdge joins by Sleeper id, the id its boards carry. Current week only.
    fp.vegas = sid && !onBye ? (F.vegas.get(String(sid)) ?? null) : null;

    fp.schedule = {
      bye,
      opp: onBye ? null : (schedThis?.opp ?? null),
      home: onBye ? null : (schedThis?.home ?? null),
    };

    cache.set(key, fp);
    return fp;
  }

  /** Provenance of a format's trade market (dates axis, site time), for the page to label it. */
  const tradeMeta = (scoring) => formatOf(scoring).trade?.meta ?? null;

  /** Which Dynasty Daddy markets are on disk, and as of when. */

  return { season: yr, week: wk, have, signals, schedule: nflSchedule, idMap: { fpToSleeper }, fpFor, tradeMeta };
}

export function enrich({ season, week, idMap = null } = {}) {
  const model = readJson(join(DATA, 'latest.json'));
  if (!model) throw new Error('No data/latest.json — run `npm run scrape` first.');

  const E = createEnricher({ season, week, idMap });
  for (const league of model.leagues) {
    for (const team of league.teams) {
      for (const p of team.players) p.fp = E.fpFor(p, league.scoring);
    }
  }

  const signals = E.signals;
  model.signals = { ok: signals.ok, buzzDate: signals.buzzDate, buzzStale: signals.buzzStale, trendFetchedAt: signals.trendFetchedAt, windows: signals.windows, counts: signals.counts };
  model.enrichedAt = new Date().toISOString();
  model.enrichedSeason = E.season;
  model.enrichedWeek = E.week;
  model.fpDataPresent = E.have;
  writeFileSync(join(DATA, 'enriched.json'), JSON.stringify(model, null, 2));
  return model;
}

/** `enrich` with the id map loaded and a one-paragraph summary logged — the pipeline step and the CLI command. */
export async function runEnrich({ season, week, log = console.log } = {}) {
  const { season: yr } = resolveWeek({ season, week });
  const idMap = await loadIdMap({ season: yr });
  const m = enrich({ season, week, idMap });
  const all = m.leagues.flatMap((l) => l.teams.flatMap((t) => t.players));
  const count = (f) => all.filter(f).length;
  log(`Enriched ${all.length} roster slots for season ${m.enrichedSeason} week ${m.enrichedWeek}`);
  if (!m.fpDataPresent) log('  (no data/fp/ yet — run `fp:sync`)');
  log(`  FantasyPros week ${count((p) => p.fp?.weekPoints != null)} · ranked ${count((p) => p.fp?.weekRank != null)}`
    + ` · Draft Sharks ${count((p) => p.fp?.draftsharks?.week != null)} · VegasEdge ${count((p) => p.fp?.vegas?.points != null)} · injuries ${count((p) => p.fp?.injury?.status)}`
    + ` · headshots ${count((p) => p.fp?.thumb)} · Dynasty Daddy ${count((p) => p.fp?.dd)}`);
  return m;
}
