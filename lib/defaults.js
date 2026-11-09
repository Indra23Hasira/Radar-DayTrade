// Pengaturan bawaan, dipakai bersama oleh app, cli.js dan runner otomatis.
// Nilai yang disimpan user di Firestore (daytradeSettings/{idx|us}) menimpa nilai ini.
export const DEFAULTS = {
  idx: {
    equity: 10000000, cash: 10000000, maxLossPerTrade: 100000, dailyLossLimit: 300000, maxTradesPerDay: 3, minRR: 1.2,
    maxPositionPct: 50, cashBufferPct: 10, orMinutes: 15, maxExtension: 1,
    buyPct: 0.15, sellPct: 0.25, perShare: 0, minOrder: 0, maxPct: 0,
    flat: "sesi1", blocked: "", watchlist: ["BBRI", "BBCA", "TPIA", "EMAS", "ADRO"],
    // mode otomatis (runner GitHub Actions)
    autoEnabled: true, autoTopN: 40, minAvgValue: 5e9, minPrice: 50, slippage: 1, // slippage IDX = tick
    autoStopRule: "or_mid", autoTargetRule: "2R",
  },
  us: {
    equity: 5000, cash: 5000, maxLossPerTrade: 50, dailyLossLimit: 150, maxTradesPerDay: 3, minRR: 1.2,
    maxPositionPct: 60, cashBufferPct: 10, orMinutes: 15, maxExtension: 1,
    buyPct: 0, sellPct: 0, perShare: 0.005, minOrder: 1, maxPct: 1,
    flat: "next", nextExit: "23:30", blocked: "", watchlist: ["TSLA", "NVDA", "AMD"],
    autoEnabled: true, autoTopN: 40, minAvgValue: 0, minPrice: 5, slippage: 0.05, // slippage US = %
    autoStopRule: "or_mid", autoTargetRule: "2R",
  },
};

export const feesFrom = (s) => ({
  buyPct: +s.buyPct || 0, sellPct: +s.sellPct || 0, perShare: +s.perShare || 0, minOrder: +s.minOrder || 0, maxPct: +s.maxPct || 0,
});
