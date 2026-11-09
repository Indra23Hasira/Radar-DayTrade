// Mesin Radar-DayTrade: dipakai app (browser) dan cli.js (Node / skill Claude Code).
// Logika diadaptasi dari paket day-trader-skill (MIT, Jake Schincariol):
// opening-range breakout, rencana stop/target, Time Machine, sizing, dan risk gate,
// ditambah aturan pasar IDX (lot, fraksi, ARA/ARB, jeda siang, fee) dan mode "jual besok"
// (overnight: gap semalam disimulasikan dari riwayat saham itu sendiri).
import { slotsFor, floorTick, ceilTick, orderFee, exitWindow, nextTradingDate } from "./markets.js";
import { localParts, localToSec, hhmm, parseHHMM, dayLabel } from "./time.js";

export { localParts, localToSec, hhmm, parseHHMM, dayLabel };
const INTERVAL = 5;

// ------------------------------------------------------------------ waktu

// Status bursa sekarang: {state, label, date, min}
export function marketClock(market, nowSec) {
  const { date, min } = localParts(nowSec, market.tz);
  const ss = market.sessions(date);
  if (!ss) {
    const h = market.holiday(date);
    return { state: "closed", label: h ? `Libur: ${h}` : "Akhir pekan", date, min };
  }
  for (let i = 0; i < ss.length; i++) {
    const [a, b] = ss[i];
    if (min < a) return { state: i === 0 ? "pre" : "break", label: i === 0 ? `Belum buka (buka ${hhmm(a)})` : `Istirahat (sesi ${i + 1} ${hhmm(a)})`, date, min };
    if (min < b) return { state: "open", label: ss.length > 1 ? `Sesi ${i + 1} berjalan (s.d. ${hhmm(b)})` : `Bursa buka (s.d. ${hhmm(b)})`, date, min };
  }
  return { state: "closed", label: "Bursa sudah tutup", date, min };
}

// Jam bursa -> jam WIB (untuk tampilan pasar US)
export function toWIB(market, date, min) {
  if (market.tz === "Asia/Jakarta") return { date, min };
  return localParts(localToSec(date, min, market.tz), "Asia/Jakarta");
}

// ------------------------------------------------------------------ data Yahoo

export function chartUrl(market, symbol, range = "60d", interval = "5m") {
  return `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(market.yahoo(symbol))}?range=${range}&interval=${interval}&includePrePost=false`;
}

// JSON chart Yahoo -> { meta, days: {date: {bars:[...], close}}, dates:[...] }
// bars = bar sesi kontinu yang SUDAH selesai, urut waktu, bar kosong di tengah sesi diisi
// bar datar (harga close sebelumnya, volume 0) supaya saham kurang likuid tetap bisa dipakai.
export function parseChart(json, market, nowSec) {
  const res = json?.chart?.result?.[0];
  if (!res) throw new Error(json?.chart?.error?.description || "Data chart kosong");
  const meta = res.meta || {};
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  let asOf = nowSec;
  if (typeof meta.regularMarketTime === "number" && meta.regularMarketTime < asOf) asOf = meta.regularMarketTime;
  const raw = {};
  const lastClose = {};
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (ts[i] == null || o == null || h == null || l == null || c == null) continue;
    if (ts[i] > asOf) continue;
    const { date, min } = localParts(ts[i], market.tz);
    lastClose[date] = c; // termasuk bar pra-penutupan: harga penutupan resmi
    if (ts[i] % (INTERVAL * 60)) continue;
    if (ts[i] + INTERVAL * 60 > asOf) continue;
    (raw[date] ||= {})[min] = { t: ts[i], o, h, l, c, v: q.volume?.[i] || 0 };
  }
  const days = {};
  for (const date of Object.keys(raw).sort()) {
    const slots = slotsFor(market, date);
    if (!slots.length) continue;
    const got = raw[date];
    const bars = [];
    let prev = null, filled = 0, lastIdx = -1;
    slots.forEach((s, i) => { if (got[s.min]) lastIdx = i; });
    for (let i = 0; i <= lastIdx; i++) {
      const s = slots[i];
      let b = got[s.min];
      if (!b) {
        if (!prev) continue;
        b = { o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0, filled: true };
        filled++;
      }
      bars.push({ ...b, min: s.min, time: hhmm(s.min), seg: s.seg, first: s.first, last: s.last });
      prev = b;
    }
    if (bars.length) days[date] = { bars, close: lastClose[date], filled, full: lastIdx === slots.length - 1, slots: slots.length };
  }
  return { meta, days, dates: Object.keys(days).sort() };
}

const isFull = (parsed, d) => { const x = parsed.days[d]; return x && x.full && x.filled <= x.slots * 0.15; };

// Sesi lengkap sebelum `date` (bar terisi ≥ 85% asli), terlama dulu.
export function fullSessions(parsed, date) {
  return parsed.dates.filter(d => d < date && isFull(parsed, d)).map(d => ({ date: d, bars: parsed.days[d].bars }));
}
export function prevCloseOf(parsed, date) {
  const ds = parsed.dates.filter(d => d < date);
  return ds.length ? parsed.days[ds[ds.length - 1]].close : null;
}

// Pasangan hari bursa berurutan yang dua-duanya lengkap: dipakai untuk gap semalam.
function gapPairs(parsed, market, beforeDate) {
  const out = [];
  for (const d of parsed.dates) {
    if (d >= beforeDate || !isFull(parsed, d)) continue;
    const d2 = nextTradingDate(market, d);
    if (d2 && d2 < beforeDate && isFull(parsed, d2)) out.push([d, d2]);
  }
  return out.slice(-59);
}
// Statistik gap pembukaan (open hari berikut / close terakhir) 60 hari terakhir.
export function gapStats(parsed, market, beforeDate) {
  const r = gapPairs(parsed, market, beforeDate).map(([a, b]) => parsed.days[b].bars[0].o / parsed.days[a].bars.at(-1).c);
  if (!r.length) return null;
  const s = [...r].sort((x, y) => x - y);
  return { n: r.length, worst: s[0], best: s.at(-1), p5: s[Math.floor(0.05 * s.length)], avgAbs: r.reduce((a, x) => a + Math.abs(x - 1), 0) / r.length };
}

// ------------------------------------------------------------------ entry (ORB)

export function openingRange(bars, orMinutes) {
  if (!bars.length) return null;
  const start = bars[0].min;
  const rows = bars.filter(b => b.seg === bars[0].seg && b.min < start + orMinutes);
  if (rows.length < orMinutes / INTERVAL) return null;
  return { high: Math.max(...rows.map(b => b.h)), low: Math.min(...rows.map(b => b.l)), until: hhmm(start + orMinutes), n: rows.length };
}

// Batas "terlalu jauh": breakout yang closenya sudah lebih dari maxExtension × lebar opening
// range di atas level tidak dikejar (hari itu dilewati). 0 = filter mati.
export function chaseLimit(market, or, level, maxExtension) {
  if (!(maxExtension > 0) || !or) return null;
  const width = Math.max(or.high - or.low, 2 * market.tick(or.high));
  return level + maxExtension * width;
}

// Status entry hari `date`.
// opts: {setup:'orb'|'level', level, orMinutes, minVolumeX, lastEntryMin, flat, exitAt, maxExtension (default 1)}
// status: closed | waiting_or | waiting | triggered | extended | expired
export function evaluateEntry(parsed, market, date, opts = {}) {
  const orMinutes = opts.orMinutes || 15;
  const slots = slotsFor(market, date);
  if (!slots.length) return { status: "closed", note: market.holiday(date) || "Bukan hari bursa" };
  const day = parsed.days[date];
  const bars = day?.bars || [];
  const or = openingRange(bars, orMinutes);
  if (!or) return { status: "waiting_or", note: `Menunggu opening range ${orMinutes} menit pertama selesai`, bars: bars.length };
  const trigLevel = opts.setup === "level" ? Number(opts.level) : or.high;
  if (!(trigLevel > 0)) throw new Error("Level breakout belum diisi");
  const lastEntryMin = opts.lastEntryMin ?? exitWindow(market, date, opts.flat || market.defaultFlat, opts.exitAt).lastEntryMin;
  let volAvg = null;
  if (opts.minVolumeX) {
    volAvg = {};
    const hist = fullSessions(parsed, date).slice(-20);
    for (const s of hist) for (const b of s.bars) { (volAvg[b.min] ||= []).push(b.v); }
    for (const k in volAvg) volAvg[k] = volAvg[k].reduce((a, x) => a + x, 0) / volAvg[k].length;
  }
  const maxExt = opts.maxExtension ?? 1;
  const maxPrice = chaseLimit(market, or, trigLevel, maxExt);
  const startIdx = bars.findIndex(b => b.min >= bars[0].min + orMinutes);
  const last = bars[bars.length - 1];
  const P = market.price;
  for (let i = Math.max(startIdx, 0); startIdx >= 0 && i < bars.length; i++) {
    const b = bars[i];
    if (b.min > lastEntryMin) break;
    if (b.c > trigLevel) {
      if (opts.minVolumeX && volAvg?.[b.min] && b.v < opts.minVolumeX * volAvg[b.min]) continue;
      const base = { or, level: trigLevel, entry: b.c, time: hhmm(b.min + INTERVAL), barMin: b.min, idx: i, maxPrice, last: last?.c, lastEntry: hhmm(lastEntryMin + INTERVAL) };
      if (maxPrice != null && b.c > maxPrice) {
        return {
          ...base, status: "extended",
          note: `Breakout ${base.time} close ${P(b.c)} sudah +${((b.c / trigLevel - 1) * 100).toFixed(1)}% di atas ${P(trigLevel)} (maks ${P(maxPrice)}) — tidak dikejar`,
        };
      }
      return { ...base, status: "triggered", note: `Bar ${b.time} close ${P(b.c)} di atas ${P(trigLevel)}` };
    }
  }
  const expired = last && last.min >= lastEntryMin;
  let lateBreak = null;
  if (expired) {
    const lb = bars.find(b => b.min > lastEntryMin && b.c > trigLevel);
    if (lb) lateBreak = { time: hhmm(lb.min + INTERVAL), price: lb.c };
  }
  const le = hhmm(lastEntryMin + INTERVAL);
  return {
    status: expired ? "expired" : "waiting", or, level: trigLevel, last: last?.c, lastTime: last ? hhmm(last.min + INTERVAL) : null,
    gapPct: last ? (trigLevel / last.c - 1) * 100 : null, lastEntry: le, maxPrice, lateBreak,
    note: !expired ? `Butuh close di atas ${P(trigLevel)}`
      : lateBreak ? `Breakout ${lateBreak.time} di ${P(lateBreak.price)} — di luar jendela entry (batas ${le})`
      : `Tidak ada breakout sampai batas entry ${le}`,
  };
}

// ------------------------------------------------------------------ biaya & R

const feesOf = (market, fees) => ({ ...market.fees, ...(fees || {}) });
// biaya pulang-pergi per lembar untuk `shares` lembar
export function roundTripFeePerShare(market, fees, entry, exit, shares) {
  const f = feesOf(market, fees);
  return (orderFee(f, entry, shares, "buy") + orderFee(f, exit, shares, "sell")) / shares;
}
// R hasil keluar di harga `exit` (bersih fee), relatif ke rugi bersih di stop
function rOf(market, fees, entry, stop, exit, shares) {
  const lossAtStop = entry - stop + roundTripFeePerShare(market, fees, entry, stop, shares);
  return (exit - entry - roundTripFeePerShare(market, fees, entry, exit, shares)) / lossAtStop;
}

// ------------------------------------------------------------------ exit plan

// stopRule: 'or_mid' | 'or_low' | 'pct:1.5' | 'price:2700'; targetRule: '2R' | '1.5R' | 'price:2800'
// refShares: jumlah lembar acuan untuk menghitung fee per lembar (penting bila ada komisi minimum).
//   Bila kosong, diperkirakan dari maxLossPerTrade (kalau diberikan) atau 1 lot.
export function planExit({ market, date, entry, or, stopRule = "or_mid", targetRule = "2R", prevClose, fees, refShares, maxLossPerTrade }) {
  if (!(entry > 0)) throw new Error("Harga entry belum ada");
  const tick = market.tick;
  let rawStop;
  const [sk, sv] = String(stopRule).split(":");
  if (sk === "or_mid") { if (!or) throw new Error("Stop or_mid butuh opening range"); rawStop = (or.high + or.low) / 2; }
  else if (sk === "or_low") { if (!or) throw new Error("Stop or_low butuh opening range"); rawStop = or.low; }
  else if (sk === "pct") rawStop = entry * (1 - Number(sv) / 100);
  else if (sk === "price") rawStop = Number(sv);
  else throw new Error(`Aturan stop tidak dikenal: ${stopRule}`);
  let stop = market.id === "us" ? Math.floor(rawStop * 100 + 1e-9) / 100 : floorTick(rawStop, tick);
  if (stop >= entry) throw new Error(`Stop (${market.price(stop)}) harus di bawah entry (${market.price(entry)})`);
  const lim = market.limits(prevClose, date);
  const warnings = [];
  if (lim && stop < lim.arb) { warnings.push(`Stop di bawah ARB (${market.price(lim.arb)}), dinaikkan ke ARB`); stop = lim.arb; }
  const risk = entry - stop;
  const minTicks = 2;
  if (risk < minTicks * tick(entry) - 1e-9) throw new Error(`Stop terlalu dekat (${market.price(risk)}, minimal ${minTicks} tick) — mudah kena hanya karena spread`);
  let target;
  const tm = /^([\d.]+)R$/i.exec(targetRule);
  if (tm) target = entry + Number(tm[1]) * risk;
  else if (String(targetRule).startsWith("price:")) target = Number(targetRule.slice(6));
  else throw new Error(`Aturan target tidak dikenal: ${targetRule}`);
  target = market.id === "us" ? Math.round(target * 100) / 100 : ceilTick(target, tick);
  if (target <= entry) throw new Error("Target harus di atas entry");
  if (lim && target > lim.ara) { warnings.push(`Target di atas ARA (${market.price(lim.ara)}), diturunkan ke ARA`); target = lim.ara; }
  let n = refShares;
  if (!(n > 0)) n = maxLossPerTrade > 0 ? Math.max(market.lot, Math.floor(maxLossPerTrade / risk / market.lot) * market.lot) : market.lot;
  const feePerShare = roundTripFeePerShare(market, fees, entry, target, n);
  const feeAtStop = roundTripFeePerShare(market, fees, entry, stop, n);
  const rGross = (target - entry) / risk;
  const rNet = (target - entry - feePerShare) / (risk + feeAtStop);
  return {
    entry, stop, target, risk, rGross: round(rGross, 2), rNet: round(rNet, 2), stopRule, targetRule,
    feePerShare, feeAtStop, refShares: n, limits: lim, warnings,
  };
}

// ------------------------------------------------------------------ jalan bar (dipakai riwayat & jurnal)

// Cek stop/target di satu bar. Kalau harga BUKA sudah lewat stop/target (gap), terisi di harga buka.
// Stop & target di bar yang sama dihitung rugi (konservatif).
function hitBar(b, stop, target) {
  if (b.o <= stop) return { out: "stop", exit: b.o, gap: b.o < stop };
  if (b.o >= target) return { out: "target", exit: b.o, gap: b.o > target };
  if (b.l <= stop) return { out: "stop", exit: stop, gap: false };
  if (b.h >= target) return { out: "target", exit: target, gap: false };
  return null;
}

// Bar yang dipegang: sisa hari entry (setelah bar entry) + (overnight) hari berikut s.d. flatMin.
function heldBars(parsed, trade) {
  const d1 = parsed.days[trade.date];
  if (!d1) return null;
  const flatDate = trade.flatDate || trade.date;
  if (flatDate === trade.date) {
    return { bars: d1.bars.filter(b => b.min > trade.entryMin && b.min <= trade.flatMin).map(b => ({ ...b, date: trade.date })), done: d1.bars.some(b => b.min >= trade.flatMin) };
  }
  const rest1 = d1.bars.filter(b => b.min > trade.entryMin).map(b => ({ ...b, date: trade.date }));
  const d2 = parsed.days[flatDate];
  const day1Done = d1.full || (d2 != null);
  const rest2 = d2 ? d2.bars.filter(b => b.min <= trade.flatMin).map((b, i) => ({ ...b, date: flatDate, gapBar: i === 0 })) : [];
  return { bars: rest1.concat(rest2), done: day1Done && !!d2 && d2.bars.some(b => b.min >= trade.flatMin), day1Done };
}

// ------------------------------------------------------------------ Time Machine

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// kunci pool: bar pertama tiap segmen (sesudah pembukaan/istirahat) punya pola gap sendiri
const poolKey = (b) => (b.first ? `open${b.seg}` : String(b.min));

export function buildPool(sessions) {
  const pool = {};
  for (const s of sessions) {
    for (let i = 1; i < s.bars.length; i++) {
      const pc = s.bars[i - 1].c, b = s.bars[i];
      (pool[poolKey(b)] ||= []).push([b.o / pc, b.h / pc, b.l / pc, b.c / pc]);
    }
  }
  return pool;
}
// bar pembukaan hari berikut relatif ke close bar terakhir hari sebelumnya
function buildGapPool(parsed, market, beforeDate) {
  return gapPairs(parsed, market, beforeDate).map(([a, b]) => {
    const pc = parsed.days[a].bars.at(-1).c, x = parsed.days[b].bars[0];
    return [x.o / pc, x.h / pc, x.l / pc, x.c / pc];
  });
}
function slotKeys(market, date, slots, pool, window) {
  const allMins = slotsFor(market, date).filter(x => !x.first).map(x => x.min);
  return slots.map(s => {
    if (s.first) return [poolKey(s)];
    const j = allMins.indexOf(s.min);
    const ks = [];
    for (let d = -window; d <= window; d++) { const m = allMins[j + d]; if (m != null && pool[m]) ks.push(String(m)); }
    return ks.length ? ks : [String(s.min)];
  });
}

// Replay sisa waktu pegang sebanyak `replays` kali dari pola bar saham itu sendiri.
// fromMin = bar entry (masuk di close-nya). Intraday: sampai flatMin hari itu.
// Overnight (flatDate > date): sisa hari ini → gap semalam (dari riwayat gap saham ini) → hari berikut s.d. flatMin.
export function timeMachine({ market, date, parsed, plan, fromMin, flatMin, flatDate, replays = 10000, seed = 19, window = 2, prevClose, fees }) {
  const sessions = fullSessions(parsed, date).slice(-59);
  if (sessions.length < 10) throw new Error(`Butuh minimal 10 sesi lengkap, baru ada ${sessions.length}`);
  const pool = buildPool(sessions);
  const overnight = !!flatDate && flatDate !== date;
  const s1 = slotsFor(market, date).filter(s => s.min > fromMin && (overnight || s.min <= flatMin));
  const k1 = slotKeys(market, date, s1, pool, window);
  let k2 = [], gapPool = null, s2 = [];
  if (overnight) {
    gapPool = buildGapPool(parsed, market, date);
    if (gapPool.length < 10) throw new Error(`Butuh minimal 10 pasangan hari untuk gap semalam, baru ada ${gapPool.length}`);
    s2 = slotsFor(market, flatDate).filter(s => s.min <= flatMin);
    k2 = slotKeys(market, flatDate, s2.slice(1), pool, window);
  }
  if (!s1.length && !s2.length) throw new Error("Tidak ada bar tersisa antara entry dan batas jual");
  const lim1 = market.limits(prevClose, date);
  const { entry, stop, target } = plan;
  const n0 = plan.refShares || market.lot;
  const R = (exit) => rOf(market, fees, entry, stop, exit, n0);
  const rTarget = R(target);
  const r = rng(seed);
  let nT = 0, nS = 0, nC = 0, nGap = 0, green = 0, sumR = 0;
  const closes = new Float64Array(replays), rs = new Float64Array(replays);
  const step = (p, arr, lim, st) => {
    const [o, h, l, c] = arr;
    let op = p * o, hi = p * h, lo = p * l, cl = p * c;
    if (lim) { op = Math.min(Math.max(op, lim.arb), lim.ara); hi = Math.min(hi, lim.ara); lo = Math.max(lo, lim.arb); cl = Math.min(Math.max(cl, lim.arb), lim.ara); }
    if (!st.out) {
      const hit = hitBar({ o: op, h: Math.max(hi, op), l: Math.min(lo, op), c: cl }, stop, target);
      if (hit) { st.out = hit.out; st.exit = hit.exit; st.gap = hit.gap; }
    }
    return cl;
  };
  for (let n = 0; n < replays; n++) {
    let p = entry;
    const st = { out: null, exit: null, gap: false };
    for (const ks of k1) {
      const arr = pool[ks[Math.floor(r() * ks.length)]];
      if (arr) p = step(p, arr[Math.floor(r() * arr.length)], lim1, st);
    }
    if (overnight) {
      const lim2 = market.limits(p, flatDate);
      p = step(p, gapPool[Math.floor(r() * gapPool.length)], lim2, st);
      for (const ks of k2) {
        const arr = pool[ks[Math.floor(r() * ks.length)]];
        if (arr) p = step(p, arr[Math.floor(r() * arr.length)], lim2, st);
      }
    }
    closes[n] = p;
    let rr;
    if (st.out === "target") { nT++; rr = R(st.exit); }
    else if (st.out === "stop") { nS++; if (st.gap) nGap++; rr = R(st.exit); }
    else { nC++; rr = R(p); }
    rs[n] = rr; sumR += rr; if (rr > 0) green++;
  }
  const sorted = Array.from(closes).sort((a, b) => a - b);
  const pc = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const rSorted = Array.from(rs).sort((a, b) => a - b);
  const mc = {
    replays, seed, window, sessions: sessions.length, barsLeft: s1.length + s2.length, overnight,
    pTarget: nT / replays, pStop: nS / replays, pNeither: nC / replays, pGreen: green / replays, pGapStop: nGap / replays,
    avgR: round(sumR / replays, 3), rTarget: round(rTarget, 2), worstR5: round(rSorted[Math.floor(0.05 * replays)], 2),
    medianClose: pc(0.5), p5Close: pc(0.05), p95Close: pc(0.95),
    from: hhmm(fromMin + INTERVAL), until: (overnight ? `${dayLabel(flatDate)} ` : "") + hhmm(flatMin + INTERVAL),
    gapPairs: gapPool ? gapPool.length : 0,
  };
  mc.verdict = verdict(mc);
  return mc;
}

export function verdict(mc) {
  const { pTarget: pt, pStop: ps } = mc;
  if (pt + ps <= 0) return { tone: "neutral", text: `Tidak ada replay yang menyentuh target atau stop sampai ${mc.until}: harga di jam itu yang menentukan.` };
  const r = mc.rTarget > 0 ? mc.rTarget : 1;
  const share = pt / (pt + ps), even = 1 / (1 + r), d = share - even;
  let head, tone;
  if (Math.abs(d) < 0.05) { head = "Mirip lempar koin"; tone = "neutral"; }
  else if (Math.abs(d) < 0.15) { head = d > 0 ? "Condong ke target" : "Condong ke stop"; tone = d > 0 ? "good" : "bad"; }
  else { head = d > 0 ? "Kuat ke target" : "Kuat ke stop"; tone = d > 0 ? "good" : "bad"; }
  let text = `${head}: target duluan ${pct(pt)} vs stop duluan ${pct(ps)}. Dengan R bersih ${r.toFixed(2)}, impas butuh target duluan ${Math.round(even * 100)}% dari yang kena salah satu; hasilnya ${Math.round(share * 100)}%.`;
  if (mc.pNeither > 0.25) text += ` ${pct(mc.pNeither)} replay tidak kena keduanya — harga saat jual (${mc.until}) yang menentukan.`;
  if (mc.overnight && mc.pGapStop > 0) text += ` ${pct(mc.pGapStop)} replay kena stop karena GAP semalam (terisi di bawah stop); 5% replay terburuk rugi ${mc.worstR5}R atau lebih.`;
  if (Math.abs(d) >= 0.05 && mc.avgR !== 0 && (mc.avgR > 0) !== (d > 0)) text += ` Rata-rata R tetap ${mc.avgR > 0 ? "+" : ""}${mc.avgR}: replay yang tidak kena keduanya menarik ke arah sebaliknya.`;
  return { tone, text };
}

// Aturan yang sama dijalankan di setiap sesi historis yang lengkap.
// Pakai evaluateEntry yang sama dengan scan, jadi filter "terlalu jauh" & jendela entry ikut berlaku.
export function historyReplay({ market, parsed, date, orMinutes = 15, stopRule = "or_mid", targetRule = "2R", flatPreset, exitAt, fees, maxExtension = 1, maxLossPerTrade }) {
  const preset = flatPreset || market.defaultFlat;
  const sessions = fullSessions(parsed, date).slice(-59);
  const trades = [];
  let skipped = 0;
  for (const s of sessions) {
    const w = exitWindow(market, s.date, preset, exitAt);
    if (w.overnight && !(w.flatDate < date && isFull(parsed, w.flatDate))) continue;
    const ev = evaluateEntry(parsed, market, s.date, { orMinutes, lastEntryMin: w.lastEntryMin, maxExtension });
    if (ev.status === "extended") { skipped++; continue; }
    if (ev.status !== "triggered") continue;
    const e = ev.entry;
    let plan;
    try { plan = planExit({ market, date: s.date, entry: e, or: ev.or, stopRule, targetRule, prevClose: prevCloseOf(parsed, s.date), fees, maxLossPerTrade }); }
    catch { continue; }
    const held = heldBars(parsed, { date: s.date, entryMin: ev.barMin, flatDate: w.flatDate, flatMin: w.flatMin });
    let hit = null;
    for (const b of held.bars) { hit = hitBar(b, plan.stop, plan.target); if (hit) break; }
    const exit = hit ? hit.exit : (held.bars.length ? held.bars.at(-1).c : e);
    const R = rOf(market, fees, e, plan.stop, exit, plan.refShares);
    trades.push({ date: s.date, time: ev.time, entry: e, stop: plan.stop, target: plan.target, exit, outcome: hit?.out || "close", gap: !!hit?.gap, R: round(R, 2) });
  }
  const n = trades.length;
  return {
    sessions: sessions.length, triggered: n, skippedExtended: skipped,
    target: trades.filter(t => t.outcome === "target").length,
    stop: trades.filter(t => t.outcome === "stop").length,
    gapStops: trades.filter(t => t.outcome === "stop" && t.gap).length,
    close: trades.filter(t => t.outcome === "close").length,
    green: trades.filter(t => t.R > 0).length,
    avgR: n ? round(trades.reduce((a, t) => a + t.R, 0) / n, 3) : null,
    trades,
  };
}

// ------------------------------------------------------------------ sizing

// account: {equity, cash, maxLossPerTrade, maxPositionPct, cashBufferPct}
// Fee dihitung per order (komisi minimum ikut), jadi jumlah dicari dari atas ke bawah.
export function sizeOrder({ market, symbol, plan, account, fees }) {
  const f = feesOf(market, fees);
  const unit = market.lot;
  const { entry, stop, target } = plan;
  const lossFor = (sh) => sh * (entry - stop) + orderFee(f, entry, sh, "buy") + orderFee(f, stop, sh, "sell");
  const costFor = (sh) => sh * entry + orderFee(f, entry, sh, "buy");
  const usableCash = Math.max(0, (account.cash ?? account.equity) - account.equity * (account.cashBufferPct || 0) / 100);
  const posCap = account.maxPositionPct > 0 ? account.equity * account.maxPositionPct / 100 : Infinity;
  const limits = [
    { id: "maxLoss", label: "batas rugi per trade", ok: (sh) => lossFor(sh) <= account.maxLossPerTrade + 1e-9 },
    { id: "position", label: `maks ${account.maxPositionPct}% modal per posisi`, ok: (sh) => sh * entry <= posCap + 1e-9 },
    { id: "cash", label: "kas tersedia setelah cadangan", ok: (sh) => costFor(sh) <= usableCash + 1e-9 },
  ];
  let units = Math.floor(Math.min(account.maxLossPerTrade / (entry - stop), usableCash / entry, posCap / entry) / unit + 1e-9);
  const firstFail = (sh) => limits.find(l => !l.ok(sh));
  while (units > 0 && firstFail(units * unit)) units--;
  if (units < 1) {
    const why = firstFail(unit);
    return { ok: false, reason: !why ? "Tidak cukup untuk 1 unit"
      : why.id === "maxLoss" ? `Stop terlalu jauh untuk batas rugi ${market.money(account.maxLossPerTrade)}: 1 ${market.unitLabel} saja rugi ${market.money(lossFor(unit))} kalau kena stop (termasuk fee)`
      : `Tidak cukup untuk 1 ${market.unitLabel} (${why.label})`, limits: limits.map(({ id, label }) => ({ id, label })) };
  }
  const shares = units * unit;
  // pembatas: syarat pertama yang gagal bila ditambah 1 unit
  const binding = firstFail((units + 1) * unit);
  const buyFee = orderFee(f, entry, shares, "buy"), sellFeeT = orderFee(f, target, shares, "sell");
  const maxLoss = lossFor(shares);
  return {
    ok: true, symbol: market.display(symbol), side: "buy", units, shares, decidedBy: binding?.label || "batas rugi per trade",
    entry, stop, target, value: shares * entry, maxLoss,
    expectedWin: shares * (target - entry) - buyFee - sellFeeT,
    fees: buyFee + sellFeeT, buyFee,
    rNet: round((shares * (target - entry) - buyFee - sellFeeT) / maxLoss, 2),
  };
}

// ------------------------------------------------------------------ risk gate

// settings: {maxLossPerTrade, dailyLossLimit, maxTradesPerDay, minRR, maxPositionPct, equity, blocked:[]}
// today: {trades, riskUsed, realized}; win: exitWindow(...); extra: {earningsChecked, gap: gapStats}
export function riskCheck({ market, order, plan, settings, today, clock, win, flatMin, now, earningsChecked, gap }) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });
  const w = win || (flatMin != null ? { overnight: false, lastEntryMin: flatMin - 30, flatMin, flatDate: null } : null);
  add(!!order?.ok, "Ukuran order", order?.ok ? `${order.units} ${market.unitLabel}` : order?.reason || "Belum ada order");
  if (order?.ok) {
    const rNet = order.rNet ?? plan.rNet;
    add(order.stop < order.entry, "Stop wajib ada & di bawah entry", market.price(order.stop));
    add(order.maxLoss <= settings.maxLossPerTrade + 1e-6, "Rugi di stop ≤ batas per trade", `${market.money(order.maxLoss)} / ${market.money(settings.maxLossPerTrade)}`);
    const used = (today.riskUsed || 0) + order.maxLoss + Math.max(0, -(today.realized || 0));
    add(used <= settings.dailyLossLimit + 1e-6, "Risiko harian ≤ batas rugi harian", `${market.money(used)} / ${market.money(settings.dailyLossLimit)}${today.realized ? ` (termasuk realisasi ${market.money(today.realized)})` : ""}`);
    add((today.trades || 0) < settings.maxTradesPerDay, "Jumlah trade hari ini", `${today.trades || 0} dari maks ${settings.maxTradesPerDay}`);
    add(rNet >= settings.minRR, "Reward:risk bersih fee", `${rNet} (min ${settings.minRR})`);
    if (settings.maxPositionPct > 0) add(order.value <= settings.equity * settings.maxPositionPct / 100 + 1e-6, "Nilai posisi", `${market.money(order.value)} (maks ${settings.maxPositionPct}% modal)`);
    add(!(settings.blocked || []).map(s => s.toUpperCase()).includes(order.symbol), "Saham tidak di daftar blokir", order.symbol);
    if (plan.limits) add(order.stop >= plan.limits.arb && order.target <= plan.limits.ara, "Stop & target di dalam ARA/ARB", `ARB ${market.price(plan.limits.arb)} · ARA ${market.price(plan.limits.ara)}`);
    if (w?.overnight) {
      add(!!earningsChecked, "Tidak ada laporan keuangan s.d. jual", earningsChecked ? "sudah dicek" : "centang setelah cek jadwal laporan keuangan");
      if (gap) {
        const gapPrice = order.entry * gap.worst;
        const gapLoss = gapPrice < order.stop ? order.shares * (order.entry - gapPrice) + order.fees : order.maxLoss;
        add(gapLoss <= settings.dailyLossLimit + 1e-6, "Rugi skenario gap terburuk 60 hari ≤ batas harian",
          `${market.money(gapLoss)} (gap ${((gap.worst - 1) * 100).toFixed(1)}%) / ${market.money(settings.dailyLossLimit)}`);
      }
    }
    if (clock) {
      const open = clock.state === "open";
      add(open, "Bursa sedang buka", clock.label);
      if (open && w) {
        const sell = w.overnight ? `besok ${dayLabel(w.flatDate)} ${hhmm(w.flatMin + INTERVAL)}` : hhmm(w.flatMin + INTERVAL);
        add(clock.min <= w.lastEntryMin + INTERVAL, "Masih dalam jendela entry", `batas entry ${hhmm(w.lastEntryMin + INTERVAL)}, jual paling lambat ${sell}`);
      }
    }
  }
  const pass = checks.every(c => c.ok);
  return { pass, checks, at: now || null };
}

// Tiket order dalam bahasa biasa (dieksekusi manual di aplikasi broker).
export function ticketText({ market, order, flatMin, win, date }) {
  if (!order?.ok) return "";
  const w = win || { overnight: false, flatMin, flatDate: date };
  const u = market.id === "idx" ? `${order.units} lot (${order.shares.toLocaleString("id-ID")} lembar)` : `${order.shares} lembar`;
  const t = `${hhmm(w.flatMin + INTERVAL)} ${market.tzLabel}`;
  const wib = market.tz !== "Asia/Jakarta" && w.flatDate ? ` (${hhmm(toWIB(market, w.flatDate, w.flatMin + INTERVAL).min)} WIB)` : "";
  if (w.overnight) {
    return [
      `BELI ${order.symbol} ${u} limit ${market.price(order.entry)}`,
      `Langsung pasang bracket GTC: stop loss ${market.price(order.stop)} · take profit ${market.price(order.target)}`,
      `Kalau belum kena keduanya, jual paling lambat ${dayLabel(w.flatDate)} ${t}${wib}`,
      `Rugi di stop ≈ ${market.money(order.maxLoss)} (bisa lebih besar kalau harga gap di bawah stop) · nilai ${market.money(order.value)}`,
      market.id === "us" ? "Akun cash: pakai dana yang sudah settle; hasil jual baru settle 1 hari kerja (T+1)." : "",
    ].filter(Boolean).join("\n");
  }
  return [
    `BELI ${order.symbol} ${u} limit ${market.price(order.entry)}`,
    `Stop loss ${market.price(order.stop)} · Take profit ${market.price(order.target)}`,
    `Jual sisa paling lambat ${t}${wib}`,
    `Rugi maks di stop ≈ ${market.money(order.maxLoss)} · nilai posisi ${market.money(order.value)}`,
  ].join("\n");
}

// Evaluasi trade paper dari bar yang sudah terjadi (bisa lintas hari untuk mode jual besok).
export function evaluateTrade({ market, parsed, trade, fees }) {
  const held = heldBars(parsed, trade);
  if (!held) return null;
  const f = feesOf(market, fees);
  let hit = null, time = null, onDate = null;
  for (const b of held.bars) { hit = hitBar(b, trade.stop, trade.target); if (hit) { time = b.time; onDate = b.date; break; } }
  if (!hit && !held.done) return { status: "open", last: held.bars.length ? held.bars.at(-1).c : null };
  let out, exit;
  if (hit) { out = hit.out; exit = hit.exit; }
  else { out = "flat"; exit = held.bars.length ? held.bars.at(-1).c : trade.entry; time = hhmm(trade.flatMin + INTERVAL); onDate = trade.flatDate || trade.date; }
  const sh = trade.shares;
  const pnl = sh * (exit - trade.entry) - orderFee(f, trade.entry, sh, "buy") - orderFee(f, exit, sh, "sell");
  return { status: "closed", outcome: out, exit, time, exitDate: onDate, gap: !!hit?.gap, pnl, R: round(pnl / trade.maxLoss, 2) };
}

// ------------------------------------------------------------------ util
function round(x, n) { const k = 10 ** n; return Math.round(x * k) / k; }
function pct(x) { return `${(x * 100).toFixed(1)}%`; }
