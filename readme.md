# ff091126 — Gridiron Desk

Your fantasy football leagues (ESPN, Yahoo, Sleeper — whatever FantasyPros
MyPlaybook can see), joined with two projection sources and two demand signals,
built into one self-contained dashboard. Zero dependencies. Node 20+.

```bash
cp .env.example .env     # your FantasyPros account email (+ optional API key)
npm run leagues          # check it sees your leagues
npm run sync             # fetch whatever is stale, then build dist/dashboard.html
npm run serve            # http://localhost:4173 — the dashboard with working buttons
```

## What it pulls

| Source | What it gives | Window | Its own clock? |
|---|---|---|---|
| **MyPlaybook** (`mpbnfl.fantasypros.com/api`) | every league on the account: rosters, settings, transactions, live matchups, league analysis | live | no |
| **FantasyPros** public pages | expert rankings + rank-implied points, its projections model, news, injuries | current week + rest of season | yes, `last_updated_ts` |
| **FantasyPros** API v2 (optional key) | player external ids, points scored to date | season | — |
| **Draft Sharks** | a second, independent board with floor/ceiling and SOS | current week + rest of season | yes, `Last-Modified` |
| **Sleeper** | standings and past weeks for Sleeper leagues; weekly points for every player; the id bridge + headshots | live / per week | no |
| **Yahoo BuzzIndex**, **Sleeper trending** | who the rest of fantasy football is adding right now | today / rolling | Yahoo's is a date |
| **ESPN schedule** | opponent and bye, every team, every week | season | no |
| **Dynasty Daddy** (`api.dynasty-daddy.com`) | player rows in one request: ids, ADP, Sleeper roster rates, and ESPN/FanDuel/FantasyGuys ROS ranks (its trade-value markets are not kept); each Sleeper/ESPN league's full schedule and Sleeper potential points | today / season | yes, `most_recent_data_point` (nightly) |

Two rules keep the numbers honest, and both were learned the hard way:

- **Current week and rest of season, nothing else.** Both projection sources
  publish exactly those two; anything further out was a season total spread
  across weeks, which looked like data and was not. The dashboard's window is
  *this week*, *rest of season*, or *full season* (scored + rest of season).
- **No blending.** FantasyPros and Draft Sharks are each shown as their own
  number. A weighted "consensus" used to sit on top and was removed: it hid
  which source said what, and a stale source averaged with a fresh one read as
  a real move.

Earlier versions also pulled WinWithOdds, First Down Studio, FanDuel and
Sleeper/Yahoo weekly projections. They were dropped (see git history) —
static season files, expiring cookies, or numbers on a different scale.

VegasEdge was dropped with them and brought back (2026-10-23) for what no
other source here has: a simulated spread around this week's projection
(p10–p90, boom/bust, skew). It is shown beside the agreed number and is not
an input to it. Its points are scored from the props' stat line, never read
off its board — the board follows whatever scoring the account last saved
(a PPR pull came back half-PPR). `VEGAS_TOKEN` expires about monthly; the
sync says so before asking.

## Daily use

| Command | What it does |
|---|---|
| `npm run sync` | **the one to run.** Every source that has gone stale, then join + rebuild + audit |
| `npm run live` | the minute-by-minute set: live boards, player points, trending, buzz, Draft Sharks |
| `npm run proj` | projections + rankings only (FantasyPros, Draft Sharks) |
| `npm run all` | everything, ignoring freshness |
| `npm run sync -- --only fp,trend` | named steps (or a preset: `live`, `projections`, `leagues`) |
| `npm run sync -- --dry-run` | what would fetch, fetching nothing |
| `npm run sync -- --watch 5` | a pass every 5 minutes; each pass still honours every TTL |
| `npm run status` | each source's age on both clocks |
| `npm run log` | the permanent run log (`--errors`, `--src fp`, `--limit N`) |
| `npm run serve` | the dashboard at `http://localhost:4173` with working Sync, Log and league switches |

`node src/cli.js help` lists every command, including the league edits below.

### Freshness: two clocks

`data/freshness.json` records, per source, **when we fetched** and **when the
site says it last recomputed**. Conflating them hides the case that matters: a
source fetched a minute ago that is still serving yesterday's numbers. Each
source declares how often it actually republishes (`MAX_AGE_MIN` in
`src/freshness.js`) and is skipped while younger than that. The joins
(`enrich`, `dashboard`, `audit`) always run — a skipped fetch still needs the
other sources joined.

### The run log

Every line every sync prints — from the terminal or from the dashboard — is
appended to `data/runlog.jsonl` (trimmed to the last 3,000). The dashboard
inlines its tail, tails it live under `serve`, and shows it on the **Log**
page; the toasts at the foot of the second rail are its temporary half.

## The dashboard

`dist/dashboard.html` is one file with its data inline. Open it directly, or
run `npm run serve` to make its buttons work.

- **Search (⌘K / Ctrl K / `/`)** — the box in the header. Pages, leagues,
  players (opens their card) and commands: sync presets, any single step, dry
  run, theme, copy the scores bookmarklet, save League Setup edits. `>` narrows
  to commands, `@` to players. Opened as a file, a command that needs the
  server copies its CLI line instead.
- **League** — My Team, Matchup, Standings, Analysis, Power Rankings, All
  Rosters, Players, Waiver Wire, Transactions, League Setup, for the league in
  the switcher. **Power Rankings** scores every roster from League Value (or
  any one rest-of-season source) two ways — *Contender* (the best legal
  lineup's value) and *Trade value* (the whole roster) — with Dynasty Daddy's
  tiers (Super Team … Trust the Process), positional needs, remaining-schedule
  strength, and the league's rank in every source side by side.
- **Values** (under Players) — every rest-of-season source as its own column:
  FantasyPros ROS, Draft Sharks ROS, and the ESPN, FanDuel and FantasyGuys ROS
  ranks. No trade-market values: each is already priced for someone else's
  league, and pricing for this one is League Value's job. **Every source is
  put on this league's axis**: its position rank for the player, priced by
  the league's projection curve and replacement level — so every column is
  in the same unit (rest-of-season points over replacement here) and still
  one source's opinion. League Value is the highlighted first column; every
  other cell is shaded green or red by how much higher or lower its source is
  on him. *Position rank* and *Source's own* number are one toggle away. A
  *Spread* column shows how far the sources disagree.
  Pick a team to list its players with roster and starting-lineup totals per
  source, or switch to **Teams** for every team's lineup or roster value and
  rank in every source. A player's card has a **Values** tab with the same.
- **League Value** — the first column there and the default on Power
  Rankings: one number per player priced for *this* league. Every source's
  values assume some other league (size, 1QB vs superflex, bench), so only
  their order within each position is used: FantasyPros ROS and Draft Sharks
  (its ROS projection and 3D Value, half a vote each) rank the position, one
  vote per site (FantasyPros once — its ROS points are its rank board's
  implied points), their consensus orders it, the FantasyPros + Draft Sharks
  rest-of-season curve (in the league's scoring format) gives that order its
  points, and the league's own lineup and real roster depth set replacement.
  Value is rest-of-season points over replacement. No trade-market value goes
  in. The player card shows every input. Custom scoring beyond PPR/half/standard
  (TE premium, 6-pt passing TDs) is not yet modelled.
- **The agreed number** — every player table (My Team, All Rosters, Players,
  Waiver Wire) leads with one position rank and one points figure for this
  week and for rest of season: FantasyPros and Draft Sharks, one vote per site
  (week: FP's ECR and projections model half each, Draft Sharks' projection;
  ROS: as League Value), ranked within position and priced off the sites' own
  points curve. Each site's own columns are opt-in chips.
- **Players**, **Trade Market**, **Sources** — league-independent. Sources
  opens on an overview of every raw file the dashboard reads (path, rows,
  when we pulled it, when the site recomputed it), then gives each site its
  own page — FantasyPros, Draft Sharks, Dynasty Daddy, Yahoo, Sleeper, ESPN —
  with one tab per file that site gives us, each unmixed with any other's.
- **All Leagues** — a card per league: your team, record and rank, and this
  week's matchup (or the latest stored one between slates). Each has an on/off
  switch: an off league is skipped by every sync but stays listed so it can be
  switched back on.
- **Sync** — one row per source with both clocks, its refresh limit and a Run
  button; presets above; the live log below; the ESPN/Yahoo past-weeks import.
- **Log** — the run log as a terminal: filter by problems, source or text;
  follow; copy.

### One player, one row

`buildUniverse` (`src/dashboard.js`) builds one row per player through one
function (`createEnricher`, `src/enrich.js`); league rosters are ids plus that
league's live fields, and the Sources tables are read off the same rows. Before
this, rostered players and free agents were built by different code and a
player could carry a different projection on My Team than on Players.

### Why the demand signal is separate

Projections answer *how many points*; on a Thursday night the question is *will
he still be there in an hour*. Differencing Sleeper's 6h and 24h windows gives
adds-per-hour now against before:

```
Devin Singletary   99,999 adds/24h    16,428/hr now    206x prior rate    1% rostered
Michael Mayer     384,678 adds/24h     6,436/hr now   0.33x prior rate   26% rostered
```

Mayer has the bigger number and is the worse claim — that wave broke hours ago.
Volume tells you who has been claimed; acceleration tells you who is being
claimed.

## Leagues

- **On/off.** Leagues are on by default. `leagues:off <name>`, `leagues:only
  <name>...`, `leagues:all`, or the switches on All Leagues (under `serve`).
  Each MyPlaybook sync writes the account's full list to
  `data/leagues-directory.json`, which is how an off league stays visible.
- **Scores on every host.** MyPlaybook's matchup endpoint answers for any team
  in the league, so a 12-team ESPN or Yahoo league's whole board costs 6
  requests. It only ever answers for the current week, so ESPN/Yahoo season
  totals are *accumulated* from finished boards on disk, each total carrying
  its game count. Sleeper leagues backfill any past week directly.
- **Past weeks on ESPN/Yahoo.** `scores:script` builds a bookmarklet; click it
  on a logged-in league page and it posts every past week to `serve` (or paste
  it on the Sync page, or `scores:ingest`).
- **League-scored points.** Per-player points come from the league's own
  scoring (MyPlaybook applies it), not a generic PPR file: one league scoring an
  interception at −2 was off by exactly 1.00 per INT before this.

### Your corrections (`data/league-overrides.json`)

The one file a re-scrape never touches: league and team names, badge
abbreviations, which teams are yours (a list — co-managers exist), divisions,
seeding rules (`league:playoffs --rule points-wildcard --teams 6 --wildcards 1`),
waiver mechanics and scoring corrections. Edit them on **League Setup**; under
`serve` they save straight to disk, otherwise **Export edits** writes a patch for
`league:import`. Standings ranks by record then points for; a seeding rule
decides who is *in*, and with no rule no bracket is guessed.

## Layout

```
data/latest.json            the scrape: every active league, normalized
data/fp/<season>/           FantasyPros: week-N/{rankings,projections,injuries}, ros/rankings, news, points, trade
data/draftsharks/<season>/  one store per scoring format: the current week + ROS
data/scores/<season>/       every league's board, per week
data/actuals/<season>/      weekly points for every player
data/buzz, data/trend       demand signals
data/enriched.json          the join
data/freshness.json         the two clocks, per source
data/runlog.jsonl           the run log
dist/dashboard.html         the build
```

`data/` holds league keys, which are the entire credential for a league — never
publish it. `docs/architecture.md` maps every module.

## Tests

```sh
npm test          # node --test, no dependencies
```

Every test pins a defect that actually shipped, usually one that produced a
plausible wrong number rather than an error, and the suite is mutation-checked:
reintroducing the defect fails a test. A few:

| Covered | The defect |
|---|---|
| `renderHtml` | `$&`/`$$` in the payload read as replacement patterns — a team named `Money$$` blanked the page |
| `parseEnv` | `FP_WEEK=3 # pinned` parsed as `NaN` and went into a file path |
| `since()` | hours and minutes rounded independently: `8h 60m` |
| `sleeperPoints` | `{fpts:1102, fpts_decimal:6}` string-joined to 1102.6 instead of 1102.06 |
| `writeJsonAtomic` | a truncated write read as "no overrides", and the next write made it permanent |
| `buildSourceTables` | a Sources table re-read the files and drifted from the player row |
| `pipelineMods` | the server's copy of the step wiring lacked four steps and reported them "unavailable" |
| `runlog` | a sync from the dashboard printed nowhere; a torn line fused with the next |
| `parseHorizon` | twenty-odd look-ahead windows, all but three rendering blank |

CI also extracts the dashboard's inline script and runs `node --check` on it —
it never executes under Node, so a syntax error there is invisible to the tests.

## Configuration (`.env`)

| Key | |
|---|---|
| `FP_EMAIL` | the FantasyPros account; this alone enumerates every league and its key |
| `FP_EXTRA_KEYS` | league keys not on that account, comma separated |
| `FP_API_KEY` | optional; adds external ids and points scored (2–4 calls a sync against a 500/day quota whose throttle answers 403, same as a bad key) |
| `FP_COOKIE` | optional logged-in fantasypros.com `Cookie:` header; unlocks the full projections board (logged out it shows ~10 per position, and rank-implied points fill the rest) |
| `FP_SEASON`, `FP_WEEK` | pin the season/week; detected from the calendar otherwise |
| `FP_CONCURRENCY`, `FP_DELAY_MS`, `FP_TIMEOUT_MS`, `FP_API_GAP_MS` | pacing |
| `ESPN_S2`, `ESPN_SWID` | optional; sent to Dynasty Daddy only, so it can refresh a private ESPN league instead of serving its frozen cache |
