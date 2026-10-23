import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardRow, scoreLine, skewOf, distRow, tokenInfo } from '../src/vegas.js';
import { steps, PRESETS } from '../src/sync.js';
import { MAX_AGE_MIN } from '../src/freshness.js';

/**
 * VegasEdge came back for its spread. The two lessons from the first time it
 * was here are pinned: the site's printed points follow whatever scoring the
 * account last saved (measured 2026-10-23: half-PPR on a PPR pull, Gibbs 23.13
 * where his props score 25.49), and a partial market is not a ranking.
 */

const gibbs = { Player: 'Jahmyr Gibbs', Position: 'RB', PlayerID: '9221', Team: 'DET', RushingYds: 92.8768, ReceivingYds: 39.7912,
  Receptions: 4.7312, TD_Prob: 0.7371, ExpectedTds: 1.2489, FantasyPoints: 23.13, volatility_tag: 'High Floor',
  no_odds: false, missing_props: [], missing_from_book: false, InjuryStatus: '' };
const maye = { Player: 'Drake Maye', PlayerID: '11564', Team: 'NE', PassYds: 247.9532, PassTds: 1.5399642882794233, INTs: 0.5163,
  RushingYds: 28.5474, RushTDs: 0.24258044096516246, ExpectedRushTds: 0.2426, FantasyPoints: 19.36, no_odds: false, missing_props: [] };

test('points are scored from the stat line, not read off the board', () => {
  const r = boardRow(gibbs, 'flex');
  assert.equal(r.site, 23.13, 'the printed figure is kept, for drift');
  assert.equal(scoreLine(r, 'PPR'), 25.49);
  assert.equal(scoreLine(r, 'HALF'), r.site, 'the board was half-PPR: the account setting, not the market');
  assert.equal(scoreLine(r, 'STD'), 20.76);
});

test('the QB board has no Position field: the board is the position', () => {
  const r = boardRow(maye, 'qb');
  assert.equal(r.p, 'QB');
  assert.equal(scoreLine(r, 'PPR'), 19.36);
});

test('a missing prop makes the row partial, and an incomplete line scores nothing', () => {
  const r = boardRow({ ...gibbs, missing_props: ['Receptions'] }, 'flex');
  assert.equal(r.complete, false);
  assert.equal(scoreLine({ ...r, st: { ...r.st, rec: null } }, 'PPR'), null);
  assert.equal(boardRow({ ...gibbs, no_odds: true }, 'flex').complete, false);
});

test('skew is upside room against downside room around the median', () => {
  assert.equal(skewOf({ p10: 12.13, p50: 25.8, p90: 44.53 }), 0.16);
  assert.equal(skewOf({ p10: 10, p50: 20, p90: 30 }), 0);
  assert.equal(skewOf({ p10: 0, p50: 0, p90: 0 }), null, 'no spread is no skew, not zero');
  assert.equal(skewOf(null), null);
});

test('only a fully simulated player keeps percentiles', () => {
  assert.deepEqual(distRow({ status: 'thin_market' }), { status: 'thin_market' });
  const ok = distRow({ status: 'ok', p5: 9, p10: 12, p25: 17, p50: 25, p75: 35, p90: 44, p95: 50, boom_pct: 0.25, bust_pct: 0.11 });
  assert.equal(ok.p90, 44);
  assert.equal(ok.boom, 0.25);
});

test('an expired token is known before the site is asked', () => {
  const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
  assert.equal(tokenInfo(jwt(Math.floor(Date.now() / 1000) - 60)).expired, true);
  assert.equal(tokenInfo(jwt(Math.floor(Date.now() / 1000) + 3600)).expired, false);
  assert.equal(tokenInfo('not-a-jwt'), null);
});

test('vegas is a sync step with its own freshness limit, and in the live preset', () => {
  assert.ok(steps({}).some((s) => s.name === 'vegas'));
  assert.ok(MAX_AGE_MIN.vegas > 0);
  assert.match(PRESETS.live, /\bvegas\b/);
});

test('the join ranks complete markets only, and only for the week the site served', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vegas-'));
  const { vegasIndex } = await import('../src/enrich.js');
  const { filePath } = await import('../src/vegas.js');
  // filePath is under DATA; the index reads it there, so write a real week file to a season no test uses.
  const season = 1999;
  const file = filePath(season, 7);
  mkdirSync(join(file, '..'), { recursive: true });
  const a = { ...boardRow(gibbs, 'flex'), dist: { PPR: distRow({ status: 'ok', p10: 12, p50: 25, p90: 44, boom_pct: 0.25, bust_pct: 0.1 }) } };
  const b = { ...boardRow({ ...gibbs, PlayerID: '2', Player: 'Partial Back', missing_props: ['Receptions'], RushingYds: 200 }, 'flex'), dist: {} };
  const c = { ...boardRow({ ...gibbs, PlayerID: '3', Player: 'Lesser Back', RushingYds: 40 }, 'flex'), dist: {} };
  writeFileSync(file, JSON.stringify({ season, week: 7, players: { [a.sid]: a, [b.sid]: b, [c.sid]: c } }));
  try {
    const idx = vegasIndex(season, 7, 'PPR');
    assert.equal(idx.get('9221').posRank, 1);
    assert.equal(idx.get('2').posRank, null, 'a partial market is not ranked, however big its number');
    assert.equal(idx.get('3').posRank, 2);
    assert.equal(idx.get('9221').skew, skewOf({ p10: 12, p50: 25, p90: 44 }));
    assert.equal(vegasIndex(season, 8, 'PPR').size, 0, 'another week is not this one');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(join(file, '..'), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the site\'s volatility tag and TD method ride through to the page', async () => {
  const r = boardRow({ ...gibbs, TdMethod: 'poisson_from_anytime_fallback' }, 'flex');
  assert.equal(r.vol, 'High Floor');
  assert.equal(r.tdm, 'poisson_from_anytime_fallback');
  const { FEED_TD_METHOD, feedSite } = await import('../src/sourcefeeds.js');
  assert.equal(FEED_TD_METHOD[r.tdm], 'Anytime price only', 'the weakest TD source is named, not a code');
  const stats = feedSite('vegas').feeds.find((f) => f.key === 'stats');
  const col = stats.cols({}).find((c) => c.key === 'vg.tdm');
  assert.equal(col.get({ vg: { tdm: 'tds_over_ladder' } }), 'Averaged ladder');
  const template = (await import('node:fs')).readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  const a = template.indexOf('function vegasCols('), b = template.indexOf('\nfunction ', a + 1);
  assert.match(template.slice(a, b), /key:'vgtag'[\s\S]*?VG_TAG_BLURB\[t\]/, 'the tag column explains itself on hover');
});
