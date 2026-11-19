// Saldo berjalan: modal awal ± hasil trade otomatis, batas rugi ikut diskalakan.
import test from "node:test";
import assert from "node:assert/strict";
import { paperBalance, effectiveSettings } from "../lib/balance.js";

const T = (pnl, date = "2026-11-12", extra = {}) => ({ auto: true, date, result: { status: "closed", pnl, R: pnl < 0 ? -1 : 2 }, ...extra });
const S = { equity: 20_000_000, cash: 20_000_000, maxLossPerTrade: 200_000, dailyLossLimit: 600_000 };

test("saldo turun setelah SL, ukuran trade berikutnya ikut mengecil", () => {
  const trades = [T(-200_000), T(-200_000), T(-200_000), T(400_000, "2026-11-13"), { auto: true, result: { status: "open" } }, T(-999, "2026-11-13", { replay: true }), { ...T(-5000), auto: false }];
  const b = paperBalance(S, trades);
  assert.equal(b.balance, 19_800_000);
  assert.equal(b.n, 4);
  const { S: eff, factor } = effectiveSettings(S, trades, Math.floor);
  assert.equal(factor, 0.99);
  assert.equal(eff.equity, 19_800_000);
  assert.equal(eff.cash, 19_800_000);
  assert.equal(eff.maxLossPerTrade, 198_000);
  assert.equal(eff.dailyLossLimit, 594_000);
});

test("bisa dimatikan, dan dihitung mulai tanggal tertentu", () => {
  const trades = [T(-200_000, "2026-11-10"), T(-200_000, "2026-11-14")];
  assert.equal(effectiveSettings({ ...S, compound: false }, trades).S.maxLossPerTrade, 200_000);
  assert.equal(paperBalance({ ...S, balanceFrom: "2026-11-13" }, trades).balance, 19_800_000);
  // saldo habis → tidak ada ukuran posisi
  assert.equal(effectiveSettings(S, [T(-25_000_000)]).S.maxLossPerTrade, 0);
});
