import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEED_SITES, feedSite, feedOf, feedRows, feedStatCols, feedDir } from '../src/sourcefeeds.js';
import { TRACKED } from '../src/freshness.js';

const ctx = { season: 2026, week: 7, scoring: 'ppr', weeks: [1, 2], schedule: null };

/**
 * One row's fields, grouped by the site that publishes them (dashboard.js
 * `slim`). `schedule` is not a site with player tabs, but its fields ride on
 * every row: `opp` comes from the ESPN schedule, so a FantasyPros tab showing
 * it would be mixing sites.
 */
const BY_SITE = {
  fp: { rk: 3, pr: 'RB2', wkX: 18, rmin: 1, rmax: 6, rave: 2.4, tr: 1, g: 'A', own: 99, wkP: 17.5, ros: 200, rosRk: 4, rosPr: 'RB3', rosMin: 2, rosMax: 9, rosAve: 4.1,
    tm: { v: 800, pv: 790, rk: 5, pr: 2, n: [3, 4], xv: 810 }, pts: 120, inj: 'Q', injT: 'Ankle', nw: 'Limited Wednesday', blurb: null },
  draftsharks: { ds: { wk: 16, rk: 4, prk: 2, floor: 10, ceiling: 24, d3: 17, cons: 15, tier: 1, opp: 'BUF', sos: 3, st: { rush_yds: 80 },
    ros: 190, rosPrk: 3, rosFloor: 9, rosCeiling: 25, rosD3: 18, rosCons: 16, rosG: 10, rosTier: 1, rosSt: { rush_yds: 75 }, val: 90, dv: 2, mkt: 85, inj: 30 } },
  dd: { dd: { age: 25, adp: 8, own: 99, st: 90, inj: null, r: [3, 4, 5] } },
  vegas: { vg: { wk: 18.2, prk: 3, ok: true, miss: null, vol: 'High Floor', fl: 9, md: 17.5, ce: 31, boom: 0.25, bust: 0.12, sk: 0.15, ds: 'ok', st: { rushYds: 80, recYds: 20, rec: 3, tds: 0.8 } } },
  yahoo: { sig: { ya: 100, yd: 20, yn: 80, yc: 5, yr: 98, yrc: 1, ys: 90, nt: 'Sun 1:00 pm @ Buf' } },
  sleeper: { sig: { a: 3000, d: 100, r: 40, v: 1.4 }, act: { 1: 20, 2: 14 } },
  schedule: { opp: '@BUF', bye: 8, sch: { bye: 8, opp: 'BUF', home: false } },
};
const merge = (...parts) => {
  const out = { i: 1, n: 'Test Back', p: 'RB', t: 'DET' };
  for (const part of parts) for (const [k, v] of Object.entries(part)) out[k] = typeof v === 'object' && v && !Array.isArray(v) && out[k] ? { ...out[k], ...v } : v;
  return out;
};

test('every feed points at a ledger the freshness report still returns', () => {
  // report() drops sources outside TRACKED, so a feed naming one would read
  // "no sync recorded" forever however recently it was pulled.
  for (const site of FEED_SITES) for (const f of site.feeds) assert.ok(TRACKED.has(f.ledger), `${site.id}/${f.key} -> ${f.ledger}`);
});

test('no site’s tab reads another site’s numbers', () => {
  for (const site of FEED_SITES) {
    if (!BY_SITE[site.id]) continue;
    const others = merge(...Object.entries(BY_SITE).filter(([id]) => id !== site.id).map(([, v]) => v));
    for (const f of site.feeds) {
      assert.equal(f.has(others, ctx), false, `${site.id}/${f.key} counts a row that has none of its fields`);
      for (const c of f.cols(ctx, [others])) {
        assert.equal(c.get(others, ctx) ?? null, null, `${site.id}/${f.key}.${c.key} reads another site’s field`);
      }
    }
  }
});

test('every player tab finds its own fields on a row that has them', () => {
  for (const site of FEED_SITES) {
    if (!BY_SITE[site.id]) continue;
    const own = merge(BY_SITE[site.id]);
    for (const f of site.feeds) {
      assert.equal(f.has(own, ctx), true, `${site.id}/${f.key}`);
      assert.ok(f.cols(ctx, [own]).some((c) => c.get(own, ctx) != null), `${site.id}/${f.key} shows something`);
    }
  }
});

test('FantasyPros’ rankings board and its projections model are separate tabs', () => {
  // They were one row on the old Sources tab, so a player the projections
  // model does not cover (most of them, logged out) looked like a gap in FP.
  const fp = feedSite('fp');
  const rankedOnly = { i: 1, p: 'WR', rk: 40, wkX: 9 };
  const projectedOnly = { i: 2, p: 'WR', wkP: 12 };
  const pool = [rankedOnly, projectedOnly];
  assert.deepEqual(feedRows(feedOf(fp, 'week'), { ...ctx, pool }).map((r) => r.i), [1]);
  assert.deepEqual(feedRows(feedOf(fp, 'proj'), { ...ctx, pool }).map((r) => r.i), [2]);
});

test('Dynasty Daddy has no market tab: its player data is the one file kept', () => {
  const dd = feedSite('dd');
  assert.deepEqual(dd.feeds.map((f) => f.key), ['players']);
  assert.equal(feedOf(dd, 'players').ledger, 'ddplayers');
});

test('a file path names the season, week and scoring it was read from', () => {
  assert.deepEqual(feedOf(feedSite('fp'), 'week').files(ctx), ['fp/2026/week-7/rankings/ppr/{qb,rb,wr,te,k,dst}.json']);
  assert.deepEqual(feedOf(feedSite('fp'), 'trade').files(ctx), ['fp/2026/trade/ppr.json']);
  assert.match(feedOf(feedSite('draftsharks'), 'week').files(ctx)[0], /^draftsharks\/2026\/ppr\.json · weeks\.7/);
});

test('a stat-line tab gets one column per stat the shown rows carry, in reading order', () => {
  const rows = [{ ds: { st: { rec_yds: 60, rush_yds: 10 } } }, { ds: { st: { rec_catch: 5 } } }];
  assert.deepEqual(feedStatCols(rows, 'st').map((c) => c.label), ['Rush Yds', 'Rec', 'Rec Yds']);
  assert.deepEqual(feedStatCols([{ ds: {} }], 'st'), []);
});

test('Sleeper’s weekly points get one column per week played, plus their total', () => {
  const f = feedOf(feedSite('sleeper'), 'actuals');
  const row = merge(BY_SITE.sleeper);
  const cols = f.cols(ctx, [row]);
  assert.deepEqual(cols.map((c) => c.label), ['Total', 'Wk 1', 'Wk 2']);
  assert.equal(cols[0].get(row), 34);
});

test('the schedule tab is one row per team, away games marked', () => {
  const f = feedOf(feedSite('espn'), 'schedule');
  const rows = feedRows(f, { ...ctx, schedule: { teams: { DET: { bye: 8, weeks: { 1: { opp: 'GB', home: true }, 2: { opp: 'CHI', home: false } } } } } });
  assert.equal(rows.length, 1);
  const cols = f.cols(ctx, rows);
  assert.equal(cols.find((c) => c.key === 'w1').get(rows[0]), 'GB');
  assert.equal(cols.find((c) => c.key === 'w2').get(rows[0]), '@CHI');
  assert.equal(cols.find((c) => c.key === 'w8').get(rows[0]), null);
});

test('ranks sort low-to-high, values high-to-low', () => {
  assert.equal(feedDir({ kind: 'rank' }), 'asc');
  assert.equal(feedDir({ kind: 'pos' }), 'asc');
  assert.equal(feedDir({ kind: 'num', asc: true }), 'asc');
  assert.equal(feedDir({ kind: 'value' }), 'desc');
});

test('every feed sorts by one of its own columns, and keys are unique within a site', () => {
  for (const site of FEED_SITES) {
    assert.equal(new Set(site.feeds.map((f) => f.key)).size, site.feeds.length, site.id);
    for (const f of site.feeds) {
      if (f.sort == null) continue;
      const row = merge(...Object.values(BY_SITE));
      assert.ok(f.cols({ ...ctx, weeks: [1] }, [row]).some((c) => c.key === f.sort), `${site.id}/${f.key} sorts by ${f.sort}`);
    }
  }
});

test('each site is its own page in the Sources rail, with a renderer', () => {
  // The site pages are generated, so the PAGES/RENDER table checks in
  // nav-and-analysis-payload.test.js cannot see them.
  const template = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  assert.match(template, /\.\.\.FEED_SITES\.map\(s=>\(\{id:'src-'\+s\.id, label:s\.label, group:'sources', section:s\.section\}\)\)/);
  assert.match(template, /FEED_SITES\.forEach\(site=>\{ RENDER\[SRC_PAGE\(site\.id\)\]=\(\)=>pageSourceSite\(site\); \}\);/);
  assert.match(template, /const SRC_PAGE = id=> 'src-'\+id;/);
  // The inlined module must come before PAGES reads it.
  assert.ok(template.indexOf('/*__INLINE:sourcefeeds.js__*/') < template.indexOf('const PAGES = ['));
});
