import { check, report, MAX_AGE_MIN } from './freshness.js';
import { resolve as resolveWeek } from './week.js';
import { config } from './config.js';
import { logger, RUNLOG } from './runlog.js';

/**
 * One pipeline runner that asks "has this moved?" before paying to find out.
 *
 * Each step declares a max age. A step under its age is skipped with a reason;
 * `--force`, `--only` and `--skip` override. Nothing here decides what data
 * means — it decides only whether to go and get it.
 *
 * The steps are wired ONCE, here (`pipelineMods`). The CLI and the server each
 * used to carry their own copy of the wiring, and the server's had drifted:
 * its Sync page listed `trade`, `actuals`, the backfill and the audit as
 * steps, then reported every one of them "unavailable" because its table
 * simply had no entry for them.
 */

/** Step order matters: joins read what the fetches wrote. */
export function steps(mods) {
  return [
    { name: 'scrape', label: 'MyPlaybook leagues + rosters', run: mods.scrape },
    { name: 'fp', label: 'FantasyPros rankings, projections, news', run: mods.fp },
    { name: 'draftsharks', label: 'Draft Sharks current week + ROS', run: mods.draftsharks },
    { name: 'vegas', label: 'VegasEdge current week: props-implied projections + spread', run: mods.vegas },
    { name: 'trade', label: 'FantasyPros trade market values', run: mods.trade },
    { name: 'ddplayers', label: 'Dynasty Daddy player data (ESPN/FanDuel/FantasyGuys ROS ranks)', run: mods.ddplayers },
    { name: 'schedule', label: 'NFL opponent schedule (weeks not yet stored)', run: mods.schedule },
    { name: 'buzz', label: 'Yahoo BuzzIndex', run: mods.buzz },
    { name: 'trend', label: 'Sleeper trending', run: mods.trend },
    { name: 'leaguedetail', label: 'Sleeper standings + matchups', run: mods.leaguedetail },
    { name: 'leaguedetail-backfill', label: 'Sleeper past weeks', run: mods.leaguedetailBackfill },
    { name: 'ddleague', label: 'Dynasty Daddy league schedules (Sleeper, ESPN)', run: mods.ddleague },
    { name: 'matchups', label: 'Every league\'s live board + score ledger', run: mods.matchups },
    { name: 'actuals', label: 'Weekly fantasy points, every player', run: mods.actuals },
    // Joins are local and cheap; they always run, because a skipped fetch still
    // leaves the previous fetch's data un-joined if a different source moved.
    { name: 'enrich', label: 'Join every source onto rosters', run: mods.enrich, always: true },
    { name: 'dashboard', label: 'Build dist/dashboard.html', run: mods.dashboard, always: true },
    // Last, so it judges what was just built from: is each source at the right
    // scale, filed under the right week, and how old is it.
    { name: 'audit', label: 'Check every source\'s scale, week and age', run: mods.audit, always: true },
  ];
}

/** Named groups the Sync page and `--only` both understand. */
export const PRESETS = {
  live: 'trend,buzz,matchups,actuals,draftsharks,vegas',
  // Everything League Value is built from: rest-of-season projections and ranks.
  projections: 'fp,draftsharks,ddplayers',
  leagues: 'scrape,leaguedetail,ddleague,matchups',
};

/**
 * What every step actually runs. Imported lazily so that `steps()` and the
 * pipeline runner stay cheap to import (the tests, `status`).
 *
 * `all` ignores the per-league on/off switches for the league steps.
 */
export async function pipelineMods({ all = false, scorings = null, days = 2 } = {}) {
  const [
    { scrape }, { fpSync }, { dsSync }, { vegasSync }, { tradeSync }, { ddPlayersSync, ddLeagueSync }, { scheduleSync }, { buzzSync }, { trendSync },
    { syncLeagueDetail, backfillLeagueDetail }, { matchupsSync }, { syncActuals },
    { resolveLeagues }, { applyFilters }, { runEnrich }, { buildDashboard }, { auditSources, formatAudit },
    { readFileSync, existsSync }, { join }, { DATA },
  ] = await Promise.all([
    import('./scrape.js'), import('./fpsync.js'), import('./draftsharks.js'), import('./vegas.js'), import('./trademarket.js'), import('./dynastydaddy.js'),
    import('./schedule.js'), import('./buzz.js'), import('./sleepertrend.js'), import('./leaguedata.js'),
    import('./matchups.js'), import('./actuals.js'), import('./fantasypros.js'), import('./leaguestate.js'),
    import('./enrich.js'), import('./dashboard.js'), import('./sourceaudit.js'),
    import('node:fs'), import('node:path'), import('./config.js'),
  ]);
  const activeLeagues = async () => applyFilters(await resolveLeagues(), { all });
  const scraped = () => {
    const p = join(DATA, 'latest.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).leagues : [];
  };
  return {
    scrape: ({ log }) => scrape({ all, log }),
    fp: ({ season, week, log }) => fpSync({ season, week, scorings, log }),
    draftsharks: ({ season, week, log }) => dsSync({ season, week, scorings, log }),
    vegas: ({ season, week, log }) => vegasSync({ season, week, scorings, log }),
    trade: ({ season, week, log }) => tradeSync({ season, week, scorings, log }),
    ddplayers: ({ season, week, log }) => ddPlayersSync({ season, week, log }),
    ddleague: ({ season, week, log }) => ddLeagueSync({ season, week, leagues: scraped(), log }),
    schedule: ({ season, week, log }) => scheduleSync({ season, week, log }),
    buzz: ({ season, week, log }) => buzzSync({ season, week, days, log }),
    trend: ({ season, week, log }) => trendSync({ season, week, log }),
    leaguedetail: async ({ season, week, log }) => syncLeagueDetail({ season, week, leagues: await activeLeagues(), log }),
    leaguedetailBackfill: async ({ season, week, log }) => backfillLeagueDetail({ season, throughWeek: week, leagues: await activeLeagues(), log }),
    matchups: ({ season, week, log }) => matchupsSync({ season, week, leagues: scraped(), log }),
    actuals: ({ season, week, log }) => syncActuals({ season, week, log }),
    enrich: ({ season, week, log }) => runEnrich({ season, week, log }),
    dashboard: ({ log }) => buildDashboard({ log }),
    audit: async ({ season, week, log }) => formatAudit(await auditSources({ season, week }), log),
  };
}

/** The steps as plain rows, for a page or an API: no run functions. */
export function stepRows() {
  return steps({}).map(({ name, label, always }) => ({ name, label, always: !!always, maxAgeMin: always ? null : (MAX_AGE_MIN[name] ?? 60) }));
}

const list = (v) => (v ? String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null);
const expand = (v) => (v && PRESETS[String(v).toLowerCase()]) || v;

/**
 * The run in progress, if any. The server refuses a second sync while one is
 * going: two runs writing the same files is not twice the freshness.
 */
export const current = { run: null };

export async function runPipeline(mods, {
  force = false, only = null, skip = null, maxAge = null, dryRun = false,
  log = console.log, runlog = RUNLOG, origin = 'cli',
} = {}) {
  const { season, week } = resolveWeek({ season: config.season, week: config.week });
  const onlySet = list(expand(only)), skipSet = list(skip);
  const all = steps(mods);
  const results = [];
  const say = logger({ src: 'sync', echo: log, file: runlog });

  const flags = [force && 'forced', dryRun && 'dry run', onlySet && `only ${onlySet.join(',')}`, skipSet && `skip ${skipSet.join(',')}`].filter(Boolean);
  current.run = { startedAt: new Date().toISOString(), origin, flags, step: null };
  say(`▶ sync — season ${season}, week ${week}${flags.length ? ` (${flags.join('; ')})` : ''} · from ${origin}`);

  try {
    for (const step of all) {
      if (!step.run) { results.push({ ...step, status: 'unavailable' }); continue; }
      // `--only` names which FETCHES to run. The joins are marked `always` and
      // are exempt, because the point of re-fetching one source is to see it on
      // the page: `--only trend` that leaves the dashboard on the previous pull
      // has done nothing at all. `--skip` still stops them, since that is an
      // explicit instruction rather than a selection.
      if (onlySet && !onlySet.includes(step.name) && !step.always) {
        results.push({ ...step, status: 'not selected' });
        continue;
      }
      if (skipSet && skipSet.includes(step.name)) {
        say(`  skip  ${step.name.padEnd(13)} — asked to skip`);
        results.push({ ...step, status: 'skipped' });
        continue;
      }

      let decision = { skip: false, reason: 'always runs' };
      if (!step.always) {
        // --only names a step explicitly, which is a request to run it.
        decision = check(step.name, { maxAgeMin: maxAge != null ? Number(maxAge) : null, force: force || !!onlySet });
      }
      if (decision.skip) {
        say(`  fresh ${step.name.padEnd(13)} — ${decision.reason}`);
        results.push({ ...step, status: 'fresh', ...decision });
        continue;
      }
      if (dryRun) {
        say(`  would ${step.name.padEnd(13)} — ${decision.reason}`);
        results.push({ ...step, status: 'would run', ...decision });
        continue;
      }

      const t0 = Date.now();
      current.run.step = step.name;
      try {
        await step.run({ season, week, log: say.as(step.name) });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        say(`  done  ${step.name.padEnd(13)} — ${secs}s`);
        results.push({ ...step, status: 'ok', seconds: Number(secs) });
      } catch (err) {
        say(`  FAIL  ${step.name.padEnd(13)} — ${err.message.split('\n')[0]}`);
        results.push({ ...step, status: 'failed', error: err.message });
        // Recorded and carried on: a failed fetch must not stop the joins,
        // because the other sources are on disk and a dashboard built from
        // them is strictly better than none.
      }
    }
  } finally {
    current.run = null;
  }

  const ran = results.filter((r) => r.status === 'ok').length;
  const fresh = results.filter((r) => r.status === 'fresh').length;
  const failed = results.filter((r) => r.status === 'failed');
  say(`■ ${ran} run, ${fresh} already fresh, ${failed.length} failed`);
  for (const f of failed) say(`  ${f.name}: FAIL ${f.error.split('\n')[0]}`);
  return results.map(({ run, ...r }) => r);
}

/**
 * The freshness table, printed.
 *
 * Both clocks, side by side, plus whether the site republished between our
 * last two pulls. A row that is freshly fetched and has not moved is the case
 * that matters: it looks current and is not.
 */
export function printStatus(log = console.log) {
  const rows = report();
  if (!rows.length) return void log('No sync has been recorded yet — run `npm run sync`.');
  log('  SOURCE          FETCHED    SITE SAID   MOVED    ITEMS  STATE');
  for (const r of rows) {
    const moved = r.moved === null ? '—' : (r.moved ? 'yes' : 'no');
    const state = r.stale ? `stale (>${r.limitMin}m)` : 'fresh';
    log(
      `  ${r.source.padEnd(15)} ${String(r.age).padStart(8)}  ${String(r.sourceAge || '—').padStart(10)}  ${moved.padStart(5)}  ` +
      `${String(r.items ?? '—').padStart(7)}  ${state}` +
      (r.sourceStale ? ', site is behind' : '') +
      (r.failed ? `, ${r.failed} failed` : ''),
    );
  }
  log('\n  "site said" is the source\'s OWN recompute time where it publishes one;');
  log('  "moved" is whether that time changed between our last two pulls.');
  log('  MyPlaybook publishes none, so it is governed by our clock alone.');
}
