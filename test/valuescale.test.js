import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VS_SOURCES, VS_WEEK_SOURCES, VS_DISPLAY, vsSources, vsSignals, vsRaw, vsScore, vsGames } from '../src/valuescale.js';
import { FEED_SITES } from '../src/sourcefeeds.js';

const allen = { i: 1, p: 'QB', ros: 260, rosRk: 2, ds: { ros: 250, val: 88 }, dd: { r: [1, 3, null] } };
const gibbs = { i: 2, p: 'RB', ros: 240, rosRk: 1, ds: { ros: 245 } };

test('a source nobody in the pool is covered by is left out', () => {
  assert.deepEqual(vsSources([allen, gibbs]).map((s) => s.id), ['fp:ros', 'ds:ros', 'ds:3d', 'espn:ros', 'fd:ros']);
  assert.deepEqual(vsSources([gibbs]).map((s) => s.id), ['fp:ros', 'ds:ros']);
});

test('no market trade value is a source: a row priced only by markets answers for nothing', () => {
  // A market value is a price for someone else's league. Draft Sharks' 3D Value
  // is the one value kept: it is Draft Sharks' own ROS judgement, not a market.
  const priced = { i: 3, p: 'WR', tm: { v: 900 }, ds: { mkt: 80 }, dd: { m: { 22: [900, 900] }, adp: 4 } };
  assert.deepEqual(vsSources([priced]), []);
  assert.deepEqual(vsSources([priced], VS_WEEK_SOURCES), []);
  for (const s of [...VS_SOURCES, ...VS_WEEK_SOURCES]) assert.ok(!/trade|market/i.test(s.id + s.label), s.id);
});

test('one vote per site: FantasyPros and Draft Sharks are the inputs, and a site with two signals splits its vote', () => {
  const vote = (sources) => {
    const by = {};
    for (const s of vsSignals(sources)) by[s.id] = s.weight;
    return by;
  };
  assert.deepEqual(vote(VS_SOURCES), { 'fp:ros': 1, 'ds:ros': 0.5, 'ds:3d': 0.5 });
  assert.deepEqual(vote(VS_WEEK_SOURCES), { 'fp:ecr': 0.5, 'fp:proj': 0.5, 'ds:wk': 1 });
  // ESPN, FanDuel and FantasyGuys are shown for comparison, never blended in.
  assert.ok(VS_SOURCES.filter((s) => s.group === 'other').every((s) => !s.input));
});

test('a player on a Draft Sharks bye has no week number from it, not a 0', () => {
  const ds = VS_WEEK_SOURCES.find((s) => s.id === 'ds:wk');
  assert.equal(vsRaw({ ds: { wk: 0, bye: true } }, ds), null);
  assert.equal(vsRaw({ ds: { wk: 14.2, bye: false } }, ds), 14.2);
});

test('a projection is read as published; a rank is turned so that higher is better', () => {
  const fp = VS_SOURCES.find((s) => s.id === 'fp:ros'), espn = VS_SOURCES.find((s) => s.id === 'espn:ros');
  assert.equal(vsRaw(allen, fp), 260);
  assert.equal(vsScore(allen, fp), 260);
  assert.equal(vsRaw(allen, espn), 1);
  assert.equal(vsScore(allen, espn), -1);
  assert.ok(vsScore({ dd: { r: [1] } }, espn) > vsScore({ dd: { r: [2] } }, espn), 'rank 1 orders ahead of rank 2');
  assert.equal(vsRaw(gibbs, espn), null);
});

test('FantasyPros is one vote: its ROS points are its ROS rank board, so it is not listed twice', () => {
  // FP publishes no ROS projections model; `ros` is the ROS rankings board's
  // implied points. A separate `rosRk` source double-counted FantasyPros.
  const fp = VS_SOURCES.filter((s) => s.group === 'fp');
  assert.equal(fp.length, 1);
  assert.ok(!VS_SOURCES.some((s) => /rosRk/.test(String(s.raw))), 'nothing reads FantasyPros’ ROS rank as its own source');
});

test('the module is inlined into the page and collides with nothing there', () => {
  const src = readFileSync(new URL('../src/valuescale.js', import.meta.url), 'utf8');
  const tpl = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  assert.ok(tpl.includes('/*__INLINE:valuescale.js__*/'));
  const names = [...src.matchAll(/^(?:export )?(?:const|function) (\w+)/gm)].map((m) => m[1]);
  for (const n of names) assert.ok(!new RegExp(`(?:const|let|function) ${n}\\b`).test(tpl), `${n} is declared in the template too`);
});

test('every catalog product points at a Sources tab, and display products do not vote', () => {
  const tabs = new Set(FEED_SITES.flatMap((s) => s.feeds.map((f) => s.id + '/' + f.key)));
  for (const s of [...VS_SOURCES, ...VS_WEEK_SOURCES, ...VS_DISPLAY]) {
    assert.ok(s.feed && tabs.has(s.feed.site + '/' + s.feed.key), `${s.id} -> ${s.feed && s.feed.site}/${s.feed && s.feed.key}`);
    assert.equal(s.input, s.role === 'input', `${s.id} input matches role`);
  }
  assert.ok(VS_SOURCES.filter((s) => s.group === 'other').every((s) => s.role === 'compare' && !s.input));
  assert.deepEqual(VS_DISPLAY.map((s) => s.id), ['fp:week', 'fp:expert']);
  assert.ok(VS_DISPLAY.every((s) => s.role === 'display' && !s.input));
  assert.deepEqual(vsSignals(VS_DISPLAY), []);
  // Merged week points are not the projections-model vote: a player the model
  // missed still has a published FP column from the rankings board.
  const row = { wk: 12, wkP: 11, wkX: 9 };
  assert.equal(vsRaw(row, VS_WEEK_SOURCES.find((s) => s.id === 'fp:proj')), 11);
  assert.equal(vsRaw(row, VS_DISPLAY.find((s) => s.id === 'fp:week')), 12);
  assert.equal(vsRaw(row, VS_DISPLAY.find((s) => s.id === 'fp:expert')), 9);
});

test('a ROS projection carries its per-game rate, and games left come off the row', () => {
  const row = { ros: 120, rosPg: 10.9, rosG: 11, ds: { ros: 110, rosW: 10 } };
  const sig = Object.fromEntries(vsSignals(VS_SOURCES).map((s) => [s.id, s]));
  assert.equal(sig['fp:ros'].rate(row), 10.9);
  assert.equal(sig['ds:ros'].rate(row), 10);
  assert.equal(sig['ds:3d'].rate, null);
  assert.equal(vsGames(row), 11);
});
