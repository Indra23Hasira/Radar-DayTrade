// Data contoh untuk "Coba demo" (tanpa login). Semuanya dibuat di browser, tidak membaca/menulis Firestore,
// dan TIDAK memakai data trading asli. Angka acak tapi tetap (seed), supaya tiap kali dibuka sama.
import { MARKETS } from "./markets.js";
import { localParts, addDays } from "./time.js";

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

const POOL = {
  idx: ["BBRI", "BMRI", "TLKM", "ANTM", "ADRO", "GOTO", "MDKA", "BRPT", "PGAS", "MEDC", "AMMN", "BUMI", "CUAN", "TPIA", "INKP", "PTBA"],
  us: ["NVDA", "TSLA", "AMD", "AAPL", "META", "AMZN", "MSFT", "AVGO", "PLTR", "SMCI", "NFLX", "COIN", "MU", "UBER"],
};
const PRICE = { BBRI: 4150, BMRI: 5600, TLKM: 2950, ANTM: 1630, ADRO: 2480, GOTO: 68, MDKA: 1890, BRPT: 820, PGAS: 1570, MEDC: 1210, AMMN: 7900, BUMI: 126, CUAN: 398, TPIA: 7600, INKP: 6100, PTBA: 2700,
  NVDA: 182, TSLA: 412, AMD: 238, AAPL: 268, META: 640, AMZN: 231, MSFT: 505, AVGO: 335, PLTR: 176, SMCI: 33, NFLX: 112, COIN: 290, MU: 214, UBER: 92 };

function tradingDays(m, upto, n) {
  const out = [];
  for (let d = upto, i = 0; out.length < n && i < 60; d = addDays(d, -1), i++) if (m.sessions(d)) out.unshift(d);
  return out;
}

export function makeDemo(nowSec = Math.floor(Date.now() / 1000)) {
  const trades = [], sigs = {}, runner = {}, sigDate = {};
  for (const id of ["idx", "us"]) {
    const m = MARKETS[id], R = rng(id === "idx" ? 1107 : 2026);
    const today = localParts(nowSec, m.tz).date;
    const days = tradingDays(m, today, 16);
    const last = days.at(-1);
    const risk = id === "idx" ? 100000 : 50;
    const tick = (p) => (id === "idx" ? m.tick(p) : 0.01);
    const round = (p) => (id === "idx" ? Math.round(p / tick(p)) * tick(p) : Math.round(p * 100) / 100);
    const mk = (date, sym, k, closed = true) => {
      const base = PRICE[sym] * (0.94 + R() * 0.12);
      const entry = round(base), stopD = Math.max(tick(entry) * 2, entry * (0.012 + R() * 0.012));
      const stop = round(entry - stopD), target = round(entry + 2 * stopD);
      const sizeU = Math.max(1, Math.floor(risk / (entry - stop) / (id === "idx" ? 100 : 1)));
      const roll = R();
      const R_ = roll < 0.52 ? -1 - R() * 0.08 : roll < 0.82 ? 1.55 + R() * 0.25 : (R() - 0.4) * 0.9;
      const outcome = roll < 0.52 ? "stop" : roll < 0.82 ? "target" : "flat";
      const t = {
        id: `demo_${id}_${date}_${sym}`, demo: true, auto: k !== "manual", mode: "paper", market: id, symbol: sym, date,
        createdAt: `${date}T0${id === "idx" ? 2 : 14}:${10 + Math.floor(R() * 40)}:00Z`, entry, stop, target,
        units: id === "idx" ? sizeU : undefined, shares: id === "us" ? sizeU : undefined, maxLoss: risk, value: entry * sizeU * (id === "idx" ? 100 : 1),
        overnight: id === "us", flatDate: id === "us" ? (days[days.indexOf(date) + 1] || addDays(date, 1)) : date,
      };
      t.result = closed
        ? { status: "closed", R: Math.round(R_ * 100) / 100, pnl: Math.round(R_ * risk * (id === "idx" ? 1 : 100)) / (id === "idx" ? 1 : 100), outcome,
            exit: round(outcome === "stop" ? stop : outcome === "target" ? target : entry + R_ * stopD), time: id === "idx" ? "10:4" + Math.floor(R() * 9) : "11:2" + Math.floor(R() * 9),
            exitDate: id === "us" ? t.flatDate : date }
        : { status: "open" };
      trades.push(t);
      return t;
    };
    for (const d of days.slice(0, -1)) {
      const n = R() < 0.25 ? 0 : 1 + Math.floor(R() * 2.2);
      const used = new Set();
      for (let i = 0; i < n; i++) { let s; do s = POOL[id][Math.floor(R() * POOL[id].length)]; while (used.has(s)); used.add(s); mk(d, s, "auto"); }
    }
    mk(days[days.length - 4], POOL[id][3], "manual");
    // hari ini: beberapa sinyal, satu posisi masih berjalan
    const bars = id === "idx" ? ["09:20", "09:20", "09:25", "09:35", "09:50", "10:15"] : ["09:50", "09:55", "10:05", "10:20", "10:40", "11:05"];
    const statuses = ["pass", "block", "pass", "extended", "block", "late"];
    sigs[id] = bars.map((b, i) => {
      const sym = POOL[id][(i * 5 + 2) % POOL[id].length];
      const t = statuses[i] === "pass" ? mk(last, sym, "auto", i !== 0) : null;
      const p = t || { entry: round(PRICE[sym]), stop: round(PRICE[sym] * 0.985), target: round(PRICE[sym] * 1.03) };
      return {
        market: id, date: last, symbol: sym, detectBar: b, rel: Math.round((1.8 + R() * 6) * 10) / 10, status: statuses[i],
        signalPrice: p.entry, entry: p.entry, stop: p.stop, target: p.target,
        units: id === "idx" ? (t?.units ?? Math.max(1, Math.floor(risk / (p.entry - p.stop) / 100))) : undefined,
        shares: id === "us" ? (t?.shares ?? Math.max(1, Math.floor(risk / (p.entry - p.stop)))) : undefined,
        tradeId: t?.id,
        reasons: { block: ["Risiko harian ≤ batas rugi harian (contoh)"], extended: ["harga sudah terlalu jauh dari batas atas opening range"], late: ["terdeteksi setelah batas jam entry"] }[statuses[i]] || [],
      };
    });
    sigDate[id] = last;
    runner[id] = {
      state: "selesai", heartbeat: new Date(nowSec * 1000 - 3 * 3600e3).toISOString(), date: last,
      universe: id === "idx" ? 157 : 517, universeAsOf: id === "idx" ? days.at(-2) : null, candidates: POOL[id].slice(0, 12), dataLagMin: id === "idx" ? 9 : 0,
    };
  }
  return { trades, sigs, runner, sigDate };
}
