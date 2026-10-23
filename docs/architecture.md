# Architecture — file-by-file code map

This is the file map that `AGENTS.md` points at. It answers "what does this
module do, what data does it touch, and which CLI command runs it" so a first
pass through the code never has to read every file. `readme.md` is the
narrative — the *why* behind the shapes here. `AGENTS.md` is the 60-second
orientation.

Read order if you are new: this page → `src/sync.js` + `src/freshness.js` (how
a run happens) → `src/cli.js` (what a command is) → one per-source module →
`src/enrich.js` (how it all joins).

## The data pipeline

```
data/latest.json  ───────────────►  per-source syncs  ──►  data/<source>/...
        ▲                                  │
   (scrape step)                            ▼
                                      src/enrich.js  ──►  data/enriched.json
                                                                 │
                                                                 ▼
                       src/dashboard.js renders src/dashboard.template.html
                                                                 │
                                                                 ▼
                                                        dist/dashboard.html
```

- **Fetch half** — `scrape` (MyPlaybook leagues) plus one sync step per external
  source (`fp`, `draftsharks`, `trade`, `schedule`, `buzz`, `trend`,
  `leaguedetail`, `leaguedetail-backfill`, `matchups`, `actuals`). Each writes
  its own `data/<source>/` tree and records the fetch in `data/freshness.json`.
  Every line a step prints goes to `data/runlog.jsonl` (`src/runlog.js`).
- **Join half** — `enrich` reads the FantasyPros and Draft Sharks trees plus
  the scraped rosters and writes one row-per-player universe to
  `data/enriched.json`. Current week + rest-of-season only — neither source
  is asked for, or joins, any other week.
- **Build half** — `dashboard` turns `enriched.json` into the in-browser app.
  The only transforms that still happen at build time are shaping for the page
  (`buildUniverse`, `buildSourceTables`, `slimAnalysis`) and the inlined
  look-ahead-window module.

The `sync` command orchestrates both halves via `src/sync.js`; the joins are
marked `always` so a `--only <source>` run still lands the fetch on the page.
The step wiring (`pipelineMods`) exists once, in `sync.js`, and both the CLI
and the server call it.

## Layers

### Entry, config, shared plumbing

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/cli.js` | CLI entrypoint (`#!/usr/bin/env node`), the `commands{}` dispatcher, argv wiring | reads `data/latest.json`, `data/enriched.json`, `.env` | — (the `ff` binary / npm scripts) |
| `src/args.js` | `--flag` / `--opt value` / positional parser; `BOOLEAN_FLAGS` disambiguates value-less flags | none | everything via `parseArgs` |
| `src/config.js` | path constants (`DATA`, `RAW`, `CACHE`, `FPDIR`, `STATE`), `.env` loader, the `config` object (credentials, pacing, season/week pins) | `.env` | every module |
| `src/http.js` | the one `fetch` wrapper: retries, exponential backoff, ETag/`NotModified` handling, shared pool, timeouts | network | every network sync |
| `src/jsonfile.js` | atomic JSON writes (temp file + rename) so a truncated write can never read as data | writes `data/…/*.json` | schedule, draftsharks, mpbadvanced, overrides, leaguestate, freshness |
| `src/teams.js` | NFL abbreviation normalization across namespaces (ESPN `JAX/WSH` vs Sleeper `JAC/WAS`), `normPos` `DEF/DST→DST`, matchup-string parser | none | `enrich`, `dashboard` |

### Scrape → the normalized league model

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/fantasypros.js` | MyPlaybook per-league API (`getLeagueRostersJSON`, settings, transactions, analysis…), account→leagues bootstrap | none | `leagues`, `scrape`, `endpoints`, sync |
| `src/scrape.js` | pulls every league into `data/raw/<ts>/` snapshots + normalized `_normalized.json`, writes `data/latest.json`; refuses an empty league list | writes `data/raw/`, `data/latest.json` | `scrape`, sync step |
| `src/normalize.js` | flattens raw endpoint payloads into the queryable `latest.json` model, derives `scoringSystem` | none | `scrape` |
| `src/leaguestate.js` | per-league on/off toggles (`data/leagues-state.json`) and the account's full league list (`data/leagues-directory.json`, written by every scrape so an off league stays visible) | both files | `leagues:*`, `scrape`, `serve`, dashboard build |
| `src/overrides.js` | user corrections (renames, badges, divisions, my teams, playoff rules, waivers, scoring) in `data/league-overrides.json` | `data/league-overrides.json` | `league*` commands, dashboard |
| `src/prune.js` | bounded history: keeps last 20 `raw/` runs, last 48 trend files | deletes old files | seen from `scrape`, `trend:sync` |
| `src/export.js` | CSV export with CSV-formula injection defusing (`esc`, leading `=` neutralized) | writes `data/export/*.csv` | `export`, sync step |
| `src/leaguedata.js` | per-league detail (standings, matchups, waivers) from MyPlaybook — **Sleeper host only**; cached to `data/leaguedetail/` | reads/writes `data/leaguedetail/` | sync step `leaguedetail`, `serve` |
| `src/leagueanalysis.js` | `getLeagueAnalysisJSON?period=ros|week`: VORP grid, team strength/tiers, your ranks; `normalizeAnalysis` | reads scraped model | dashboard build |
| `src/mpbadvanced.js` | MyPlaybook *advanced* endpoints (matchup, projected standings, start/sit, insights) with a disk cache `data/mpbadvanced/` | reads/writes `data/mpbadvanced/` | `matchups`, dashboard build |

### Per-source syncs (each writes its own `data/<source>/` tree)

Only two projection/ranking sources remain, and each fetches current week +
rest of season only — never any other week:

| File | Source | Writes | Called by |
|---|---|---|---|
| `src/fpsync.js` | **the one way FantasyPros is fetched**: `fpSync` = the public pages (`scrapefp.js`), then `apiSupplement` (external ids, points scored) when `FP_API_KEY` is set. `sync` and `fp:sync` run the same call | `data/fp/<season>/` | `fp:sync`, sync step `fp` |
| `src/scrapefp.js` | FantasyPros **public pages** (no key). Rankings (`ecrData`, current-week + ROS) and projections (`<table id="data">`, current week only — the projections page has no real ROS mode, only a static preseason total, so ROS comes from the rankings board) are two separate FantasyPros products; the projections board is paywalled to the top ~10 players/position without `FP_COOKIE`, and `enrich.js` falls back to the rankings board's implied points. Also injury-news pages | `data/fp/<season>/` | `fpSync` |
| `src/fpapi.js` | FantasyPros public API v2 client, down to the two endpoints with no public-page equivalent (`players`, `playerPoints`) plus `ping`; serialized per-key queue; home of `SCORING_KEY`, `LEAGUE_SCORING_TO_API` and `scoringsInUse` (which formats the account's leagues use) | none | `fpsync`, `fp:check` |
| `src/vegas.js` | VegasEdge current week: `/qb` + `/flex/rankings` (expected stat line, Sleeper ids) and `/inseason/boombust/batch` (p5–p95, boom/bust, every name in one POST, at a scoring we send). Points are scored here (`scoreLine`); the board's own figure follows the account's saved scoring. Token expiry checked before any request | `data/vegas/<season>/week-<n>.json` | `vegas:sync`, sync step `vegas` (also in `live`); joined by `enrich.js` `vegasIndex` (Sleeper id), audited by `sourceaudit.js` |
| `src/draftsharks.js` | Draft Sharks current-week rankings + ROS board (SSR top-25 + HTMX `load-table`). `dsSync` fetches the current week + ROS for every scoring format in use — there is no other mode | `data/draftsharks/<season>/` | `ds:sync`, sync step `draftsharks` |

Two more sources are demand signals, not projections, and are not part of the
current-week/ROS scope above:

| File | Source | Writes | Called by |
|---|---|---|---|
| `src/sleepertrend.js` | Sleeper trending (6h/24h/72h rolling lookbacks, the demand signal's *acceleration*) | `data/trend/<season>/` | `trend:sync`, `trend`, sync step `trend` |
| `src/buzz.js` | Yahoo BuzzIndex daily add/drop/trade boards, fanned out over position × sort × date (the demand signal's *volume*) | `data/buzz/<season>/` | `buzz:sync`, `buzz`, sync step `buzz`, `serve` |

And the rest of the fetch layer:

| File | Purpose | Writes | Called by |
|---|---|---|---|
| `src/schedule.js` | NFL opponents + byes from ESPN (`cdn.espn.com/core/nfl/schedule`), one request per week, and only for weeks not yet stored (`missingWeeks`; `schedule:sync --force` re-pulls all 18) — the schedule is fixed for the season; `MIN_GAMES_TRUSTED` guards empty weeks; also home of the shared `LAST_WEEK` constant | `data/schedule/<season>/` | `schedule:sync`, `schedule:import`, sync step |
| `src/trademarket.js` | FantasyPros trade market values + 10-day volume series (`tradeMarketValues`) | `data/fp/<season>/trade/` | `trade:sync`, sync step `trade` |
| `src/dynastydaddy.js` | Dynasty Daddy (`api.dynasty-daddy.com`, public): player rows in ONE request (`player/all/today?market=22` — every market returns the same rows; its trade values are not kept): ids, ADP, ESPN/FanDuel/FantasyGuys ROS ranks; and `league/load` for Sleeper/ESPN leagues (every week's pairings, Sleeper potential points; a private ESPN league is a frozen cache unless `ESPN_S2`/`ESPN_SWID` are set). Joined in `enrich.js` by Sleeper → ESPN → Yahoo id | `data/dynastydaddy/<season>/{players.json,leagues/}` | `dd:players`, `dd:league`, sync steps `ddplayers`, `ddleague` |
| `src/matchups.js` | every league's live scoreboard via `mpbadvanced.getMatchup`; **accumulates** season points/standings on disk (ESPN/Yahoo expose no other source) | reads/writes `data/scores/<season>/week-N.json` | `matchups:sync`, `matchups`, sync step, `serve` |
| `src/scoresingest.js` | recover ESPN/Yahoo past weeks MyPlaybook can no longer answer for: parse a logged-in browser dump (ESPN `mMatchupScore`, Yahoo scoreboard, or Dynasty Daddy `league/load`) into the same `data/scores/` ledger | reads/writes `data/scores/<season>/week-N.json` | `scores:script`, `scores:ingest` |
| `src/actuals.js` | every player's fantasy points for each week, from Sleeper's public stats (`pts_ppr` / `pts_half_ppr` / `pts_std`). Finished weeks stay on disk; the current week refreshes. The page uses this when a matchup lineup has no score for that player | `data/actuals/<season>/week-N.json` | `actuals:sync`, sync step `actuals` |
| `src/players.js` | FP ECR dictionary: scrapes ten ranking boards into `data/cache/players.json` (fpId → player) | `data/cache/players.json` | `players` |

### Joins and derived data

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/idmap.js` | the id bridge (FantasyPros `fpId` ↔ Sleeper ↔ ESPN/Yahoo) built from FP external ids + scraped model, cached 12h | `data/cache/idmap.json` | `enrich`, `lineup` |
| `src/enrich.js` | **the join** — FantasyPros (current week + ROS rank/points/injury/news/trade) and Draft Sharks (current-week cell + ROS total) onto the row-per-player universe, then `data/enriched.json`. Degrades cleanly: whatever slice of `data/` exists gets joined, the rest is null. No cross-source blending and no per-week curve beyond the current week — that machinery (`weekshape.js`, `consensus.js`) was removed | reads `data/fp/`, `data/draftsharks/`, schedule, trade market, signals; writes `data/enriched.json` | `enrich`, `lineup`, sync step |
| `src/powerrank.js` | team scoring from one source's player values (League Value by default): contender (best legal lineup), trade value (whole roster), Dynasty Daddy's six tiers and needs, remaining-schedule strength — pure logic, inlined verbatim into the page (`/*__INLINE:powerrank.js__*/`) | none | inlined into page (Power Rankings, player Values tab) |
| `src/leaguevalue.js` | `lvConsensus`: the agreed week/ROS position rank and points every player table shows (no league, any positions incl. K/DST). League Value on top of the same consensus: each signal's within-position ranks (absent from a deep board → ranked past its end at half weight; best/worst dropped at ≥4) → consensus order over the ROS inputs in `valuescale.js`, one vote per site (no market trade values) → this league's ROS points curve from FP + Draft Sharks projections → lineup filled league-wide (`lvDemand`, flex by points), depth from the league's real rosters → replacement halfway between last starter and waiver (`LV_REPLACEMENT_BLEND`) → value over replacement + 0–100 index. `lvRanksBy` + `lvWorth` price ANY source's position rank the same way, which is how the page puts every source on the league's axis (League Value = `lvWorth` at the consensus rank). Pure, inlined (`/*__INLINE:leaguevalue.js__*/`); the page passes signals as functions | none | Values, Power Rankings (default source), player Values tab |
| `src/valuescale.js` | the sources a pool can answer for: ROS (`VS_SOURCES`: FantasyPros ROS — once, its points are its rank board's — Draft Sharks ROS + 3D Value, and ESPN/FanDuel/FantasyGuys ROS ranks for comparison only) and this week (`VS_WEEK_SOURCES`: FantasyPros ECR + projections model, Draft Sharks week), each one's own number (`vsRaw`), its higher-is-better score (`vsScore`), and `vsSignals` — the inputs as signals, one vote per site. No market trade values. Pure, inlined (`/*__INLINE:valuescale.js__*/`) | none | League Value signals, Values + Power Rankings pages, player Values tab |
| `src/weekhorizon.js` | the window keys — `w-<current>`, `ros`, `szn`; any other key reads as the current week: `parseHorizon`, `labelHorizon`, `horizonOptions` — pure logic, inlined verbatim into the page | none | inlined into page |
| `src/accuracy.js` | scores FantasyPros' and Draft Sharks' stored projections against actual points for finished weeks (MAE, bias, RMSE, correlation); Draft Sharks' past-week data is whatever was captured while that week was current, never re-fetched | `data/fp/<season>/…`, `data/draftsharks/<season>/` | the Sources overview's Accuracy panels |
| `src/signals.js` | demand signal per player: Sleeper trending acceleration × Yahoo buzz, percentile heat | `data/trend/`, `data/buzz/` | `signal`, dashboard build |
| `src/sourceaudit.js` | verifies the stored FantasyPros/Draft Sharks data (scale band, week labels); `audit` exits 1 on failure | reads `data/fp/`, `data/draftsharks/` | `audit`, sync step |
| `src/sourcetables.js` | per-source tables (`buildSourceTables`), read off the *same* universe rows as the player tables (the page reads FP's for points already scored; the build logs coverage), and `SOURCE_META` — each source's plain-language scope; `SOURCE_ORDER` is `['fp', 'draftsharks']` | none (takes rows) | dashboard build |
| `src/sourcefeeds.js` | the Sources pages: `FEED_SITES` is one page per site and one tab per file it gives us, each with its columns (by `kind`), its data/ path and the freshness-ledger key whose two clocks it shows. Reads universe rows only — a path is provenance, not a second read — and no tab reads another site's field (`opp` is the ESPN schedule's, so FP tabs omit it). Pure, inlined (`/*__INLINE:sourcefeeds.js__*/`) before `PAGES`, which generates a `src-<site>` page per site | none | Sources pages |

### Week resolution (shared by nearly everything)

| File | Purpose |
|---|---|
| `src/week.js` | NFL season/week resolution: kickoff heuristic, `FP_SEASON`/`FP_WEEK` pins, week 0 = preseason; also exports the shared `LAST_WEEK` constant |
| `src/accuracy.js` | (listed above) |

### Dashboard & serving

| File | Purpose | Reads / Writes | Called by |
|---|---|---|---|
| `src/dashboard.js` | builds the compact page payload from `data/enriched.json` + league detail/advanced/accuracy, runs `buildUniverse` (one row per player), adds the league directory (`leagueDirectory`), the step table and the run log's tail, renders `src/dashboard.template.html` → `dist/dashboard.html` | reads `data/enriched.json`, `data/leaguedetail/`, `data/mpbadvanced/`, `data/runlog.jsonl`, caches, template; writes `dist/dashboard.html` | `dashboard`, sync step, `serve` |
| `src/dashboard.template.html` | the in-browser app: one inline `<script>` + markup + CSS. `GROUPS`/`PAGES`/`RENDER` define the rail and the pages. Near the end: `LOG` (the log store), `toast`, the server bridge (`api`, `probe`, `runSync`, log polling), the Log / Sync / All Leagues pages, and the command palette (`openPalette`, ⌘K) | — | `dashboard`, `serve` |
| `src/serve.js` | localhost-only HTTP server (`npm run serve`): serves `dist/dashboard.html`; `/api/state`, `/api/sync` (one run at a time, 409 otherwise), `/api/log?after=` (the live tail), `/api/leagues` (on/off), `/api/overrides`, `/api/scores-ingest`, `/api/scores-bookmarklet` | `data/`, `dist/dashboard.html` | `serve` |
| `src/runlog.js` | the permanent run log, `data/runlog.jsonl`: `logger` (prints and keeps, tagged per step), `append`, `tail({after})`, `levelOf`; trimmed to 3,000 lines | `data/runlog.jsonl` | `sync.js`, `serve.js`, `log`, dashboard build |

## The `sync` pipeline (what actually runs)

Seen in `src/sync.js` — `steps(mods)` returns the ordered step list; `runPipeline`
applies `--force/--only/--skip/--max-age/--dry-run/--watch N` and consults the
freshness ledger (`freshness.check`) before fetching. Notable rules codified there:

- Fetch steps in order: `scrape, fp, draftsharks, trade, schedule, buzz,
  trend, leaguedetail, leaguedetail-backfill, matchups, actuals`. Presets
  (`PRESETS`): `live`, `projections`, `leagues` — `--only live` etc.
- `pipelineMods()` is the single wiring of those names to the sync functions;
  each step's `run` receives `{ season, week, log }`, where `log` writes to the
  terminal (CLI) and to the run log tagged with the step's name.
- `current.run` is the run in progress; the server refuses a second one.
- `enrich`, `dashboard`, `audit` are `always: true` — exempt from `--only`,
  because a fetch you cannot see on the page has achieved nothing. `--skip`
  still stops them.
- A failed fetch is recorded and the pipeline **continues**: the other
  sources are on disk, and a dashboard built from them is better than none.
- `data/freshness.json` is the ledger: `fetchedAt` (our clock) vs `sourceAt`
  (the site's own recompute time) vs `prevSourceAt` (to detect "moved").
  `MAX_AGE_MIN` in `src/freshness.js` is the per-source republish interval, not
  arbitrary numbers — change one only when the site's cadence actually changes.

## Tests

`test/*.test.js` are `node --test` regression tests, **mutation-checked**: each
pins a defect that actually shipped and fails if the bug is reintroduced.
Mapping (file → target module):

| Test | Targets |
|---|---|
| `accuracy.test.js` | `accuracy.js` (MAE/bias/RMSE/correlation) |
| `args.test.js` | `args.js` (boolean flags don't eat the next arg) |
| `dashboard-build.test.js` | `dashboard.js` render, `sourcetables.js`, template script compiles |
| `dates.test.js` | `buzz.js` date boundary, `signals.js` heat |
| `freshness.test.js` | `freshness.js` (since rounding, siteMoved) |
| `jsonfile.test.js` | `jsonfile.js` atomic write |
| `leagueanalysis.test.js` | `leagueanalysis.js`, `fantasypros.js` |
| `nav-and-analysis-payload.test.js` | `dashboard.js` slimAnalysis + template nav tables |
| `render.test.js` | `dashboard.js` renderHtml injection safety |
| `schedule.test.js` | `schedule.js` bye inference, repairStore |
| `source-trust.test.js` | `sourceaudit.js` (scale band, week/provenance judging) |
| `runlog-and-pipeline.test.js` | `sync.js` (every step wired, run log per step, lock released), `runlog.js`, `weekhorizon.js`, `dashboard.js` leagueDirectory |
| `team-overrides.test.js` | `overrides.js`, `sourcetables.js` |
| `trademarket.test.js` | `trademarket.js` |
| `dynastydaddy.test.js` | `dynastydaddy.js` (unpriced ≠ 0, picks skipped, stale league snapshot, ESPN cookie gating), `dashboard.js` slimDDLeague |
| `leaguevalue.test.js` | `leaguevalue.js` (flex/superflex demand, real roster depth, superflex prices QBs up, replacement blend, consensus + mix, imputation, trimming) |
| `sourcefeeds.test.js` | `sourcefeeds.js` (every ledger is tracked, no tab reads another site's field, FP rankings vs projections are separate tabs, Dynasty Daddy keeps only its player data, file paths, stat/week columns, site pages are generated with renderers) |
| `valuescale.test.js` | `valuescale.js` (no trade value is a source, FantasyPros counts once, ranks turn higher-is-better, empty sources dropped, no name collisions) |
| `powerrank.test.js` | `powerrank.js` (lineup fill, IR exclusion, tiers, needs, schedule strength, no name collisions with the page) |
| `values.test.js` | `export.js` esc, `config.js` parseEnv, `leaguedata.js` |
| `week.test.js` | `week.js` |

`http.js`, `fpapi.js`, `idmap.js`, `serve.js` and the `sleeper.js` cache have
no dedicated unit tests — they are the network-touching pieces, exercised via
the CLI/sync path.
