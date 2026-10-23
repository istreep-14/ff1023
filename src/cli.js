#!/usr/bin/env node
/**
 * The CLI entrypoint and its command dispatch table (`help` lists them).
 *
 * Each command is one async method on `commands{}` named exactly what the user
 * types; the dispatch tail owns --help/--version, unknown commands and error
 * exit codes. Command bodies stay thin — parse args, delegate to the module
 * that owns the work. `docs/architecture.md` is the fastest map of which
 * command does what.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ROOT, config } from './config.js';
import { resolveLeagues, ENDPOINTS } from './fantasypros.js';
import { loadDictionary } from './players.js';
import { scrape } from './scrape.js';
import { exportCsv } from './export.js';
import * as fp from './fpapi.js';
import { scoringsInUse } from './fpapi.js';
import { fpSync } from './fpsync.js';
import { resolve as resolveWeek } from './week.js';
import { enrich, runEnrich } from './enrich.js';
import { loadState, isActive, setActive, setOnly, applyFilters } from './leaguestate.js';
import { auditSources, formatAudit } from './sourceaudit.js';
import { loadIdMap } from './idmap.js';
import { buildDashboard, sourceAsOf } from './dashboard.js';
import { report as freshnessReport, record, since } from './freshness.js';
import { buzzSync, fetchDay, recentDates } from './buzz.js';
import { tradeSync } from './trademarket.js';
import { ddPlayersSync, ddLeagueSync } from './dynastydaddy.js';
import { trendSync, fetchAll as fetchTrending } from './sleepertrend.js';
import { loadSignals } from './signals.js';
import { runPipeline, printStatus, pipelineMods, PRESETS } from './sync.js';
import { dsSync, dsWeekReport } from './draftsharks.js';
import { vegasSync } from './vegas.js';
import { tail as runlogTail } from './runlog.js';
import { writeJsonAtomic } from './jsonfile.js';
import { scheduleSync, readSchedule, repairStore, emptyTeams, importScheduleWeeks, filePath as scheduleFilePath } from './schedule.js';
import { parseArgs, resolveLeague } from './args.js';
import * as ov from './overrides.js';
import { syncLeagueDetail, backfillLeagueDetail } from './leaguedata.js';
import { matchupsSync } from './matchups.js';
import { syncActuals } from './actuals.js';
import { captureScript, ingestScores, readClipboard, bookmarklet } from './scoresingest.js';
import { execFileSync } from 'node:child_process';

const [, , cmd, ...rest] = process.argv;
const { positional, flag, opt } = parseArgs(rest);

const resolveLeagueArg = () => resolveLeague(loadLatest().leagues, positional);

function loadLatest() {
  const p = join(DATA, 'latest.json');
  if (!existsSync(p)) throw new Error('No data yet — run `npm run scrape` first.');
  return JSON.parse(readFileSync(p, 'utf8'));
}

const commands = {
  async leagues() {
    const leagues = await resolveLeagues();
    const state = loadState();
    const on = leagues.filter((l) => isActive(state, l.key)).length;
    console.log(`${leagues.length} league(s) for ${config.email || '(keys only)'} — ${on} active, ${leagues.length - on} inactive\n`);
    console.log('  ON   HOST      SCORING  NICKNAME                        KEY');
    for (const l of leagues) {
      console.log(
        ` ${isActive(state, l.key) ? ' \u2713 ' : ' \u00b7 '}  `,
        (l.host || '?').padEnd(9),
        (l.scoring || '-').padEnd(8),
        (l.nickname || l.name || '-').slice(0, 30).padEnd(31),
        l.key,
      );
    }
    console.log('\n  leagues:on <name> | leagues:off <name> | leagues:only <name> [name...]');
  },

  async 'leagues:on'() {
    const hits = setActive(await resolveLeagues(), positional[0], true);
    if (!hits.length) throw new Error(`No league matched "${positional[0]}"`);
    console.log(`activated: ${hits.map((l) => l.nickname || l.name).join(', ')}`);
  },

  async 'leagues:off'() {
    const hits = setActive(await resolveLeagues(), positional[0], false);
    if (!hits.length) throw new Error(`No league matched "${positional[0]}"`);
    console.log(`deactivated: ${hits.map((l) => l.nickname || l.name).join(', ')}`);
  },

  async 'leagues:only'() {
    if (!positional.length) throw new Error('Name at least one league to keep active.');
    const kept = setOnly(await resolveLeagues(), positional);
    if (!kept.length) throw new Error(`No league matched ${positional.join(', ')}`);
    console.log(`active now: ${kept.map((l) => l.nickname || l.name).join(', ')}`);
  },

  async 'leagues:all'() {
    const leagues = await resolveLeagues();
    setOnly(leagues, leagues.map((l) => l.key));
    console.log(`activated all ${leagues.length} leagues`);
  },

  async scrape() {
    const only = opt('league');
    const eps = opt('endpoints')?.split(',') || Object.keys(ENDPOINTS);
    const { model } = await scrape({ filter: only, limit: opt('limit'), all: flag('all'), endpoints: eps });
    if (model.unresolvedPlayerIds.length) {
      console.log(`\nNote: ${model.unresolvedPlayerIds.length} player id(s) not in the ECR dictionary: ${model.unresolvedPlayerIds.join(', ')}`);
    }
  },

  async players() {
    const dict = await loadDictionary({ refresh: flag('refresh') });
    console.log(`${dict.count} players (fetched ${dict.fetchedAt})`);
    const q = positional[0];
    if (q) {
      const hits = Object.values(dict.players).filter((p) => p.name?.toLowerCase().includes(q.toLowerCase()));
      for (const p of hits.slice(0, 20)) console.log(`  ${String(p.fpId).padEnd(7)} ${(p.name||'').padEnd(24)} ${p.position} ${p.team}  ppr ${p.ranks?.ppr ?? '-'} | half ${p.ranks?.half ?? '-'} | std ${p.ranks?.std ?? '-'} | ${p.position}${p.ranks?.pos ?? '-'}`);
    }
  },

  async roster() {
    const model = loadLatest();
    const q = (positional[0] || '').toLowerCase();
    const leagues = q ? model.leagues.filter((l) => l.nickname?.toLowerCase().includes(q) || l.key === positional[0]) : model.leagues;
    if (!leagues.length) throw new Error(`No league matched "${positional[0]}"`);
    for (const l of leagues) {
      console.log(`\n=== ${l.nickname} (${l.host}, ${l.scoring}) — ${l.teams.length} teams, ${l.playerCount} players [${l.status}] ===`);
      if (l.status !== 'active') console.log(`  (no roster data upstream — ${l.status})`);
      for (const t of l.teams) {
        console.log(`\n  ${t.name}${t.isMine ? '  <-- you' : ''} [team ${t.teamId}]`);
        for (const p of t.players) {
          console.log(`    ${String(p.position || '--').padEnd(4)} ${(p.name || '').padEnd(26)} ${(p.team || '').padEnd(4)} ovr ${String(p.ecrOverall ?? '-').padStart(4)}  ${String(p.position || '')}${p.ecrPosition ?? '-'}`);
        }
      }
    }
  },

  /** Moves, kept whole: the add and the drop that paid for it on one line. */
  async transactions() {
    const model = loadLatest();
    const name = (i) => `${i.playerName || '?'}${i.playerPos ? ` (${i.playerPos})` : ''}`;
    for (const l of model.leagues) {
      if (!l.transactions.length) continue;
      console.log(`\n=== ${l.nickname} (${l.host}) ===`);
      for (const t of l.transactions) {
        const parts = [];
        if (t.adds.length) parts.push('+ ' + t.adds.map(name).join(', '));
        if (t.drops.length) parts.push('- ' + t.drops.map(name).join(', '));
        console.log(
          `  ${t.date?.slice(0, 10)}  ${String(t.kind).padEnd(5)}${t.viaWaivers ? ' W' : '  '} ` +
          `${(t.teamName || '').slice(0, 26).padEnd(27)} ${parts.join('   ')}`,
        );
      }
    }
  },

  // ---------------------------------------------------------- FantasyPros API

  async 'fp:check'() {
    const { season, week } = resolveWeek({ season: config.season, week: config.week });
    console.log(`season ${season}, week ${week} (override with FP_SEASON / FP_WEEK)`);
    console.log(`scoring formats in use: ${scoringsInUse().join(', ')}`);
    if (!config.apiKey) { console.log('\nFP_API_KEY: not set'); return; }
    console.log(`FP_API_KEY: set (${config.apiKey.length} chars)\n`);
    try {
      const r = await fp.ping();
      console.log(`OK — key works. /nfl/players returned ${r?.players?.length ?? '?'} players.`);
    } catch (err) {
      console.log(err.message);
    }
  },

  /** Everything FantasyPros: public pages, then the two API-only files when FP_API_KEY is set. */
  async 'fp:sync'() {
    await fpSync({ season: opt('season'), week: opt('week'), scorings: opt('scoring')?.split(',') || null });
  },

  async enrich() {
    await runEnrich({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    console.log('  -> data/enriched.json');
  },

  async lineup() {
    const { season } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const idMap = await loadIdMap({ season });
    const m = enrich({ season: opt('season') ?? config.season, week: opt('week') ?? config.week, idMap });
    const q = (positional[0] || '').toLowerCase();
    const leagues = q ? m.leagues.filter((l) => l.nickname?.toLowerCase().includes(q)) : m.leagues;
    if (!leagues.length) throw new Error(`No league matched "${positional[0]}"`);
    let shown = 0;
    for (const l of leagues) {
      const mine = l.teams.find((t) => t.isMine);
      if (!mine) {
        console.log(`\n=== ${l.nickname} (${l.host}) — no roster for your team [${l.status}] ===`);
        continue;
      }
      shown++;
      console.log(`\n=== ${l.nickname} (${l.host}, ${l.scoring}) — ${mine.name}, week ${m.enrichedWeek} ===`);
      console.log('  POS  PLAYER                      TM    FP WK   DS WK   ROS PTS   WK RK  STATUS');
      const rows = [...mine.players].sort((a, b) => (b.fp?.weekPoints ?? -1) - (a.fp?.weekPoints ?? -1));
      for (const p of rows) {
        const f = p.fp || {};
        console.log(
          `  ${String(p.position || '--').padEnd(4)} ${(p.name || '').slice(0, 26).padEnd(27)} ${(p.team || '').padEnd(4)} ` +
          `${String(f.weekPoints ?? '-').padStart(6)} ${String(f.draftsharks?.week ?? '-').padStart(7)} ` +
          `${String(f.rosPoints ?? '-').padStart(9)} ` +
          `${String(f.weekRank ?? '-').padStart(6)}  ${f.injury?.status || ''}`,
        );
      }
    }
    if (shown && !m.fpDataPresent) console.log('\n  (projections/ranks blank — run `fp:sync` once the API key is active)');
  },

  // ------------------------------------------------------------ league edits
  //
  // Everything else in this CLI reads. These write data/league-overrides.json,
  // which is merged over the scrape at dashboard time and is never touched by a
  // re-scrape.

  /** Show one league's overrides, or all of them. */
  async league() {
    const model = loadLatest();
    const q = positional.join(' ');
    const matched = q ? model.leagues.filter((l) => (l.nickname || '').toLowerCase().includes(q.toLowerCase()) || l.key === q) : model.leagues;
    if (!matched.length) throw new Error(`No league matched "${q}"`);
    for (const l of matched) {
      const o = ov.forLeague(l.key);
      console.log(`\n=== ${o.nickname || l.nickname} ${o.nickname ? `(scraped: ${l.nickname})` : ''}`);
      console.log(`  key       ${l.key}`);
      console.log(`  host      ${l.host} · ${l.scoring} · ${l.teams.length} teams`);
      const mine = o.myTeamIds.length ? o.myTeamIds : (l.myTeamId != null ? [l.myTeamId] : []);
      console.log(`  mine      ${mine.length ? mine.map((id) => {
        const t = l.teams.find((x) => String(x.teamId) === String(id));
        const nm = o.teams[String(id)]?.nickname || t?.name || id;
        return `${nm}${String(o.primaryTeamId ?? mine[0]) === String(id) ? ' *' : ''}`;
      }).join(', ') : '(none)'}${o.myTeamIds.length ? '' : '  [from host]'}`);
      console.log(`  playoffs  ${ov.describeRule(o.playoffs) || `(no rule set — host says ${l.playoffs?.teams ?? '?'} teams from week ${l.playoffs?.startWeek ?? '?'})`}`);
      console.log(`  waivers   ${o.waivers.type || l.waiverType || '(unset)'}${o.waivers.claimDays != null ? `, ${o.waivers.claimDays}d claim period` : ''}`);
      if (o.divisions.length) console.log(`  divisions ${o.divisions.map((d) => d.name).join(', ')}`);
      console.log('\n  TEAM                             ID   DIVISION');
      for (const t of l.teams) {
        const to = o.teams[String(t.teamId)] || {};
        const nm = to.nickname || t.name;
        console.log(`  ${(nm + (to.nickname ? ` (was ${t.name})` : '')).slice(0, 32).padEnd(33)}${String(t.teamId).padStart(3)}   ${(to.abbreviation || '').padEnd(7)}${to.division || ''}`);
      }
    }
    console.log(`\n  edits: league:name | league:team | league:abbr | league:mine | league:playoffs | league:waivers | league:division | league:scoring`);
  },

  /** Rename a league. `league:name <key-or-match> <new name>` */
  async 'league:name'() {
    const { league, rest: name } = resolveLeagueArg();
    if (!name) throw new Error('Usage: league:name <league> <new nickname>');
    ov.update(league.key, { nickname: name });
    console.log(`${league.nickname} -> "${name}"`);
  },

  /** Rename a team. `league:team <league> <teamId> <new name>` */
  async 'league:team'() {
    const { league, rest } = resolveLeagueArg();
    const [teamId, ...nameParts] = rest.split(' ');
    const team = league.teams.find((t) => String(t.teamId) === teamId);
    if (!team) throw new Error(`No team ${teamId} in ${league.nickname}. Run \`league ${league.nickname}\` for ids.`);
    const name = nameParts.join(' ');
    if (!name) throw new Error('Usage: league:team <league> <teamId> <new nickname>');
    ov.setTeam(league.key, teamId, { nickname: name });
    console.log(`${league.nickname}: team ${teamId} "${team.name}" -> "${name}"`);
  },

  /**
   * Set a team's badge abbreviation. `league:abbr <league> <teamId> [ABBR]`
   *
   * Shown on the Players and Sources pages beside the crest, where the full
   * team name will not fit. Omit ABBR to clear it and fall back to initials.
   */
  async 'league:abbr'() {
    const { league, rest } = resolveLeagueArg();
    const [teamId, abbr = ''] = rest.split(/\s+/);
    const team = league.teams.find((t) => String(t.teamId) === teamId);
    if (!team) throw new Error(`No team ${teamId} in ${league.nickname}. Run \`league ${league.nickname}\` for ids.`);
    if (abbr.length > ov.ABBR_MAX) throw new Error(`Abbreviation is at most ${ov.ABBR_MAX} characters: "${abbr}".`);
    const next = ov.setTeam(league.key, teamId, { abbreviation: abbr });
    const set = next.teams[String(teamId)].abbreviation;
    console.log(`${league.nickname}: team ${teamId} "${team.name}" badge ${set ? `-> "${set}"` : 'cleared'}`);
  },

  /**
   * Which teams are yours. `league:mine <league> <teamId> [teamId...]`
   *
   * A list, because the host reports exactly one and that is wrong for anyone
   * co-managing or running two teams. The first id given is the primary — the
   * one "My Team" opens on.
   */
  async 'league:mine'() {
    const { league, rest } = resolveLeagueArg();
    const ids = rest.split(/[\s,]+/).filter(Boolean);
    if (!ids.length) throw new Error('Usage: league:mine <league> <teamId> [teamId...]');
    const bad = ids.filter((id) => !league.teams.some((t) => String(t.teamId) === id));
    if (bad.length) throw new Error(`Not a team id in ${league.nickname}: ${bad.join(', ')}`);
    ov.update(league.key, { myTeamIds: ids, primaryTeamId: ids[0] });
    const names = ids.map((id) => league.teams.find((t) => String(t.teamId) === id).name);
    console.log(`${league.nickname}: yours = ${names.join(', ')} (primary: ${names[0]})`);
  },

  /** Assign a team to a division. `league:division <league> <teamId> <division>` */
  async 'league:division'() {
    const { league, rest } = resolveLeagueArg();
    const [teamId, ...div] = rest.split(' ');
    const name = div.join(' ');
    if (!teamId || !name) throw new Error('Usage: league:division <league> <teamId> <division name>');
    const cur = ov.forLeague(league.key);
    const divisions = cur.divisions.some((d) => d.name === name) ? cur.divisions : [...cur.divisions, { id: name, name }];
    ov.update(league.key, { divisions });
    ov.setTeam(league.key, teamId, { division: name });
    console.log(`${league.nickname}: team ${teamId} -> division "${name}"`);
  },

  /**
   * How playoff seeds are decided.
   * `league:playoffs <league> --rule points-wildcard --teams 6 --wildcards 1`
   */
  async 'league:playoffs'() {
    const { league } = resolveLeagueArg();
    const rule = opt('rule');
    if (rule && !ov.SEED_RULES[rule]) {
      throw new Error(`Unknown rule "${rule}". One of: ${Object.keys(ov.SEED_RULES).join(', ')}`);
    }
    const patch = {};
    if (rule) patch.rule = rule;
    if (opt('teams')) patch.playoffTeams = Number(opt('teams'));
    if (opt('division-seeds')) patch.divisionSeeds = Number(opt('division-seeds'));
    if (opt('wildcards')) patch.wildcards = Number(opt('wildcards'));
    if (opt('tiebreak')) patch.tiebreak = opt('tiebreak');
    if (opt('start-week')) patch.startWeek = Number(opt('start-week'));
    if (opt('note')) patch.note = opt('note');
    if (!Object.keys(patch).length) {
      console.log('Rules:');
      for (const [k, v] of Object.entries(ov.SEED_RULES)) console.log(`  ${k.padEnd(16)} ${v.label}`);
      console.log('Tiebreaks:');
      for (const [k, v] of Object.entries(ov.TIEBREAK)) console.log(`  ${k.padEnd(16)} ${v.label}`);
      return;
    }
    const next = ov.update(league.key, { playoffs: patch });
    console.log(`${league.nickname}: ${ov.describeRule(next.playoffs)}`);
  },

  /** Waiver mechanics the hosts do not expose. */
  async 'league:waivers'() {
    const { league } = resolveLeagueArg();
    const patch = {};
    if (opt('type')) patch.type = opt('type');
    if (opt('claim-days')) patch.claimDays = Number(opt('claim-days'));
    if (opt('process-day')) patch.processDay = Number(opt('process-day'));
    if (opt('process-hour')) patch.processHour = Number(opt('process-hour'));
    if (opt('note')) patch.note = opt('note');
    if (!Object.keys(patch).length) {
      throw new Error('Usage: league:waivers <league> [--type rolling|faab|reverse|none] [--claim-days N] [--process-day 0-6] [--process-hour 0-23]');
    }
    const next = ov.update(league.key, { waivers: patch });
    console.log(`${league.nickname}: waivers ${JSON.stringify(next.waivers)}`);
  },

  /**
   * The league's scoring table, and corrections to it.
   *
   * `league:scoring <league>`              print it
   * `league:scoring <league> IntQB -2`     override one stat
   * `league:scoring <league> IntQB --clear`
   *
   * Two readings are printed because two sources disagree: MyPlaybook's read of
   * the host's rules (available for every host, complete for none — it lists no
   * defensive stats at all for a Sleeper league that scores them) and the host's
   * own table where the host publishes one. Yours wins over both.
   */
  async 'league:scoring'() {
    const { league, rest } = resolveLeagueArg();
    const o = ov.forLeague(league.key);
    const parts = rest.split(/\s+/).filter(Boolean);

    if (parts.length) {
      const [stat, val] = parts;
      const next = { ...o.scoring };
      if (flag('clear') || val === undefined) delete next[stat];
      else next[stat] = Number(val);
      ov.update(league.key, { scoring: next });
      console.log(`${league.nickname}: ${stat} ${next[stat] === undefined ? 'cleared' : `= ${next[stat]}`}`);
      return;
    }

    const sys = league.scoringSystem;
    if (!sys) {
      console.log(`${league.nickname}: no scoring table from ${league.host} (run \`scrape\` to refresh).`);
      return;
    }
    console.log(`\n=== ${o.nickname || league.nickname} — ${sys.format || '?'}${sys.custom ? ' (custom scoring on)' : ''}`);
    console.log('\n  STAT          SCRAPED                 YOURS');
    for (const r of sys.rules) {
      const val = r.tiers.length > 1
        ? r.tiers.map((t) => `${t.points}@${t.lower}-${t.upper}`).join(' ')
        : String(r.tiers[0]?.points ?? '—');
      const mine = o.scoring[r.stat];
      console.log(`  ${r.stat.padEnd(13)} ${val.slice(0, 23).padEnd(24)}${mine == null ? '' : mine}`);
    }
    const extra = Object.keys(o.scoring).filter((k) => !sys.rules.some((r) => r.stat === k));
    for (const k of extra) console.log(`  ${k.padEnd(13)} ${'(not in scrape)'.padEnd(24)}${o.scoring[k]}`);
    console.log('\n  Per-player points elsewhere come from the host itself, not from this table.');
  },

  /**
   * Apply a JSON patch exported from the dashboard's league editor.
   * `league:import <file.json>` — or pipe it in.
   */
  async 'league:import'() {
    const file = positional[0];
    if (!file) throw new Error('Usage: league:import <file.json>  (from the dashboard\u2019s Export button)');
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const leagues = body.leagues || body;
    let n = 0;
    for (const [key, patch] of Object.entries(leagues)) { ov.update(key, patch); n++; }
    console.log(`Imported overrides for ${n} league(s) -> ${ov.OVERRIDES_PATH}`);
  },

  // ------------------------------------------------------------- pipeline

  /**
   * Every source, but only the ones that have gone stale.
   *
   * This is what `all` should always have been. `all` is kept as the
   * unconditional escape hatch; this is the one to run repeatedly.
   */
  async sync() {
    const mods = await pipelineMods({ all: flag('all'), scorings: opt('scoring')?.split(',') || null, days: opt('days') || 2 });
    const run = () => runPipeline(mods, {
      force: flag('force'),
      only: opt('only'),
      skip: opt('skip'),
      maxAge: opt('max-age'),
      dryRun: flag('dry-run'),
    });

    const every = Number(opt('watch'));
    if (!every || !Number.isFinite(every) || every <= 0) return void (await run());

    /**
     * Keep going until interrupted.
     *
     * Each pass still honours every source's own TTL, so a one-minute interval
     * does not mean fetching everything once a minute — it means asking the
     * handful of sources that move that often, and for Sleeper's projections
     * asking with an ETag, which costs a 304. The interval is how often we
     * CHECK, not how often we fetch.
     */
    console.log(`Watching — a pass every ${every}m. Ctrl-C to stop.\n`);
    let stop = false;
    process.on('SIGINT', () => { stop = true; console.log('\nStopping after this pass…'); });
    for (let pass = 1; !stop; pass++) {
      console.log(`\n${'─'.repeat(60)}\npass ${pass} · ${new Date().toLocaleTimeString()}`);
      // One bad pass must not end the watch; the next one may well work.
      await run().catch((err) => console.error(`  pass failed — ${err.message.split('\n')[0]}`));
      if (stop) break;
      await new Promise((r) => setTimeout(r, every * 60_000));
    }
  },

  /** How old every source is, and whether the site itself has moved. */
  async status() {
    printStatus();
    // What each source's numbers for THIS week are as of.
    const { season: yr, week: wk } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const asOf = sourceAsOf({
      freshness: freshnessReport(), dsAges: dsWeekReport(yr, opt('scoring') || 'PPR'), week: wk,
    });
    console.log(`\n  Week ${wk} numbers, as of:`);
    for (const k of ['fp', 'ds']) {
      const at = asOf[k]?.asOf;
      console.log(`    ${k.padEnd(4)} ${at ? since(at) : 'unknown'}`);
    }
  },

  // ------------------------------------------------------- Draft Sharks

  /** Current week + ROS. */
  async 'ds:sync'() {
    await dsSync({ season: opt('season'), week: opt('week'), scorings: opt('scoring')?.split(',') || null });
  },

  /** VegasEdge: this week's props-implied projections and their spread. */
  async 'vegas:sync'() {
    await vegasSync({ season: opt('season'), week: opt('week'), scorings: opt('scoring')?.split(',') || null });
  },

  async 'schedule:sync'() {
    const args = { season: opt('season'), week: opt('week') };
    if (opt('week')) return void (await scheduleSync({ ...args, weeks: [Number(opt('week'))] }));
    // Only weeks not yet stored are fetched; --force re-pulls all of them.
    await scheduleSync({ ...args, full: flag('force') });
  },

  /**
   * Manual fallback when `schedule:sync` cannot complete a week — ESPN has been
   * answering empty for the whole slate of some weeks on and off. Feed it a JSON
   * with a real game list per week and it folds each trustworthy week in exactly
   * like a live fetch (byes inferred from the teams absent that week).
   */
  async 'schedule:import'() {
    const file = positional[0];
    if (!file) throw new Error('Usage: schedule:import <file.json> [--season YYYY] — a JSON like { "weeks": { "1": [ { "home": "BUF", "away": "NYJ", "date": "…" } ] } }');
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch (err) { throw new Error(`cannot read ${file}: ${err.message}`); }
    let data;
    try { data = JSON.parse(raw); } catch (err) { throw new Error(`${file} is not valid JSON: ${err.message}`); }
    const { season: yr, week } = resolveWeek({ season: opt('season') ?? data?.season, week: opt('week') });
    const store = repairStore(readSchedule(yr) || { season: yr, fetchedAt: null, weeks: {}, teams: emptyTeams() });
    if (!store.teams || Object.keys(store.teams).length < 32) store.teams = { ...emptyTeams(), ...(store.teams || {}) };
    const folded = importScheduleWeeks(store, data);
    mkdirSync(join(DATA, 'schedule', String(yr)), { recursive: true });
    writeJsonAtomic(scheduleFilePath(yr), store, { indent: 0 });
    for (const f of folded) console.log(`  ok   ${f}`);
    record('schedule', { ok: folded, failed: [], sourceAt: null, season: yr, week, items: Object.keys(store.teams).length, note: `imported ${folded.length} week(s)` });
    console.log(`  imported ${folded.length} week(s) — ${Object.keys(store.teams).length} teams -> ${scheduleFilePath(yr)}`);
  },

  // ------------------------------------------------------- demand signals

  /** Fantasy points for every player, each week — not limited to matchup lineups. */
  async 'actuals:sync'() {
    await syncActuals({ season: opt('season'), week: opt('week') });
  },

  /** Every matchup in every league, live — and the season points ledger. */
  async 'matchups:sync'() {
    await matchupsSync({ season: opt('season'), week: opt('week'), leagues: loadLatest().leagues });
  },

  /** This week's board for one league (or all), printed. */
  async matchups() {
    const { readWeek, storedWeeks, isFinal } = await import('./matchups.js');
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const data = readWeek(season, week);
    if (!data) throw new Error(`No scores for week ${week} — run \`matchups:sync\` first.`);
    const model = loadLatest();
    const q = positional.join(' ').toLowerCase();
    for (const l of model.leagues) {
      if (q && !(l.nickname || '').toLowerCase().includes(q)) continue;
      const m = data.leagues[l.key];
      console.log(`\n=== ${l.nickname} (${l.host}) week ${week} ===`);
      if (!m?.ok) { console.log(`  ${m?.error || 'not synced'}`); continue; }
      for (const x of m.matchups) {
        const [a, b] = x.sides;
        const state = isFinal(x) ? 'FINAL' : (x.isPreGame ? 'pre' : `${x.minutesLeft ?? '?'}m left`);
        const fmt1 = (s) => `${(s?.name || '—').slice(0, 26).padEnd(27)}${String((s?.points ?? 0).toFixed(2)).padStart(7)}`;
        console.log(`  ${state.padEnd(9)} ${fmt1(a)}   ${fmt1(b)}`);
      }
    }
    console.log(`\n  weeks stored: ${storedWeeks(season).join(', ') || 'none'}`);
  },

  /**
   * Fill in every past week's Sleeper league detail — the source that isn't
   * limited to the current week, unlike `matchups:sync`. Run once and every
   * finished week gets real standings-quality scores instead of whatever
   * `matchups:sync` happened to catch before it rolled over.
   */
  async 'leaguedetail:backfill'() {
    const { season, week } = resolveWeek({ season: opt('season'), week: opt('week') });
    const leagues = applyFilters(await resolveLeagues(), { all: flag('all') });
    await backfillLeagueDetail({ season, throughWeek: week, leagues, force: flag('force') });
  },

  /**
   * DevTools snippet for ESPN / Yahoo / Dynasty Daddy. MyPlaybook cannot
   * answer for a week that has rolled over; this runs as same-origin JS in
   * the logged-in tab and copies JSON for `scores:ingest`.
   */
  async 'scores:script'() {
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const opts = { season, throughWeek: week, leagues: loadLatest().leagues };
    const href = bookmarklet(opts);
    try {
      execFileSync('pbcopy', { input: href });
      console.log('Bookmarklet copied. Bookmarks → New bookmark → paste into the URL field.');
      console.log('Click it on a logged-in ESPN or Yahoo league page. If `npm run serve` is up it posts automatically; otherwise paste on Sync or run `node src/cli.js scores:ingest`.');
    } catch {
      console.log(href);
    }
    if (flag('console')) console.log('\n' + captureScript(opts));
  },

  /**
   * Fold a captured dump into data/scores/. Clipboard first, then --file.
   * Does not touch the current week (`matchups:sync` owns the live board).
   */
  async 'scores:ingest'() {
    const file = opt('file') || positional[0];
    let raw = '';
    if (file) {
      if (!existsSync(file)) throw new Error(`cannot read ${file}`);
      raw = readFileSync(file, 'utf8');
    } else {
      raw = readClipboard();
    }
    if (!raw.trim()) {
      throw new Error('Usage: scores:ingest [--file path] — paste scores:script output on the clipboard, or pass a JSON dump');
    }
    let dump;
    try { dump = JSON.parse(raw); } catch (err) {
      throw new Error(`not valid JSON: ${err.message}`);
    }
    const { season, week } = resolveWeek({ season: opt('season') ?? dump?.season ?? dump?.meta?.season, week: opt('week') ?? config.week });
    ingestScores({
      dump,
      leagues: loadLatest().leagues,
      season,
      currentWeek: week,
      force: flag('force'),
      includeSchedule: flag('schedule'),
    });
  },

  /** FantasyPros' trade market values (+ ten-day series) -> data/fp/<season>/trade/. */
  async 'trade:sync'() {
    await tradeSync({ season: opt('season'), week: opt('week'), scorings: opt('scoring')?.split(',') || null });
  },

  /** Dynasty Daddy's player rows: ids, ADP and three sites' ROS ranks, in one request. */
  async 'dd:players'() {
    await ddPlayersSync({ season: opt('season'), week: opt('week') });
  },

  /** Dynasty Daddy's copy of each Sleeper / ESPN league: the full schedule and potential points. */
  async 'dd:league'() {
    await ddLeagueSync({ season: opt('season'), week: opt('week'), leagues: loadLatest().leagues });
  },

  async 'buzz:sync'() {
    await buzzSync({ season: opt('season'), week: opt('week'), days: opt('days') || 2, date: opt('date') });
  },

  /** Yahoo's board for one day, printed. No sync, no files. */
  async buzz() {
    const date = opt('date') || recentDates(1)[0];
    const day = await fetchDay({ date });
    const rows = day.players.slice(0, Number(opt('limit') || 30));
    console.log(`Yahoo BuzzIndex ${date} — ${day.players.length} players\n`);
    console.log('    ADDS   DROPS     NET  ROS%  PLAYER                    POS TM');
    for (const p of rows) {
      console.log(
        `  ${String(p.adds ?? '-').padStart(6)}  ${String(p.drops ?? '-').padStart(6)}  ${String(p.net ?? '-').padStart(6)}` +
        `  ${String((p.pctRostered ?? '-') + '%').padStart(4)}  ${(p.name || '').slice(0, 24).padEnd(25)} ${(p.position || '').padEnd(3)} ${p.team || ''}`,
      );
    }
  },

  async 'trend:sync'() {
    await trendSync({ season: opt('season'), week: opt('week') });
  },

  /** Sleeper's trending board, sorted by how fast the rate is accelerating. */
  async trend() {
    const d = await fetchTrending();
    const sortByVelocity = flag('velocity');
    const rows = d.players
      .filter((p) => !sortByVelocity || p.ratio != null)
      .sort((a, b) => (sortByVelocity ? (b.ratio ?? 0) - (a.ratio ?? 0) : (b.addCount ?? 0) - (a.addCount ?? 0)))
      .slice(0, Number(opt('limit') || 30));
    console.log(`Sleeper trending — ${d.players.length} players, windows ${d.windows.join('h/')}h` +
      `, sorted by ${sortByVelocity ? 'acceleration' : 'adds'}\n`);
    console.log('     ADDS/24H   ADDS/HR   SURGE  PLAYER                    POS TM');
    for (const p of rows) {
      console.log(
        `  ${String(p.addCount ?? '-').padStart(9)} ${String(p.recentPerHr ?? '-').padStart(9)} ` +
        `${String(p.ratio != null ? p.ratio + 'x' : (p.fresh ? 'new' : '-')).padStart(7)}  ` +
        `${(p.name || p.sleeperId).slice(0, 24).padEnd(25)} ${(p.position || '').padEnd(3)} ${p.team || ''}`,
      );
    }
  },

  /** What the joined signal looks like for one player, across both boards. */
  async signal() {
    const { season } = resolveWeek({ season: opt('season') ?? config.season });
    const S = loadSignals({ season });
    if (!S.ok) throw new Error('No signal data — run `buzz:sync` and `trend:sync` first.');
    const name = positional.join(' ');
    if (!name) {
      console.log(`buzz ${S.buzzDate}${S.buzzStale ? ' (STALE)' : ''} · trending ${S.trendFetchedAt} · ` +
        `${S.counts.sleeper} Sleeper / ${S.counts.yahoo} Yahoo`);
      return void console.log('\n  signal <player name> [--position RB]');
    }
    const g = S.signalFor({ name, position: opt('position') });
    if (!g) return void console.log(`${name} — not on either board (outside every top 50).`);
    console.log(`${name}\n`);
    console.log(`  heat          ${g.heat}/100`);
    console.log(`  sleeper       ${g.slAdds ?? '-'} adds / ${S.windows[1]}h · ${g.addsPerHr ?? '-'} per hr now · ` +
      `${g.surge != null ? g.surge + 'x prior rate' : (g.fresh ? 'no prior activity' : 'rate unknown')}`);
    console.log(`  yahoo ${g.yDate || '-'}  ${g.yAdds ?? '-'} adds, ${g.yDrops ?? '-'} drops, net ${g.yNet ?? '-'}` +
      `${g.yAddsChange != null ? ` (${g.yAddsChange > 0 ? '+' : ''}${g.yAddsChange} vs prior day)` : ''}`);
    console.log(`  rostered      ${g.yRostered ?? '-'}% of Yahoo leagues, started ${g.yStarted ?? '-'}%`);
    if (g.note) console.log(`  note          ${g.note}`);
  },

  /** The permanent run log — the same lines the dashboard's Log page shows. */
  async log() {
    const all = runlogTail({ limit: 3000 });
    if (!all.length) return void console.log('Nothing logged yet — every sync writes to data/runlog.jsonl.');
    const rows = all
      .filter((r) => !flag('errors') || r.level === 'error' || r.level === 'warn')
      .filter((r) => !opt('src') || r.src === opt('src'))
      .slice(-Number(opt('limit') || 60));
    if (!rows.length) return void console.log(`No matching line among the last ${all.length}.`);
    for (const r of rows) {
      const t = new Date(r.t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`${t}  ${r.src.padEnd(12)} ${r.msg}`);
    }
  },

  /** Do the stored sources mean what their labels say? Non-zero exit on a failed check. */
  async audit() {
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const a = await auditSources({ season, week, scoring: String(opt('scoring') || 'PPR').toUpperCase() });
    formatAudit(a);
    if (!a.ok) process.exitCode = 1;
  },

  async dashboard() {
    const { out } = await buildDashboard({ season: opt('season'), week: opt('week') });
    console.log(`\nOpen it:  open ${out}`);
  },

  /**
   * Turns the dashboard from a static file into something its own buttons
   * can act on — a sync panel, and League Setup's "Export edits" saving
   * directly instead of downloading a patch file. See src/serve.js for why
   * this exists and what it exposes; it binds to localhost only.
   */
  async serve() {
    const { startServer } = await import('./serve.js');
    const port = Number(opt('port')) || 4173;
    await startServer({ port });
    console.log(`Serving the dashboard at http://localhost:${port} — Ctrl-C to stop.`);
    console.log('Buttons on the Sync page there run the same commands this CLI does.');
  },

  async export() {
    // Prefer the enriched model so the CSVs carry projections/ids too.
    const enrichedPath = join(DATA, 'enriched.json');
    const model = existsSync(enrichedPath) ? JSON.parse(readFileSync(enrichedPath, 'utf8')) : loadLatest();
    if (!existsSync(enrichedPath)) console.log('(no data/enriched.json — run `enrich` first for projection columns)');
    const { dir, counts } = exportCsv(model);
    console.log(`Wrote CSVs to ${dir}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}.csv — ${v} rows`);
  },

  async endpoints() {
    console.log('Per-league endpoints (param: key=<league key>)\n');
    for (const [name, ep] of Object.entries(ENDPOINTS)) {
      console.log(`  ${name.padEnd(14)} ${ep.verified ? 'OK  ' : 'thin'} ${ep.path.padEnd(30)} ${ep.note}`);
    }
    console.log('\nAccount endpoint (param: email=<account email>)\n  userLeagues    OK   getUserLeaguesJSON             every league + its key');
  },

  async help() {
    console.log(`ff — FantasyPros MyPlaybook scraper

  leagues                     list every league on the account
  scrape [--league <name>]    pull all endpoints -> data/raw + data/latest.json
         [--limit N] [--all] [--endpoints a,b]
  leagues:on|off <name>       toggle a league in/out of every sync
  leagues:only <name>...      keep only these active
  leagues:all                 reactivate everything
  roster [name]               print resolved rosters from the last scrape
  transactions [name]         print add/drop history from the last scrape
  players [--refresh] [query] build/search the fpId -> player dictionary
  export                      write leagues/rosters/transactions CSVs
  endpoints                   show the discovered API surface

 Projections + rankings — current week and rest of season, nothing else:
  fp:sync                     FantasyPros: week + ROS rankings, week projections,
                              news, injuries from the public pages; then players/
                              external ids + points scored from the API when
                              FP_API_KEY is set  -> data/fp/
       [--week N] [--season Y] [--scoring PPR,HALF]
  fp:check                    validate FP_API_KEY, show resolved season/week
  ds:sync                     Draft Sharks: week + ROS -> data/draftsharks/
  vegas:sync                  VegasEdge (needs VEGAS_TOKEN): this week's props-implied
                              projections, percentiles, boom/bust -> data/vegas/
  sync --only projections     both of the above, then the joins

 Verification:
  audit [--week N] [--scoring PPR|HALF|STD]
                              check every stored source's scale (vs FantasyPros),
                              week label and age; exit 1 if any fails

LEAGUE EDITS — your corrections, in data/league-overrides.json
  league [name]               show a league's overrides + team ids
  league:name <league> <name> rename a league
  league:team <league> <id> <name>       rename a team
  league:abbr <league> <id> [ABBR]       set (or clear) a team's badge abbreviation
  league:mine <league> <id> [id...]      which teams are yours (first = primary)
  league:division <league> <id> <name>   assign a team to a division
  league:playoffs <league> --rule R [--teams N] [--wildcards N] [--tiebreak T]
                              how seeds are decided (run with no flags to list rules)
  league:waivers <league> [--type T] [--claim-days N] [--process-day 0-6]
  league:scoring <league> [<Stat> <points> | <Stat> --clear]
  league:import <file.json>   apply a patch exported from the dashboard

PIPELINE
  sync                        every source, skipping whatever is still fresh
  sync --force                ignore freshness, fetch everything
  sync --only fp,draftsharks  run just these steps (or a preset: ${Object.keys(PRESETS).join(', ')})
  sync --skip draftsharks     run everything but these
  sync --max-age 30           override the per-source staleness limit (minutes)
  sync --dry-run              show what would run, fetch nothing
  sync --watch N              keep going, a pass every N minutes. Each pass
                              still honours every source's own TTL, so this is
                              how often we CHECK, not how often we fetch
  status                      per-source age, the site's own update time, and
                              whether the site moved between our last two pulls
  log [--limit N] [--errors] [--src fp]
                              the permanent run log (data/runlog.jsonl) — every
                              line every sync printed, CLI or dashboard

SCHEDULE
  schedule:sync [--force]     NFL opponents + byes from ESPN: weeks not yet stored (--force: all 1–18)
  schedule:import <file.json>  manual fallback for weeks ESPN answers empty —
                               fold a games-per-week JSON into the schedule

LEAGUE-WIDE SCORES — works on ESPN and Yahoo, not just Sleeper
  matchups:sync               every matchup in every league -> data/scores/
  matchups [league]           this week's board, printed
  leaguedetail:backfill       Sleeper leagues only — fill in every past week's
                               real scores (Sleeper answers for any week;
                               matchups:sync only ever gets the current one)
  scores:script               bookmarklet that copies ESPN/Yahoo past weeks
                               (click it on the logged-in league page). --console
                               also prints the DevTools snippet
  scores:ingest [--file path] fold that capture into data/scores/ (clipboard
                               if no file). Or paste on the Sync page. Skips
                               the current week. --schedule keeps future pairings
  actuals:sync                every player's fantasy points, each week, from
                               Sleeper stats -> data/actuals/ (PPR, half, standard).
                               Used wherever a matchup lineup has no score.

DEMAND SIGNALS — who the rest of fantasy football is adding, right now
  trade:sync [--scoring PPR,HALF,STD]        FantasyPros trade market values -> data/fp/<season>/trade/
  dd:players                                 Dynasty Daddy player data: ids, ADP, ESPN/FanDuel/FantasyGuys
                                             ROS ranks -> data/dynastydaddy/<season>/players.json
  dd:league                                  Dynasty Daddy's Sleeper/ESPN league load: full
                                             schedule + potential points -> data/dynastydaddy/<season>/leagues/
  buzz:sync [--days N] [--date YYYY-MM-DD]   Yahoo BuzzIndex -> data/buzz/
  buzz  [--date YYYY-MM-DD] [--limit N]      one day's board, printed
  trend:sync                                 Sleeper trending -> data/trend/
  trend [--velocity] [--limit N]             live adds, or adds acceleration
  signal <player name> [--position RB]       both boards for one player

 Dashboard:
  dashboard                   build dist/dashboard.html (league switcher + pages)
  serve [--port N]            serve it live (default 4173) with a Sync page —
                              buttons run the same commands this CLI does, and
                              League Setup saves directly instead of downloading

 Joined views:
  enrich                      join FP data onto rosters -> data/enriched.json
  lineup [league]             your team w/ week + ROS projections, ranks, injuries
`);
  },
};

// `--help` and `--version` before anything else, in either position: they are
// what someone types first, and `ff --version` answering "Unknown command" is
// a bad first impression from a tool that does have the answer.
if (cmd === '--help' || cmd === '-h' || flag('help')) {
  await commands.help();
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v' || flag('version')) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  console.log(`${pkg.name} ${pkg.version} (node ${process.version})`);
  process.exit(0);
}

// Own-property only: `ff constructor` otherwise resolved to Object's and died
// with a TypeError from the prototype chain instead of naming the mistake.
const known = Object.hasOwn(commands, cmd || '');
if (cmd && cmd !== 'help' && !known) {
  console.error(`Unknown command: ${cmd}\n`);
  await commands.help();
  process.exit(1);
}
const fn = known ? commands[cmd] : commands.help;
fn().catch((err) => { console.error(`\nError: ${err.message}`); process.exit(1); });
