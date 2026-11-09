#!/usr/bin/env node
// Radar-DayTrade CLI — dipakai skill Claude Code `radar-daytrade`.
// Contoh:
//   node cli.js status --market idx
//   node cli.js scan BBRI,BBCA,TPIA
//   node cli.js plan BBRI --flat sesi1 --target 2R
//   node cli.js plan BBRI --date 2026-11-05 --at 10:30      (putar ulang hari lalu)
//   node cli.js plan TSLA --market us --flat next --earnings-ok   (jual besok, maks 23:30 WIB)
import fs from "node:fs";
import path from "node:path";
import { MARKETS, exitWindow } from "./lib/markets.js";
import {
  marketClock, chartUrl, parseChart, evaluateEntry, planExit, timeMachine, historyReplay,
  sizeOrder, riskCheck, ticketText, prevCloseOf, hhmm, parseHHMM, localParts, localToSec, gapStats, dayLabel, toWIB,
} from "./lib/engine.js";

const DEFAULTS = {
  idx: { equity: 10_000_000, cash: null, maxLossPerTrade: 100_000, dailyLossLimit: 300_000, maxTradesPerDay: 3,
    minRR: 1.2, maxPositionPct: 50, cashBufferPct: 10, orMinutes: 15, maxExtension: 1, stopRule: "or_mid", targetRule: "2R", flat: "sesi1", blocked: [] },
  us: { equity: 5_000, cash: null, maxLossPerTrade: 50, dailyLossLimit: 150, maxTradesPerDay: 3,
    minRR: 1.2, maxPositionPct: 60, cashBufferPct: 10, orMinutes: 15, maxExtension: 1, stopRule: "or_mid", targetRule: "2R", flat: "next", nextExit: "23:30", perShare: 0.005, minOrder: 1, maxPct: 1, blocked: [] },
};

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith("--")) {
      const k = x.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      a[k] = v;
    } else a._.push(x);
  }
  return a;
}

function loadSettings(market, a) {
  const file = path.resolve(a.config || "trader/daytrade.json");
  let s = { ...DEFAULTS[market.id] };
  if (fs.existsSync(file)) {
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    s = { ...s, ...(all[market.id] || {}) };
  }
  const map = { equity: "equity", cash: "cash", "max-loss": "maxLossPerTrade", "daily-limit": "dailyLossLimit",
    "max-trades": "maxTradesPerDay", "min-rr": "minRR", "or": "orMinutes", "max-ext": "maxExtension", stop: "stopRule", target: "targetRule", flat: "flat", "exit-at": "nextExit",
    "per-share": "perShare", "min-order": "minOrder", "max-pct": "maxPct" };
  for (const [k, v] of Object.entries(map)) if (a[k] != null && a[k] !== true) s[v] = isNaN(Number(a[k])) ? a[k] : Number(a[k]);
  if (s.cash == null) s.cash = s.equity;
  s.fees = { ...market.fees };
  for (const k of ["buyPct", "sellPct", "perShare", "minOrder", "maxPct"]) if (s[k] != null) s.fees[k] = Number(s[k]);
  return s;
}

async function getChart(market, sym, a) {
  if (a.offline) {
    const f = fs.statSync(a.offline).isDirectory() ? path.join(a.offline, `${market.yahoo(sym)}.json`) : a.offline;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  const url = chartUrl(market, sym);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (radar-daytrade)" } });
    if (r.ok) return r.json();
    if (r.status === 429) { await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); continue; }
    throw new Error(`Yahoo ${r.status} untuk ${sym}`);
  }
  throw new Error(`Yahoo membatasi permintaan (429) untuk ${sym}`);
}

function nowFor(market, a) {
  if (a.date || a.at) {
    const date = a.date || localParts(Date.now() / 1000, market.tz).date;
    const min = a.at ? parseHHMM(a.at) : 23 * 60 + 59;
    return localToSec(date, min, market.tz);
  }
  return Math.floor(Date.now() / 1000);
}

const pc = (x) => `${(x * 100).toFixed(1)}%`;

async function cmdStatus(market, a) {
  const now = nowFor(market, a);
  const c = marketClock(market, now);
  const out = { market: market.name, date: c.date, time: hhmm(c.min), tz: market.tzLabel, state: c.state, label: c.label };
  if (a.json) return console.log(JSON.stringify(out, null, 2));
  console.log(`${market.name} ${c.date} ${hhmm(c.min)} ${market.tzLabel} — ${c.label}`);
}

async function cmdScan(market, a) {
  const syms = (a._[1] || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!syms.length) throw new Error("Contoh: node cli.js scan BBRI,BBCA");
  const s = loadSettings(market, a);
  const now = nowFor(market, a);
  const { date } = localParts(now, market.tz);
  const rows = [];
  for (const sym of syms) {
    try {
      const parsed = parseChart(await getChart(market, sym, a), market, now);
      const e = evaluateEntry(parsed, market, date, { orMinutes: s.orMinutes, flat: s.flat, exitAt: s.nextExit, maxExtension: s.maxExtension });
      rows.push({ symbol: market.display(sym), ...e });
    } catch (err) { rows.push({ symbol: market.display(sym), status: "error", note: err.message }); }
    if (!a.offline) await new Promise(r => setTimeout(r, 400));
  }
  if (a.json) return console.log(JSON.stringify({ date, rows }, null, 2));
  const label = { triggered: "TRIGGER", waiting: "menunggu", waiting_or: "tunggu OR", expired: "lewat", extended: "terlalu jauh", closed: "tutup", error: "error" };
  console.log(`Scan ORB ${market.name} ${date} (OR ${s.orMinutes} menit)`);
  for (const r of rows) {
    const extra = r.status === "triggered" ? `entry ${market.price(r.entry)} jam ${r.time}`
      : r.status === "waiting" ? `last ${market.price(r.last)}, perlu +${r.gapPct.toFixed(2)}% ke ${market.price(r.level)}` : r.note;
    console.log(`  ${r.symbol.padEnd(6)} ${String(label[r.status] || r.status).padEnd(10)} ${extra}`);
  }
}

async function cmdPlan(market, a) {
  const sym = a._[1];
  if (!sym) throw new Error("Contoh: node cli.js plan BBRI");
  const s = loadSettings(market, a);
  const now = nowFor(market, a);
  const { date } = localParts(now, market.tz);
  const parsed = parseChart(await getChart(market, sym, a), market, now);
  const win = exitWindow(market, date, s.flat, s.nextExit);
  if (!win) throw new Error(`${date} bukan hari bursa ${market.name}`);
  const { flatMin, flatDate } = win;
  const e = evaluateEntry(parsed, market, date, { orMinutes: s.orMinutes, lastEntryMin: win.lastEntryMin, maxExtension: s.maxExtension });
  let entry = a.entry ? Number(a.entry) : e.entry;
  let fromMin = e.barMin;
  if (!entry) {
    if (e.status === "waiting" && e.level) { entry = e.level + market.tick(e.level); }
    else throw new Error(`Belum ada entry (${e.note}). Isi --entry HARGA untuk merencanakan lebih awal.`);
  }
  if (fromMin == null) {
    const bars = parsed.days[date]?.bars || [];
    fromMin = bars.length ? bars[bars.length - 1].min : win.lastEntryMin;
  }
  const prevClose = prevCloseOf(parsed, date);
  const fees = s.fees;
  let plan = planExit({ market, date, entry, or: e.or, stopRule: s.stopRule, targetRule: s.targetRule, prevClose, fees, maxLossPerTrade: s.maxLossPerTrade });
  let order = sizeOrder({ market, symbol: sym, plan, account: s, fees });
  if (order.ok && order.shares !== plan.refShares) plan = planExit({ market, date, entry, or: e.or, stopRule: s.stopRule, targetRule: s.targetRule, prevClose, fees, refShares: order.shares });
  const tm = timeMachine({ market, date, parsed, plan, fromMin, flatMin, flatDate, prevClose, fees, replays: Number(a.replays || 10000), seed: Number(a.seed || 19) });
  const hist = historyReplay({ market, parsed, date, orMinutes: s.orMinutes, stopRule: s.stopRule, targetRule: s.targetRule, flatPreset: s.flat, exitAt: s.nextExit, fees, maxExtension: s.maxExtension, maxLossPerTrade: s.maxLossPerTrade });
  const gap = win.overnight ? gapStats(parsed, market, date) : null;
  const clock = marketClock(market, now);
  const risk = riskCheck({ market, order, plan, settings: s, today: { trades: Number(a["trades-today"] || 0), riskUsed: Number(a["risk-today"] || 0), realized: Number(a["realized-today"] || 0) }, clock, win, now, earningsChecked: !!a["earnings-ok"], gap });
  const doc = { symbol: market.display(sym), market: market.id, date, window: win, entryStatus: e, plan, timeMachine: tm, gap, history: { ...hist, trades: hist.trades.slice(-10) }, order, risk, ticket: ticketText({ market, order, win }) };
  if (a.write) {
    fs.mkdirSync("trader", { recursive: true });
    fs.writeFileSync(`trader/daytrade-${market.id}-${doc.symbol}.json`, JSON.stringify(doc, null, 2));
  }
  if (a.json) return console.log(JSON.stringify(doc, null, 2));
  const P = market.price;
  console.log(`\n${doc.symbol} — ${market.name} ${date}`);
  const wibOf = (d, m) => market.tz === "Asia/Jakarta" ? "" : ` (${hhmm(toWIB(market, d, m).min)} WIB)`;
  console.log(`Mode    : ${win.overnight ? `jual besok — beli s.d. ${hhmm(win.lastEntryMin + 5)}${wibOf(date, win.lastEntryMin + 5)}, jual paling lambat ${dayLabel(flatDate)} ${hhmm(flatMin + 5)}${wibOf(flatDate, flatMin + 5)}` : `jual hari ini paling lambat ${hhmm(flatMin + 5)}${wibOf(date, flatMin + 5)}`}`);
  console.log(`Entry   : ${e.status === "triggered" ? `TRIGGER ${e.time}, close ${P(e.entry)} > OR high ${P(e.or.high)}` : `${e.note}${a.entry ? ` (pakai --entry ${P(entry)})` : `; rencana di ${P(entry)} (1 tick di atas level)`}`}`);
  if (e.or) console.log(`OR ${s.orMinutes}m : ${P(e.or.low)} – ${P(e.or.high)}`);
  console.log(`Rencana : stop ${P(plan.stop)} (${plan.stopRule}), target ${P(plan.target)} (${plan.targetRule}), risiko ${P(plan.risk)}/lembar, R kotor ${plan.rGross}, R bersih fee ${plan.rNet}`);
  if (plan.limits) console.log(`Batas   : ARB ${P(plan.limits.arb)} · ARA ${P(plan.limits.ara)} (${plan.limits.rule})`);
  plan.warnings.forEach(w => console.log(`  ! ${w}`));
  console.log(`\nTime Machine (${tm.replays.toLocaleString("id-ID")} replay dari ${tm.sessions} sesi, ${tm.from}–${tm.until}):`);
  console.log(`  target duluan ${pc(tm.pTarget)} · stop duluan ${pc(tm.pStop)} · tidak kena keduanya ${pc(tm.pNeither)} · rata-rata R ${tm.avgR}`);
  console.log(`  harga saat jual: median ${P(tm.medianClose)}, 5%–95% ${P(tm.p5Close)}–${P(tm.p95Close)}`);
  console.log(`  ${tm.verdict.text}`);
  if (gap) console.log(`Gap     : ${gap.n} malam terakhir, rata-rata ±${(gap.avgAbs * 100).toFixed(2)}%, terburuk ${((gap.worst - 1) * 100).toFixed(1)}%, terbaik +${((gap.best - 1) * 100).toFixed(1)}%`);
  console.log(`Sejarah : aturan sama di ${hist.sessions} sesi → trigger ${hist.triggered}x${hist.skippedExtended ? ` (+${hist.skippedExtended} dilewati karena terlalu jauh)` : ""}: target ${hist.target}, stop ${hist.stop}, jual di batas waktu ${hist.close}${hist.gapStops ? ` (${hist.gapStops} stop karena gap)` : ""}; rata-rata R ${hist.avgR ?? "-"}`);
  console.log(`\nSizing  : ${order.ok ? `${market.id === "idx" ? `${order.units} lot (${order.shares} lembar)` : `${order.shares} lembar`}, nilai ${market.money(order.value)}, rugi di stop ${market.money(order.maxLoss)}, fee ${market.money(order.fees)}, R bersih ${order.rNet} — dibatasi ${order.decidedBy}` : order.reason}`);
  console.log(`Risk    : ${risk.pass ? "PASS" : "BLOCK"}`);
  risk.checks.forEach(c => console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`));
  if (order.ok) console.log(`\nTiket (eksekusi manual, setelah Anda setuju):\n${doc.ticket.split("\n").map(l => "  " + l).join("\n")}`);
  console.log("\nBukan saran keuangan. Simulasi dari pola 60 hari terakhir, bukan prediksi.");
}

const HELP = `Radar-DayTrade CLI
  node cli.js status [--market idx|us]
  node cli.js scan BBRI,BBCA,TPIA [--market idx]
  node cli.js plan BBRI [--entry 2740] [--stop or_mid|or_low|pct:1.5|price:2700] [--target 2R|price:2800] [--max-ext 1 (0=mati)]
                       [--flat sesi1|close|next] [--exit-at 23:30] [--earnings-ok] [--equity 10000000] [--max-loss 100000] [--write] [--json]
Opsi umum: --market idx|us (default idx), --date YYYY-MM-DD --at HH:MM (putar ulang), --offline FILE|DIR,
           --config trader/daytrade.json`;

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const market = MARKETS[(a.market || "idx").toLowerCase()];
  if (!market) throw new Error("--market harus idx atau us");
  if (cmd === "status") return cmdStatus(market, a);
  if (cmd === "scan") return cmdScan(market, a);
  if (cmd === "plan") return cmdPlan(market, a);
  console.log(HELP);
}
main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
