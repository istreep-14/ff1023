import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, FPDIR } from './config.js';
import { nameKey } from './sleeper.js';
import { draftsharksIndex } from './enrich.js';
import { readVegas, scoreLine } from './vegas.js';

/**
 * Do the stored sources mean what their labels say?
 *
 * Two ways a source goes quietly wrong, each of which has happened here:
 *
 *   SCALE   the numbers are in the wrong units. Caught by comparing each
 *           source's median value with FantasyPros' for the same players — a
 *           source is allowed to disagree about WHO, not to be uniformly high.
 *   WEEK    the file is filed under a week other than the one it holds.
 *
 * Nothing here fixes anything; it reports, and exits non-zero from the CLI when
 * a check fails, so it can sit at the end of a sync.
 */

/** A source's median ratio to FantasyPros outside this band is not "a different opinion". */
export const SCALE_BAND = [0.8, 1.25];

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : null;
};

/**
 * Pure. `rows` are `{ pos, v, ref }`: a source's value and FantasyPros' for one
 * player. Per position (rows under 5 reference points are skipped — a
 * 1-point kicker says nothing about scale): n, median ratio, median difference,
 * and a flag when the ratio leaves the band.
 */
export function scaleCheck(rows, { band = SCALE_BAND, minN = 10, minRef = 5 } = {}) {
  const out = {};
  for (const pos of [...new Set(rows.map((r) => r.pos))]) {
    const use = rows.filter((r) => r.pos === pos && r.ref >= minRef && Number.isFinite(r.v));
    if (use.length < minN) continue;
    const ratio = median(use.map((r) => r.v / r.ref));
    out[pos] = {
      n: use.length,
      ratio: Number(ratio.toFixed(2)),
      diff: Number(median(use.map((r) => r.v - r.ref)).toFixed(1)),
      flag: ratio > band[1] ? 'high' : ratio < band[0] ? 'low' : null,
    };
  }
  return out;
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** FantasyPros' own week board for one format: nameKey -> {pos, pts, fpId}. */
function fpReference(season, week, scoring) {
  const dir = join(FPDIR, String(season), `week-${week}`, 'rankings', String(scoring).toLowerCase());
  const out = new Map();
  let declaredWeek = null, updatedAt = null;
  if (!existsSync(dir)) return { rows: out, declaredWeek, updatedAt };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const d = readJson(join(dir, f));
    if (!d) continue;
    if (d.week != null) declaredWeek = Number(d.week);
    if (d.last_updated_ts) updatedAt = new Date(d.last_updated_ts * 1000).toISOString();
    for (const p of d.players || []) {
      if (p.r2p_pts === '' || p.r2p_pts == null) continue;
      out.set(nameKey(p.player_name, p.player_position_id), { pos: p.player_position_id, pts: Number(p.r2p_pts), fpId: p.player_id });
    }
  }
  return { rows: out, declaredWeek, updatedAt };
}

/** Provenance for the sources that keep one store with a per-week entry (asked for BY week). */
function storeWeek(store, week) {
  const w = store?.weeks?.[week] ?? store?.weeks?.[String(week)];
  if (!w) return null;
  return { week: Number(week), by: 'request', fetchedAt: w.fetchedAt ?? null, sourceAt: w.sourceAt ?? null };
}

/** What a source's stored file says about its own week and time, without loading its rows. */
function provenance(season, week) {
  return {
    // Asked for by week, so the week is part of the request, not an assumption.
    draftsharks: storeWeek(readJson(join(DATA, 'draftsharks', String(season), 'ppr.json')), week),
    // Filed under the week the site declared serving (/config), not one we asked for.
    vegas: (() => { const v = readVegas(season, week); return v ? { week: v.week, by: 'source', fetchedAt: v.fetchedAt ?? null, sourceAt: v.generatedAt ?? null } : null; })(),
  };
}

/** Pure: turn a source's provenance + scale result into pass/warn/fail lines. */
export function judge({ name, prov, scale, wantWeek, now = Date.now(), maxAgeHours = 36 }) {
  const problems = [];
  const warnings = [];
  if (prov) {
    if (prov.week != null && Number(prov.week) !== Number(wantWeek)) problems.push(`file holds week ${prov.week}, audited as week ${wantWeek}`);
    if (prov.by?.startsWith('us')) warnings.push(`week label is ours, not declared by ${name}`);
    const t = prov.sourceAt ?? prov.fetchedAt;
    if (t && (now - Date.parse(t)) / 3.6e6 > maxAgeHours) warnings.push(`data is ${Math.round((now - Date.parse(t)) / 3.6e6)}h old`);
    if (prov.note) warnings.push(prov.note);
  }
  for (const [pos, r] of Object.entries(scale || {})) {
    if (r.flag) problems.push(`${pos} runs ${r.flag} vs FantasyPros: median x${r.ratio} (${r.diff >= 0 ? '+' : ''}${r.diff} pts, n=${r.n})`);
  }
  return { problems, warnings };
}

/** Audit every stored source for one week. */
export async function auditSources({ season, week, scoring = 'PPR' } = {}) {
  const ref = fpReference(season, week, scoring);
  const prov = provenance(season, week);
  const byRef = (key, v, out) => { const f = ref.rows.get(key); if (f && v != null && Number.isFinite(Number(v))) out.push({ pos: f.pos, v: Number(v), ref: f.pts }); };
  const rows = { draftsharks: [], vegas: [] };

  for (const [k, v] of draftsharksIndex(season, scoring)) byRef(k, (v.weeks?.[week] ?? v.weeks?.[String(week)])?.proj, rows.draftsharks);
  // Complete markets only: a TD-price-only projection is low by design, not by units.
  for (const r of Object.values(readVegas(season, week)?.players || {})) if (r.complete) byRef(nameKey(r.n, r.p), scoreLine(r, scoring), rows.vegas);

  const results = {};
  for (const [name, r] of Object.entries(rows)) {
    const scale = scaleCheck(r);
    results[name] = { n: r.length, scale, prov: prov[name] ?? null, ...judge({ name, prov: prov[name], scale, wantWeek: week }) };
  }
  // FantasyPros itself: only its own declared week can be checked, it is the reference.
  const fpProblems = [];
  if (ref.declaredWeek != null && ref.declaredWeek !== Number(week)) fpProblems.push(`file holds week ${ref.declaredWeek}, audited as week ${week}`);
  results.fp = { n: ref.rows.size, scale: {}, prov: { week: ref.declaredWeek, by: 'source', sourceAt: ref.updatedAt }, problems: fpProblems, warnings: [] };
  return { season, week, scoring, sources: results, ok: Object.values(results).every((r) => !r.problems.length) };
}

export function formatAudit(a, log = console.log) {
  log(`Source audit — season ${a.season}, week ${a.week}, ${a.scoring}; scale is each source's median value relative to FantasyPros for the same players\n`);
  for (const [name, r] of Object.entries(a.sources)) {
    const scale = Object.entries(r.scale).map(([pos, s]) => `${pos} x${s.ratio}`).join('  ');
    const week = r.prov?.week != null ? `wk ${r.prov.week} (${r.prov.by})` : 'no week file';
    const state = r.problems.length ? 'FAIL' : r.n ? (r.warnings.length ? 'warn' : 'ok') : 'no data';
    log(`  ${state.padEnd(7)} ${name.padEnd(11)} n=${String(r.n).padStart(3)}  ${week.padEnd(24)} ${scale}`);
    for (const p of r.problems) log(`            ✗ ${p}`);
    for (const w of r.warnings) log(`            · ${w}`);
  }
  log(`\n${a.ok ? 'No source failed a check.' : 'One or more sources failed — do not trust their numbers until resolved.'}`);
  log('Scale flags mean uniformly high/low against FantasyPros (0.8-1.25 allowed); a source may disagree about individuals, not about units.');
}
