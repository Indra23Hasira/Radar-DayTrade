#!/usr/bin/env node
// Runner otomatis Radar-DayTrade (mode paper). Dijalankan GitHub Actions per sesi:
//   universe → kandidat paling aktif saat opening range → scan ORB tiap 5 menit →
//   rencana + Time Machine + sizing + risk check → jurnal otomatis (Firestore) → Telegram.
// Tidak pernah mengirim order ke broker.
//
//   node runner/run.js --market idx --part 1            (live, butuh secret)
//   node runner/run.js --market idx --simulate 2026-11-06 --fixtures tests/fixtures --state /tmp/sim.json
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { MARKETS, exitWindow, slotsFor } from "../lib/markets.js";
import {
  parseChart, evaluateEntry, planExit, timeMachine, historyReplay, sizeOrder, riskCheck, prevCloseOf,
  gapStats, evaluateTrade, marketClock, localParts, localToSec, hhmm, dayLabel, toWIB, openingRange, verdict,
} from "../lib/engine.js";
import { DEFAULTS, feesFrom } from "../lib/defaults.js";
import { report, CRITERIA, verdictOf, fmtR } from "../lib/report.js";
import { yahooLive, yahooFixtures, mapLimit } from "./sources.js";
import { fileStore, resilientStore } from "./store.js";

// ---------------------------------------------------------------- argumen & lingkungan
const A = {};
process.argv.slice(2).forEach((x, i, all) => { if (x.startsWith("--")) A[x.slice(2)] = all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true; });
const M = MARKETS[A.market || "idx"];
if (!M) throw new Error("--market idx|us");
const PART = Number(A.part || 1);
const SIM = !!A.simulate;
const DRY = SIM || !!A.dry;
const LABEL = `[DayTrade ${M.name}]`;
const LAG = 60; // detik setelah bar 5 menit tutup sebelum data diambil

// jam: nyata atau virtual (simulasi tidak benar-benar menunggu)
let simNow = SIM ? localToSec(A.simulate, A.start ? Number(A.start.split(":")[0]) * 60 + Number(A.start.split(":")[1]) : (M.id === "idx" ? 8 * 60 : 8 * 60), M.tz) : 0;
const now = () => (SIM ? simNow : Math.floor(Date.now() / 1000));
const sleepUntil = async (sec) => { if (SIM) { simNow = Math.max(simNow, sec); return; } const ms = (sec - now()) * 1000; if (ms > 0) await new Promise(r => setTimeout(r, ms)); };
const clockTxt = () => { const p = localParts(now(), M.tz); return `${hhmm(p.min)}${M.id === "us" ? ` ET/${hhmm(localParts(now(), "Asia/Jakarta").min)} WIB` : ""}`; };
const log = (...x) => console.log(`[${clockTxt()}]`, ...x);
const iso = () => new Date(now() * 1000).toISOString();

const Y = A.fixtures ? yahooFixtures(A.fixtures) : yahooLive();
function keyMaterial() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("Secret FIREBASE_SERVICE_ACCOUNT_KEY belum diisi");
  try { return JSON.parse(raw).private_key || raw; } catch { return raw; }
}
const store = A.store === "resilient" // uji jalur kuota habis secara lokal
  ? await resilientStore({ market: M.id, file: A.state, keyMaterial: "uji-lokal", log: (m) => console.log(m) })
  : DRY ? fileStore(A.state || null)
  : await resilientStore({ market: M.id, file: path.join("data", "daytrade", `state-${M.id}.enc`), keyMaterial: keyMaterial(), log: (m) => console.log(m) });
const degradedNote = () => (store.degraded?.() ? "\n⚠️ Firestore sedang tidak tersedia (kuota harian habis?) — jurnal disimpan aman di repo dan disinkron otomatis nanti; app belum menampilkannya." : "");
const runId = `${process.env.GITHUB_RUN_ID || "local"}-${PART}`;

// ---------------------------------------------------------------- Telegram
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
async function tg(text) {
  if (DRY) { console.log("\n----- TELEGRAM -----\n" + text.replace(/<\/?[bi]>/g, "") + "\n--------------------"); return true; }
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { log("Telegram belum diset (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)"); return false; }
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if ((await r.json()).ok) return true;
    } catch {}
  }
  log("Telegram gagal terkirim");
  return false;
}

// ---------------------------------------------------------------- format
const P = (x) => M.price(x);
const money = (x) => M.money(x);
const qty = (o) => (M.id === "idx" ? `${o.units} lot` : `${o.shares} lembar`);
const atWIB = (date, min) => (M.id === "idx" ? `${hhmm(min)} WIB` : `${hhmm(toWIB(M, date, min).min)} WIB`);
const pctTxt = (x) => `${Math.round(x * 100)}%`;
const rTxt = (x) => `${x > 0 ? "+" : ""}${Number(x).toFixed(2)}R`;

// ---------------------------------------------------------------- data helpers
const cache = new Map(); // symbol -> parsed 60 hari (diperbarui bar hari ini)
async function parsed60(sym) {
  if (!cache.has(sym)) cache.set(sym, parseChart(await Y.chart(M.yahoo(sym), "60d"), M, now()));
  return cache.get(sym);
}
async function refreshToday(sym, today) {
  const p = await parsed60(sym);
  const fresh = parseChart(await Y.chart(M.yahoo(sym), SIM ? "60d" : "1d"), M, now());
  if (fresh.days[today]) { p.days[today] = fresh.days[today]; if (!p.dates.includes(today)) p.dates.push(today); p.dates.sort(); }
  return p;
}
function orStats(day, orMinutes) {
  const or = openingRange(day.bars, orMinutes);
  if (!or) return null;
  const rows = day.bars.filter(b => b.min < day.bars[0].min + orMinutes);
  return { or, value: rows.reduce((a, b) => a + b.c * b.v, 0), bars: rows.length };
}

// ---------------------------------------------------------------- universe & kandidat
async function universe(S) {
  if (M.id === "idx") {
    if (SIM) return { rows: Y.idxUniverse().map(s => ({ symbol: s, avgValue: null })), asOf: null };
    const u = await store.idxUniverse(+S.minAvgValue || 5e9);
    return u;
  }
  const syms = await Y.usUniverse();
  return { rows: syms.map(s => ({ symbol: s, avgValue: null })), asOf: null };
}
// rata-rata nilai transaksi harian 20 hari (untuk US / simulasi), dari data harian Yahoo
async function avgDailyValue(sym) {
  if (SIM) {
    const p = await parsed60(sym);
    const today = localParts(now(), M.tz).date;
    const v = p.dates.filter(d => d < today).slice(-20).map(d => p.days[d].bars.reduce((a, b) => a + b.c * b.v, 0));
    return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
  }
  const j = await Y.chart(M.yahoo(sym), "1mo", "1d");
  const q = j?.chart?.result?.[0]?.indicators?.quote?.[0];
  if (!q) return null;
  const v = (q.close || []).map((c, i) => (c && q.volume?.[i] ? c * q.volume[i] : null)).filter(Boolean).slice(-21, -1);
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
}

async function pickCandidates(S, today, uni) {
  const orMin = +S.orMinutes || 15;
  const perDay = slotsFor(M, today).length;
  const rows = uni.rows;
  log(`ranking ${rows.length} saham universe…`);
  const res = await mapLimit(rows, SIM ? 1 : 6, async (u) => {
    const p = SIM ? await refreshToday(u.symbol, today) : parseChart(await Y.chart(M.yahoo(u.symbol), "1d"), M, now());
    const day = p.days[today];
    if (!day) return null;
    const st = orStats(day, orMin);
    if (!st) return null;
    const last = day.bars.at(-1).c;
    if (last < (+S.minPrice || 0)) return null;
    const avg = u.avgValue ?? u.avgDaily;
    if (!(avg > 0)) return null;
    return { symbol: u.symbol, rel: st.value / (avg * st.bars / perDay), orValue: st.value, avgValue: avg, price: last };
  });
  const ok = res.filter(r => r && !r.error);
  ok.sort((a, b) => b.rel - a.rel);
  const top = ok.slice(0, +S.autoTopN || 40);
  log(`kandidat: ${top.length} dari ${ok.length} yang punya data opening range`);
  await mapLimit(top, SIM ? 1 : 6, (c) => parsed60(c.symbol));
  return top.filter(c => cache.has(c.symbol));
}

// ---------------------------------------------------------------- sinyal
function slip(price, S) {
  if (M.id === "idx") return price + (+S.slippage || 0) * M.tick(price);
  return Math.round(price * (1 + (+S.slippage || 0) / 100) * 100) / 100;
}

function todayStats(trades, today) {
  const openT = trades.filter(t => t.result?.status !== "closed");
  return {
    trades: trades.filter(t => t.date === today).length,
    riskUsed: openT.reduce((a, t) => a + (t.maxLoss || 0), 0),
    openValue: openT.reduce((a, t) => a + (t.value || 0), 0),
    realized: trades.filter(t => t.result?.status === "closed" && (t.result.exitDate || t.date) === today).reduce((a, t) => a + t.result.pnl, 0),
  };
}

async function onSignal(c, e, ctx) {
  const { S, today, win, trades } = ctx;
  const p = cache.get(c.symbol);
  const day = p.days[today];
  const last = day.bars.at(-1);
  const detectMin = last.min, detectPrice = last.c;
  const lagMin = Math.max(0, Math.round((now() - localToSec(today, last.min + 5, M.tz)) / 60));
  const sig = {
    market: M.id, date: today, symbol: c.symbol, signalTime: e.time, signalPrice: e.entry, orHigh: e.or.high, orLow: e.or.low,
    detectedAt: iso(), detectBar: hhmm(detectMin + 5), detectPrice, dataLagMin: lagMin, rel: Math.round(c.rel * 10) / 10,
    flat: S.flat, overnight: !!win.overnight,
  };
  const id = `${M.id}_${today}_${c.symbol}`;
  const finish = async (status, reasons, extra = {}) => {
    Object.assign(sig, { status, reasons, ...extra });
    await store.setSignal(id, sig);
    // log GitHub Actions bersifat publik: tanpa angka uang/ukuran posisi
    log(`sinyal ${c.symbol} ${status}${reasons.length ? ": " + (DRY ? reasons[0] : reasons[0].split(":")[0]) : ""}`);
    return sig;
  };
  if (e.status === "extended") return finish("extended", [e.note]);
  if (detectMin > win.lastEntryMin) return finish("late", [`terdeteksi ${hhmm(detectMin + 5)}, lewat batas entry ${hhmm(win.lastEntryMin + 5)}`]);
  if (e.maxPrice != null && detectPrice > e.maxPrice) return finish("late", [`saat terdeteksi harga ${P(detectPrice)} sudah lewat batas kejar ${P(e.maxPrice)}`]);
  const fees = feesFrom(S);
  const entry = slip(detectPrice, S);
  const prevClose = prevCloseOf(p, today);
  const rules = { market: M, date: today, entry, or: e.or, stopRule: S.autoStopRule || "or_mid", targetRule: S.autoTargetRule || "2R", prevClose, fees };
  let plan;
  try { plan = planExit({ ...rules, maxLossPerTrade: +S.maxLossPerTrade }); }
  catch (err) { return finish("block", [err.message]); }
  const ts = todayStats(trades, today);
  const account = { ...S, equity: +S.equity, cash: Math.max(0, +S.cash - ts.openValue), maxLossPerTrade: +S.maxLossPerTrade, maxPositionPct: +S.maxPositionPct, cashBufferPct: +S.cashBufferPct };
  const order = sizeOrder({ market: M, symbol: c.symbol, plan, account, fees });
  if (order.ok && order.shares !== plan.refShares) plan = planExit({ ...rules, refShares: order.shares });
  let tm = null, hist = null;
  try { tm = timeMachine({ market: M, date: today, parsed: p, plan, fromMin: detectMin, flatMin: win.flatMin, flatDate: win.flatDate, prevClose, fees }); } catch (err) { log(`TM ${c.symbol}: ${err.message}`); }
  try { hist = historyReplay({ market: M, parsed: p, date: today, orMinutes: +S.orMinutes, stopRule: rules.stopRule, targetRule: rules.targetRule, flatPreset: S.flat, exitAt: S.nextExit, fees, maxExtension: +S.maxExtension, maxLossPerTrade: +S.maxLossPerTrade }); } catch {}
  const gap = win.overnight ? gapStats(p, M, today) : null;
  let earn = null;
  if (win.overnight) earn = await Y.earnings(M.yahoo(c.symbol), today, win.flatDate);
  const earningsChecked = !!earn && earn.ok && !earn.hit.length;
  const settings = { ...account, dailyLossLimit: +S.dailyLossLimit, maxTradesPerDay: +S.maxTradesPerDay, minRR: +S.minRR, blocked: String(S.blocked || "").split(",").map(s => s.trim()).filter(Boolean) };
  const risk = riskCheck({ market: M, order, plan, settings, today: ts, clock: marketClock(M, now()), win, now: iso(), earningsChecked, gap });
  if (win.overnight && earn && !earningsChecked) {
    const ck = risk.checks.find(x => x.label.startsWith("Tidak ada laporan"));
    if (ck) ck.detail = earn.ok ? `laporan keuangan ${earn.hit.join(", ")}` : `jadwal tidak bisa dicek (${earn.error})`;
  }
  const news = M.id === "us" && Y.news ? await Y.news(M.yahoo(c.symbol)) : [];
  const summary = {
    entry: plan.entry, stop: plan.stop, target: plan.target, rNet: order.rNet ?? plan.rNet, units: order.units || 0, shares: order.shares || 0,
    maxLoss: order.maxLoss || null, value: order.value || null, sizing: order.ok ? order.decidedBy : order.reason,
    tm: tm && { pTarget: tm.pTarget, pStop: tm.pStop, pNeither: tm.pNeither, pGapStop: tm.pGapStop, avgR: tm.avgR, verdict: tm.verdict.text, tone: tm.verdict.tone },
    hist: hist && { triggered: hist.triggered, target: hist.target, stop: hist.stop, avgR: hist.avgR },
    gap: gap && { worst: gap.worst, avgAbs: gap.avgAbs }, earnings: earn && { ok: earn.ok, hit: earn.hit || [] }, news: news.map(n => n.title),
    checks: risk.checks, flatDate: win.flatDate, flatMin: win.flatMin,
  };
  const reasons = risk.checks.filter(x => !x.ok).map(x => `${x.label}: ${x.detail}`);
  if (!risk.pass) return finish("block", reasons, summary);
  const trade = {
    auto: true, mode: "paper", market: M.id, symbol: c.symbol, date: today, signalId: id,
    entry: plan.entry, stop: plan.stop, target: plan.target, units: order.units, shares: order.shares,
    maxLoss: order.maxLoss, value: order.value, entryMin: detectMin, flatMin: win.flatMin, flatDate: win.flatDate,
    flat: S.flat, overnight: !!win.overnight, stopRule: rules.stopRule, targetRule: rules.targetRule, rNet: summary.rNet,
    tm: summary.tm, signalPrice: e.entry, signalTime: e.time, detectPrice, dataLagMin: lagMin,
    createdAt: iso(), replay: SIM,
  };
  trade.id = await store.addTrade(trade);
  trades.push(trade);
  await finish("pass", [], { ...summary, tradeId: trade.id });
  const sell = `${win.overnight ? dayLabel(win.flatDate) + " " : ""}${atWIB(win.flatDate, win.flatMin + 5)}`;
  const lines = [
    `🟢 <b>${LABEL} SINYAL ${esc(c.symbol)}</b> · ${atWIB(today, detectMin + 5)}`,
    `Beli ${qty(order)} @ ${P(plan.entry)} (breakout ${e.time}${M.id === "us" ? " ET" : ""} di ${P(e.entry)}${lagMin >= 3 ? `, data terlambat ${lagMin} mnt` : ""})`,
    `Stop ${P(plan.stop)} · Target ${P(plan.target)} · R bersih ${summary.rNet}`,
    win.overnight ? `Pasang bracket GTC. Jual paling lambat ${sell}` : `Jual paling lambat ${sell}`,
    `Rugi di stop ≈ ${money(order.maxLoss)}${win.overnight ? " (bisa lebih kalau gap)" : ""}`,
    tm ? `Time Machine: target ${pctTxt(tm.pTarget)} · stop ${pctTxt(tm.pStop)}${win.overnight ? ` (gap ${pctTxt(tm.pGapStop)})` : ""} — ${esc(tm.verdict.text.split(":")[0])}` : "",
    hist && hist.triggered ? `Riwayat 60 hari: ${hist.triggered} sinyal, rata-rata ${rTxt(hist.avgR)}` : "",
    news.length ? `Berita: ${news.map(n => "• " + esc(n.title)).join(" ")}` : "",
    `<i>Paper otomatis tercatat. Eksekusi manual di broker hanya kalau Anda setuju. Bukan saran keuangan.</i>` + degradedNote(),
  ];
  await tg(lines.filter(Boolean).join("\n"));  return sig;
}

// ---------------------------------------------------------------- evaluasi posisi terbuka
async function evaluateOpen(trades, fees, today, notify = true) {
  const open = trades.filter(t => t.result?.status !== "closed");
  for (const t of open) {
    try {
      const p = await refreshToday(t.symbol, today);
      const r = evaluateTrade({ market: M, parsed: p, trade: t, fees });
      if (!r || r.status !== "closed") continue;
      t.result = r;
      await store.updateTrade(t.id, { result: r });
      log(`hasil ${t.symbol}: ${r.outcome} ${rTxt(r.R)}`);
      if (notify) {
        const icon = r.outcome === "target" ? "✅" : r.outcome === "stop" ? "🔴" : "⏱";
        const what = { target: "TARGET", stop: r.gap ? "STOP (gap)" : "STOP", flat: "JUAL WAKTU" }[r.outcome];
        await tg(`${icon} <b>${LABEL} ${what} ${esc(t.symbol)}</b> @ ${P(r.exit)} · ${r.exitDate && r.exitDate !== t.date ? dayLabel(r.exitDate) + " " : ""}${r.time}${M.id === "us" ? " ET" : " WIB"}\n${rTxt(r.R)} (${money(r.pnl)}) · entry ${P(t.entry)} ${t.date}\n<i>Paper otomatis.</i>`);
      }
    } catch (err) { log(`evaluasi ${t.symbol} gagal: ${err.message}`); }
  }
}

// ---------------------------------------------------------------- ringkasan harian
async function dailySummary(today, trades, sigs, uniInfo) {
  const r = report(trades);
  const by = (s) => sigs.filter(x => x.status === s).length;
  const closedToday = trades.filter(t => t.result?.status === "closed" && (t.result.exitDate || t.date) === today);
  const openNow = trades.filter(t => t.result?.status !== "closed");
  const lines = [
    `📊 <b>${LABEL} Ringkasan ${dayLabel(today)}</b>`,
    `Sinyal: ${sigs.length} (PASS ${by("pass")} · BLOCK ${by("block")} · terlalu jauh/terlambat ${by("extended") + by("late")})`,
    closedToday.length ? `Selesai hari ini: ${closedToday.map(t => `${esc(t.symbol)} ${rTxt(t.result.R)}`).join(", ")} · ${money(closedToday.reduce((a, t) => a + t.result.pnl, 0))}` : "Selesai hari ini: -",
    openNow.length ? `Masih terbuka: ${openNow.map(t => `${esc(t.symbol)} (jual ${t.flatDate ? dayLabel(t.flatDate) : ""})`).join(", ")}` : "",
    "",
    `<b>Rapor otomatis</b> (${r.n} trade selesai): ${r.n ? `menang ${pctTxt(r.winRate)} · rata-rata ${fmtR(r.avgR)} · total ${money(r.totalPnl)} · drawdown terdalam -${r.maxDD.toFixed(1)}R` : "belum ada"}`,
    `Kelayakan: <b>${verdictOf(r)}</b> — ${CRITERIA.map(c => `${c.ok(r) ? "✓" : "✗"} ${c.val(r)}`).join(" · ")}`,
    uniInfo?.warn ? `⚠️ ${esc(uniInfo.warn)}` : "",
    degradedNote().trim(),
  ];
  await tg(lines.filter(x => x !== null && x !== undefined && x !== false).join("\n").replace(/\n{3,}/g, "\n\n"));
}

// ---------------------------------------------------------------- arsip bar (data backtest jangka panjang)
function archive(today, cands) {
  if (!cands?.length || A["no-archive"]) return;
  const dir = path.join(A.out || "data", "bars", M.id);
  fs.mkdirSync(dir, { recursive: true });
  const doc = { market: M.id, date: today, part: PART, candidates: cands.map(c => ({ symbol: c.symbol, rel: c.rel, bars: (cache.get(c.symbol)?.days[today]?.bars || []).map(b => [b.min, b.o, b.h, b.l, b.c, b.v]) })) };
  fs.writeFileSync(path.join(dir, `${today}-p${PART}.json.gz`), zlib.gzipSync(JSON.stringify(doc)));
  log(`arsip bar ${cands.length} saham disimpan`);
}

// ---------------------------------------------------------------- utama
async function main() {
  const S0 = await store.settings(M.id);
  const S = { ...DEFAULTS[M.id], ...S0 };
  const runner = (await store.runner(M.id)) || {};
  const today = localParts(now(), M.tz).date;
  if (S.autoEnabled === false || S.autoEnabled === "false") { log("mode otomatis dimatikan di Pengaturan"); return; }
  if (runner.parts?.[today]?.[`p${PART}`] === "done") { log(`bagian ${PART} hari ini sudah selesai (jadwal cadangan)`); return; }
  if (!SIM && runner.heartbeat && runner.runId !== runId && Date.now() - Date.parse(runner.heartbeat) < 240e3 && !["selesai", "bagian selesai", "libur", "gagal"].includes(runner.state)) { log("runner lain sedang jalan"); return; }
  const beat = (state, extra = {}) => store.setRunner(M.id, { runId, part: PART, date: today, state, heartbeat: iso(), ...extra });
  await beat("jalan", { parts: { [today]: { [`p${PART}`]: "running" } } });
  if (!runner.firstRun) { await tg(`✅ <b>${LABEL} runner otomatis aktif</b>\nSinyal, hasil, dan ringkasan harian akan dikirim ke sini. Mode paper — tidak ada order ke broker.`); await store.setRunner(M.id, { firstRun: iso() }); }

  const fees = feesFrom(S);
  const trades = await store.autoTrades(M.id);
  const ss = M.sessions(today);
  if (!ss) {
    log(`${today} bukan hari bursa (${M.holiday(today) || "akhir pekan"})`);
    await evaluateOpen(trades, fees, today);
    await beat("libur", { parts: { [today]: { [`p${PART}`]: "done" } } });
    return;
  }
  const win = exitWindow(M, today, S.flat, S.nextExit);
  const orMin = +S.orMinutes || 15;
  const T = (min) => localToSec(today, min, M.tz);
  const deadline = (SIM ? now() : Math.floor(Date.now() / 1000)) + (+A["max-minutes"] || 340) * 60;
  const dayEnd = ss.at(-1)[1];
  let untilSec = Math.min(deadline, T(dayEnd + 10));
  if (M.id === "idx" && PART === 1) untilSec = Math.min(untilSec, T(ss[0][1] + 10));
  const orReady = T(ss[0][0] + orMin) + LAG;
  const entryEnd = T(win.lastEntryMin + 5) + LAG;
  const startNeeded = PART === 2 && M.id === "idx" ? T(ss.at(-1)[0] - 5) : T(ss[0][0] - 1);
  const prevSigs = await store.signals(M.id, today);
  const signaled = new Set(prevSigs.map(s => s.symbol));
  const sigs = [...prevSigs];
  let uniInfo = null, cands = null;
  log(`mulai bagian ${PART}: entry s.d. ${hhmm(win.lastEntryMin + 5)}, jual ${win.overnight ? "besok " + win.flatDate + " " : ""}${hhmm(win.flatMin + 5)} (${M.tzLabel}); ${trades.filter(t => t.result?.status !== "closed").length} posisi terbuka`);

  // persiapan sebelum buka: universe + (US) rata-rata nilai transaksi
  // bagian ini ikut mencari sinyal kalau jendela entry masih terbuka dan beririsan dengan jam kerja bagian ini
  const needEntries = entryEnd > Math.max(now(), startNeeded) && orReady < untilSec;
  if (needEntries) {
    const u = await universe(S);
    uniInfo = { size: u.rows.length, asOf: u.asOf };
    if (M.id === "idx" && u.asOf && (Date.parse(today) - Date.parse(u.asOf)) / 864e5 > 5) uniInfo.warn = `Data likuiditas Radar IDX terakhir ${u.asOf} — upload Excel harian supaya universe tetap akurat.`;
    if (M.id === "idx" && !SIM && !u.rows.length) uniInfo.warn = "Universe IDX kosong (tickerRollingStats tidak terbaca dan belum ada salinan).";
    if (u.cached) log(`universe IDX dari salinan ${u.cachedAt}`);
    if (u.rows.some(r => r.avgValue == null)) {
      log(`menghitung likuiditas ${u.rows.length} saham…`);
      const vals = await mapLimit(u.rows, SIM ? 1 : 6, (r) => avgDailyValue(r.symbol));
      u.rows.forEach((r, i) => { r.avgDaily = typeof vals[i] === "number" ? vals[i] : null; });
    }
    uniInfo.rows = u.rows;
    await beat("menunggu opening range", { universe: uniInfo.size, universeAsOf: uniInfo.asOf || null });
  } else if (PART === 1 && now() > entryEnd && !SIM && runner.lateNotice !== today) {
    // jadwal GitHub Actions bisa terlambat berjam-jam: beri tahu, jangan diam-diam melewatkan sesi
    const nowMin = localParts(now(), M.tz).min;
    await tg(`⚠️ <b>${LABEL} runner baru jalan ${atWIB(today, nowMin)}</b> — jadwal GitHub Actions terlambat, jendela entry hari ini (s.d. ${atWIB(today, win.lastEntryMin + 5)}) sudah lewat. Tidak ada sinyal untuk sesi ini.`);
    await store.setRunner(M.id, { lateNotice: today });
  }

  let last = 0;
  while (true) {
    const t = now();
    if (t >= untilSec) break;
    const anyOpen = trades.some(x => x.result?.status !== "closed");
    if (!needEntries && !anyOpen) break; // bagian ini tidak punya tugas
    if (t < startNeeded) { await sleepUntil(Math.min(startNeeded, untilSec)); continue; }
    await evaluateOpen(trades, fees, today);
    if (needEntries && t >= orReady && t <= entryEnd) {
      if (!cands) {
        cands = await pickCandidates(S, today, uniInfo);
        await beat("scan", { candidates: cands.map(c => c.symbol), candidatesAt: iso() });
        const key = `${today}-p${PART}`;
        if ((await store.runner(M.id))?.startNotice !== key) {
          await tg(`▶️ <b>${LABEL} mulai memantau</b> ${cands.length} saham teraktif (dari ${uniInfo?.size ?? "?"} di universe) · cek tiap 5 menit s.d. ${atWIB(today, win.lastEntryMin + 5)}.\nPesan berikutnya hanya kalau ada sinyal yang lolos risk check — kalau sepi, berarti belum ada breakout yang layak.`);
          await store.setRunner(M.id, { startNotice: key });
        }
      }
      await mapLimit(cands.filter(c => !signaled.has(c.symbol)), SIM ? 1 : 6, (c) => refreshToday(c.symbol, today));
      for (const c of cands) {
        if (signaled.has(c.symbol)) continue;
        const p = cache.get(c.symbol);
        if (!p?.days[today]) continue;
        const e = evaluateEntry(p, M, today, { orMinutes: orMin, lastEntryMin: win.lastEntryMin, maxExtension: +S.maxExtension });
        if (e.status !== "triggered" && e.status !== "extended") continue;
        signaled.add(c.symbol);
        sigs.push(await onSignal(c, e, { S, today, win, trades }));
      }
      const lagBar = cands.map(c => cache.get(c.symbol)?.days[today]?.bars.at(-1)?.min).filter(x => x != null);
      const lag = lagBar.length ? Math.round((now() - T(Math.max(...lagBar) + 5)) / 60) : null;
      await beat("scan", { lastScan: iso(), signalsToday: sigs.length, dataLagMin: lag });
    } else {
      await beat(t < orReady ? "menunggu opening range" : "memantau posisi");
    }
    const exitsToday = trades.some(x => x.result?.status !== "closed" && (x.flatDate || x.date) === today && T(x.flatMin + 5) + LAG > t);
    const entriesLeft = needEntries && t <= entryEnd;
    if (!entriesLeft && !exitsToday) break;
    // tidur sampai bar 5 menit berikutnya tutup (+ jeda data)
    const next = Math.floor(now() / 300) * 300 + 300 + LAG;
    let wake = Math.min(next, untilSec);
    if (now() < orReady) wake = Math.min(orReady, untilSec);
    if (wake <= now()) wake = now() + 30;
    if (++last > 400) break;
    await sleepUntil(wake);
  }

  await evaluateOpen(trades, fees, today);
  const dayDone = now() >= entryEnd - LAG && !trades.some(x => x.result?.status !== "closed" && (x.flatDate || x.date) === today);
  const lastPart = M.id === "us" ? true : PART === 2 || dayDone;
  const fresh = await store.runner(M.id);
  if (lastPart && dayDone && fresh?.summaryDate !== today) {
    await dailySummary(today, trades, sigs.filter(Boolean), uniInfo);
    await store.setRunner(M.id, { summaryDate: today });
  }
  archive(today, cands);
  await beat(dayDone ? "selesai" : "bagian selesai", { parts: { [today]: { [`p${PART}`]: "done" } }, lastReport: report(trades) && { n: report(trades).n } });
  log("selesai");
}

try { await main(); }
catch (err) {
  console.error(err);
  const r = await store.runner(M.id).catch(() => null);
  if (!r?.lastFailAt || Date.now() - Date.parse(r.lastFailAt) > 6 * 3600e3) {
    await tg(`⚠️ <b>${LABEL} runner gagal</b>: ${esc(err.message)}\nSinyal otomatis bagian ini tidak berjalan. Cek tab Actions di GitHub.`);
    await store.setRunner(M.id, { lastFailAt: new Date().toISOString(), state: "gagal", lastError: String(err.message).slice(0, 300) }).catch(() => {});
  }
  process.exitCode = 1;
}
try { await store.save?.(); } catch (e) { console.error("simpan salinan lokal gagal:", e.message); }
if (A.dump && DRY) fs.writeFileSync(A.dump, JSON.stringify(store.dump(), null, 1));
