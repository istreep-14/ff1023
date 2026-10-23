# Dashboard components: tables, lists and data cells

Status: **phases 1–4 done** — formatting module, `cell()` kinds, one player
identity, `grid()` on every large table, `smallTable()` on every small table,
and shared List / Compare / KeyValue components; phase 5 remains. The
migration order is at the end. **The table system (§3.9, 2026-10-21)** is the
approved look every table now draws with: tokens, one header row, the
one-line player identity, owner badges, densities and row states.

The dashboard (`src/dashboard.template.html`) grew one page at a time, and its
tables show it. This document fixes ONE vocabulary of components — which one a
piece of data gets, what it looks like, and how it is built — so a number,
a player or a team reads the same way on every page.

## 1. Where things stand (audit, 2026-10-20)

| What | Today | Problem |
|---|---|---|
| Table builders | `table()` (16 calls), `table2()` (12 calls), and 7 hand-built `el('table', …)` (Players, Standings, Waivers, Matchup, Analysis grid, …) | Three ways to build a table; sticky headers, bands, widths and density differ by which one a page happened to use |
| Density | `table.fixed` (3px cell padding, sticky header, max-height scroll) vs. plain `table` (4px, no sticky) | Chosen by "has fixed widths", not by how many rows the table has |
| Cell helpers | ~30 (`stackCell`, `numCell`, `ecrCell`, `tmMarketCell`, `consPtsCell`, `srcCell`, `trendCell`, `deltaCell`, `dashCell`…) | Several do the same job differently; a blank is sometimes `dashCell()`, sometimes the text `'—'` |
| Number formatting | `fmt`, `prFmt`, `pts2`, `num`, `signed`, `rate` | The same value shows `12.0`, `12` or `12.00` depending on the page |
| Player identity | `playerCell2`, `rosterCell`, `.prow` rows, plain text names | Avatar size, position chip and team line vary |
| Disagreement / change | `.delta up/dn`, `.tmgap`, `td.hu1–3/hd1–3`, coloured text | Four encodings of "better / worse" |
| Sorting | `makeSortable` re-reads cell TEXT (`sortCell`) | "RB3", "+12", "—" are parsed back out of strings; fragile |
| Lists (non-tabular) | `.posrank/.prk`, `.pm-card dl`, lineup rows, strip tiles | No shared row component; every page rolls its own |

## 2. What the references get right

The six reference screens (FantasyPros Trade Market Values, player profile +
game log, trade result, Trade Analyzer ×2, a props table) share a small
grammar worth copying:

1. **The amount of data decides the component, not the page.** 400-row prop
   board = dense grid with heat; 10–16 teams = roomy table with bars; a trade
   side = a list of player rows; a player's headline = a stat strip.
2. **One player identity everywhere:** headshot, name, then `POS - TEAM`
   (and bye / injury badge) underneath. Rank lives at the trailing edge
   (`WR12`), never mixed into the name.
3. **Numbers are right-aligned, tabular, and unit-consistent**; change is a
   signed number in green/red, with an arrow icon only past a threshold
   (Puka `943 ⬆`).
4. **Column groups are named bands** (`Fantasy | Receiving | Rushing`,
   `Projections & Ratings | Over Hit Rates`).
5. **Heat is a background, not text colour,** and its scale is stated:
   full-bleed cells in a dense grid (props), rounded pills in a small table
   (game log).
6. **The filter bar has a fixed order:** view segment → format/scope selects
   → position pills → value filter → search on the right → row count
   (`449 of 449`).
7. **Actions sit at the end of a row**: an outlined button for the primary
   (`View Details`). (The reference's `Find Trades` link is not wanted — §6.)
8. **Summaries are a number + a bar with a marker** (Power Rank 67.6, the
   trade's +0.9%), and needs are chips (`FLX RB K`).

## 3. The components

Pick by the data's shape. When two fit, take the one higher in this list.

| Component | Use when | Row height | Examples here |
|---|---|---|---|
| **DataGrid** | > ~25 rows, or > 8 columns, or the reader scans/sorts/filters | 38px (default; 32 / 48 by the switch) | Players, League Players, Values, Trade Market, Sources |
| **Table** | ≤ ~25 rows, rows are teams/weeks, a bar or tier is the point | 38px (default) | Standings, Power Rankings, Teams matrix, Analysis, Waiver Wire sheets (top 8–30 per position), game log |
| **List** | 1–3 facts per row, read top to bottom, often selectable | 44px; 64px as cards | Lineups, trade sides, watch list, recent players, transactions |
| **Compare** | two things side by side | — | Matchup, trade result |
| **KeyValue** | one object's attributes | 28px | player card blocks, league settings |
| **StatStrip** | 2–5 headline numbers | — | page summaries, player card hero |
| **Feed** | time-ordered text | — | Log, news |

### 3.1 DataGrid (large)

- Sticky header; the first column is sticky ALWAYS.
- **One header row** (§3.9). A column group no longer gets a band row; its
  short name rides in the column's own label (`FP pts`, `DS floor`,
  `Trade value`) through `headLabel` / `BAND_SHORT`, and `head` sets a
  label outright.
- The card **hugs** its columns: a column's `w` is its floor, not a clip
  (`table.fixed` is auto layout), so a one-row header is never cut; frozen
  columns pin their width so the next one's offset is known.
- Comfortable view by default (§3.9); zebra off; row hover on; owner tints (§3.9).
- **Sort is declared, not parsed**: each column gives `sortValue(row)`;
  blanks always last; the sorted column header is highlighted.
- Rows render 100 at a time with "Show all N" (no virtualisation needed at
  our sizes, ≤ ~800 rows); the panel header shows `N of M` like the props board.
- A **view switch** (Comfortable / Compact, §3.9) — one setting for every
  table, pure CSS on `<html>`; Trade Market's rows stay roomy in both (§6).
- Optional **heat** columns (see 3.6) and a legend line under the grid.
- Filter bar above it, in the order from §2.6.

### 3.2 Table (small)

- Same column definitions as DataGrid, comfortable density, no sticky header,
  no pagination.
- Allowed here and not in DataGrid: strength **bars**, **tier chips**,
  larger team avatars (32px), two-line cells (value + rank underneath).
- Total rows (`totrow`) pinned to the bottom and excluded from sorting.
- **Lean** (`grid({lean:true})`, `table2(…, {cls:'lean'})`): one line per
  row, like a printed cheat sheet — every player table (My Team, All Rosters,
  Players, League Players, Sources, Waiver Wire, stored weeks, the Overview's
  side panels). The player is the one-line identity (§3.9); a number's rank
  sits beside it (`178.8  RB 12`) where it is not its own column; the
  kickoff moves to the opponent's hover. Pure CSS over the same cells. Team
  tables (Standings, Power, Analysis) keep their two-line team cells.

### 3.3 List

One row component, three variants:

- `plain` — avatar (with position badge overlay, as in the profile sidebar),
  name, `WR12 · HOU` subline, trailing value/rank.
- `select` — checkbox leading, IR/Q badges after the name, trailing rank
  (Trade Analyzer).
- `card` — bordered rounded row with 8px gap between rows (trade result).

**Player card** (`playerCard(p, {lines, spark, tab})`, `.pcard`): the one
card any non-table view of players uses — photo on a grey angled tile, name,
position pill + team, `[label, value]` lines, an optional area sparkline;
it opens the player on `tab`. The modal's "Similarly Valued Players" row
(`tmCard`) is the first user. A new card view builds on it rather than
drawing its own.

Lists never sort by header (they have none); a list that needs sorting is a
Table.

### 3.4 Compare

Two columns with a centred verdict between them (`Win-Win`), each side a
header (team identity + big number + marker bar) over a List. Matchup and any
future trade analyzer use it.

### 3.5 KeyValue and StatStrip

`KeyValue` replaces the ad-hoc `mdCard` `<dl>`s: label left, value right,
value uses the same formatters as cells. `StatStrip` replaces `statTile`
rows: label (eyebrow style), number, one sub-line.

### 3.6 Cell kinds (the atoms every component shares)

A column declares a `kind`; the kind owns rendering, alignment, formatting,
blank handling and sort value. No page writes a cell by hand.

| kind | Shows | Align | Blank | Notes |
|---|---|---|---|---|
| `player` | PlayerIdentity (sm 28px / md 36px) | left | — | name opens the card |
| `team` | TeamIdentity (logo + name, "you" mark) | left | — | |
| `text` | string, ellipsis | left | `—` | |
| `num` | value with unit-aware format | centre | `—` + reason tooltip | optional sub-line |
| `rank` | `#12` or `WR 12` | centre | `—` | sort ascending |
| `delta` | signed number, green/red; arrow icon past `threshold` | right | `—` | `+0` shown as `0` |
| `heat` | `num` + background from a scale | right | uncoloured | full-bleed in DataGrid, pill in Table |
| `spark` | line/area series | right | `—` | `data-v` = net change |
| `bars` | volume micro-bars | right | `—` | |
| `bar` | strength bar with tier colour | left | empty track | Table only |
| `chip` | tier / need / status chips | left | — | |
| `action` | link or outlined button | right | — | last column only |

**PlayerIdentity** (one renderer, two layouts — §3.9): one line, position
badge → 28px headshot with the NFL logo on its corner → name → NFL team →
status tag. A lineup leads with its slot badge and keeps `POS - TEAM` under
the name. `playerCell2` and `rosterCell` are its two layouts.

### 3.7 Formatting rules (one module, tested)

| Quantity | Format | Example |
|---|---|---|
| fantasy points | 1 decimal | `17.2` |
| trade value ≥ 1,000 | integer, thousands separator | `10,200` |
| trade value < 100 | 1 decimal | `97.4` |
| league points (League Value) | integer ≥ 100, else 1 decimal | `168`, `48.1` |
| overall rank | `#n` | `#12` |
| position rank | `POS n` (`fxPosRank`; `fxRankText` tidies a source's `WR12`) | `WR 12` |
| percent | integer + `%` | `99%` |
| change | sign always, same decimals as the value | `+22`, `-1.5` |
| missing | `—`, never `0`, with a tooltip saying why | |

### 3.8 Colour scales

- **Diverging** (better / worse than a reference): 3 steps each side of a
  neutral band — the existing `hu1–3 / hd1–3`, renamed `heat-up-1..3 /
  heat-dn-1..3`, used for League Value disagreement, value gap, rank change.
- **Sequential** (more is better, e.g. hit rate, snap %): 4 steps of one hue.
- **Categorical**: positions (existing `--p-*`), tiers (`prt0–5`).
- Heat steps come from `fxHeat(delta, thresholds)` in `src/format.js`; the
  class from `fxHeatClass`.
- Every scale works in both themes (built with `color-mix` on tokens, as
  today) and every heated column has a one-line legend.

### 3.9 The table system (approved boards, 2026-10-21)

The Design canvas's "Page choices" boards — Team view and Player table, dark
and light — are the reference. Everything below is in
`src/dashboard.template.html`, shared by `grid()`, `smallTable()`, `table2()`
and `table()`; no page styles its own table.

**Tokens.** Dark is the default theme (`:root`); light is the same names
re-valued under `:root[data-theme="light"]`, chosen by the Theme button only.

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--ground` | `#12161F` | `#DFE4EC` | page |
| `--surface` | `#29304A` | `#FFFFFF` | card and rows |
| `--th-bg` / `--surface-2` | `#222A3E` | `#F3F5F9` | header bar |
| `--line-strong` | `#424B69` | `#D6DCE5` | card edge, rule under the header |
| `--line` | `#3A4360` | `#E2E7EE` | row lines |
| `--row-hover` | `#353E5A` | `#F3F5F9` | hover |
| `--ink` / `--ink-name` | `#E6E9EF` / `#EEF1F6` | `#262B33` / `#1F242C` | numbers / names |
| `--ink-3` / `--th-ink` | `#A9B1BF` / `#B9C0CC` | `#868B95` / `#525A67` | secondary line / headers |
| `--gold` on `--gold-ink` | `#FACD39` on `#16191D` | same | the accent: active chip, sort arrow (dark) |
| `--row-you` / `--you-ink` | `#24365A` / `#0B1A30` | `#E9F1FD` / `#FFFFFF` | your rows; ink on the blue YOU tag |
| `--p-qb … --p-ir` | QB `#C8A1FF` RB `#83DCEF` WR `#85DE9E` TE `#FF8AA2` K `#FDB97C` DST `#BDC3CD` BN `#EBEEF4` IR `#FD9891`; FLX `#7FD1D8` | FLX `#A9E6EE` | position and slot badges, ink `#13284A` |
| `--heat-u2 … --heat-d2` | `#1F5A50 #1C3F43 · #3E2B38 #5E3239` | soft green / soft red | shaded value cells |

**Type.** Poppins (Arial, Helvetica fallback), antialiased, weights 400 /
500 / 600 only. Names 14px/500 (`--fs-name`); numbers and ranks 12px/500
tabular, centred (`--fs-num`); headers 12px/500 in sentence case on the
header bar (`--fs-th`). No vertical column lines, no zebra.

**Rows.** 38px by default, cells padded `0 8px`, columns sized to content;
the player column is ~330px. The card hugs its table.

**Player identity** (`playerIdentity`): one line —

| Piece | Spec |
|---|---|
| position badge | `.pos.mini`, min-width 20px, 13px tall, radius 3px, 8.5px/600, `#13284A` on the position colour — smaller than the name, as in transaction rows |
| headshot | `.av` 28px round; the NFL logo `.lg` 13px at its bottom-left with a drop shadow; a defense is its logo |
| name | `.plink` 14px/500; turns link-blue with its row on hover; opens the player card |
| NFL team | `.prt`: the team abbreviation (10px/600 muted, .04em, the Matchup page's team tag) — beside the name in compact; after the position ("QB CAR") on a second line in comfortable, which drops the leading badge |
| owner | not part of the identity: League Players and Players give it its own `Owner` column (`rosterBadgeCell`) |
| status | `statusTag`: `.st` 16px tall, 10px/600 — BYE yellow, OUT/IR coral, Q/D amber |

A lineup (`layout:'roster'`) leads with the slot badge (`.pos.slot`: min-width
28px, 23px tall, radius 6px, 11px/600; flex reads FLX) and keeps a
`POS - TEAM` line under the name (his game is the Opp column's: in
comfortable, kickoff sits under the opponent); a starter who cannot play is dimmed. The
all-players grids lead with a muted, centred "#" column: the player's own
overall rank in the pool by the agreed number (`overallRank`), which stays
put under any filter or sort and sorts the table when clicked. A table of one position (`nopos`) drops
the badge.

**Ranks** read `RB 6`: position, a space, the number (`fxPosRank`,
`fxRankText`). The agreed number and its rank are two columns named for the
window — `Week` / `Wk rank`, `ROS` / `ROS rank` — with an (i) on the points
header explaining "Agreed". The opponent column is centred and muted.

**Owner column** (`fxOwner` → `ownerTag`, league-wide tables: Players, League
Players, Values, Waiver Wire): centred, 56px, small muted abbreviation text
and nothing else, so it stays out of the way. Only the answers that matter
to you get a fill: `YOU` in blue (`--consensus`), `FA` green, `W` amber plus
the day he clears (`Thu`). The full name is on hover. The whole row is tinted
by the same answer: `tr.you` (blue), `tr.fa` (green), `tr.wv` (amber). Every
column after it is centred, like every number column.

**Toolbar** (`.dg-bar`, above a grid or a lineup): filter chips (`.fchip`,
28px pills; the active one yellow), a muted count with the sort ("Showing
100 of 539 players · sorted by Week"), and the view switch.

**Views** (`tableViewSwitch`, `setTableView`): two, ONE setting for every
table — `data-tv` on `<html>`, remembered under `gd.tv`; any table's switch
(or the command palette) flips them all. **Comfortable** (default) draws each
row as a card, like a Matchup page player: no position badge before the
headshot; under the name the position and team, "QB CAR", both in the team
abbreviation's type with no team logo (a one-position table drops the
position). **Compact** is one line per player — position badge, full name
(13px/600), team abbreviation, status tag — in 30px rows with no headshot or
team crest (a lineup keeps its slot badge and puts "POS - TEAM" beside the
name), and two-line number cells on one line. Trade Market's sparkline
rows stay taller in both (`density:'roomy'`).

**Headers** (`headCell`): sortable columns show dim up/down arrows; the
sorted column's live arrow is the accent (`--sort-on`: yellow dark, blue
light).

**Row states**, strongest last — each is a `--cell-bg` the cells paint, so a
frozen cell layers it over the card instead of hiding it:

| State | Look |
|---|---|
| hover | `--row-hover` tint; the name turns link blue |
| yours / FA / waivers | blue / green / amber tint |
| selected | `--row-sel` tint with a 3px blue left edge |
| expanded | `--row-exp` tint; a detail tray (`playerTray`) opens under it: this week, rest of season, rostered, weekly bars |

Clicking a player row anywhere but the name (which opens the card) selects
it and opens the tray; a second click closes it; one open row per table.

**Section dividers** (`tr.sec`, `tr.grouphdr`, `tr.cutrow`): Bench, Injured
reserve, a playoff cut — a 10px muted uppercase label over a thin top rule,
never a filled band. The totals row is unfilled, under a strong rule.

**Shaded value cells** (`fxHeatClass` + `shadeCell`): the shade is a rounded
cell (`.hc`) inside the column, never a full-bleed fill — League Value vs
each source, team totals vs League Value, Yahoo net adds.

## 4. How it is built

Same pattern as the rest of the page's logic: the pure part is a module in
`src/`, inlined with `/*__INLINE:…__*/` and unit-tested under Node.

- `src/format.js` (pure, inlined): the formatters in 3.7 and the heat-scale
  functions (`heatStep(delta, thresholds)`). Replaces `fmt/prFmt/pts2/num/
  signed/rate`.
- In the template, one component layer:
  - `grid({ cols, rows, bands, density, sticky, limit, empty, footer, legend })`
  - `table(...)` = `grid` with `density:'comfortable', sticky:false, limit:null`
  - `list({ items, variant, row, trailing, onSelect })`
  - `compare({ left, right, verdict })`, `keyValue(rows)`, `statStrip(tiles)`
- A column is data, shared by grid and table:

  ```js
  {key:'lv', label:'League Value', band:'This league', kind:'heat',
   get:p=>valWorth(p,LV,sf), sub:p=>posRank(p), heat:{ref:..., steps:[8,20,40]},
   title:'…', w:84}
  ```

- Sorting reads `sortValue` (defaults to `get`), so `makeSortable` and
  `sortCell`'s text parsing go away.

## 5. Migration, page by page

Each phase ships on its own, with `npm test`, the template `node --check`, and
a before/after screenshot of every page it touches.

1. **Atoms, no visual change.** ✅ `src/format.js` (+ `test/format.test.js`);
   `playerIdentity()`; `cell(kind, v, opts)` with `num` / `delta` / `blank` /
   `player`. `fmt`, `num`, `pts2`, `prFmt`, `signed`, `rate`, `stackCell`,
   `numCell`, `dashCell`, `deltaCell`, `playerCell2`, `rosterCell` are now
   thin aliases over them. Verified by dumping every page's rendered DOM
   (2 leagues × 17 pages + the Values teams view) before and after: identical.
2. **DataGrid.** ✅ `grid()` in the template: Values, Trade Market (roomy),
   Players, League Players, Sources. Sticky header + band row, sticky
   identity column(s) (star + player on the Players pages), Compact /
   Comfortable (Roomy on Trade Market) remembered per grid, "Showing N of M",
   100 rows then "Show all", sorting by each column's `sort(row)` (Values,
   Trade Market) or the page's own comparator (Players, Sources — controlled
   mode). A test fails if those tables go back to building their own
   `<table>`. Waiver Wire moved to phase 3: its sheets are 8–30 rows.
3. **Table.** ✅ Power Rankings, Teams matrix, Standings, Analysis, Waiver Wire
   sheets, and stored-week player scores use `smallTable()`.
4. **List / Compare.** ✅ Matchup score and lineup comparisons use `compare()`;
   transaction moves use responsive `list()` cards; player-card detail blocks
   use `keyValue()`. There is no trade-analyzer/trade-side view in the app yet.
5. **Remove the old layer.** `table2`, `stackCell`, the `*Cell` helpers,
   `makeSortable`'s text parsing. Add a test that fails if any page builds
   `el('table'` itself, so the drift cannot come back.

## 6. Decisions (2026-10-20)

- **Trade Market is roomy**: comfortable density, ~88px rows with the
  sparkline and volume bars, like the reference. Every other DataGrid
  defaults to compact.
- **No per-row `Find Trades`.** Rows keep only `View Details`.
- **The first column is sticky always**, on every screen size, in every
  DataGrid.
- **My Team's roster tables are Tables** (comfortable, 46px rows): ~16 rows
  of two-line cells. A starter on bye is flagged on the slot; the score
  column appears once someone on the roster has scored. On the Overview the
  roster hugs its table and Injury watch / Being added / Recent moves sit
  beside it, wrapping underneath when there is no room.
- **League Value is a My Team column** (Lineup, Rest of season, Trade
  value): the same `lvFor` number as the Values page, drawn by the one
  `lvCols` definition, with its position rank beside it and a starters
  total. FantasyPros points carry their own window's position rank underneath
  (week rank under the week, ROS rank under ROS).
- **My Team's tabs follow the hosts' team page (2026-10-23).** Each tab
  answers one question, columns left to right: matchup, agreed number, each
  source, result, worth.
  - **Lineup** (landing, ESPN/Sleeper's row): Opp · SOS, Proj, Score,
    Wk rank, ROS rank, League value. The lineup check's START / SIT rides
    the slot row, not a column. The side rail is Injury watch and Recent
    moves; the demand board (Sleeper adds) left it (2026-10-23).
  - **Sources**: the agreed week beside FP pts, ECR, grade and DS pts,
    floor, ceiling, then Score.
  - **Rest of season**: ROS rank, ECR, DS, League value, Avg, L3, Bye. The
    position rank is what it is read by; the season points total is not a
    column.
  - **Trade value**: League value, Market value, change, chart, Gap (market
    position rank minus League Value's).
  - **Schedule**: ROS rank and the opponent for every week left; the
    starters row counts byes. Opponents only, never a projection.
  Old `tab=overview` / `week` / `buzz` links open Lineup, `weeks` opens
  Schedule. No Buzz tab: adds, drops and start % lag a day and say little
  about a player already rostered, so My Team does not show them; they stay
  an opt-in column group on Players.
