/**
 * Builds dist/dashboard.html: the page payload assembled from data/enriched.json
 * plus the league-detail/advanced/accuracy/source-table layers, rendered into
 * src/dashboard.template.html with the look-ahead-window module inlined beside it.
 *
 * Nothing here changes what the numbers MEAN — that is enrich.js's job. It
 * shapes rows for the page: buildUniverse makes the one row-per-player universe
 * every table reads, and buildSourceTables reads those same rows so a Sources
 * table number can never drift from the player tables.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA, FPDIR, ROOT } from './config.js';
import { LEAGUE_SCORING_TO_API } from './fpapi.js';
import { resolve as resolveWeek } from './week.js';
import { fetchLeagueDetail, loadDetailCache, writeDetailCache, supportsLeagueDetail } from './leaguedata.js';
import { fetchAdvanced, loadAdvancedCache, writeAdvancedCache } from './mpbadvanced.js';
import { loadIdMap } from './idmap.js';
import { loadSignals } from './signals.js';
import { report as freshnessReport } from './freshness.js';
import { readWeek as readScores, seasonTotals, storedWeeks, completeWeeks, isFinal } from './matchups.js';
import { load as loadOverrides, forLeague, applyToLeague, describeRule, SEED_RULES, TIEBREAK } from './overrides.js';
import { dsWeekReport } from './draftsharks.js';
import { buildSourceTables, SOURCE_META, SOURCE_ORDER, ROS_BASIS } from './sourcetables.js';
import { buildAccuracy } from './accuracy.js';
import { createEnricher } from './enrich.js';
import { tail as runlogTail } from './runlog.js';
import { stepRows, PRESETS } from './sync.js';
import { loadDirectory, loadState, isActive } from './leaguestate.js';
import { loadDDLeague } from './dynastydaddy.js';

/**
 * Builds the compact payload the dashboard runs on.
 *
 * enriched.json is ~2MB, most of it expert `note` prose and raw stat blocks the
 * UI never shows. This strips to what the pages render, and adds a free-agent
 * pool computed from the FP ranking boards minus every rostered player.
 */

/** A src module as plain script text for the page (see renderHtml): `export` is not valid in a classic script. */
const inlineModule = (file) => readFileSync(join(dirname(new URL(import.meta.url).pathname), file), 'utf8').replace(/^export /gm, '');

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/**
 * Every player on the FantasyPros boards for one scoring format, plus anyone
 * rostered in a league that is not on a board (an IR stash, a just-signed
 * player), as seeds for the enricher: {fpId, name, team, position, byeWeek}.
 */
function universeSeeds(season, week, scoring, leagues) {
  const sc = String(scoring).toLowerCase();
  const seeds = new Map();
  for (const dir of [
    join(FPDIR, String(season), `week-${week}`, 'rankings', sc),
    join(FPDIR, String(season), 'ros', 'rankings', sc),
  ]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const board = readJson(join(dir, f));
      for (const p of board?.players || []) {
        const id = Number(p.player_id);
        if (!id || seeds.has(id)) continue;
        seeds.set(id, { fpId: id, name: p.player_name, team: p.player_team_id, position: p.player_position_id, byeWeek: p.player_bye_week ?? null });
      }
    }
  }
  for (const l of leagues) {
    for (const t of l.teams) {
      for (const p of t.players) {
        const id = Number(p.fpId);
        if (id && !seeds.has(id)) seeds.set(id, { fpId: id, name: p.name, team: p.team, position: p.position, byeWeek: p.byeWeek ?? null });
      }
    }
  }
  return [...seeds.values()];
}

/**
 * THE player rows: one per player, built one way, shared by every page.
 *
 * Rostered players and free agents used to be built by two different functions,
 * which is how a player could carry a different projection, rank, injury flag or
 * roster % on My Team than on Players. A league roster now holds only ids and
 * that league's own live fields (see `leagueFields`); the page reads everything
 * else from these rows.
 */
function buildUniverse(seeds, scoring, enricher) {
  return seeds.map((seed) => slim({ ...seed, fp: enricher.fpFor(seed, scoring) }));
}

/**
 * The signal, thinned for transport. Short keys because this rides on every
 * player in a pool of ~800, twice over.
 */
const slimSignal = (g) => g && {
  h: g.heat ?? null,          // 0-100, better of the two boards' percentiles
  r: g.addsPerHr ?? null,     // Sleeper adds/hr over the short window
  v: g.surge ?? null,         // that rate against the preceding window
  a: g.slAdds ?? null,        // Sleeper adds, long window
  d: g.slDrops ?? null,
  ya: g.yAdds ?? null,        // Yahoo adds for the day
  yd: g.yDrops ?? null,
  yn: g.yNet ?? null,
  yr: g.yRostered ?? null,    // % of Yahoo leagues rostering him
  ys: g.yStarted ?? null,
  yc: g.yAddsChange ?? null,  // adds vs the previous day
  yrc: g.yRosteredChange ?? null,
  dt: g.yDate ?? null,        // which day the Yahoo half is from
  nt: g.note ?? null,         // Yahoo's own game note, e.g. "Final W 28-20 vs Dal"
  hist: g.history ?? null,
};

/**
 * FantasyPros' league analysis (see leagueanalysis.js), thinned for transport.
 *
 * Players are keyed by fpId and carry only what the universe row does not
 * already have: name, position and team come from `pools`, so they are not
 * repeated here for every rostered player of every period.
 */
export function slimAnalysis(a, asOf = null) {
  if (!a || !(a.ros || a.week)) return null;
  const period = (x) => x && {
    period: x.period,
    basis: x.basis,
    slots: x.slots,
    teams: x.teams,
    ok: x.scoreMatchesGrid,
    drift: x.maxScoreDrift,
    me: x.me,
    players: Object.fromEntries(Object.entries(x.players).map(([id, p]) => [id, {
      tid: p.teamId, slot: p.slot, vorp: p.vorp, value: p.value, pRank: p.pRank, oRank: p.oRank,
    }])),
  };
  return { asOf, ros: period(a.ros), week: period(a.week) };
}

/**
 * One player, thinned for transport. League-independent: the same row serves
 * every league that scores in this format.
 */
const slim = (p) => {
  const f = p.fp || {};
  const sch = f.schedule || {};
  return {
    i: p.fpId,
    n: p.name,
    t: p.team,
    p: p.position,
    bye: p.byeWeek ?? sch.bye ?? null,
    s: f.sleeperId ?? null,
    wk: f.weekPoints ?? null,
    // Rankings-implied vs. FantasyPros' own projections model, kept apart —
    // see the note on weekExpertPoints/weekProjPoints in enrich.js.
    wkX: f.weekExpertPoints ?? null,
    wkP: f.weekProjPoints ?? null,
    rk: f.weekRank ?? null,
    pr: f.weekPosRank ?? null,
    tr: f.weekTrend ?? null,
    rmin: f.expertSpread?.min ?? null,
    rmax: f.expertSpread?.max ?? null,
    rave: f.expertSpread?.ave ?? null,
    // The same expert spread on the rest-of-season board.
    rosMin: f.rosSpread?.min ?? null,
    rosMax: f.rosSpread?.max ?? null,
    rosAve: f.rosSpread?.ave ?? null,
    /**
     * FantasyPros trade market: what managers actually pay for him, on a
     * ~1000-point scale, with the ten-day series behind it. `s`/`n` share the
     * date axis in `payload.trade[format].dates`. Null means UNPRICED (K, DST,
     * fringe players), which is not the same as cheap.
     */
    tm: f.trade ? {
      v: f.trade.value ?? null,
      pv: f.trade.prev ?? null,
      rk: f.trade.rank ?? null,
      pr: f.trade.posRank ?? null,
      s: f.trade.series ?? null,
      n: f.trade.volume ?? null,
      ...tmExpert(f),
    } : null,
    ros: f.rosPoints ?? null,
    // Games the player's team has left (bye removed) and FantasyPros' per-game rate:
    // the agreed ROS number prices a rank per game, then multiplies by these games.
    rosG: f.rosGames ?? null,
    rosPg: f.rosPerGame ?? null,
    rosRk: f.rosRank ?? null,
    rosPr: f.rosPosRank ?? null,
    g: f.startSitGrade ?? null,
    // The NFL schedule is what names the opponent (and the side), the FP board
    // only fills in where the schedule has no row.
    opp: sch.opp ? (sch.home ? sch.opp : `@${sch.opp}`) : (f.opponent ?? null),
    own: f.ownedPct ?? null,
    sig: slimSignal(f.signal),
    inj: f.injury?.status ?? null,
    injT: f.injury?.type ?? null,
    // Cheat-sheet copy: the ranking blurb when FantasyPros wrote one, else the
    // latest injury-news headline. Kickoff text is not a note.
    blurb: f.note ? String(f.note).replace(/\s+/g, ' ').trim().slice(0, 240) : null,
    nw: (f.news && f.news[0] && f.news[0].title) || null,
    pts: f.scored?.points ?? null,
    // Week -> points scored, for every week the stat file (or FP) has.
    // The matchup board's league points still win on the page when present.
    act: f.actualWeeks ?? null,
    /** Draft Sharks' current-week cell + its own ROS total — a second opinion, not a curve. */
    ds: f.draftsharks ? {
      wk: f.draftsharks.week ?? null,
      d3: f.draftsharks.d3 ?? null,
      floor: f.draftsharks.floor ?? null,
      ceiling: f.draftsharks.ceiling ?? null,
      opp: f.draftsharks.opponent ?? null,
      sos: f.draftsharks.sos ?? null,
      rk: f.draftsharks.rank ?? null,
      bye: !!f.draftsharks.bye,
      ros: f.draftsharks.rosTotal ?? null,
      rosW: f.draftsharks.rosWeekly ?? null,
      // Draft Sharks publishes floor/ceiling for the ROS board too, not just the week.
      rosFloor: f.draftsharks.rosFloor ?? null,
      rosCeiling: f.draftsharks.rosCeiling ?? null,
      cons: f.draftsharks.consensus ?? null,
      prk: f.draftsharks.posRank ?? null,
      tier: f.draftsharks.tier ?? null,
      st: f.draftsharks.stats ?? null,
      rosCons: f.draftsharks.rosConsensus ?? null,
      rosD3: f.draftsharks.rosD3 ?? null,
      rosG: f.draftsharks.rosGames ?? null,
      rosPrk: f.draftsharks.rosPosRank ?? null,
      rosTier: f.draftsharks.rosTier ?? null,
      rosSt: f.draftsharks.rosStats ?? null,
      // 3D Value (0-100) is Draft Sharks' trade value; `dv` is its latest change.
      val: f.draftsharks.value ?? null,
      dv: f.draftsharks.valueDelta ?? null,
      mkt: f.draftsharks.marketValue ?? null,
      inj: f.draftsharks.injuryRisk ?? null,
    } : null,
    sch: f.schedule || null,
    /**
     * VegasEdge, this week only: sportsbook props scored at this format, the
     * position rank by them (complete markets only), and the simulation's
     * spread — p10 floor, p50, p90 ceiling, boom/bust share, and the skew.
     */
    vg: f.vegas ? {
      wk: f.vegas.points ?? null,
      prk: f.vegas.posRank ?? null,
      ok: f.vegas.complete,
      miss: f.vegas.missing ?? null,
      vol: f.vegas.volatility ?? null,
      fl: f.vegas.floor ?? null,
      md: f.vegas.median ?? null,
      ce: f.vegas.ceiling ?? null,
      boom: f.vegas.boom ?? null,
      bust: f.vegas.bust ?? null,
      sk: f.vegas.skew ?? null,
      ds: f.vegas.distStatus ?? null,
      st: f.vegas.stats ?? null,
      tdm: f.vegas.tdMethod ?? null,
    } : null,
    /** Dynasty Daddy's player data: age, ADP, Sleeper roster/start rates and three sites' ROS ranks. */
    dd: f.dd ? {
      age: f.dd.age ?? null,
      adp: f.dd.adp ?? null,
      own: f.dd.owned ?? null,
      st: f.dd.started ?? null,
      inj: f.dd.inj ?? null,
      // ESPN, FanDuel and FantasyGuys rest-of-season overall ranks (FantasyPros'
      // own is `rosRk`) — League Value reads them as expert-rank signals.
      r: f.dd.ros ? [f.dd.ros.espn ?? null, f.dd.ros.fanduel ?? null, f.dd.ros.fantasyguys ?? null] : null,
    } : null,
  };
};

/**
 * The experts' side of FantasyPros' trade market.
 *
 * `tradeMarketValues` carries `expertValue` for only a handful of players.
 * Dynasty Daddy's FantasyPros redraft market used to fill the rest; it went
 * with the other markets, so an expert value is shown only where FantasyPros
 * itself publishes one.
 */
export function tmExpert(f) {
  const xv = f.trade?.expert?.value ?? null;
  const v = f.trade?.value ?? null;
  return {
    xv,
    x: f.trade?.expert?.gap ?? (xv != null && v != null ? Math.round(xv - v) : null),
    xs: xv != null ? 'fp' : null,
  };
}

/**
 * Dynasty Daddy's copy of a league, for what MyPlaybook cannot give: every
 * week's pairings (future ones included) and Sleeper's potential points.
 * Team ids are the host's own, the same ids the scrape uses.
 */
export function slimDDLeague(snap, week) {
  if (!snap) return null;
  return {
    fetchedAt: snap.fetchedAt ?? null,
    scoredThrough: snap.scoredThrough ?? 0,
    // A cached ESPN copy keeps answering with scores frozen at its last load.
    stale: (snap.scoredThrough ?? 0) < Number(week) - 1,
    playoffStartWeek: snap.playoffStartWeek ?? null,
    schedule: Object.fromEntries(Object.entries(snap.schedule || {}).map(([w, rows]) => [w, rows.map((sides) => sides.map((x) => ({ id: x.id })))])),
    metrics: Object.fromEntries((snap.teams || []).filter((t) => t.metrics).map((t) => [t.id, { ppts: t.metrics.ppts ?? null }])),
  };
}

/**
 * What only a LEAGUE knows about a rostered player: this league's actual points
 * for the week under its own scoring (`lp`, which is why `pts` - FantasyPros'
 * season total under a generic format - is a different number answering a
 * different question), the host's live-adjusted projection, and the slot and
 * game state. Everything else about the player is read from the shared row.
 */
const leagueFields = (p, leaguePts) => {
  const lp = leaguePts ? leaguePts.get(Number(p.fpId)) : null;
  return {
    i: p.fpId,
    ...(lp ? { lp: lp.pts, lproj: lp.proj, lslot: lp.slot, lgame: lp.game } : {}),
  };
};

/**
 * fpId -> this league's own numbers for the week, from the live board.
 *
 * The board is fetched per team, so it covers EVERY roster in the league, not
 * just the two teams in your matchup — which is what lets the roster tables,
 * the scoreboard and the matchup page all read the same league-scored number.
 */
function leaguePointsIndex(leagueScores) {
  const idx = new Map();
  if (!leagueScores?.ok) return idx;
  for (const m of leagueScores.matchups || []) {
    for (const side of m.sides || []) {
      for (const line of [...(side.starters || []), ...(side.bench || [])]) {
        if (line.fpId == null) continue;
        idx.set(Number(line.fpId), {
          pts: line.pts, proj: line.proj, slot: line.slot, game: line.game,
        });
      }
    }
  }
  return idx;
}

/** A lineup slot, thinned the way `slim` thins a player. */
const slimLine = (x) => ({
  slot: x.slot, pos: x.pos, i: x.fpId, n: x.name, t: x.team, opp: x.opp,
  ecr: x.ecr, proj: x.proj, proj0: x.proj0, pts: x.pts,
  game: x.game, score: x.score, clock: x.clock, pre: x.pre, over: x.over,
  min: x.min, inj: x.inj,
});

/**
 * Every stored week's board for one league, thinned for the week picker.
 *
 * The CURRENT week lives in `matchups`; this carries the past weeks that are
 * on disk, so the Matchup page and My Team's week picker can re-open a finished
 * week and the week-by-week tab can show ACTUALS instead of re-projecting a
 * week that already happened.
 *
 * `playerPts` is every rostered player's league-scored points for that week,
 * keyed by fpId — a stale week that was captured mid-game carries whatever it
 * captured, which is why the UI always labels the source week.
 */
function buildScoreBoard(season, weeks, league, currentWeek) {
  const leagueKey = league.key;
  const board = {};
  for (const w of weeks) {
    const wkFile = readScores(season, w);
    const lg = wkFile?.leagues?.[leagueKey];
    if (!lg?.ok || !(lg.matchups || []).length) continue;
    // Older files can still hold the all-noMatchup garbage; never surface it.
    const matchups = lg.matchups.filter((x) => x.sides.length > 1 || !/no\s*matchup/i.test(String(x.status || '')));
    if (!matchups.length) continue;
    const playerPts = {};
    for (const x of matchups) {
      for (const s of x.sides) {
        for (const line of [...(s.starters || []), ...(s.bench || [])]) {
          if (line.fpId == null || line.pts == null) continue;
          const id = Number(line.fpId);
          if (!(id in playerPts)) playerPts[id] = line.pts;
        }
      }
    }
    board[String(w)] = {
      week: w,
      fetchedAt: lg.fetchedAt ?? wkFile?.fetchedAt ?? null,
      // A past week whose board still has an unfinished matchup is not "in
      // progress" — MyPlaybook has no way to answer for a past week, so this
      // is the last snapshot this app will ever have of it. A stuck 0-0 or
      // notStarted card here means the sync that would have caught the real
      // score never ran before the week rolled over, not that the game
      // hasn't happened.
      stale: w < currentWeek && !matchups.every(isFinal),
      matchups: matchups.map((x) => ({
        status: x.status, pre: x.isPreGame, final: isFinal(x),
        minutesLeft: x.minutesLeft, winProb: x.winProbability, result: x.result,
        sides: x.sides.map((s) => ({
          id: s.teamId, name: s.name, logo: s.logo,
          pts: s.points, proj: s.projected,
          starters: (s.starters || []).map(slimLine),
          bench: (s.bench || []).map(slimLine),
        })),
      })),
      playerPts,
    };
  }

  /**
   * Fill gaps with Sleeper's own record, where MyPlaybook's frozen snapshot
   * is missing or caught the week before it finished.
   *
   * Unlike MyPlaybook's matchup endpoint, Sleeper's takes a week and answers
   * for any of them — `leaguedetail:backfill` is what populates this cache
   * for past weeks. No per-player lineup here (Sleeper's player ids need the
   * idmap join `buildScoreBoard` does not have at this point), so this covers
   * the team score and final result, not the roster breakdown MyPlaybook's
   * own capture carries when it has one.
   */
  if (supportsLeagueDetail(league.host)) {
    for (let w = 1; w < currentWeek; w++) {
      if (board[String(w)] && !board[String(w)].stale) continue;
      const cache = loadDetailCache(season, w);
      const detail = cache?.leagues?.[leagueKey];
      if (!detail?.supported || !(detail.matchups || []).length) continue;
      const byRoster = new Map((detail.standings || []).map((s) => [s.rosterId, s]));
      board[String(w)] = {
        week: w,
        fetchedAt: cache.fetchedAt ?? null,
        stale: false,
        source: 'sleeper',
        matchups: detail.matchups.map((m) => ({
          status: 'final', pre: false, final: true, minutesLeft: 0, winProb: null, result: null,
          sides: m.sides.map((s) => ({
            id: s.rosterId, name: s.team, logo: s.avatar || byRoster.get(s.rosterId)?.avatar || null,
            pts: s.points, proj: null, starters: [], bench: [],
          })),
        })),
        playerPts: {},
      };
    }
  }
  return board;
}

/** NFL schedule, thinned: per team, bye + remaining weeks' opponent. */
function slimSchedule(store) {
  if (!store?.teams) return null;
  const teams = {};
  for (const [abbr, t] of Object.entries(store.teams)) {
    const weeks = {};
    for (const [w, cell] of Object.entries(t.weeks || {})) {
      weeks[w] = { opp: cell.opp, home: !!cell.home, final: !!cell.final, date: cell.date ?? null };
    }
    teams[abbr] = { bye: t.bye ?? null, weeks };
  }
  return { season: store.season, fetchedAt: store.fetchedAt, teams };
}

/**
 * One line per source at build time: how many players it prices and how its
 * level compares with FantasyPros', so a scale problem is visible in the
 * terminal before anyone opens the page.
 */
function logSourceHealth(log, sc, tables) {
  const fpRows = tables.fp || [], dsRows = tables.draftsharks || [];
  const fpWk = new Map(fpRows.filter((r) => r.wk != null).map((r) => [r.i, r.wk]));
  const ratios = dsRows.filter((r) => r.wk != null && fpWk.has(r.i)).map((r) => r.wk / fpWk.get(r.i)).sort((a, b) => a - b);
  const median = ratios.length ? ratios[ratios.length >> 1] : null;
  log(`  ${sc} sources — fp ${fpRows.length} players, draftsharks ${dsRows.length} players`
    + (median != null ? ` (draftsharks median x${median.toFixed(2)} vs fp)` : ''));
}

/**
 * When each source's numbers for THIS week were last known good, by the short
 * source key the page uses. The site's own recompute time where it publishes
 * one, else when we pulled it — and for Draft Sharks, which is stored per
 * week, the age of the CURRENT week's record, not of the source as a whole.
 */
export function sourceAsOf({ freshness, dsAges, week }) {
  const led = (name) => freshness.find((f) => f.source === name) || null;
  const wk = (rows) => (rows || []).find((r) => Number(r.week) === Number(week)) || null;
  const pick = (r) => (r ? { asOf: r.sourceAt || r.fetchedAt || null, fetchedAt: r.fetchedAt || null, siteAt: r.sourceAt || null } : { asOf: null, fetchedAt: null, siteAt: null });
  return {
    fp: pick(led('fp')),
    ds: pick(wk(dsAges)),
  };
}

export async function buildPayload({ season, week, log = console.log } = {}) {
  const model = readJson(join(DATA, 'enriched.json')) || readJson(join(DATA, 'latest.json'));
  if (!model) throw new Error('No data — run `scrape` then `enrich` first.');
  const { season: yr, week: wk } = resolveWeek({ season: season ?? model.enrichedSeason, week: week ?? model.enrichedWeek });

  log(`Building dashboard payload — season ${yr}, week ${wk}`);

  const signals = loadSignals({ season: yr });
  if (signals.ok) {
    log(`  signals — Sleeper ${signals.counts.sleeper} trending, Yahoo buzz ${signals.counts.yahoo} over ${signals.dates.join(', ')}`);
  } else {
    log('  signals — none (run `buzz:sync` and `trend:sync`)');
  }

  // Read the league-detail cache ONCE, not once per league, and let every
  // league answer from it when it is fresh. Building the dashboard used to fire
  // four Sleeper endpoints per league on every run, immediately after `scrape`
  // had pulled the same leagues.
  // Your corrections, applied over the scrape. Done here rather than in
  // normalize so a re-scrape can never clobber them and the dashboard always
  // reflects the current override file without re-scraping.
  const overrides = loadOverrides();

  // This week's live board and the season points ledger. Both come from disk —
  // `matchups:sync` is what fills them, so a dashboard build never fetches
  // scores itself.
  const scores = readScores(yr, wk);
  const totals = seasonTotals(yr, { throughWeek: wk });
  const complete = completeWeeks(yr, { throughWeek: wk });
  const weeksOnDisk = storedWeeks(yr);

  const detailCache = loadDetailCache(yr, wk);
  const refreshedDetail = { ...(detailCache?.leagues || {}) };
  let detailFetched = 0, detailCached = 0;

  const advCache = loadAdvancedCache(yr, wk);
  const refreshedAdv = { ...(advCache?.leagues || {}) };
  let advFetched = 0, advCached = 0;

  const leagues = [];
  for (const l of model.leagues) {
    const ov = forLeague(l.key, overrides);
    const leaguePts = leaguePointsIndex(scores?.leagues?.[l.key]);
    applyToLeague(l, ov);
    log(`  ${(l.host || '').padEnd(8)} ${l.nickname}${l.nicknameScraped ? ` (was "${l.nicknameScraped}")` : ''}`);
    const [detail, adv] = await Promise.all([
      fetchLeagueDetail(l, wk, { season: yr, cache: detailCache }),
      fetchAdvanced(l, { season: yr, week: wk, cache: advCache }),
    ]);
    if (detail.cached) detailCached++; else if (detail.supported) { detailFetched++; refreshedDetail[l.key] = detail; }
    if (adv.cached) advCached++; else { advFetched++; refreshedAdv[l.key] = adv; }
    const flag = (r) => (r.ok ? 'ok' : (r.inactive ? 'inactive' : 'err'));
    log(`      matchup:${flag(adv.matchup)} standings:${flag(adv.standings)} insights:${flag(adv.insights)}`
      + (adv.cached ? ` (cached ${adv.cachedAgeMin ?? '?'}m)` : '')
      + (detail.cached ? `  detail: cached ${detail.cachedAgeMin ?? '?'}m` : (detail.supported ? '  detail: fetched' : '')));
    leagues.push({
      key: l.key,
      name: l.nickname,
      host: l.host,
      scoring: l.scoring,
      status: l.status,
      leagueId: l.leagueId,
      url: l.url,
      // Players carry over to next season: League Value then weighs the dynasty markets too.
      keepers: !!(l.keepers || l.dynasty),
      myTeamId: l.myTeamId,
      myTeamName: l.myTeamName,
      rosterSlots: l.rosterSlots,
      /**
       * The league's real scoring table, plus your corrections to it.
       *
       * `scraped` is MyPlaybook's reading of the host's rules; `host` is the
       * host's own table where it publishes one (Sleeper does, and its version
       * is the more complete of the two); `over` is what you set in League
       * Setup. All three are carried separately so a disagreement between them
       * is visible instead of silently resolved.
       */
      scoringSystem: l.scoringSystem || null,
      scoringOverride: ov.scoring || {},
      playoffs: l.playoffs,
      waiverType: l.waiverType,
      faabBudget: l.faabBudget,
      // FantasyPros' valuation of every roster in this league, both periods.
      analysis: slimAnalysis(l.analysis, model.generatedAt ?? null),
      teams: l.teams.map((t) => {
        const tot = totals.get(l.key)?.get(String(t.teamId)) || null;
        return {
          id: t.teamId,
          name: t.name,
          nameScraped: t.nameScraped ?? null,
          logo: t.logo,
          mine: !!t.isMine,
          primary: !!t.isPrimary,
          division: t.division ?? null,
          // Accumulated from the weeks we have actually stored, and only from
          // weeks where every matchup finished. Carried with a week count so
          // the UI never presents a two-week sum as a season.
          totals: tot,
          players: t.players.map((p) => leagueFields(p, leaguePts)),
        };
      }),
      transactions: l.transactions.slice(0, 80),
      // Every matchup in the league this week, for every host — the MyPlaybook
      // matchup endpoint answers per teamId, so ESPN and Yahoo get a full board
      // even though neither exposes one any other way.
      matchups: (() => {
        const m = scores?.leagues?.[l.key];
        if (!m?.ok) return { ok: false, reason: m?.error || 'not synced — run `matchups:sync`' };
        // A board synced before kickoff is all single-sided no-matchup cards
        // (0 points every team). Same cleanup the sync applies: drop the junk,
        // so the page and standings read "no live board" instead of "0-0".
        const rows = (m.matchups||[]).filter((x) => (x.sides||[]).length > 1 || !/no\s*matchup/i.test(String(x.status||'')));
        return {
          ok: true,
          week: wk,
          fetchedAt: scores?.fetchedAt ?? null,
          rows: rows.map((x) => ({
            status: x.status, pre: x.isPreGame, final: isFinal(x),
            minutesLeft: x.minutesLeft, winProb: x.winProbability, result: x.result,
            sides: x.sides.map((s) => ({
              id: s.teamId, name: s.name, logo: s.logo,
              pts: s.points, proj: s.projected, proj0: s.projected0,
              // The full lineup for EVERY team, which is what lets the matchup
              // page open any pairing in the league rather than only yours.
              starters: (s.starters || []).map(slimLine),
              bench: (s.bench || []).map(slimLine),
            })),
          })),
        };
      })(),
      // Every past week this app has stored for the league, keyed by week
      // number — the week picker's data source (see buildScoreBoard).
      scoreBoard: buildScoreBoard(yr, weeksOnDisk, l, wk),
      divisions: l.divisions || [],
      // The override record itself rides along, so the dashboard's league
      // editor starts from what is on disk rather than from an empty form.
      overrides: {
        nickname: ov.nickname,
        myTeamIds: ov.myTeamIds,
        primaryTeamId: ov.primaryTeamId,
        teams: ov.teams,
        divisions: ov.divisions,
        playoffs: ov.playoffs,
        waivers: ov.waivers,
        scoring: ov.scoring,
        notes: ov.notes,
      },
      // Which weeks are complete for THIS league — the denominator behind any
      // accumulated points total.
      completeWeeks: complete.get(l.key) || [],
      /**
       * Seeding is computed IN THE PAGE, not here.
       *
       * It used to be computed server-side off Sleeper's standings, which meant
       * it silently never ran for ESPN or Yahoo — the two hosts with no detail
       * endpoint — so a rule configured for those leagues did nothing at all.
       * The page already merges records, divisions and live scores from every
       * source into one row set; seeding belongs on those same rows, or the
       * bracket and the table it sits in disagree about who is winning.
       */
      seedRule: ov.playoffs?.rule ? { ...ov.playoffs, describe: describeRule(ov.playoffs) } : null,
      detail: detail.supported
        ? { supported: true, standings: detail.standings.map(({ playerIds, starters, ...rest }) => rest), matchups: detail.matchups, settings: detail.settings }
        : { supported: false, reason: detail.reason },
      dd: slimDDLeague(loadDDLeague(yr, l.leagueId), wk),
      // MyPlaybook advanced data — only served for the FantasyPros-active league.
      adv: {
        inactive: adv.inactive,
        matchup: adv.matchup.ok ? adv.matchup : { ok: false, inactive: !!adv.matchup.inactive, error: adv.matchup.error },
        standings: adv.standings.ok ? adv.standings : { ok: false, inactive: !!adv.standings.inactive, error: adv.standings.error },
        insights: adv.insights.ok ? adv.insights : { ok: false, inactive: !!adv.insights.inactive, error: adv.insights.error },
        startSit: adv.startSit.ok ? adv.startSit : { ok: false, inactive: !!adv.startSit.inactive, error: adv.startSit.error },
      },
    });
  }

  if (detailFetched) writeDetailCache(yr, wk, refreshedDetail);
  if (detailCached || detailFetched) log(`  league detail — ${detailCached} from cache, ${detailFetched} fetched`);
  if (advFetched) writeAdvancedCache(yr, wk, refreshedAdv);
  if (advCached || advFetched) log(`  advanced — ${advCached} from cache, ${advFetched} fetched (${advFetched * 4} requests)`);

  // One universe per scoring format in use: every FantasyPros-ranked player plus
  // anyone rostered, built by ONE function (see buildUniverse). Rosters in
  // `leagues` carry ids only; the page joins them to these rows.
  const formats = [...new Set(model.leagues.map((l) => LEAGUE_SCORING_TO_API[String(l.scoring || '').toUpperCase()] || 'PPR'))];
  const idMap = await loadIdMap({ season: yr }).catch(() => ({ fpToSleeper: {} }));
  const enricher = createEnricher({ season: yr, week: wk, idMap });
  const nflSchedule = enricher.schedule;
  const pools = {};
  const sourceTables = {};
  const accuracy = {};
  const tradeMeta = {};
  for (const sc of formats) {
    const inFormat = model.leagues.filter((l) => (LEAGUE_SCORING_TO_API[String(l.scoring || '').toUpperCase()] || 'PPR') === sc);
    pools[sc] = buildUniverse(universeSeeds(yr, wk, sc, inFormat), sc, enricher);
    sourceTables[sc] = buildSourceTables({ rows: pools[sc] });
    accuracy[sc] = buildAccuracy({ season: yr, week: wk, scoring: sc, pool: pools[sc] });
    const tm = enricher.tradeMeta(sc);
    if (tm) tradeMeta[sc] = { sourceAt: tm.sourceAt ?? null, fetchedAt: tm.fetchedAt ?? null, anchorDate: tm.anchorDate ?? null, windowDays: tm.windowDays ?? null, dates: tm.dates ?? [], priced: tm.counts?.priced ?? null };
    logSourceHealth(log, sc, sourceTables[sc]);
  }

  const freshness = freshnessReport();
  const dsAges = dsWeekReport(yr, formats[0] || 'PPR');
  const directory = leagueDirectory(model.leagues);

  const payload = {
    generatedAt: new Date().toISOString(),
    season: yr,
    week: wk,
    leagues,
    pools,
    // Each source's own numbers, one table per source per scoring format —
    // see src/sourcetables.js for what each holds and what it never blends.
    sourceTables,
    sourceMeta: SOURCE_META,
    rosBasis: ROS_BASIS,
    sourceOrder: SOURCE_ORDER,
    // Projections vs what players actually scored, for every completed week.
    accuracy,
    // Trade-market provenance per scoring format (the date axis for `tm.s`).
    trade: tradeMeta,
    signals: {
      ok: signals.ok,
      buzzDate: signals.buzzDate,
      buzzStale: signals.buzzStale,
      dates: signals.dates,
      trendFetchedAt: signals.trendFetchedAt,
      windows: signals.windows,
      counts: signals.counts,
    },
    // Per-source ages, so the UI can say how old each number is rather than
    // implying everything on the page was fetched at the same moment. Each row
    // carries both clocks and whether the site republished between our last
    // two pulls — a source fetched a minute ago that has not moved since this
    // morning is the case that looks fine and is not.
    freshness,
    // Draft Sharks is stored per week, so its age is the CURRENT week's
    // record, not the source as a whole.
    dsAges,
    // What each source's THIS-week numbers are as of.
    sourceAsOf: sourceAsOf({ freshness, dsAges, week: wk }),
    schedule: slimSchedule(nflSchedule),
    scoreWeeks: weeksOnDisk,
    // Every league on the account with its on/off state, scraped or not — the
    // All Leagues page is where an inactive league is switched back on.
    directory,
    // What a sync can run, for the Sync page (and the command palette) to offer
    // even when no server is answering.
    steps: stepRows(),
    presets: PRESETS,
    // The permanent log's tail, so the Log page has history without a server.
    runlog: runlogTail({ limit: 500 }),
    // The vocabulary the league editor offers, defined once in overrides.js so
    // the UI and the CLI cannot drift apart on what a rule is called.
    rules: {
      seed: Object.fromEntries(Object.entries(SEED_RULES).map(([k, v]) => [k, v.label])),
      tiebreak: Object.fromEntries(Object.entries(TIEBREAK).map(([k, v]) => [k, v.label])),
    },
  };
  log(`  ${leagues.length} leagues, players: ${formats.map((f) => `${f}=${pools[f].length}`).join(' ')}`);
  return payload;
}

/**
 * Every league the account has: the scrape's directory, plus anything scraped
 * or switched off before the directory existed. Scraped leagues are the ones
 * with data on the page; the rest are names and a switch.
 */
export function leagueDirectory(scraped = [], { directory = loadDirectory(), state = loadState() } = {}) {
  const out = new Map();
  for (const l of directory) out.set(l.key, { ...l });
  for (const l of scraped) {
    const prev = out.get(l.key) || {};
    out.set(l.key, { ...prev, key: l.key, name: l.nickname || prev.name, host: l.host || prev.host, scoring: l.scoring || prev.scoring });
  }
  // A league known only from the on/off file is one you switched OFF before
  // the directory existed. One still marked on there but absent from both
  // lists is a league the account no longer has (last season's), not one to show.
  for (const [key, st] of Object.entries(state.leagues || {})) {
    if (!out.has(key) && st.active === false) out.set(key, { key, name: st.nickname || key, host: st.host || null, scoring: null });
  }
  const have = new Set(scraped.map((l) => l.key));
  return [...out.values()].map((l) => ({
    key: l.key, name: l.name, host: l.host ?? null, scoring: l.scoring ?? null,
    active: isActive(state, l.key), scraped: have.has(l.key),
  }));
}

/** Injects the payload into the HTML shell and writes the standalone file. */
/**
 * Put the payload into the template.
 *
 * Exported separately from the build because both halves of it are one
 * character away from silently destroying the page, and neither failure is
 * visible in anything but a browser.
 */
export function renderHtml(shell, payload) {
  // Pure modules are inlined as text (`/*__INLINE:file.js__*/`) so the page
  // runs the very functions the tests do. They are named in the template and
  // read here, at render time, never at import: `serve` and a dashboard Sync
  // keep one Node process alive for hours, and a renderer holding its own list
  // of modules, loaded at startup, rebuilt the page from a NEWER template that
  // named a module it did not know. The placeholder stayed a comment and the
  // page died on load with "LV_MIXES is not defined".
  // Escape everything that can end a script block or break the parse: `<` for
  // `</script>`, and U+2028/U+2029, which are literal line terminators in JS
  // source but legal inside a JSON string — a player note containing one would
  // produce an unterminated string at parse time.
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  // A function replacement, because a string one would interpret `$&`, `$'` and
  // `$$` in the payload as substitution patterns — a team named "Money$$" was
  // enough to silently corrupt the JSON and blank the whole page.
  const filled = shell.replace(/\/\*__INLINE:([\w.-]+\.js)__\*\//g, (_, file) => inlineModule(file));
  // Anything still shaped like a placeholder would ship a page that cannot
  // start. Refuse to write it; the previous dist/dashboard.html stays. Checked
  // before the payload goes in, which may quote anything.
  const left = filled.replace('/*__DATA__*/null', '').match(/\/\*__[A-Z][\w:.-]*__\*\//);
  if (left) throw new Error(`renderHtml: template placeholder ${left[0]} was not filled — is this process older than src/dashboard.template.html? Restart it.`);
  return filled.replace('/*__DATA__*/null', () => json);
}

export async function buildDashboard({ season, week, out = join(ROOT, 'dist', 'dashboard.html'), log = console.log } = {}) {
  const payload = await buildPayload({ season, week, log });
  const shell = readFileSync(join(ROOT, 'src', 'dashboard.template.html'), 'utf8');
  const html = renderHtml(shell, payload);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  log(`\n${out} (${kb} KB)`);
  return { out, payload };
}
