// Jalankan: node --test tests/   (offline, pakai data Yahoo asli yang disimpan 6 Nov 2026)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MARKETS, slotsFor, flatMinute } from "../lib/markets.js";
import {
  parseChart, evaluateEntry, planExit, timeMachine, historyReplay, sizeOrder, riskCheck,
  marketClock, prevCloseOf, fullSessions, evaluateTrade, localParts,
} from "../lib/engine.js";

const IDX = MARKETS.idx, US = MARKETS.us;
const fx = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
// 5 Nov 2026 11:00 WIB = 04:00 UTC
const AT = (iso) => Date.parse(iso) / 1000;

test("fraksi harga BEI", () => {
  assert.equal(IDX.tick(150), 1);
  assert.equal(IDX.tick(450), 2);
  assert.equal(IDX.tick(1500), 5);
  assert.equal(IDX.tick(2730), 10);
  assert.equal(IDX.tick(5825), 25);
});

test("ARA/ARB mengikuti tanggal berlaku", () => {
  assert.deepEqual([IDX.limits(1000, "2026-10-01").arb, IDX.limits(1000, "2026-10-01").ara], [850, 1250]);
  assert.equal(IDX.limits(1000, "2026-11-05").arb, 930);              // ARB 7%
  assert.equal(IDX.limits(12, "2026-11-05").arb, 11);                 // Rp11–14: ARB Rp1
  assert.equal(IDX.limits(8, "2026-11-05").ara, 9);                   // Rp1–10: Rp1
  assert.equal(IDX.limits(1000, "2027-01-04").arb, 750);              // rencana simetris 2027
  assert.equal(IDX.limits(6000, "2026-11-05").ara, 7200);
});

test("sesi BEI: Senin–Kamis vs Jumat, libur", () => {
  assert.equal(slotsFor(IDX, "2026-11-05").length, 36 + 28);         // 09:00–11:55, 13:30–15:45
  assert.equal(slotsFor(IDX, "2026-11-06").length, 30 + 22);         // Jumat
  assert.equal(slotsFor(IDX, "2026-12-25").length, 0);
  assert.equal(flatMinute(IDX, "2026-11-05", "sesi1"), 11 * 60 + 55);
  assert.equal(flatMinute(IDX, "2026-11-06", "sesi1"), 11 * 60 + 25);
  assert.equal(flatMinute(IDX, "2026-11-05", "close"), 15 * 60 + 45);
  assert.equal(marketClock(IDX, AT("2026-11-05T05:30:00Z")).state, "break"); // 12:30 WIB
});

test("jam US ikut DST", () => {
  assert.equal(localParts(AT("2026-11-04T14:30:00Z"), US.tz).min, 9 * 60 + 30); // EST
  assert.equal(localParts(AT("2026-10-29T13:30:00Z"), US.tz).min, 9 * 60 + 30); // EDT
});

test("parse chart: bar istirahat & pra-penutupan dibuang, bar belum selesai tidak dipakai", () => {
  const p = parseChart(fx("BBRI.JK.json"), IDX, AT("2026-11-06T07:38:00Z"));
  const thu = p.days["2026-11-05"];
  assert.equal(thu.bars.length, 64);
  assert.equal(thu.bars.at(-1).time, "15:45");
  assert.equal(thu.close, 2710);
  assert.ok(!thu.bars.some(b => b.min >= 12 * 60 && b.min < 13 * 60 + 30));
  const fri = p.days["2026-11-06"];
  assert.equal(fri.bars.at(-1).time, "14:20"); // 14:25 belum selesai menurut regularMarketTime
  assert.ok(fullSessions(p, "2026-11-06").length >= 55);
});

test("ORB: EMAS trigger 09:30, BBRI masih menunggu", () => {
  const now = AT("2026-11-05T04:00:00Z");
  const em = parseChart(fx("EMAS.JK.json"), IDX, now);
  const e = evaluateEntry(em, IDX, "2026-11-05", { orMinutes: 15 });
  assert.equal(e.status, "triggered");
  assert.equal(e.time, "09:30");
  assert.equal(e.entry, 5825);
  assert.equal(e.or.high, 5750);
  const br = parseChart(fx("BBRI.JK.json"), IDX, now);
  assert.equal(evaluateEntry(br, IDX, "2026-11-05", { orMinutes: 15 }).status, "waiting");
});

test("rencana exit: stop/target ke fraksi, R bersih fee, tolak stop terlalu dekat", () => {
  const plan = planExit({ market: IDX, date: "2026-11-05", entry: 5825, or: { high: 5750, low: 5500 }, stopRule: "or_mid", targetRule: "2R", prevClose: 5300 });
  assert.equal(plan.stop, 5625);
  assert.equal(plan.target, 6225);
  assert.ok(plan.rNet < plan.rGross);
  assert.throws(() => planExit({ market: IDX, date: "2026-11-05", entry: 2730, or: { high: 2730, low: 2725 }, prevClose: 2700 }), /terlalu dekat/);
  const capped = planExit({ market: IDX, date: "2026-11-05", entry: 1000, or: { high: 1000, low: 700 }, stopRule: "or_low", targetRule: "2R", prevClose: 1000 });
  assert.equal(capped.stop, 930); // dinaikkan ke ARB
  assert.ok(capped.warnings.length);
});

test("sizing dalam lot & risk gate", () => {
  const plan = planExit({ market: IDX, date: "2026-11-05", entry: 5825, or: { high: 5750, low: 5500 }, prevClose: 5300 });
  const acc = { equity: 10_000_000, cash: 10_000_000, maxLossPerTrade: 100_000, maxPositionPct: 50, cashBufferPct: 10 };
  const o = sizeOrder({ market: IDX, symbol: "EMAS", plan, account: acc });
  assert.equal(o.units, 4);
  assert.equal(o.shares, 400);
  assert.ok(o.maxLoss <= 100_000);
  const tight = sizeOrder({ market: IDX, symbol: "EMAS", plan, account: { ...acc, maxLossPerTrade: 20_000 } });
  assert.equal(tight.ok, false);
  const settings = { ...acc, dailyLossLimit: 300_000, maxTradesPerDay: 3, minRR: 1.2, blocked: [] };
  const clock = marketClock(IDX, AT("2026-11-05T02:35:00Z"));
  const ok = riskCheck({ market: IDX, order: o, plan, settings, today: {}, clock, flatMin: flatMinute(IDX, "2026-11-05", "sesi1") });
  assert.equal(ok.pass, true);
  const lost = riskCheck({ market: IDX, order: o, plan, settings, today: { realized: -250_000 }, clock, flatMin: 715 });
  assert.equal(lost.pass, false);
  const late = riskCheck({ market: IDX, order: o, plan, settings, today: {}, clock: marketClock(IDX, AT("2026-11-05T04:45:00Z")), flatMin: 715 });
  assert.equal(late.pass, false);
});

test("Time Machine deterministik & masuk akal", () => {
  const now = AT("2026-11-05T03:00:00Z");
  const p = parseChart(fx("EMAS.JK.json"), IDX, now);
  const plan = planExit({ market: IDX, date: "2026-11-05", entry: 5825, or: { high: 5750, low: 5500 }, prevClose: prevCloseOf(p, "2026-11-05") });
  const args = { market: IDX, date: "2026-11-05", parsed: p, plan, fromMin: 9 * 60 + 25, flatMin: 715, prevClose: prevCloseOf(p, "2026-11-05"), replays: 3000 };
  const a = timeMachine(args), b = timeMachine(args);
  assert.deepEqual(a, b);
  assert.ok(Math.abs(a.pTarget + a.pStop + a.pNeither - 1) < 1e-9);
  assert.ok(a.sessions >= 50);
  const h = historyReplay({ market: IDX, parsed: p, date: "2026-11-05" });
  assert.equal(h.triggered, h.target + h.stop + h.close);
});

test("evaluasi trade paper dari bar", () => {
  const p = parseChart(fx("EMAS.JK.json"), IDX, AT("2026-11-06T07:38:00Z"));
  const r = evaluateTrade({ market: IDX, parsed: p, trade: { date: "2026-11-05", entryMin: 9 * 60 + 25, flatMin: 715, entry: 5825, stop: 5625, target: 6225, shares: 400, maxLoss: 89_120 } });
  assert.equal(r.status, "closed");
  assert.ok(["stop", "target", "flat"].includes(r.outcome));
});

test("US: TSLA ORB 4 Nov 2026", () => {
  const p = parseChart(fx("TSLA.json"), US, AT("2026-11-04T15:30:00Z"));
  const e = evaluateEntry(p, US, "2026-11-04", { orMinutes: 15 });
  assert.equal(e.status, "triggered");
  assert.equal(e.time, "09:55");
});

test("filter terlalu jauh: DEFI 6 Nov loncat 13% di atas OR high → tidak dikejar", () => {
  const p = parseChart(fx("DEFI.JK.json"), IDX, AT("2026-11-06T03:00:00Z"));
  const e = evaluateEntry(p, IDX, "2026-11-06", { orMinutes: 15 });
  assert.equal(e.status, "extended");
  assert.equal(e.time, "09:20");
  assert.equal(e.entry, 76);
  assert.equal(e.maxPrice, 71);                                   // 67 + 1 × (67 − 63)
  const off = evaluateEntry(p, IDX, "2026-11-06", { orMinutes: 15, maxExtension: 0 });
  assert.equal(off.status, "triggered");
});

test("breakout di luar jendela dicatat sebagai info: BBRI 6 Nov jual siang", () => {
  const p = parseChart(fx("BBRI.JK.json"), IDX, AT("2026-11-06T07:38:00Z"));
  const e = evaluateEntry(p, IDX, "2026-11-06", { orMinutes: 15, flat: "sesi1" });
  assert.equal(e.status, "expired");
  assert.deepEqual(e.lateBreak, { time: "14:05", price: 2730 });
  assert.match(e.note, /di luar jendela/);
  const s2 = evaluateEntry(p, IDX, "2026-11-06", { orMinutes: 15, flat: "close" });
  assert.equal(s2.status, "triggered");
  assert.equal(s2.time, "14:05");
});

test("riwayat memakai filter yang sama", () => {
  const p = parseChart(fx("EMAS.JK.json"), IDX, AT("2026-11-05T03:00:00Z"));
  const on = historyReplay({ market: IDX, parsed: p, date: "2026-11-05" });
  const off = historyReplay({ market: IDX, parsed: p, date: "2026-11-05", maxExtension: 0 });
  assert.equal(on.triggered + on.skippedExtended, off.triggered + off.skippedExtended);
  assert.equal(off.skippedExtended, 0);
});
