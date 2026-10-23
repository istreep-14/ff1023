/**
 * Every raw feed the Sources pages show: one page per site, one tab per file
 * (or per board inside a file) that site gives us.
 *
 * The old Sources page was one tab per site, and each tab was one wide table
 * that ran several different products together — FantasyPros' rankings board,
 * its projections model, its ROS board and its API season totals all on one
 * row, with nothing saying which file a column came from. A site publishes
 * those separately, revises them on different clocks and covers different
 * players (the projections model is ~60 players logged out; the rankings
 * board ~400), so here each is its own tab, named for the file it was read
 * from, with that file's own row count.
 *
 * Nothing here re-reads a file. Every feed reads the universe rows the rest of
 * the page renders (dashboard.js `slim`), so a number on a Sources tab is the
 * number on the player's row. A feed's `files` is provenance — where that row
 * field came from on disk — not a second read.
 *
 * Nothing is blended: a feed's columns are that one file's fields. Sleeper's
 * "heat" (a percentile across Sleeper AND Yahoo) is deliberately absent.
 *
 * Inlined into the page (see renderHtml), so: no imports, and every name
 * carries a `feed`/`FEED_` prefix so it cannot collide with the page's own.
 *
 * A column is { key, label, get(row, ctx), kind, d, title }:
 *
 *   num      a number at `d` decimals     value   a trade value (1,234)
 *   count    people doing something (12k)
 *   rank     overall rank, `#12`          pos     position rank, `WR12`
 *   delta    signed change                pct     a percentage
 *   text     a string
 *
 * A rank sorts ascending; everything else descending. `ctx` carries what a
 * column needs beyond the row: { season, week, scoring, weeks, schedule, buzzDate }.
 */

const FEED_POS = ['qb', 'rb', 'wr', 'te', 'k', 'dst'];
/** VegasEdge's TdMethod in words (src/vegas.js TD_METHOD; this file is inlined and imports nothing). */
export const FEED_TD_METHOD = {
  tds_over_ladder_per_book: 'Each book’s ladder',
  tds_over_ladder: 'Averaged ladder',
  poisson_from_anytime_fallback: 'Anytime price only',
};
/** "WR12" -> 12: FantasyPros publishes a position rank as text. */
const feedPosNum = (v) => Number(String(v ?? '').replace(/[^0-9]/g, '')) || null;
const feedBoards = (dir) => `${dir}/{${FEED_POS.join(',')}}.json`;

/** Draft Sharks' projected stat line: its own keys, in reading order. */
export const FEED_STAT_LABELS = {
  pass_att: 'Pass Att', pass_cmp: 'Cmp', pass_yds: 'Pass Yds', pass_tds: 'Pass TD', pass_int: 'Int',
  rush_att: 'Rush Att', rush_yds: 'Rush Yds', rush_tds: 'Rush TD',
  rec_tgt: 'Tgt', rec_catch: 'Rec', rec_yds: 'Rec Yds', rec_tds: 'Rec TD',
  k_xp: 'XP', k_fg_0_29: 'FG 0–29', k_fg_30_39: 'FG 30–39', k_fg_40_49: 'FG 40–49', k_fg_50_59: 'FG 50–59', k_fg_60: 'FG 60+',
  def_sack: 'Sacks', def_int: 'Int', def_fum_rec: 'Fum Rec', def_tds: 'Def TD', def_opp_pts: 'Pts Allowed', def_opp_yds: 'Yds Allowed',
};

/**
 * One column per stat key the shown rows carry, in FEED_STAT_LABELS order —
 * a QB-only view gets passing columns, a WR-only view receiving ones, rather
 * than every row carrying 24 mostly-empty columns.
 */
export function feedStatCols(rows, field) {
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r.ds?.[field] || {})) seen.add(k);
  const order = Object.keys(FEED_STAT_LABELS);
  return [...seen]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((k) => ({ key: `${field}.${k}`, label: FEED_STAT_LABELS[k] || k, kind: 'num', d: 1, get: (r) => r.ds?.[field]?.[k] ?? null }));
}

const feedSum = (o) => {
  const v = Object.values(o || {}).filter((x) => typeof x === 'number');
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 10) / 10 : null;
};

export const FEED_SITES = [
  {
    id: 'fp', label: 'FantasyPros', host: 'fantasypros.com', section: 'Projections & rankings', meta: 'fp',
    about: 'Expert-consensus rankings, a separate projections model, the trade market and API season totals — each a different product on its own clock.',
    feeds: [
      {
        key: 'week', label: 'Week rankings', ledger: 'fp',
        files: (c) => [feedBoards(`fp/${c.season}/week-${c.week}/rankings/${c.scoring}`)],
        about: 'The expert-consensus (ECR) board for this week. Its points are implied by the panel’s rank order, not modelled.',
        has: (r) => r.rk != null || r.wkX != null,
        // `rk` is not printed: each board is one position, so it is the
        // position rank again (389 of 389 rows on 2026-10-20).
        cols: () => [
          { key: 'pr', label: 'Pos Rk', kind: 'pos', get: (r) => feedPosNum(r.pr) },
          { key: 'wkX', label: 'Pts', kind: 'num', d: 1, get: (r) => r.wkX, title: 'Points implied by where the expert panel ranked him.' },
          { key: 'rmin', label: 'Best', kind: 'pos', get: (r) => r.rmin, title: 'Best rank any expert gave him.' },
          { key: 'rmax', label: 'Worst', kind: 'pos', get: (r) => r.rmax, title: 'Worst rank any expert gave him.' },
          { key: 'rave', label: 'Avg', kind: 'num', d: 1, get: (r) => r.rave, title: 'Average expert rank.' },
          { key: 'tr', label: 'Move', kind: 'delta', d: 0, get: (r) => r.tr, title: 'Rank movement since the board’s last update.' },
          { key: 'g', label: 'Grade', kind: 'text', get: (r) => r.g, title: 'Start/sit grade.' },
          { key: 'own', label: 'Rostered', kind: 'pct', get: (r) => r.own },
        ],
        sort: 'wkX',
      },
      {
        key: 'proj', label: 'Week projections', ledger: 'fp',
        files: (c) => [feedBoards(`fp/${c.season}/week-${c.week}/projections`)],
        about: 'FantasyPros’ own points model. Logged out it publishes only the top ~10 per position; set FP_COOKIE for the full board.',
        has: (r) => r.wkP != null,
        cols: () => [
          { key: 'wkP', label: 'Proj', kind: 'num', d: 1, get: (r) => r.wkP },
        ],
        sort: 'wkP',
      },
      {
        key: 'ros', label: 'ROS rankings', ledger: 'fp',
        files: (c) => [feedBoards(`fp/${c.season}/ros/rankings/${c.scoring}`)],
        about: 'The rest-of-season board. Revised weekly; its total includes the current week.',
        has: (r) => r.ros != null || r.rosRk != null,
        cols: () => [
          { key: 'rosPr', label: 'Pos Rk', kind: 'pos', get: (r) => feedPosNum(r.rosPr) },
          { key: 'ros', label: 'ROS Pts', kind: 'num', d: 1, get: (r) => r.ros },
          { key: 'rosMin', label: 'Best', kind: 'pos', get: (r) => r.rosMin },
          { key: 'rosMax', label: 'Worst', kind: 'pos', get: (r) => r.rosMax },
          { key: 'rosAve', label: 'Avg', kind: 'num', d: 1, get: (r) => r.rosAve },
        ],
        sort: 'ros',
      },
      {
        key: 'trade', label: 'Trade market', ledger: 'trade',
        files: (c) => [`fp/${c.season}/trade/${c.scoring}.json`],
        about: 'What managers actually pay, on a ~1,000 scale, rebuilt daily. Unpriced (K, DST, fringe) is not the same as cheap.',
        has: (r) => r.tm?.v != null,
        cols: () => [
          { key: 'tm.v', label: 'Value', kind: 'value', get: (r) => r.tm?.v },
          { key: 'tm.d', label: 'Change', kind: 'delta', d: 0, get: (r) => (r.tm?.v != null && r.tm?.pv != null ? r.tm.v - r.tm.pv : null), title: 'Against the previous day.' },
          { key: 'tm.rk', label: 'Rank', kind: 'rank', get: (r) => r.tm?.rk },
          { key: 'tm.pr', label: 'Pos Rk', kind: 'pos', get: (r) => r.tm?.pr },
          { key: 'tm.n', label: 'Trades', kind: 'num', d: 0, get: (r) => feedSum(r.tm?.n), title: 'Trades in the ten-day window.' },
          { key: 'tm.xv', label: 'Expert', kind: 'value', get: (r) => r.tm?.xv, title: 'The experts’ value, where FantasyPros publishes one.' },
        ],
        sort: 'tm.v',
      },
      {
        key: 'points', label: 'Season points', ledger: 'fp',
        files: (c) => [`fp/${c.season}/points/${c.scoring}.json`],
        about: 'FantasyPros API: points scored to date. Needs FP_API_KEY; without it the last copy stays.',
        has: (r) => r.pts != null,
        cols: () => [
          { key: 'pts', label: 'Points', kind: 'num', d: 1, get: (r) => r.pts },
        ],
        sort: 'pts',
      },
      {
        key: 'news', label: 'Injuries & news', ledger: 'fp',
        files: (c) => [`fp/${c.season}/week-${c.week}/injuries.json`, `fp/${c.season}/news.json`],
        about: 'Injury designations for this week and the latest headline per player. Text, not numbers.',
        has: (r) => !!(r.inj || r.nw || r.blurb),
        cols: () => [
          { key: 'inj', label: 'Status', kind: 'text', get: (r) => r.inj },
          { key: 'injT', label: 'Injury', kind: 'text', get: (r) => r.injT },
          { key: 'nw', label: 'Headline', kind: 'text', wide: true, get: (r) => r.nw || r.blurb },
        ],
        sort: 'inj',
      },
    ],
  },
  {
    id: 'draftsharks', label: 'Draft Sharks', host: 'draftsharks.com', section: 'Projections & rankings', meta: 'draftsharks',
    about: 'Two boards (this week, rest of season), each served as a rankings view and a projected-stats view. Publishes no update time.',
    feeds: [
      {
        key: 'week', label: 'Week rankings', ledger: 'draftsharks',
        files: (c) => [`draftsharks/${c.season}/${c.scoring}.json · weeks.${c.week} (weekly-rankings)`],
        about: 'This week’s projection with its floor, ceiling, Draft Sharks’ 3D blend and the consensus it publishes beside it.',
        has: (r) => r.ds?.wk != null,
        cols: () => [
          { key: 'ds.rk', label: 'Rank', kind: 'rank', get: (r) => r.ds?.rk },
          { key: 'ds.prk', label: 'Pos Rk', kind: 'pos', get: (r) => r.ds?.prk },
          { key: 'ds.wk', label: 'Proj', kind: 'num', d: 1, get: (r) => r.ds?.wk },
          { key: 'ds.floor', label: 'Floor', kind: 'num', d: 1, get: (r) => r.ds?.floor },
          { key: 'ds.ceiling', label: 'Ceiling', kind: 'num', d: 1, get: (r) => r.ds?.ceiling },
          { key: 'ds.d3', label: '3D', kind: 'num', d: 1, get: (r) => r.ds?.d3, title: 'Floor, ceiling and scoring combined.' },
          { key: 'ds.cons', label: 'Consensus', kind: 'num', d: 1, get: (r) => r.ds?.cons, title: 'Other sites’ average, as Draft Sharks publishes it.' },
          { key: 'ds.tier', label: 'Tier', kind: 'num', d: 0, asc: true, get: (r) => r.ds?.tier },
          { key: 'ds.opp', label: 'Opp', kind: 'text', get: (r) => r.ds?.opp },
          { key: 'ds.sos', label: 'SOS', kind: 'num', d: 1, get: (r) => r.ds?.sos, title: 'Matchup strength; positive is easier.' },
        ],
        sort: 'ds.rk',
      },
      {
        key: 'weekStats', label: 'Week stat line', ledger: 'draftsharks',
        files: (c) => [`draftsharks/${c.season}/${c.scoring}.json · weeks.${c.week} (projections view)`],
        about: 'The projected stat line behind this week’s number.',
        has: (r) => !!r.ds?.st,
        cols: (c, rows) => [{ key: 'ds.wk', label: 'Proj', kind: 'num', d: 1, get: (r) => r.ds?.wk }, ...feedStatCols(rows, 'st')],
        sort: 'ds.wk',
      },
      {
        key: 'ros', label: 'ROS rankings', ledger: 'draftsharks',
        files: (c) => [`draftsharks/${c.season}/${c.scoring}.json · ros (ros-rankings)`],
        about: 'Its own rest-of-season total as published, with its own floor and ceiling. Bye excluded from games.',
        has: (r) => r.ds?.ros != null,
        cols: () => [
          { key: 'ds.rosPrk', label: 'Pos Rk', kind: 'pos', get: (r) => r.ds?.rosPrk },
          { key: 'ds.ros', label: 'ROS Pts', kind: 'num', d: 1, get: (r) => r.ds?.ros },
          { key: 'ds.rosFloor', label: 'Floor', kind: 'num', d: 1, get: (r) => r.ds?.rosFloor, title: 'Per game.' },
          { key: 'ds.rosCeiling', label: 'Ceiling', kind: 'num', d: 1, get: (r) => r.ds?.rosCeiling, title: 'Per game.' },
          { key: 'ds.rosD3', label: '3D', kind: 'num', d: 1, get: (r) => r.ds?.rosD3 },
          { key: 'ds.rosCons', label: 'Consensus', kind: 'num', d: 1, get: (r) => r.ds?.rosCons },
          { key: 'ds.rosG', label: 'Games', kind: 'num', d: 0, get: (r) => r.ds?.rosG },
          { key: 'ds.rosTier', label: 'Tier', kind: 'num', d: 0, asc: true, get: (r) => r.ds?.rosTier },
        ],
        sort: 'ds.ros',
      },
      {
        key: 'rosStats', label: 'ROS stat line', ledger: 'draftsharks',
        files: (c) => [`draftsharks/${c.season}/${c.scoring}.json · ros (projections view)`],
        about: 'The rest-of-season stat line, per game.',
        has: (r) => !!r.ds?.rosSt,
        cols: (c, rows) => [{ key: 'ds.ros', label: 'ROS Pts', kind: 'num', d: 1, get: (r) => r.ds?.ros }, ...feedStatCols(rows, 'rosSt')],
        sort: 'ds.ros',
      },
      {
        key: 'value', label: '3D Value', ledger: 'draftsharks',
        files: (c) => [`draftsharks/${c.season}/${c.scoring}.json · ros (value columns)`],
        about: 'Draft Sharks’ rest-of-season trade value (0–100) beside the trade market’s on the same scale, and its injury risk.',
        has: (r) => r.ds?.val != null,
        cols: () => [
          { key: 'ds.val', label: '3D Value', kind: 'num', d: 0, get: (r) => r.ds?.val },
          { key: 'ds.dv', label: 'Trend', kind: 'delta', d: 0, get: (r) => r.ds?.dv, title: 'Change since its last update.' },
          { key: 'ds.mkt', label: 'Market', kind: 'num', d: 1, get: (r) => r.ds?.mkt, title: 'Below 3D Value means the market is cheaper than Draft Sharks.' },
          { key: 'ds.inj', label: 'Inj risk', kind: 'pct', get: (r) => r.ds?.inj },
        ],
        sort: 'ds.val',
      },
    ],
  },
  {
    id: 'vegas', label: 'VegasEdge', host: 'vegasedgefantasy.com', section: 'Projections & rankings',
    about: 'Sportsbook player props turned into this week’s projection, and the site’s 10K-sample simulation around it. Current week only; QB, RB, WR and TE.',
    feeds: [
      {
        key: 'week', label: 'Week projections', ledger: 'vegas',
        files: (c) => [`vegas/${c.season}/week-${c.week}.json · players (qb + flex rankings)`],
        about: 'Points are scored here from the expected stat line at this format, not read off the board: the site’s own figure follows one scoring setting any visitor can change. A partial market (a missing prop) keeps its points but is not ranked.',
        has: (r) => r.vg?.wk != null,
        cols: () => [
          { key: 'vg.prk', label: 'Pos Rk', kind: 'pos', get: (r) => r.vg?.prk, title: 'By points, among complete markets only.' },
          { key: 'vg.wk', label: 'Proj', kind: 'num', d: 1, get: (r) => r.vg?.wk },
          { key: 'vg.ok', label: 'Market', kind: 'text', get: (r) => (r.vg ? (r.vg.ok ? 'complete' : 'missing ' + (r.vg.miss || ['odds']).join(', ')) : null) },
          { key: 'vg.vol', label: 'Tag', kind: 'text', get: (r) => r.vg?.vol, title: 'The site’s volatility tag: this week’s priced range against his position peers — High Floor narrower, Volatile wider, Balanced typical. Only simulated players get one.' },
        ],
        sort: 'vg.wk',
      },
      {
        key: 'dist', label: 'Distribution', ledger: 'vegas',
        files: (c) => [`vegas/${c.season}/week-${c.week}.json · players.*.dist (boombust batch)`],
        about: 'Percentiles of the site’s 10K-sample simulation, at this format. Skew is upside room (p90 − p50) against downside (p50 − p10): +1 all upside, −1 all downside. Players with too thin a market are not simulated.',
        has: (r) => r.vg?.md != null,
        cols: () => [
          { key: 'vg.fl', label: 'Floor (p10)', kind: 'num', d: 1, get: (r) => r.vg?.fl },
          { key: 'vg.md', label: 'Median', kind: 'num', d: 1, get: (r) => r.vg?.md },
          { key: 'vg.ce', label: 'Ceiling (p90)', kind: 'num', d: 1, get: (r) => r.vg?.ce },
          { key: 'vg.boom', label: 'Boom', kind: 'pct', get: (r) => (r.vg?.boom != null ? r.vg.boom * 100 : null), title: 'Simulated games over 135% of his projection.' },
          { key: 'vg.bust', label: 'Bust', kind: 'pct', get: (r) => (r.vg?.bust != null ? r.vg.bust * 100 : null), title: 'Simulated games under 50% of his projection.' },
          { key: 'vg.sk', label: 'Skew', kind: 'num', d: 2, get: (r) => r.vg?.sk },
        ],
        sort: 'vg.md',
      },
      {
        key: 'stats', label: 'Stat line', ledger: 'vegas',
        files: (c) => [`vegas/${c.season}/week-${c.week}.json · players.*.st`],
        about: 'The expected stat line the props imply — what the projection is scored from.',
        has: (r) => !!r.vg?.st,
        cols: () => [
          { key: 'vg.wk', label: 'Proj', kind: 'num', d: 1, get: (r) => r.vg?.wk },
          ...[['passYds', 'Pass Yds', 1], ['passTds', 'Pass TD', 2], ['ints', 'Int', 2], ['rushYds', 'Rush Yds', 1], ['rushTds', 'Rush TD', 2],
            ['rec', 'Rec', 1], ['recYds', 'Rec Yds', 1], ['tds', 'TDs', 2], ['tdProb', 'TD prob', 2]]
            .map(([k, label, d]) => ({ key: `vg.st.${k}`, label, kind: 'num', d, get: (r) => r.vg?.st?.[k] ?? null })),
          { key: 'vg.tdm', label: 'TD source', kind: 'text', get: (r) => (r.vg?.tdm ? FEED_TD_METHOD[r.vg.tdm] || r.vg.tdm : null),
            title: 'How the expected TDs were priced, strongest first: each book’s 1+/2+/3+ TD ladder, the ladder averaged across books, or a Poisson guess off the anytime-TD price alone.' },
        ],
        sort: 'vg.wk',
      },
    ],
  },
  {
    id: 'dd', label: 'Dynasty Daddy', host: 'dynasty-daddy.com', section: 'Rest-of-season ranks',
    about: 'Player data in one request: ids, ADP, Sleeper roster rates, and the ESPN, FanDuel and FantasyGuys ROS ranks League Value reads. Its trade-value markets are not fetched.',
    feeds: [
      {
        key: 'players', label: 'Player data', ledger: 'ddplayers',
        files: (c) => [`dynastydaddy/${c.season}/players.json`],
        about: 'Age, ADP, Sleeper rostered/started rates, and the ESPN, FanDuel and FantasyGuys ROS ranks Dynasty Daddy republishes.',
        has: (r) => !!r.dd,
        cols: () => [
          { key: 'dd.age', label: 'Age', kind: 'num', d: 0, get: (r) => r.dd?.age },
          { key: 'dd.adp', label: 'ADP', kind: 'num', d: 1, get: (r) => r.dd?.adp, asc: true },
          { key: 'dd.own', label: 'Rostered', kind: 'pct', get: (r) => r.dd?.own },
          { key: 'dd.st', label: 'Started', kind: 'pct', get: (r) => r.dd?.st },
          { key: 'dd.r0', label: 'ESPN ROS', kind: 'rank', get: (r) => r.dd?.r?.[0] },
          { key: 'dd.r1', label: 'FanDuel ROS', kind: 'rank', get: (r) => r.dd?.r?.[1] },
          { key: 'dd.r2', label: 'FantasyGuys ROS', kind: 'rank', get: (r) => r.dd?.r?.[2] },
          { key: 'dd.inj', label: 'Injury', kind: 'text', get: (r) => r.dd?.inj },
        ],
        sort: 'dd.adp',
      },
    ],
  },
  {
    id: 'yahoo', label: 'Yahoo', host: 'sports.yahoo.com', section: 'Demand & results',
    about: 'Yahoo’s BuzzIndex: what Yahoo managers added, dropped and started. Demand, not a projection.',
    feeds: [
      {
        key: 'buzz', label: 'BuzzIndex', ledger: 'buzz',
        files: (c) => [`buzz/${c.season}/${c.buzzDate || '<date>'}.json`],
        about: 'One day’s board. Yahoo recomputes it through the morning.',
        has: (r) => r.sig?.ya != null || r.sig?.yr != null,
        cols: () => [
          { key: 'ya', label: 'Adds', kind: 'count', get: (r) => r.sig?.ya },
          { key: 'yd', label: 'Drops', kind: 'count', get: (r) => r.sig?.yd },
          { key: 'yn', label: 'Net', kind: 'delta', d: 0, get: (r) => r.sig?.yn },
          { key: 'yc', label: 'Adds Δ', kind: 'delta', d: 0, get: (r) => r.sig?.yc, title: 'Adds against the previous day.' },
          { key: 'yr', label: 'Rostered', kind: 'pct', get: (r) => r.sig?.yr },
          { key: 'yrc', label: 'Rost Δ', kind: 'delta', d: 0, get: (r) => r.sig?.yrc },
          { key: 'ys', label: 'Started', kind: 'pct', get: (r) => r.sig?.ys },
          { key: 'nt', label: 'Game', kind: 'text', get: (r) => r.sig?.nt },
        ],
        sort: 'ya',
      },
    ],
  },
  {
    id: 'sleeper', label: 'Sleeper', host: 'sleeper.com', section: 'Demand & results',
    about: 'Sleeper’s public trending counter and its weekly stat results.',
    feeds: [
      {
        key: 'trend', label: 'Trending', ledger: 'trend',
        files: (c) => [`trend/${c.season}/<timestamp>.json`],
        about: 'Adds and drops across Sleeper. The rate and surge come from two snapshots of the same counter.',
        has: (r) => r.sig?.a != null || r.sig?.d != null || r.sig?.r != null,
        cols: () => [
          { key: 'a', label: 'Adds', kind: 'count', get: (r) => r.sig?.a },
          { key: 'd', label: 'Drops', kind: 'count', get: (r) => r.sig?.d },
          { key: 'r', label: 'Adds/hr', kind: 'count', get: (r) => r.sig?.r, title: 'Over the short window.' },
          { key: 'v', label: 'Surge', kind: 'num', d: 2, get: (r) => r.sig?.v, title: 'The short-window rate against the window before it; above 1 is accelerating.' },
        ],
        sort: 'a',
      },
      {
        key: 'actuals', label: 'Weekly points', ledger: 'actuals',
        files: (c) => [`actuals/${c.season}/week-{${(c.weeks || []).join(',')}}.json`],
        about: 'Fantasy points from Sleeper’s stat feed for every week played. Results, not projections.',
        has: (r) => !!r.act && Object.keys(r.act).length > 0,
        cols: (c) => [
          { key: 'act.sum', label: 'Total', kind: 'num', d: 1, get: (r) => feedSum(r.act) },
          ...(c.weeks || []).map((w) => ({ key: `act.${w}`, label: `Wk ${w}`, kind: 'num', d: 1, get: (r) => r.act?.[w] ?? null })),
        ],
        sort: 'act.sum',
      },
    ],
  },
  {
    id: 'espn', label: 'ESPN', host: 'espn.com', section: 'Demand & results',
    about: 'The NFL schedule: who each team plays, home or away, and which games are final.',
    feeds: [
      {
        key: 'schedule', label: 'NFL schedule', ledger: 'schedule', unit: 'teams',
        files: (c) => [`schedule/${c.season}/nfl.json`],
        about: 'One row per team. `@` is an away game; a week with no opponent is the bye.',
        rows: (c) => Object.entries(c.schedule?.teams || {}).map(([team, t]) => ({ i: team, team, bye: t.bye ?? null, weeks: t.weeks || {} })).sort((a, b) => a.team.localeCompare(b.team)),
        cols: () => [
          { key: 'bye', label: 'Bye', kind: 'num', d: 0, get: (r) => r.bye, asc: true },
          ...Array.from({ length: 18 }, (_, k) => k + 1).map((w) => ({
            key: `w${w}`, label: `Wk ${w}`, kind: 'text', get: (r) => (r.weeks[w]?.opp ? (r.weeks[w].home ? '' : '@') + r.weeks[w].opp : null),
          })),
        ],
        sort: null,
      },
    ],
  },
];

export const feedSite = (id) => FEED_SITES.find((s) => s.id === id) || null;
export const feedOf = (site, key) => site?.feeds.find((f) => f.key === key) || site?.feeds[0] || null;

/** The rows a feed shows: the universe rows that carry its fields, or its own (the schedule's teams). */
export function feedRows(feed, ctx) {
  if (feed.rows) return feed.rows(ctx);
  return (ctx.pool || []).filter((r) => feed.has(r, ctx));
}

/** A rank (and anything flagged `asc`) sorts low-to-high; every other column high-to-low. */
export const feedDir = (col) => (col.asc || col.kind === 'rank' || col.kind === 'pos' ? 'asc' : 'desc');
