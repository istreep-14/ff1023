import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUrl, mergeViews, parsePlayerBlock, upsertPlayer } from '../src/draftsharks.js';

/**
 * Draft Sharks dropped the `fantasy_points` cell from its ROS table (a site
 * redesign, not a fetch bug — verified live: every other ROS attribute is
 * still there). `rosTotal` silently went null for every player as a result,
 * which is what "Draft Sharks ROS not working" turned out to be. The fix
 * derives the total from the per-week average and how many remaining games
 * it covers, both of which the redesigned table still publishes.
 */

const rosBlock = ({ weekly, games, total }) => `<tbody data-player-row>
  <span data-attribute="data-player-name" data-value="ignored"></span>
  data-player-name="Jahmyr Gibbs" data-fantasy-position="RB" data-key="13542"
  <td data-attribute="rosWeeklyPts" data-value="${weekly}"></td>
  <td data-attribute="games_played" data-value="${games}"></td>
  ${total != null ? `<td data-attribute="fantasy_points" data-value="${total}"></td>` : ''}
</tbody>`;

test('rosTotal is derived from weekly pace × games remaining when the site publishes no total', () => {
  const rec = parsePlayerBlock(rosBlock({ weekly: '21.2', games: '15.0', total: null }));
  assert.equal(rec.rosWeekly, 21.2);
  assert.equal(rec.rosGames, 15);
  assert.equal(rec.rosTotal, null);

  const store = { players: {} };
  upsertPlayer(store, rec, { ros: true });
  const stored = store.players['jahmyr gibbs|RB'];
  assert.equal(stored.ros.proj, 318); // 21.2 * 15, rounded to one decimal
});

test('a published fantasy_points total is used as-is, not overridden by the derived figure', () => {
  const rec = parsePlayerBlock(rosBlock({ weekly: '21.2', games: '15.0', total: '340.5' }));
  assert.equal(rec.rosTotal, 340.5);

  const store = { players: {} };
  upsertPlayer(store, rec, { ros: true });
  assert.equal(store.players['jahmyr gibbs|RB'].ros.proj, 340.5);
});

test('ros.proj stays null when neither a total nor the pieces to derive one are present', () => {
  const rec = parsePlayerBlock(`<tbody data-player-row>
    data-player-name="Jahmyr Gibbs" data-fantasy-position="RB" data-key="13542"
  </tbody>`);
  const store = { players: {} };
  upsertPlayer(store, rec, { ros: true });
  assert.equal(store.players['jahmyr gibbs|RB'].ros.proj, null);
});

/* A real ROS rankings row, trimmed to the cells that carry data. */
const ROS_ROW = `<tbody data-player-row data-key="13542" data-tier-overall="1" data-tier-positional="3" data-fantasy-position="RB" data-player-name="Jahmyr Gibbs" data-is-rookie="false">
<td class="rank"><div class="column-title rank-index"> <span>1</span> </div></td>
<span class="player-details-group__team-name">DET</span> <pos-roster-spot pill="false" pos-roster-spot="RB">1</pos-roster-spot>
<td data-value="12.0" data-attribute="games_played"></td>
<td data-value="-4.6%" data-attribute="strength_of_schedule"></td>
<td data-value="54%" data-attribute="player.sipPlayerProfile.injury_prob"></td>
<td data-value="18.1" data-attribute="rosWeeklyFloorPts"></td>
<td data-value="25.3" data-attribute="consensusRosWeeklyPts"></td>
<td data-value="21.3" data-attribute="rosWeeklyPts"></td>
<td data-value="24.7" data-attribute="rosWeeklyCeilingPts"></td>
<td data-value="0" data-ds-value="100" data-market-value="93.8" data-attribute="dsValueDelta"></td>
<td data-value="100" data-attribute="dsValue"></td>
</tbody>`;

test('ROS row: 3D Value, trend, market value, injury risk and games left are read', () => {
  const rec = parsePlayerBlock(ROS_ROW);
  assert.equal(rec.value, 100);
  assert.equal(rec.valueDelta, 0);
  assert.equal(rec.marketValue, 93.8);
  assert.equal(rec.injuryRisk, 54);
  assert.equal(rec.rosGames, 12);
  assert.equal(rec.sos, -4.6);
});

test('consensus comes from consensusRosWeeklyPts — the old consensus_projection name left it null', () => {
  const store = { players: {} };
  upsertPlayer(store, parsePlayerBlock(ROS_ROW), { ros: true });
  assert.equal(store.players['jahmyr gibbs|RB'].ros.consensus, 25.3);
});

test('position rank is the pos-roster-spot number, not the positional tier', () => {
  const rec = parsePlayerBlock(ROS_ROW);
  assert.equal(rec.posRank, 1);
  assert.equal(rec.posTier, 3);
  assert.equal(rec.tier, 1);
});

test('IDP rows are dropped', () => {
  assert.equal(parsePlayerBlock(ROS_ROW.replace('data-fantasy-position="RB"', 'data-fantasy-position="LB"')), null);
});

test('the projections view stat line is merged onto the rankings row by Draft Sharks id', () => {
  const proj = parsePlayerBlock(`<tbody data-player-row data-key="13542" data-fantasy-position="RB" data-player-name="Jahmyr Gibbs">
    <td data-value="95.2" data-attribute="rush_yds"></td><td data-value="0" data-attribute="pass_yds"></td>
    <td data-value="14.3" data-attribute="rushTotal"></td><td data-value="22.7" data-attribute="weekly3dPts"></td></tbody>`);
  const [merged] = mergeViews([parsePlayerBlock(ROS_ROW)], [proj]);
  assert.deepEqual(merged.stats, { rush_yds: 95.2 });
  assert.equal(merged.d3, 22.7);
});

test('the whole board is asked for through load-rows, not the top-250 load-table', () => {
  const u = new URL(loadUrl('week', { week: 7, scoring: 'PPR', depth: 'projections' }));
  assert.equal(u.pathname, '/weekly-rankings/load-rows');
  assert.equal(u.searchParams.get('researchDepth'), 'projections');
  assert.ok(Number(u.searchParams.get('limit')) >= 1500);
  assert.equal(new URL(loadUrl('ros', { scoring: 'HALF' })).searchParams.get('pprSuperflexSlug'), 'half-ppr');
});

test('a FantasyPros nickname finds the Draft Sharks full name on the same team and position', async () => {
  const { dsFind } = await import('../src/enrich.js');
  const { nameKey } = await import('../src/sleeper.js');
  const rows = [
    { n: 'Kenneth Gainwell', p: 'RB', t: 'TB' },
    { n: 'Cameron Skattebo', p: 'RB', t: 'NYG' },
    { n: 'Chigoziem Okonkwo', p: 'TE', t: 'WAS' },
    { n: 'Andres Borregales', p: 'K', t: 'NE' },
    { n: 'Jacory Croskey-Merritt', p: 'RB', t: 'WAS' },
    { n: 'Nathaniel Dell', p: 'WR', t: 'HOU' },
  ];
  const idx = new Map(rows.map((r) => [nameKey(r.n, r.p), r]));
  assert.equal(dsFind(idx, { name: 'Kenny Gainwell', position: 'RB', team: 'TB' })?.n, 'Kenneth Gainwell');
  assert.equal(dsFind(idx, { name: 'Cam Skattebo', position: 'RB', team: 'NYG' })?.n, 'Cameron Skattebo');
  assert.equal(dsFind(idx, { name: 'Chig Okonkwo', position: 'TE', team: 'WAS' })?.n, 'Chigoziem Okonkwo');
  assert.equal(dsFind(idx, { name: 'Andy Borregales', position: 'K', team: 'NE' })?.n, 'Andres Borregales');
  assert.equal(dsFind(idx, { name: 'Jacory Croskey-Merritt', position: 'RB', team: 'WAS' })?.n, 'Jacory Croskey-Merritt');
  assert.equal(dsFind(idx, { name: 'Tank Dell', position: 'WR', team: 'HOU' })?.n, 'Nathaniel Dell');
  // Different team, different first name, or two candidates: no guess.
  assert.equal(dsFind(idx, { name: 'Kenny Gainwell', position: 'RB', team: 'PHI' }), null);
  assert.equal(dsFind(idx, { name: 'Tony Gainwell', position: 'RB', team: 'TB' }), null);
  const twins = new Map([...idx, [nameKey('Kenton Gainwell', 'RB'), { n: 'Kenton Gainwell', p: 'RB', t: 'TB' }]]);
  assert.equal(dsFind(twins, { name: 'Kenny Gainwell', position: 'RB', team: 'TB' }), null);
});

test('FantasyPros\' ROS board credits every week left; a bye still to come is a game not played', async () => {
  const { gamesLeft, fpRosFromBoard } = await import('../src/enrich.js');
  assert.equal(gamesLeft(7, 6), 12);   // bye behind him
  assert.equal(gamesLeft(7, 13), 11);  // bye ahead
  assert.equal(gamesLeft(7, 7), 11);   // on bye now
  // Measured: Jonathan Taylor 196.8 on the week-7 board = 16.4 × 12; his bye is week 13.
  assert.equal(fpRosFromBoard(196.8, 7, gamesLeft(7, 13)), 180.4);
  assert.equal(fpRosFromBoard(267.6, 7, gamesLeft(7, 6)), 267.6);
  assert.equal(fpRosFromBoard(null, 7, 11), null);
});
