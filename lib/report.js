// Rapor kelayakan untuk trade otomatis (forward test). Dipakai app & runner (ringkasan Telegram).

const exitKey = (t) => `${t.result?.exitDate || t.flatDate || t.date} ${t.result?.time || ""} ${t.createdAt || ""}`;

export function report(trades) {
  const closed = trades.filter(t => t.result?.status === "closed").sort((a, b) => (exitKey(a) < exitKey(b) ? -1 : 1));
  const rs = closed.map(t => Number(t.result.R) || 0);
  const n = rs.length;
  const sum = rs.reduce((a, x) => a + x, 0);
  const win = rs.filter(x => x > 0), loss = rs.filter(x => x <= 0);
  const grossWin = win.reduce((a, x) => a + x, 0), grossLoss = -loss.reduce((a, x) => a + x, 0);
  let cum = 0, peak = 0, maxDD = 0;
  const curve = closed.map((t, i) => {
    cum += rs[i]; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
    return { date: t.result.exitDate || t.date, symbol: t.symbol, R: rs[i], cumR: cum };
  });
  const half = Math.floor(n / 2);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    n, wins: win.length, winRate: n ? win.length / n : null, avgR: n ? sum / n : null, totalR: sum,
    totalPnl: closed.reduce((a, t) => a + (t.result.pnl || 0), 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    maxDD, curve, firstHalfAvg: avg(rs.slice(0, half)), secondHalfAvg: avg(rs.slice(half)), last20Avg: avg(rs.slice(-20)),
    open: trades.filter(t => t.result?.status !== "closed").length,
  };
}

// Kriteria "lulus" ditetapkan SEBELUM forward test dimulai, supaya tidak digeser setelah melihat hasil.
export const CRITERIA = [
  { id: "n", label: "Minimal 60 trade otomatis", ok: (r) => r.n >= 60, val: (r) => `${r.n}/60` },
  { id: "avg", label: "Rata-rata R ≥ +0,10 setelah fee", ok: (r) => r.avgR != null && r.avgR >= 0.1, val: (r) => (r.avgR == null ? "-" : fmtR(r.avgR)) },
  { id: "pf", label: "Profit factor ≥ 1,2", ok: (r) => r.profitFactor != null && r.profitFactor >= 1.2, val: (r) => (r.profitFactor == null ? "-" : r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2)) },
  { id: "dd", label: "Drawdown terdalam ≤ 10R", ok: (r) => r.n > 0 && r.maxDD <= 10, val: (r) => `-${r.maxDD.toFixed(1)}R` },
  { id: "half", label: "Paruh awal & paruh akhir sama-sama positif", ok: (r) => r.n >= 20 && r.firstHalfAvg > 0 && r.secondHalfAvg > 0,
    val: (r) => (r.n >= 20 ? `${fmtR(r.firstHalfAvg)} / ${fmtR(r.secondHalfAvg)}` : "butuh ≥20 trade") },
];
export const verdictOf = (r) => (CRITERIA.every(c => c.ok(r)) ? "LULUS" : "BELUM");
export function fmtR(x) { return `${x > 0 ? "+" : ""}${x.toFixed(2)}R`; }
