import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeTeams, applyToLeague, emptyLeague, ABBR_MAX } from '../src/overrides.js';
import { rankInSource, posRankNumber } from '../src/sourcetables.js';

/**
 * A team carries independent overrides — nickname, badge abbreviation,
 * division — and a save usually touches one. The merge has to be per field, or
 * saving a badge silently erases the nickname beside it.
 */

test('a patch to one team field leaves the others on that team alone', () => {
  const cur = { 7: { nickname: 'Indy FUEL', division: 'West' }, 8: { nickname: 'Other' } };
  const next = mergeTeams(cur, { 7: { abbreviation: 'FUEL' } });
  assert.deepEqual(next[7], { nickname: 'Indy FUEL', division: 'West', abbreviation: 'FUEL' });
  assert.deepEqual(next[8], { nickname: 'Other' });
});

test('a nickname patch leaves an existing abbreviation alone', () => {
  const next = mergeTeams({ 7: { abbreviation: 'FUEL' } }, { 7: { nickname: 'Indy' } });
  assert.deepEqual(next[7], { abbreviation: 'FUEL', nickname: 'Indy' });
});

test('an abbreviation is trimmed and capped; a blank one clears to null', () => {
  assert.equal(mergeTeams({}, { 1: { abbreviation: '  ab  ' } })[1].abbreviation, 'ab');
  assert.equal(mergeTeams({}, { 1: { abbreviation: 'ABCDEFGHIJ' } })[1].abbreviation.length, ABBR_MAX);
  assert.equal(mergeTeams({ 1: { abbreviation: 'AB' } }, { 1: { abbreviation: '   ' } })[1].abbreviation, null);
});

test('merging does not mutate the record it was given', () => {
  const cur = { 1: { nickname: 'A' } };
  mergeTeams(cur, { 1: { abbreviation: 'X' } });
  assert.deepEqual(cur, { 1: { nickname: 'A' } });
});

test('applyToLeague puts the abbreviation on the team and keeps the scraped name', () => {
  const league = { key: 'k', nickname: 'L', teams: [{ teamId: 7, name: 'Host Name' }, { teamId: 8, name: 'Untouched' }] };
  const o = { ...emptyLeague(), teams: { 7: { nickname: 'Indy FUEL', abbreviation: 'FUEL' } } };
  applyToLeague(league, o);
  assert.equal(league.teams[0].name, 'Indy FUEL');
  assert.equal(league.teams[0].nameScraped, 'Host Name');
  assert.equal(league.teams[0].abbreviation, 'FUEL');
  assert.equal(league.teams[1].abbreviation, undefined);
});

/**
 * Once a team nickname is on disk (league:import, or a save), the build ships
 * the nickname as `name` and the host's as `nameScraped`. The standings
 * subtext read `t.name`, so it repeated the nickname and the real team name
 * was gone from the page.
 */
test('the page shows the host team name under a nickname that came from disk', () => {
  const template = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');
  const line = (name) => template.match(new RegExp(`^const ${name} = .*$`, 'm'))[0];
  const ovFor = () => ({ teams: { 7: { nickname: 'Indy FUEL' } } });
  const { teamHostName, teamLabel } = new Function('ovFor', `${line('teamHostName')}\n${line('teamLabel')}\nreturn { teamHostName, teamLabel };`)(ovFor);
  const t = { id: 7, name: 'Indy FUEL', nameScraped: 'Host Name' };
  assert.equal(teamLabel({}, t), 'Indy FUEL');
  assert.equal(teamHostName(t), 'Host Name');
  assert.equal(teamHostName({ id: 8, name: 'Untouched', nameScraped: null }), 'Untouched');
  assert.match(template, /nickname \? teamHostName\(t\) : null, dt\?\.owner/);
});

test('a cleared abbreviation is not applied', () => {
  const league = { key: 'k', nickname: 'L', teams: [{ teamId: 7, name: 'N' }] };
  applyToLeague(league, { ...emptyLeague(), teams: { 7: { abbreviation: null } } });
  assert.equal(league.teams[0].abbreviation, undefined);
});

test('FantasyPros positional ranks parse from position + number', () => {
  assert.equal(posRankNumber('WR12'), 12);
  assert.equal(posRankNumber('K9'), 9);
  assert.equal(posRankNumber(null), null);
  assert.equal(posRankNumber(''), null);
});

test('a source fills its own missing positional ranks, per position, from its own numbers', () => {
  const pos = { 1: 'QB', 2: 'QB', 3: 'RB', 4: 'RB' };
  const rows = [{ i: 1, wk: 20 }, { i: 2, wk: 25 }, { i: 3, wk: 9 }, { i: 4, wk: 12, wkRk: 7 }, { i: 5 }];
  pos[5] = 'QB';
  rankInSource(rows, (r) => pos[r.i], 'wk', 'wkRk');
  assert.equal(rows[1].wkRk, 1);   // QB 25 leads QBs
  assert.equal(rows[0].wkRk, 2);
  assert.equal(rows[2].wkRk, 2);   // RB 9 trails RB 12
  assert.equal(rows[3].wkRk, 7);   // a published rank is never overwritten
  assert.equal(rows[4].wkRk, undefined); // no value, no rank
});
