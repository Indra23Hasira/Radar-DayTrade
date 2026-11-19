// Saldo berjalan (paper): modal awal + untung/rugi trade OTOMATIS yang sudah selesai.
// Kalau aktif, runner menghitung ukuran posisi dari saldo ini — seperti akun sungguhan: setelah kena SL
// modal berkurang, trade berikutnya ikut mengecil (batas rugi per trade & harian diskalakan sebanding).
export const balanceOn = (S) => !(S.compound === false || S.compound === "false");

export function paperBalance(S, trades) {
  const start = +S.equity || 0;
  const from = String(S.balanceFrom || "").trim();
  const closed = (trades || []).filter(t => t.auto && !t.replay && t.result?.status === "closed" && (!from || (t.result.exitDate || t.date) >= from));
  const realized = closed.reduce((a, t) => a + (Number(t.result.pnl) || 0), 0);
  return { on: balanceOn(S), start, realized, balance: start + realized, n: closed.length, pct: start ? realized / start : 0, from };
}

// Pengaturan efektif untuk sizing & risk check. Rasio yang Anda pilih (mis. rugi per trade 1% modal,
// harian 3%) dipertahankan terhadap saldo saat ini.
export function effectiveSettings(S, trades, round = (x) => x) {
  const b = paperBalance(S, trades);
  if (!b.on || !(b.start > 0)) return { S: { ...S }, b, factor: 1 };
  const factor = Math.max(0, b.balance) / b.start;
  return {
    b, factor,
    S: {
      ...S,
      equity: round(Math.max(0, b.balance)),
      cash: round(Math.max(0, (+S.cash || b.start) + b.realized)),
      maxLossPerTrade: round((+S.maxLossPerTrade || 0) * factor),
      dailyLossLimit: round((+S.dailyLossLimit || 0) * factor),
    },
  };
}
