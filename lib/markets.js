// Aturan pasar untuk Radar-DayTrade. Satu objek per pasar; engine.js tidak tahu
// apa-apa soal IDX atau US selain lewat file ini.
//
// Semua waktu dalam MENIT sejak tengah malam waktu lokal bursa.
// Sesi = daftar segmen perdagangan kontinu [mulai, selesai) — bar 5 menit yang
// mulai di [mulai, selesai-5] dianggap bar sesi.

import { localParts, localToSec, parseHHMM, addDays } from "./time.js";

// ------------------------------------------------------------------ IDX

// Libur bursa BEI. 2026 dari kalender resmi BEI; 2027 dari kalender yang beredar
// (cek ulang begitu BEI menerbitkan versi final).
const IDX_HOLIDAYS = {
  "2026-01-01": "Tahun Baru", "2026-01-16": "Isra Mikraj", "2026-02-16": "Cuti bersama Imlek",
  "2026-02-17": "Imlek", "2026-03-18": "Cuti bersama Nyepi", "2026-03-19": "Nyepi",
  "2026-03-20": "Cuti bersama Idul Fitri", "2026-03-23": "Cuti bersama Idul Fitri",
  "2026-03-24": "Cuti bersama Idul Fitri", "2026-04-03": "Wafat Yesus Kristus", "2026-05-01": "Hari Buruh",
  "2026-05-14": "Kenaikan Yesus Kristus", "2026-05-15": "Cuti bersama", "2026-05-27": "Idul Adha",
  "2026-05-28": "Cuti bersama", "2026-06-01": "Hari Lahir Pancasila", "2026-06-16": "Tahun Baru Islam",
  "2026-08-17": "Kemerdekaan RI", "2026-08-25": "Maulid Nabi", "2026-12-24": "Cuti bersama Natal",
  "2026-12-25": "Natal", "2026-12-31": "Libur bursa akhir tahun",
  "2027-01-01": "Tahun Baru", "2027-01-05": "Isra Mikraj", "2027-02-05": "Cuti bersama Imlek",
  "2027-03-08": "Nyepi", "2027-03-09": "Cuti bersama", "2027-03-10": "Idul Fitri", "2027-03-11": "Idul Fitri",
  "2027-03-12": "Cuti bersama", "2027-03-15": "Cuti bersama", "2027-03-25": "Cuti bersama",
  "2027-03-26": "Wafat Yesus Kristus", "2027-05-06": "Kenaikan Yesus Kristus", "2027-05-17": "Idul Adha",
  "2027-05-18": "Cuti bersama", "2027-05-19": "Cuti bersama", "2027-05-20": "Waisak",
  "2027-06-01": "Hari Lahir Pancasila", "2027-08-17": "Kemerdekaan RI", "2027-12-24": "Cuti bersama Natal",
  "2027-12-31": "Libur bursa akhir tahun",
};

// Fraksi harga BEI (pasar reguler).
function idxTick(price) {
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

// Batas auto rejection. Aturan berubah per tanggal, jadi disimpan sebagai tabel berlaku.
// - s.d. 18 Okt 2026: ARB simetris 15%.
// - 19 Okt – 31 Des 2026: ARB 7% (Kep-00158/BEI/10-2026), harga Rp11–14 ARB Rp1 mulai 20 Okt.
// - mulai 1 Jan 2027: RENCANA ARB = ARA per kelompok harga (bisa berubah setelah evaluasi BEI).
const IDX_LIMIT_RULES = [
  { from: "0000-01-01", label: "ARB 15%", arb: () => 0.15 },
  { from: "2026-10-19", label: "ARB 7% (sementara s.d. 31 Des 2026)", arb: (p, d) => (d >= "2026-10-20" && p <= 14 ? "rp1" : 0.07) },
  { from: "2027-01-01", label: "ARB simetris (rencana BEI 2027, cek ulang)", arb: (p) => araPct(p) },
];
function araPct(p) {
  if (p <= 200) return 0.35;
  if (p <= 5000) return 0.25;
  return 0.20;
}
function idxLimits(prevClose, date) {
  if (!(prevClose > 0)) return null;
  const rule = IDX_LIMIT_RULES.filter(r => date >= r.from).pop();
  let ara, arb;
  if (prevClose <= 10) {
    ara = prevClose + 1; arb = Math.max(1, prevClose - 1);
  } else {
    const ap = araPct(prevClose);
    ara = floorTick(prevClose * (1 + ap), idxTick);
    const b = rule.arb(prevClose, date);
    arb = b === "rp1" ? prevClose - 1 : ceilTick(prevClose * (1 - b), idxTick);
  }
  return { ara, arb, rule: rule.label };
}

// ------------------------------------------------------------------ US (NYSE)

const NYSE_HOLIDAYS = {
  "2026-01-01": "New Year's Day", "2026-01-19": "Martin Luther King Jr. Day", "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday", "2026-05-25": "Memorial Day", "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed)", "2026-09-07": "Labor Day", "2026-11-26": "Thanksgiving",
  "2026-12-25": "Christmas", "2027-01-01": "New Year's Day", "2027-01-18": "Martin Luther King Jr. Day",
  "2027-02-15": "Washington's Birthday", "2027-03-26": "Good Friday", "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth (observed)", "2027-07-05": "Independence Day (observed)", "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving", "2027-12-24": "Christmas (observed)",
};
const NYSE_EARLY_CLOSE = { "2026-11-27": 1, "2026-12-24": 1, "2027-11-26": 1 };

// ------------------------------------------------------------------ helpers

export function floorTick(x, tickFn) {
  const t = tickFn(x);
  return Math.floor(x / t + 1e-9) * t;
}
export function ceilTick(x, tickFn) {
  const t = tickFn(x);
  return Math.ceil(x / t - 1e-9) * t;
}
function weekday(date) { // 0 = Minggu
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const MARKETS = {
  idx: {
    id: "idx", name: "IDX", tz: "Asia/Jakarta", tzLabel: "WIB", currency: "IDR", lot: 100,
    yahoo: (s) => (s.includes(".") ? s : s.toUpperCase() + ".JK"),
    display: (s) => s.replace(/\.JK$/i, "").toUpperCase(),
    tick: idxTick,
    limits: idxLimits,
    // Fee default (bisa diubah di Pengaturan). PPh final 0,1% jual sudah termasuk di fee jual.
    fees: { buyPct: 0.15, sellPct: 0.25, perShare: 0, minOrder: 0, maxPct: 0 },
    holiday: (d) => IDX_HOLIDAYS[d] || null,
    sessions(date) {
      const wd = weekday(date);
      if (wd === 0 || wd === 6 || IDX_HOLIDAYS[date]) return null;
      return wd === 5
        ? [[9 * 60, 11 * 60 + 30], [14 * 60, 15 * 60 + 50]]
        : [[9 * 60, 12 * 60], [13 * 60 + 30, 15 * 60 + 50]];
    },
    // Pilihan "jual paling lambat": akhir sesi 1 (gaya beli pagi jual siang) atau akhir sesi 2.
    flatPresets: [
      { id: "sesi1", label: "Akhir sesi 1 (jual siang)", seg: 0 },
      { id: "close", label: "Akhir sesi 2", seg: 1 },
    ],
    defaultFlat: "sesi1",
    money: (x) => (x < 0 ? "−" : "") + "Rp" + Math.abs(Math.round(x)).toLocaleString("id-ID"),
    price: (x) => Math.round(x).toLocaleString("id-ID"),
    unitLabel: "lot",
  },
  us: {
    id: "us", name: "US", tz: "America/New_York", tzLabel: "ET", currency: "USD", lot: 1,
    yahoo: (s) => s.toUpperCase(),
    display: (s) => s.toUpperCase(),
    tick: () => 0.01,
    limits: () => null,
    // IBKR Pro Fixed: $0,005/lembar, min $1/order, maks 1% nilai transaksi
    fees: { buyPct: 0, sellPct: 0, perShare: 0.005, minOrder: 1, maxPct: 1 },
    holiday: (d) => NYSE_HOLIDAYS[d] || null,
    sessions(date) {
      const wd = weekday(date);
      if (wd === 0 || wd === 6 || NYSE_HOLIDAYS[date]) return null;
      return [[9 * 60 + 30, NYSE_EARLY_CLOSE[date] ? 13 * 60 : 16 * 60]];
    },
    flatPresets: [
      { id: "next", label: "Jual besok (maks jam WIB di Pengaturan)", overnight: true, exitAt: "23:30", exitTz: "Asia/Jakarta" },
      { id: "close", label: "Jual hari ini (5 mnt sebelum tutup)", seg: 0 },
    ],
    defaultFlat: "next",
    money: (x) => (x < 0 ? "−" : "") + "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    price: (x) => x.toFixed(2),
    unitLabel: "lembar",
  },
};

// Bar 5 menit yang ada di hari itu: [{min, seg, first, last}]
export function slotsFor(market, date, interval = 5) {
  const ss = market.sessions(date);
  if (!ss) return [];
  const out = [];
  ss.forEach(([a, b], seg) => {
    for (let m = a; m + interval <= b; m += interval) out.push({ min: m, seg, first: m === a, last: m + interval >= b });
  });
  return out;
}

// Menit bar terakhir yang masih boleh dipegang untuk preset "flat".
export function flatMinute(market, date, presetId) {
  const ss = market.sessions(date);
  if (!ss) return null;
  const p = market.flatPresets.find(x => x.id === presetId) || market.flatPresets[0];
  const seg = ss[Math.min(p.seg ?? ss.length - 1, ss.length - 1)];
  // US: tutup 5 menit sebelum close; IDX: bar terakhir sesi (sebelum pra-penutupan)
  return market.id === "us" ? seg[1] - 10 : seg[1] - 5;
}

// Biaya satu order (mata uang pasar). f = {buyPct, sellPct, perShare, minOrder, maxPct}.
// IBKR Fixed: perShare × lembar, minimal minOrder, tapi tidak lebih dari maxPct% nilai transaksi.
export function orderFee(f, price, shares, side) {
  if (!(shares > 0)) return 0;
  const value = price * shares;
  let fee = value * (side === "buy" ? (f.buyPct || 0) : (f.sellPct || 0)) / 100;
  if (f.perShare > 0) {
    let c = f.perShare * shares;
    if (f.minOrder > 0) c = Math.max(c, f.minOrder);
    if (f.maxPct > 0) c = Math.min(c, value * f.maxPct / 100);
    fee += c;
  }
  return fee;
}

export function nextTradingDate(market, date) {
  for (let i = 1; i <= 10; i++) {
    const d = addDays(date, i);
    if (market.sessions(d)) return d;
  }
  return null;
}

export const presetOf = (market, id) => market.flatPresets.find(x => x.id === id) || market.flatPresets[0];

// Jendela trade untuk preset: {overnight, lastEntryMin, flatDate, flatMin, exitLabel}
// - intraday: jual di hari yang sama (flatMinute), entry paling lambat 30 menit sebelumnya
// - overnight: beli s.d. jam `exitAt` (zona exitTz) hari ini, jual paling lambat jam yang sama
//   di hari bursa berikutnya. Menit = awal bar 5 menit terakhir yang masih dipegang.
export function exitWindow(market, date, presetId, exitAt) {
  const ss = market.sessions(date);
  if (!ss) return null;
  const p = presetOf(market, presetId);
  if (!p.overnight) {
    const fm = flatMinute(market, date, p.id);
    return { overnight: false, preset: p, lastEntryMin: fm - 30, flatDate: date, flatMin: fm };
  }
  const at = parseHHMM(exitAt || p.exitAt);
  const toMarketMin = (d) => {
    const lp = localParts(localToSec(d, at, p.exitTz), market.tz);
    return lp.date === d ? lp.min : null;
  };
  const end1 = ss[ss.length - 1][1];
  let le = toMarketMin(date);
  le = le == null ? end1 - 20 : Math.floor(le / 5) * 5 - 5;
  le = Math.min(le, end1 - 20);
  const day2 = nextTradingDate(market, date);
  const ss2 = market.sessions(day2);
  const end2 = ss2[ss2.length - 1][1];
  let fm = toMarketMin(day2);
  fm = fm == null ? end2 - 10 : Math.floor(fm / 5) * 5 - 5;
  fm = Math.max(ss2[0][0], Math.min(fm, end2 - 10));
  return { overnight: true, preset: p, lastEntryMin: le, flatDate: day2, flatMin: fm, exitAt: exitAt || p.exitAt, exitTz: p.exitTz };
}
