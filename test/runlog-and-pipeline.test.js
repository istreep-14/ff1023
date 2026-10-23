import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { append, tail, levelOf, logger } from '../src/runlog.js';
import { steps, pipelineMods, runPipeline, current, stepRows } from '../src/sync.js';
import { parseHorizon, horizonOptions } from '../src/weekhorizon.js';
import { leagueDirectory } from '../src/dashboard.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ff-runlog-')), 'runlog.jsonl');

/**
 * The server and the CLI each carried their own wiring of the pipeline steps,
 * and the server's had drifted: its Sync page listed trade, actuals, the
 * backfill and the audit, and reported every one "unavailable". One wiring
 * now; a step without a run function is that bug again.
 */
test('every pipeline step is wired to something that runs', async () => {
  const mods = await pipelineMods({});
  const missing = steps(mods).filter((s) => typeof s.run !== 'function').map((s) => s.name);
  assert.deepEqual(missing, []);
});

test('the step table the page gets carries no run functions and marks the joins', () => {
  const rows = stepRows();
  assert.ok(rows.every((r) => !('run' in r)));
  assert.deepEqual(rows.filter((r) => r.always).map((r) => r.name), ['enrich', 'dashboard', 'audit']);
  assert.ok(rows.filter((r) => !r.always).every((r) => r.maxAgeMin > 0));
});

/**
 * A sync run from the dashboard used to print nowhere (`log: () => {}`), so a
 * failed step was one word in a table. Every line now lands in the run log,
 * tagged with the step that printed it.
 */
test('a pipeline run writes every step\'s narration to the run log, tagged by step', async () => {
  const file = tmp();
  const seen = [];
  const mods = Object.fromEntries(['scrape', 'fp', 'draftsharks', 'trade', 'schedule', 'buzz', 'trend', 'leaguedetail',
    'leaguedetailBackfill', 'matchups', 'actuals', 'enrich', 'dashboard', 'audit'].map((k) => [k, async ({ log }) => {
    seen.push(log.src);
    log(`hello from ${k}`);
    if (k === 'trade') throw new Error('trade board refused');
  }]));
  const results = await runPipeline(mods, { force: true, log: null, runlog: file });
  assert.equal(current.run, null, 'the run lock is released');
  assert.ok(seen.includes('fp') && seen.includes('leaguedetail-backfill'));
  const rows = tail({ file, limit: 1000 });
  assert.ok(rows.some((r) => r.src === 'fp' && r.msg === 'hello from fp'));
  assert.ok(rows.some((r) => r.src === 'sync' && /FAIL\s+trade/.test(r.msg) && r.level === 'error'));
  const summary = rows.at(-2);
  assert.match(summary.msg, /1 failed/);
  assert.equal(summary.level, 'error');
  // A failed fetch does not stop the joins.
  assert.equal(results.find((r) => r.name === 'dashboard').status, 'ok');
  assert.ok(results.every((r) => !('run' in r)));
});

test('the run log tails after a sequence id, and survives a torn last line', () => {
  const file = tmp();
  const [a] = append({ msg: 'first' }, { file });
  append([{ msg: 'second' }, { msg: '   ' }, { msg: 'third', level: 'warn' }], { file });
  assert.deepEqual(tail({ file }).map((r) => r.msg), ['first', 'second', 'third']);
  assert.deepEqual(tail({ file, after: a.seq }).map((r) => r.msg), ['second', 'third']);
  assert.equal(tail({ file }).at(-1).level, 'warn');
  // A killed run can leave half a line; the next entry must not fuse onto it.
  appendFileSync(file, '{"t":"2026-10-20T00:00:00Z","msg":"half');
  append({ msg: 'fourth' }, { file });
  assert.deepEqual(tail({ file }).map((r) => r.msg), ['first', 'second', 'third', 'fourth']);
});

test('a null file logs to the terminal only', () => {
  const echoed = [];
  const log = logger({ src: 'x', echo: (m) => echoed.push(m), file: null });
  log('one');
  log.as('y')('two');
  assert.deepEqual(echoed, ['one', 'two']);
});

test('line levels: a summary with failures is an error, with none it is ok', () => {
  assert.equal(levelOf('■ 3 run, 1 already fresh, 2 failed'), 'error');
  assert.equal(levelOf('■ 3 run, 1 already fresh, 0 failed'), 'ok');
  assert.equal(levelOf('  FAIL  fp — 403'), 'error');
  assert.equal(levelOf('  done  fp — 2.1s'), 'ok');
  assert.equal(levelOf('  would fp'), 'info');
});

/**
 * Both remaining sources publish the current week and rest of season only, so
 * every other window (next 3 weeks, playoffs, any single week) rendered blank.
 * An old bookmark's key now reads as this week rather than as an empty page.
 */
test('the window is this week, rest of season or full season — old keys fall back to this week', () => {
  assert.deepEqual(horizonOptions({ now: 7 }).map((o) => o.value), ['ovw', 'w-7', 'ros', 'szn', 'l3', 'l5', 'std']);
  // Game-log windows read completed weeks only, and do not exist before one is played.
  assert.deepEqual(horizonOptions({ now: 1 }).map((o) => o.value), ['ovw', 'w-1', 'ros', 'szn']);
  assert.deepEqual([parseHorizon('l3', { now: 7 }).from, parseHorizon('l3', { now: 7 }).to], [4, 6]);
  assert.deepEqual([parseHorizon('l5', { now: 3 }).from, parseHorizon('l5', { now: 3 }).to], [1, 2]);
  assert.deepEqual([parseHorizon('std', { now: 7 }).from, parseHorizon('std', { now: 7 }).to], [1, 6]);
  assert.equal(parseHorizon('ovw', { now: 7 }).kind, 'overview');
  for (const old of ['n-3', 'p', 'w-12', 'r-3-5', 'playoffs', '']) {
    assert.equal(parseHorizon(old, { now: 7 }).key, 'w-7', old);
  }
  assert.equal(parseHorizon('ros', { now: 7 }).from, 7);
  assert.equal(parseHorizon('szn', { now: 7 }).kind, 'season');
});

/**
 * A league switched off disappeared from every page, including the one where
 * it would be switched back on. The directory keeps it — but a league still
 * marked ON in the state file and absent from the account is last season's,
 * and listing it would offer a switch for a league that no longer exists.
 */
test('the league directory keeps switched-off leagues and drops ones the account no longer has', () => {
  const scraped = [{ key: 'a', nickname: 'Alpha', host: 'ESPN', scoring: 'PPR' }];
  const state = { leagues: { a: { active: true }, b: { active: false, nickname: 'Bravo', host: 'Yahoo' }, c: { active: true, nickname: 'Old', host: 'ESPN' } } };
  const d = leagueDirectory(scraped, { directory: [], state });
  assert.deepEqual(d.map((x) => [x.key, x.active, x.scraped]), [['a', true, true], ['b', false, false]]);
  const withDir = leagueDirectory(scraped, { directory: [{ key: 'c', name: 'Old', host: 'ESPN', active: true }], state });
  assert.ok(withDir.some((x) => x.key === 'c' && !x.scraped), 'a league in the directory is listed even when not scraped');
});
