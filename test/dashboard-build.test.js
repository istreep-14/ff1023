import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderHtml } from '../src/dashboard.js';
import { buildSourceTables, SOURCE_ORDER } from '../src/sourcetables.js';

const template = readFileSync(new URL('../src/dashboard.template.html', import.meta.url), 'utf8');

test('the built page has no leftover template placeholders, and its script still compiles', () => {
  const html = renderHtml(template, { leagues: [] });
  assert.ok(!/\/\*__[A-Z]/.test(html), 'every placeholder replaced');
  const script = html.match(/<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/)[1];
  // `export` is not valid in a classic script; the build strips it from the inlined module.
  assert.ok(!/^export /m.test(script), 'no export left in the page script');
  // Compile only. It is a browser script, so it is never run here.
  assert.doesNotThrow(() => new vm.Script(script));
});

test('every pure module the page inlines is in it, unchanged', () => {
  const html = renderHtml(template, {});
  for (const file of ['weekhorizon.js', 'valuescale.js', 'powerrank.js', 'leaguevalue.js', 'sourcefeeds.js']) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/^export /gm, '');
    assert.ok(html.includes(src), `${file} is inlined`);
  }
});

test('a placeholder the renderer cannot fill fails the build instead of shipping a page that dies on load', () => {
  // A renderer older than the template: it knows HORIZON, not LEAGUEVALUE. This shipped.
  assert.throws(() => renderHtml(`${template}\n/*__LEAGUEVALUE__*/`, {}), /LEAGUEVALUE__\*\/ was not filled/);
  assert.throws(() => renderHtml('<script>/*__INLINE:nope.js__*/</script>/*__DATA__*/null', {}), /ENOENT/);
});

test('the large tables are DataGrids: one builder, not a hand-rolled table per page', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  for (const name of ['playersTable', 'leaguePlayersTable', 'sourceTable', 'pageValues', 'pageTrade']) {
    const body = fnBody(name);
    assert.ok(/\bgrid\(\{/.test(body), `${name} renders through grid()`);
    assert.ok(!/el\('table'|table2\(/.test(body), `${name} does not build its own table`);
  }
});

test('the small tables are smallTable()s, sorted by their columns, not hand-rolled', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  for (const name of ['pagePower', 'valTeamsMatrix', 'pageStandings', 'pageWaivers', 'pageAnalysis', 'storedWeekPanel']) {
    const body = fnBody(name);
    assert.ok(/\bsmallTable\(\{/.test(body), `${name} renders through smallTable()`);
    assert.ok(!/el\('table'|table2\(|[^.\w]table\(\[/.test(body), `${name} does not build its own table`);
  }
  // The DOM-text sorter's own builders for these pages are gone.
  assert.ok(!/function (sortableTable|sortTh|waiverSheetRow|srcBands)\(/.test(template));
});

test('phase-four views use the shared List, Compare and KeyValue components', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  assert.match(template, /function list\(\{/);
  assert.match(template, /function compare\(\{/);
  assert.match(template, /function keyValue\(/);
  assert.match(fnBody('pageMoves'), /\blist\(\{/);
  assert.match(fnBody('matchupPanel'), /\bcompare\(\{/);
  assert.match(fnBody('muRows'), /\bcompare\(\{/);
  assert.match(fnBody('muRosterFallback'), /\bcompare\(\{/);
  assert.match(fnBody('sleeperMatchupFallback'), /\bcompare\(\{/);
  assert.match(fnBody('mdCard'), /\bkeyValue\(/);
  assert.doesNotMatch(fnBody('pageMoves'), /table2\(|[^.\w]table\(\[/);
});

test('a Sources table is read off the player row, so the two cannot disagree', () => {
  const rows = [
    { i: 1, n: 'A', p: 'RB', wk: 20, ros: 250, pr: 'RB1', rosPr: 'RB2', pts: 19,
      ds: { wk: 18, ros: 245, floor: 10, ceiling: 30 } },
    { i: 2, n: 'B', p: 'RB', wk: 10, ros: 100, pr: 'RB2', rosPr: 'RB1' },
  ];
  const t = buildSourceTables({ rows });
  assert.deepEqual(Object.keys(t), SOURCE_ORDER);
  const of = (source, i = 1) => t[source].find((r) => r.i === i);
  assert.equal(of('fp').wk, 20);
  assert.equal(of('fp').wkAct, 19);
  assert.equal(of('draftsharks').ceiling, 30);
  assert.equal(of('draftsharks', 2), undefined, 'a source that does not price him has no row');
});

test('a source’s own positional rank is computed within its own numbers', () => {
  const rows = [1, 2, 3].map((i) => ({ i, n: String(i), p: 'WR', ds: { wk: 10 - i, ros: 100 - i } }));
  const t = buildSourceTables({ rows });
  assert.deepEqual(t.draftsharks.map((r) => [r.i, r.wkRk]), [[1, 1], [2, 2], [3, 3]]);
});

test('the page parses and labels a look-ahead window with the tested module', async () => {
  const html = renderHtml(template, {});
  const horizon = readFileSync(new URL('../src/weekhorizon.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  assert.ok(html.includes(horizon), 'weekhorizon.js is inlined unchanged');
  const { parseHorizon, labelHorizon } = await import('../src/weekhorizon.js');
  assert.equal(labelHorizon(parseHorizon('ros', { now: 2 }), { now: 2 }), 'Rest of season (wk 2–18)');
});

test('My Team: recent moves read the move shape, and controls only show where they act', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  // A move is {kind, teamName, adds[], drops[]}. The Overview read per-player
  // fields (x.playerName, x.action) a move no longer has, so every row said "—".
  const parts = fnBody('overviewParts');
  assert.match(parts, /\blist\(\{items:recent, row:moveRow\}\)/);
  assert.doesNotMatch(parts, /\.playerName|\.playerPos|\.action\b/);
  const row = fnBody('moveRow');
  assert.match(row, /movePlayers\(t\.adds,1\)/);
  assert.match(row, /movePlayers\(t\.drops,-1\)/);
  // Only Lineup can show a stored week; the picker did nothing on the other tabs.
  assert.match(fnBody('pageMyTeam'), /teamTab==='lineup'\? weekPicker\(l\) : null/);
  // Before kickoff the score column is all dashes and a 0.0 total.
  assert.match(fnBody('teamRosterTable'), /if\(!anyScored\(t\)\) cols=cols\.filter\(c=>c\.key!=='pts'\)/);
});

test('projection columns carry a tone: the headline number of each band leads', () => {
  const tone = template.match(/const COL_TONE = (\{[^}]*\})/);
  assert.ok(tone, 'COL_TONE exists');
  const map = Function(`return ${tone[1]}`)();
  for (const k of ['cons', 'tm', 'pts']) assert.equal(map[k], 'key', `${k} leads its band`);
  for (const k of ['ecr', 'own']) assert.equal(map[k], 'aux', `${k} is context`);
  // A column's own tone wins: the ROS rank leads, the ROS points recede.
  assert.match(template, /const tone=c\.tone\|\|COL_TONE\[c\.key\]/);
  // Applied by toneCols, which columnsFor (and the overview / game-log column
  // sets) return through, so My Team, Players and All Rosters all get it.
  const a = template.indexOf('function toneCols('), b = template.indexOf('\nfunction ', a + 1);
  assert.match(template.slice(a, b), /td\.classList\.add\('t-'\+tone\)/);
  const c = template.indexOf('function columnsFor('), d = template.indexOf('\nfunction ', c + 1);
  assert.match(template.slice(c, d), /return toneCols\(cols\)/);
});

test('My Team shows League Value beside its ROS inputs, and each window its own position rank', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  // One League Value: the module's number, read through lvFor, never recomputed per page.
  const lv = fnBody('lvCols');
  assert.match(lv, /const lv=lvFor\(l\)/);
  assert.doesNotMatch(lv, /lvValues\(/);
  const cols = fnBody('teamColumns');
  // My Team drew League Value two ways: the ROS consensus column on Overview
  // and Rest of season, lvCols on Trade value. One definition now, every tab.
  assert.equal((cols.match(/lvCols\(L\(\)\)/g) || []).length, 1, 'built once');
  assert.doesNotMatch(cols, /c\.key==='cons'\)/, 'never the ROS consensus Value column');
  assert.match(cols, /head:'League value'/);
  assert.match(fnBody('columnsFor'), /key:'cons', label:'Value'[\s\S]*?get:p=> rosValue\(p\)/);
  // The agreed points and their position rank are two columns, named for the
  // window ("Week" / "Wk rank", "ROS" / "ROS rank"); My Team keeps the pair.
  assert.match(fnBody('consPtsCell'), /stackCell\(fmt\(c&&c\.v\), null/);
  assert.match(fnBody('columnsFor'), /key:'consrk', label:rkLab/);
  // The rank carries its outlook (FP expert spread, DS floor/ceiling) on hover instead of range columns — no mini chart.
  assert.match(fnBody('columnsFor'), /cell:p=> rankOutlookCell\(p,h\)/);
  assert.match(fnBody('rankOutlookCell'), /outlookTip\(o/);
  assert.doesNotMatch(template, /'olk'|'olr/);
  // The rank was a bold, right-pushed block; it is a plain centred number like ECR and DS.
  assert.match(fnBody('rankOutlookCell'), /cell\('num', null, \{text:m&&m\.pr/);
  assert.doesNotMatch(template, /'rkv|\.rko\{/);
  assert.doesNotMatch(fnBody('columnsFor'), /key:'(ecrrng|dsfloor|dsceil)'/);
  // Every tab hands back its scope with its columns; a bare array lost the scope.
  for (const tab of ['lineup', 'sources', 'ros', 'trade', 'schedule']) {
    assert.match(cols, new RegExp(`case '${tab}':[\\s\\S]*?return \\{scope:`), tab);
  }
});

test('lean tables: one line per row, on the player tables', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    const b = template.indexOf('\nfunction ', a + 1);
    return template.slice(a, b);
  };
  // Lean is a table class, styled in CSS, so no page builds its own one-line player.
  assert.match(fnBody('grid'), /\(o\.lean\? ' lean' : ''\)\+\(o\.nopos\? ' nopos' : ''\)/);
  for (const name of ['playersTable', 'leaguePlayersTable', 'sourceTable', 'pageWaivers', 'storedWeekPanel', 'overviewParts']) {
    assert.match(fnBody(name), /lean:true/, `${name} is lean`);
  }
  assert.match(fnBody('lineupTableView'), /cls:'roster lean'/);
  assert.match(fnBody('positionTableView'), /cls:'roster lean nopos'/, 'grouped by position: no position on each row');
  assert.match(fnBody('rosterTable'), /cls:'lean'/);
  // The kickoff a lean row hides stays on hover.
  assert.match(fnBody('oppCell'), /td\.title=kickoff/);
  assert.match(template, /table\.lean \.stack\{flex-direction:row-reverse/);
  assert.doesNotMatch(fnBody('overviewParts'), /table2\(|[^.\w]table\(\[/, 'the Overview side panels do not hand-build tables');
});

test('League Players: the owner in its own column, a leading rank, and rows tinted by owner', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const cols = fnBody('leaguePlayerColumns');
  // "#" is the player's own overall rank, centred and sortable — not the row's place under the sort.
  assert.match(cols, /OVR_COL/);
  assert.match(fnBody('playerColumns'), /OVR_COL/);
  assert.match(template, /const OVR_COL=\{w:44, band:'', key:'ovr', label:'#', ctr:1,[^\n]*\n[^\n]*overallRank\(p\)/);
  assert.match(template, /PLAYER_SORTS\.ovr *= \{[^}]*overallRank\(p\)/);
  assert.match(fnBody('overallRank'), /PLAYER_POOL\.filter/);
  assert.doesNotMatch(template, /rankCell|rank:true/);
  // Owner is a column of its own, not text beside the name — on both player pools.
  assert.match(cols, /label:'Owner', ctr:1, cell:p=> rosterBadgeCell\(p\)/);
  assert.match(fnBody('playerColumns'), /label:'Owner', ctr:1, cell:p=> rosterBadgeCell\(p\)/);
  // One pill: the fantasy team's crest at the pill's height, then its text; centred.
  // Small text, not a crest pill that crowded the row; yours is the blue one.
  assert.doesNotMatch(fnBody('ownerTag'), /teamAvatar/);
  assert.match(template, /\.own\.you\{background:var\(--consensus\)/);
  assert.match(fnBody('rosterBadgeCell'), /el\('td','ctr'\)[\s\S]*ownerTag\(o\)/);
  assert.match(fnBody('headCell'), /c\.ctr\?'ctr'/);
  assert.doesNotMatch(template, /owner:true|ownerText/);
  assert.match(fnBody('leaguePlayersTable'), /rowClass:ownerRowClass/);
  assert.match(fnBody('ownerOf'), /fxOwner\(/);
  // Values and the Waiver Wire draw the same badge, not a team name in text.
  assert.match(fnBody('pageValues'), /ownerTag\(valOwner\(p\)\)/);
  assert.match(template, /rowClass:r=> ownerRowClass\(r\.p\)/);
  assert.doesNotMatch(template, /teambadge/, 'the old pill is gone');
});

test('one header row: a column group rides in the label, never a band row above it', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  for (const name of ['grid', 'table2']) {
    assert.doesNotMatch(fnBody(name), /'bands'|th\.band|colSpan=n/, `${name} draws no band row`);
    assert.match(fnBody(name), /headCell\(c/, `${name} heads through headCell`);
  }
  assert.doesNotMatch(template, /function projBands\(/);
  // Two "Pts" columns still say whose: FP pts, DS pts.
  const short = template.match(/const BAND_SHORT = (\{[^}]*\})/);
  const map = Function(`return ${short[1]}`)();
  assert.equal(map.FantasyPros, 'FP');
  assert.equal(map['Draft Sharks'], 'DS');
  // A single-row header is never clipped: widths are floors, not fixed layout.
  assert.match(template, /table\.fixed\{table-layout:auto\}/);
  assert.doesNotMatch(template, /table-layout:fixed/);
  // Sortable headers show both arrows dim; the sorted one the accent.
  assert.match(fnBody('sortIcon'), /var\(--sort-on\)/);
});

test('the table system: dark tokens by default, light as the same tokens, and no bold', () => {
  const root = template.slice(template.indexOf(':root{'), template.indexOf('}', template.indexOf(':root{')));
  for (const hex of ['#12161F', '#29304A', '#222A3E', '#424B69', '#3A4360', '#E6E9EF', '#EEF1F6', '#FACD39']) {
    assert.ok(root.includes(hex), `dark default carries ${hex}`);
  }
  const light = template.slice(template.indexOf(':root[data-theme="light"]{'));
  for (const hex of ['#DFE4EC', '#FFFFFF', '#F3F5F9', '#D6DCE5', '#E2E7EE', '#262B33', '#1F242C', '#525A67']) {
    assert.ok(light.slice(0, light.indexOf('}')).includes(hex), `light carries ${hex}`);
  }
  // Light is chosen, never inferred: the toggle treats "no theme" as dark.
  assert.match(template, /const isDark = cur!=='light';/);
  assert.doesNotMatch(template, /font-weight:\s*[78]00|fontWeight='[78]00'/, 'weights 400/500/600 only');
  assert.match(template, /Poppins:wght@400;500;600&/);
  // Two views, one setting on <html> for every table, both plain tables on
  // hairlines: comfortable is taller with a headshot, compact has none. A row
  // is never drawn as a card (that is the single-player card component).
  assert.match(template, /:root\[data-tv="comfortable"\] table\{--row-h:46px\}/);
  assert.doesNotMatch(template, /border-spacing:0 6px/);
  assert.match(template, /:root\[data-tv="compact"\] table\{--row-h:30px/);
  assert.match(template, /:root\[data-tv="compact"\] td \.pid>\.av/);
  assert.match(template, /document\.documentElement\.setAttribute\('data-tv', v\)/);
  assert.doesNotMatch(template, /gd\.dg\./, 'the view is not remembered per table');
  // No zebra, no vertical column rules.
  assert.match(template, /td\.bandsep,\.tsep\{border-left:0\}/);
  assert.doesNotMatch(template, /tr\.benchrow td\{background/);
});

test('the player identity: small badge, headshot, name, status, team abbreviation (with position, under it in comfortable); a lineup keeps its large slot and his game underneath', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const id = fnBody('playerIdentity');
  const row = id.slice(id.indexOf("el('div','pid')"));
  const order = ["posChip(p.p,'mini')", 'avatarFor(p,{logo:true})', 'plink(p)', 'who.append(tag)', "el('span','tpos',p.p)", "el('span','tma',p.t)"];
  let at = -1;
  for (const k of order) { const i = row.indexOf(k); assert.ok(i > at, `${k} comes next`); at = i; }
  // No position badge on the headshot and no rank in the subtext — the columns carry ranks.
  assert.doesNotMatch(template, /'skt'/);
  assert.doesNotMatch(id, /rankTeam|agreed\(/);
  // The team in the Matchup page's tag type: beside the name in compact, under it in comfortable.
  // Compact: the abbreviation after the name, not a logo.
  assert.doesNotMatch(template, /\.tma\{display:none\}/);
  assert.doesNotMatch(fnBody('playerIdentity'), /'tmlogo'/);
  assert.match(template, /\.pid \.who>\.prt\{display:inline-flex;align-items:center;gap:4px;font-size:var\(--fs-2xs\);font-weight:600;letter-spacing:\.04em;color:var\(--muted\)/);
  assert.match(template, /:root\[data-tv="comfortable"\] \.pid \.who>\.prt\{grid-row:2/);
  assert.doesNotMatch(template, /:root\[data-tv="compact"\] \.pid \.who>\.prt\{grid-row/);
  // Comfortable: no badge before the headshot; the subtext reads "QB CAR" in the team's type.
  // Compact keeps the badge, and a one-position table shows neither.
  assert.match(template, /:root\[data-tv="comfortable"\] \.pid:not\(\.roster\)>\.pos\{display:none\}/);
  assert.match(template, /:root\[data-tv="compact"\] \.pid \.who>\.prt>\.tpos,table\.nopos \.pid \.who>\.prt>\.tpos\{display:none\}/);
  // The lineup leads with the slot badge; under the name, position, team and his game.
  assert.match(id, /posChip\(o\.slot,'slot'\)/);
  // Under the name, position and team only: the kickoff is the Opp column's, under the opponent in comfortable.
  assert.match(id, /\[p\.p, p\.t\]\.filter/);
  assert.doesNotMatch(template, /gameLine/);
  assert.doesNotMatch(id, /oppLabel/);
  assert.match(template, /:root\[data-tv="comfortable"\] table\.roster \.oppwrap>\.ss\{display:block/);
  assert.match(fnBody('avatarFor'), /imgEl\(teamLogo\(p\.t\),'lg'\)/);
  assert.match(fnBody('statusTag'), /'BYE'/);
});

test('row states: shaded cells are rounded, rows expand into a tray, sections are labels', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  // A heated cell's shade moves onto a rounded wrapper (full-bleed fills shipped before).
  assert.match(fnBody('shadeCell'), /el\('span','hc h'/);
  assert.doesNotMatch(template, /td\.h[ud][123]\{background/);
  // Every table builder marks player rows expandable.
  assert.match(fnBody('grid'), /expandable\(tr\)/);
  assert.match(fnBody('table2'), /expandable\(r\)/);
  assert.match(fnBody('playerTray'), /agreed\(p,false\)/);
  assert.match(fnBody('playerTray'), /agreed\(p,true\)/);
  // Rest of season in a league, the agreed rank is League Value's, so ROS rank, Value and "#" agree.
  assert.match(fnBody('agreed'), /ros && L\(\)[\s\S]*lvFor\(l\)\.players\.get\(p\.i\)[\s\S]*lv\.posRank/);
  // A frozen cell keeps the row's tint (it painted over yours / FA before).
  assert.match(template, /table\.dg \.stk\{position:sticky;z-index:1;background:linear-gradient\(var\(--cell-bg/);
  // Bench and reserve are section labels in the lineup, not filled bands.
  const lu = fnBody('lineupTableView');
  assert.match(lu, /section\('Bench'\)/);
  assert.match(lu, /section\('Injured reserve'\)/);
  assert.match(template, /table tbody tr\.sec>td,table tbody tr\.grouphdr>td,table tbody tr\.cutrow>td\{height:20px;/);
});

test('the player tables’ main number is the agreed one, not one site’s', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  // consFor fed every table, total, sort and lineup with FantasyPros' own
  // `wk`/`ros`; it now reads the FantasyPros + Draft Sharks consensus.
  const cons = fnBody('consFor');
  assert.match(cons, /agreed\(p,\s*(true|false)\)/);
  assert.doesNotMatch(cons, /p\.wk\b|p\.ros\b/);
  assert.match(template, /lvConsensus\(DATA\.pools\[sc\]\|\|\[\], vsSignals\(ros\? VS_SOURCES : VS_WEEK_SOURCES\)/);
  // A best-fit lineup is picked on the agreed week number too.
  assert.match(fnBody('lineupFor'), /wkPts\(b\)/);
  assert.match(template, /const wkPts = p=>\{ const m=metric\(p,'agreed'/);
  assert.match(fnBody('columnsFor'), /metric\(p,'agreed'/);
});

test('metric() is the one table accessor: agreed vs each site’s published number', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const met = fnBody('metric');
  assert.match(met, /id==='agreed'/);
  assert.match(met, /id==='fp'/);
  assert.match(met, /id==='ds'/);
  assert.match(met, /p\.wk\b/);
  assert.match(met, /p\.ros\b/);
  // FantasyPros as published, not the agreed blend — this labeled the card "FP"
  // and filled it with consFor.
  const src = fnBody('srcValue');
  assert.match(src, /metric\(p,\s*key/);
  assert.doesNotMatch(src, /consFor/);
  assert.match(fnBody('fpOwn'), /metric\(p,'fp'/);
  assert.match(fnBody('mdProjections'), /srcValue\(p,k,/);
  assert.doesNotMatch(fnBody('mdProjections'), /consFor/);
  assert.match(fnBody('mdDetails'), /metric\(p,'fp'/);
  assert.match(fnBody('mdKpis'), /metric\(p,'agreed'/);
});

test('grid() draws kind+get columns when cell is absent, and sorts by get', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const draw = fnBody('dgCell');
  assert.match(draw, /c\.cell\) return shadeCell\(c\.cell\(r\)\)/);
  assert.match(draw, /c\.kind\) return cell\(c\.kind,\s*c\.get/);
  assert.match(fnBody('grid'), /!c\.sort && c\.get/);
  assert.match(fnBody('grid'), /dgCell\(c,r\)/);
  const cols = fnBody('columnsFor');
  assert.match(cols, /kind:'num'/);
  assert.match(cols, /get:p=>\{ const m=metric\(p,'agreed'/);
  assert.match(cols, /get:p=>\{ const m=metric\(p,'fp'/);
  assert.match(cols, /get:p=>\{ const m=metric\(p,'ds',h\)/);
});

test('My Team checks the lineup you set against the best one on the agreed week projections', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const chk = fnBody('lineupCheck');
  // The Power Rankings' slot-filling, not a second optimiser.
  assert.match(chk, /prLineup\(/);
  // Bye, Out and IR project nothing; a started game is locked where it is.
  assert.match(chk, /isBye\(p,DATA\.week\) \|\| \['O','IR'\]\.includes\(injClass\(p\)\)/);
  assert.match(chk, /locked\(p\)\? \(isStarter\.has\(p\.i\)\? 1e6 : -1\)/);
  // Only a lineup you actually set gets a call; a computed lineup is already the best fit.
  assert.match(fnBody('teamRosterTable'), /lu\.source==='actual' && o\.check\? lineupCheck\(l, lu\)/);
  const tabs = fnBody('teamColumns');
  assert.match(tabs, /case 'lineup':[\s\S]*?check:true/);
  assert.match(tabs, /key:'grade'/);
  // The call rides the slot, as the hosts draw it, not a column of its own.
  assert.doesNotMatch(template, /function decisionCol\(/);
  assert.match(fnBody('lineupTableView'), /LU_CHECK\.call\.get\(p\.i\)[\s\S]*?l1\.append\(chip\)/);
});

test('My Team: old tab links land on the redrawn tabs, and Schedule shows opponents, not projections', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  const m = template.match(/const teamTabOf = (v=>[^;]*);/);
  assert.ok(m, 'teamTabOf exists');
  const of = Function(`return ${m[1]}`)();
  assert.equal(of('overview'), 'lineup');
  assert.equal(of('week'), 'lineup');
  assert.equal(of('weeks'), 'schedule');
  assert.equal(of('ros'), 'ros');
  assert.equal(of('buzz'), 'lineup');
  // A bookmarked ?tab=overview was dropped on the floor before the redraw kept it.
  assert.match(template, /teamTab=teamTabOf\(h\.tab\)/);
  const sch = fnBody('teamColumns').split("case 'schedule':")[1];
  assert.match(sch, /oppLabel\(p,wkN\)/);
  assert.doesNotMatch(sch, /metric\(/, 'no per-week projections beyond the current week');
});

test('this week\'s score sits beside the projection, and reads the live matchup over a stale roster', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  // The roster said "Not Started" for a Thursday game the live matchup had as
  // Final, so a 10.9 never showed and the Score column stayed hidden.
  const shown = fnBody('shownPoints');
  assert.match(shown, /const s=liveLine\(p\);[\s\S]*?if\(s && gameOn\(s\.game\) && s\.pts!=null\) return \{v:s\.pts, src:'league'/);
  assert.ok(shown.indexOf('liveLine(p)') < shown.indexOf('p.lp'), 'the live line is read before the roster');
  assert.match(fnBody('liveLine'), /x\.fpId, \{pts:x\.pts, game:x\.game\}/);
  // The score column is spliced in right after the projection, not pushed to the end.
  assert.match(fnBody('columnsFor'), /cols\.splice\(at\+1, 0, scoreCol\(h\.from\)\)/);
  const tabs = fnBody('teamColumns');
  assert.match(tabs, /case 'lineup':[\s\S]*?pick\('cons'\), \{sep:1\}\),\s*pick\('pts'\),/);
  assert.match(tabs, /case 'sources':[\s\S]*?pick\('cons'\), \{sep:1\}\),\s*pick\('pts'\),/);
  // As prominent as the name; green or red against the projection once final.
  assert.match(template, /\.scored\{font-variant-numeric:tabular-nums;font-weight:600;font-size:var\(--fs-name\)/);
  assert.match(fnBody('scoredCell'), /v>=m\.v\? ' beat' : ' miss'/);
  // The key tone must not paint over the beat / miss colour.
  assert.match(template, /td\.t-key \.scored:not\(\.zero\):not\(\.beat\):not\(\.miss\)/);
});

test('Opp · SOS: the opponent in plain text, a dot only for a lopsided matchup, the rating on hover', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  assert.match(fnBody('oppCell'), /oppChip\(oppLabel\(p,h\.from\), sos\)/);
  const c = fnBody('oppChip');
  assert.match(c, /if\(val>=10 \|\| val<=-10\) c\.append\(el\('i','sosd '/);
  assert.match(c, /c\.title='Draft Sharks/);
  assert.doesNotMatch(c, /chip\.classList/, 'the opponent itself is never tinted');
  assert.doesNotMatch(template, /\.oppname\.[gb]/);
  assert.doesNotMatch(c, /'sosv/, 'no number on the row');
  assert.match(c, /label==='BYE'\) return c/, 'a bye has no matchup to rate');
  assert.doesNotMatch(template, /sosMeter|'pips'/);
});

test('My Team leaves out the demand board: adds, drops and start % lag, and say little about a player you already roster', () => {
  const fnBody = (name) => {
    const a = template.indexOf(`function ${name}(`);
    assert.ok(a >= 0, `${name} exists`);
    return template.slice(a, template.indexOf('\nfunction ', a + 1));
  };
  assert.doesNotMatch(template.match(/const TEAM_TABS=.*/)[0], /'buzz'/, 'no Buzz tab');
  assert.doesNotMatch(fnBody('teamColumns'), /buzzColumns|yStart|case 'buzz'/);
  assert.doesNotMatch(fnBody('overviewParts'), /p\.sig|Being added/);
  // Rest of season is read by position rank; the season total is not a column.
  const ros = fnBody('teamColumns').split("case 'ros':")[1].split("case 'trade':")[0];
  assert.doesNotMatch(ros, /conspts/);
  assert.match(ros, /ov\('consrk'\)/);
});
