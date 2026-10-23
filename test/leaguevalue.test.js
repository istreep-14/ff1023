import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lvValues, lvConsensus, lvDemand, lvRanksBy, lvWorth } from '../src/leaguevalue.js';
import { prSlots } from '../src/powerrank.js';

// A small universe: points fall 10 a rank at every position, from different tops.
const TOPS = { QB: 300, RB: 260, WR: 240, TE: 160 };
function pool(n = 30) {
  const rows = [];
  let id = 1;
  for (const [pos, top] of Object.entries(TOPS)) {
    for (let k = 0; k < n; k++) rows.push({ i: id++, p: pos, proj: top - 10 * k, mkt: 1000 - 30 * k });
  }
  return rows;
}
const proj = { id: 'proj', label: 'Projection', points: true, score: (r) => r.proj };
// An expert ROS rank, as a higher-is-better score (valuescale.js vsScore).
const mkt = { id: 'mkt', label: 'Expert rank', score: (r) => r.mkt };
const ONE_QB = prSlots(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR/RB/TE', 'K', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const SUPERFLEX = prSlots(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR/RB/TE', 'QB/WR/RB/TE', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const byPos = (lv, rows, pos, k) => lv.players.get(rows.filter((r) => r.p === pos)[k].i);

test('flex slots go to whoever outscores the alternatives; a superflex takes quarterbacks', () => {
  const supply = { QB: [300, 290, 280, 270, 260, 250], RB: [200, 150, 100, 95, 40, 30], WR: [200, 150, 100, 90, 80, 70], TE: [100, 90, 20] };
  // Flex: the fifth WR (80) beats the fifth RB (40) and third TE (20), twice.
  assert.deepEqual(lvDemand(ONE_QB, 2, 0, supply).starters, { QB: 2, RB: 4, WR: 6, TE: 2 });
  // Superflex: QB3 and QB4 (280, 270) outscore every other candidate.
  assert.deepEqual(lvDemand(SUPERFLEX, 2, 0, supply).starters, { QB: 4, RB: 4, WR: 6, TE: 2 });
});

test('real roster depth wins over the bench model, but never below the starters', () => {
  const supply = { QB: [300], RB: [200], WR: [200], TE: [100] };
  assert.equal(lvDemand(ONE_QB, 10, 6, supply, { QB: 20, RB: 48, WR: 60, TE: 2 }).rostered.QB, 20);
  assert.equal(lvDemand(ONE_QB, 10, 6, supply, { QB: 20, RB: 48, WR: 60, TE: 2 }).rostered.TE, 10);
  // The bench model gives RB/WR the depth and QB/TE a spare each, roughly.
  const m = lvDemand(ONE_QB, 10, 6, supply).rostered;
  assert.ok(m.RB - 20 > m.QB - 10 && m.WR - 30 > m.TE - 10);
});

test('the same player is worth more where his position is scarce: superflex prices the QB up', () => {
  const rows = pool();
  const one = lvValues(rows, [proj, mkt], { teams: 12, slots: ONE_QB, benchSpots: 6 });
  const sf = lvValues(rows, [proj, mkt], { teams: 12, slots: SUPERFLEX, benchSpots: 6 });
  assert.ok(byPos(sf, rows, 'QB', 0).value > byPos(one, rows, 'QB', 0).value);
  assert.ok(byPos(sf, rows, 'QB', 0).rank < byPos(one, rows, 'QB', 0).rank);
  // And more teams make every position deeper to replace.
  const big = lvValues(rows, [proj, mkt], { teams: 16, slots: ONE_QB, benchSpots: 6 });
  assert.ok(big.replacement.RB < one.replacement.RB);
});

test('replacement sits halfway between the last starter and the first unrostered player', () => {
  const rows = pool();
  const lv = lvValues(rows, [proj], { teams: 2, slots: prSlots(['QB', 'BN']), benchSpots: 1, rostered: { QB: 3, RB: 0, WR: 0, TE: 0 } });
  assert.equal(lv.lastStarter.QB, 290);
  assert.equal(lv.waiver.QB, 270);
  assert.equal(lv.replacement.QB, 280);
  assert.equal(byPos(lv, rows, 'QB', 0).value, 20);
  // Below replacement is worth 0, never negative.
  assert.equal(byPos(lv, rows, 'QB', 10).value, 0);
});

test('the order is a consensus of sources; the points are the projection curve at that rank', () => {
  const rows = pool();
  // The expert rank has RB #2 as the best RB; projections disagree. Two signals
  // of equal weight average to a tie, broken toward the id order.
  rows.find((r) => r.p === 'RB' && r.proj === 250).mkt = 5000;
  const lv = lvValues(rows, [proj, mkt], { teams: 12, slots: ONE_QB, benchSpots: 6 });
  const second = byPos(lv, rows, 'RB', 1);
  assert.equal(second.consensus, 1.5);
  // A signal carrying more weight moves him to RB1 and gives him RB1's points.
  const m = lvValues(rows, [proj, { ...mkt, weight: 3 }], { teams: 12, slots: ONE_QB, benchSpots: 6 });
  assert.equal(byPos(m, rows, 'RB', 1).posRank, 1);
  assert.equal(byPos(m, rows, 'RB', 1).points, 260);
});

test('a player a deep source leaves out is ranked past its end, at half weight', () => {
  const rows = pool();
  const ghost = { i: 999, p: 'WR', proj: null, mkt: 999 };
  const lv = lvValues([...rows, ghost], [proj, mkt], { teams: 12, slots: ONE_QB, benchSpots: 6 });
  const g = lv.players.get(999);
  const imputed = g.inputs.find((o) => o.id === 'proj');
  assert.equal(imputed.imputed, true);
  assert.equal(imputed.rank, 31);
  assert.equal(g.n, 1);
  // The rank says WR1, absence from 30-deep projections says WR31: he lands deep, not at the top.
  assert.ok(g.posRank > 10);
});

test('with four or more ranks the best and worst are dropped', () => {
  const rows = pool(20);
  const sigs = [proj, mkt,
    { id: 'a', score: (r) => r.proj },
    { id: 'outlier', score: (r) => (r.p === 'TE' && r.proj === 160 ? -1 : r.mkt) }];
  const lv = lvValues(rows, sigs, { teams: 12, slots: ONE_QB, benchSpots: 6 });
  assert.equal(byPos(lv, rows, 'TE', 0).posRank, 1);
});

test('K and DST are not valued, and a pool with no projections values nobody rather than crashing', () => {
  const rows = [...pool(5), { i: 500, p: 'K', proj: 150, mkt: 10 }];
  const lv = lvValues(rows, [proj, mkt], { teams: 2, slots: ONE_QB, benchSpots: 1 });
  assert.equal(lv.players.get(500), undefined);
  const none = lvValues(pool(5), [mkt], { teams: 2, slots: ONE_QB, benchSpots: 1 });
  assert.equal(none.replacement.QB, null);
  assert.equal([...none.players.values()][0].value, null);
});

test('a source\'s view is put on the league\'s axis: its rank, priced by the league\'s curve', () => {
  const rows = pool();
  const lv = lvValues(rows, [proj, mkt], { teams: 12, slots: ONE_QB, benchSpots: 6 });
  // A source that has the RB5 as its RB1.
  const fan = lvRanksBy(rows, (r) => (r.p === 'RB' && r.proj === 220 ? 9999 : r.mkt));
  const rb5 = rows.find((r) => r.p === 'RB' && r.proj === 220);
  assert.equal(fan.get(rb5.i), 1);
  assert.equal(lvWorth(lv, 'RB', 1), 260 - lv.replacement.RB);
  // League Value IS lvWorth at the consensus rank: the two columns use one formula.
  const x = lv.players.get(rb5.i);
  assert.equal(x.value, lvWorth(lv, 'RB', x.posRank));
  // Below replacement is 0, and an unranked player is null rather than 0.
  assert.equal(lvWorth(lv, 'RB', 30), 0);
  assert.equal(lvWorth(lv, 'RB', null), null);
  assert.equal(lvRanksBy(rows, () => null).size, 0);
});

test('the module is inlined into the page and collides with nothing there', () => {
  const src = readFileSync(new URL('../src/leaguevalue.js', import.meta.url), 'utf8');
  const tpl = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  assert.ok(tpl.includes('/*__INLINE:leaguevalue.js__*/'));
  assert.ok(!/^import /m.test(src), 'an import would break the inlined copy');
  const names = [...src.matchAll(/^(?:export )?(?:const|function) (\w+)/gm)].map((m) => m[1]);
  for (const n of names) assert.ok(!new RegExp(`(?:const|let|function) ${n}\\b`).test(tpl), `${n} is declared in the template too`);
});

test('the agreed number needs no league: the same order and points League Value prices', () => {
  const rows = pool();
  rows.find((r) => r.p === 'RB' && r.proj === 250).mkt = 5000;
  const agreed = lvConsensus(rows, [proj, mkt]);
  const lv = lvValues(rows, [proj, mkt], { teams: 12, slots: ONE_QB, benchSpots: 6 });
  for (const [id, a] of agreed.players) {
    assert.equal(a.posRank, lv.players.get(id).posRank);
    assert.equal(a.points, lv.players.get(id).points);
  }
  // Nobody any source covers is left without a number; nobody no source covers gets one.
  const ghost = { i: 777, p: 'WR', proj: null, mkt: null };
  assert.equal(lvConsensus([...rows, ghost], [proj, mkt]).players.get(777), undefined);
});

test('ROS points are a per-game rate times the player\'s own games left, not the k-th best total', () => {
  // Two RBs with the same per-game rate; one has his bye still to come.
  const rows = [
    { i: 1, p: 'RB', pg: 20, g: 12 },
    { i: 2, p: 'RB', pg: 18, g: 11 },
    { i: 3, p: 'RB', pg: 18, g: 12 },
    { i: 4, p: 'RB', pg: 10, g: 12 },
  ];
  const ros = { id: 'ros', label: 'ROS', points: true, score: (r) => r.pg * r.g, rate: (r) => r.pg };
  const games = (r) => r.g;
  const a = lvConsensus(rows, [ros], ['RB'], { games });
  assert.equal(a.players.get(2).points, 198);
  assert.equal(a.players.get(3).points, 216);
  // A total curve gave rank k the k-th best total, whatever his games.
  const old = lvConsensus(rows, [ros], ['RB']);
  assert.equal(old.players.get(2).points, old.curves.RB[old.players.get(2).posRank - 1]);

  // Value is (rate − replacement rate) × his games: a bye week is a week the replacement plays.
  const lv = lvValues(rows, [ros], { teams: 1, slots: prSlots(['RB']), benchSpots: 0, rostered: { QB: 0, RB: 2, WR: 0, TE: 0 }, games });
  assert.equal(lv.perGame, true);
  const x = lv.players.get(1);
  assert.equal(x.replacement, lv.replacement.RB * 12);
  assert.equal(x.value, x.points - x.replacement);
  assert.equal(lvWorth(lv, 'RB', 1, 11), (20 - lv.replacement.RB) * 11);
  assert.equal(lvWorth(lv, 'RB', 1, null), null);
});

test('rest of season the position rank follows the number beside it: the agreed total, and in a league the value', () => {
  // RB 1 is the better per-game player but has a bye still to come.
  const rows = [
    { i: 1, p: 'RB', pg: 20, g: 11 },
    { i: 2, p: 'RB', pg: 19, g: 12 },
    { i: 3, p: 'RB', pg: 10, g: 12 },
    { i: 4, p: 'RB', pg: 5, g: 12 },
  ];
  const ros = { id: 'ros', label: 'ROS', points: true, score: (r) => r.pg * r.g, rate: (r) => r.pg };
  const games = (r) => r.g;
  // No league: ranked per game, RB1 showed 220 to RB2's 228.
  const a = lvConsensus(rows, [ros], ['RB'], { games });
  assert.equal(a.players.get(2).points, 228);
  assert.equal(a.players.get(2).posRank, 1);
  assert.equal(a.players.get(1).posRank, 2);
  // In a league, value is (rate − replacement) × games: 1 is worth more (55 to 48), so 1 is RB1 there.
  const lv = lvValues(rows, [ros], { teams: 1, slots: prSlots(['RB']), benchSpots: 0, rostered: { QB: 0, RB: 2, WR: 0, TE: 0 }, games });
  assert.ok(lv.players.get(1).value > lv.players.get(2).value);
  for (const pos of ['RB']) {
    const byRank = [...lv.players.values()].filter((x) => x.posRank != null).sort((x, y) => x.posRank - y.posRank);
    for (let k = 1; k < byRank.length; k++) assert.ok(byRank[k - 1].value >= byRank[k].value, `${pos}${k} is worth at least ${pos}${k + 1}`);
  }
  assert.equal(lv.players.get(1).posRank, 1);
  // Who starts is still read off the per-game order.
  assert.equal(lv.starters.RB, 1);
});
