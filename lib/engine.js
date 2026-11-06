// Mesin Radar-DayTrade: dipakai app (browser) dan cli.js (Node / skill Claude Code).
// Logika diadaptasi dari paket day-trader-skill (MIT, Jake Schincariol):
// opening-range breakout, rencana stop/target, Time Machine, sizing, dan risk gate,
// ditambah aturan pasar IDX (lot, fraksi, ARA/ARB, jeda siang, fee).
import { slotsFor, flatMinute, floorTick, ceilTick } from "./markets.js";

const INTERVAL = 5;

// ------------------------------------------------------------------ waktu

const _fmt = {};
export function localParts(tsSec, tz) {
  const f = _fmt[tz] || (_fmt[tz] = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }));
  const p = {};
  for (const x of f.formatToParts(new Date(tsSec * 1000))) p[x.type] = x.value;
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, min: hour * 60 + Number(p.minute) };
}
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Jam tidak valid: ${s} (format HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

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

// Sesi lengkap sebelum `date` (bar terisi ≥ 85% asli), terlama dulu.
export function fullSessions(parsed, date) {
  return parsed.dates
    .filter(d => d < date && parsed.days[d].full && parsed.days[d].filled <= parsed.days[d].slots * 0.15)
    .map(d => ({ date: d, bars: parsed.days[d].bars }));
}
export function prevCloseOf(parsed, date) {
  const ds = parsed.dates.filter(d => d < date);
  return ds.length ? parsed.days[ds[ds.length - 1]].close : null;
}

// ------------------------------------------------------------------ entry (ORB)

export function openingRange(bars, orMinutes) {
  if (!bars.length) return null;
  const start = bars[0].min;
  const rows = bars.filter(b => b.seg === bars[0].seg && b.min < start + orMinutes);
  if (rows.length < orMinutes / INTERVAL) return null;
  return { high: Math.max(...rows.map(b => b.h)), low: Math.min(...rows.map(b => b.l)), until: hhmm(start + orMinutes), n: rows.length };
}

// Status entry hari `date`. opts: {setup:'orb'|'level', level, orMinutes, minVolumeX, lastEntryMin}
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
  const lastEntryMin = opts.lastEntryMin ?? (flatMinute(market, date, opts.flat || market.defaultFlat) - 30);
  // rata-rata volume per jam dari sesi sebelumnya, untuk filter volume
  let volAvg = null;
  if (opts.minVolumeX) {
    volAvg = {};
    const hist = fullSessions(parsed, date).slice(-20);
    for (const s of hist) for (const b of s.bars) { (volAvg[b.min] ||= []).push(b.v); }
    for (const k in volAvg) volAvg[k] = volAvg[k].reduce((a, x) => a + x, 0) / volAvg[k].length;
  }
  const startIdx = bars.findIndex(b => b.min >= bars[0].min + orMinutes);
  const last = bars[bars.length - 1];
  for (let i = Math.max(startIdx, 0); startIdx >= 0 && i < bars.length; i++) {
    const b = bars[i];
    if (b.min > lastEntryMin) break;
    if (b.c > trigLevel) {
      if (opts.minVolumeX && volAvg?.[b.min] && b.v < opts.minVolumeX * volAvg[b.min]) continue;
      return {
        status: "triggered", or, level: trigLevel, entry: b.c, time: hhmm(b.min + INTERVAL), barMin: b.min,
        idx: i, note: `Bar ${b.time} close ${market.price(b.c)} di atas ${market.price(trigLevel)}`,
      };
    }
  }
  const expired = last && last.min >= lastEntryMin;
  return {
    status: expired ? "expired" : "waiting", or, level: trigLevel, last: last?.c, lastTime: last ? hhmm(last.min + INTERVAL) : null,
    gapPct: last ? (trigLevel / last.c - 1) * 100 : null, lastEntry: hhmm(lastEntryMin),
    note: expired ? `Tidak ada breakout sampai batas entry ${hhmm(lastEntryMin)}` : `Butuh close di atas ${market.price(trigLevel)}`,
  };
}

// ------------------------------------------------------------------ exit plan

// stopRule: 'or_mid' | 'or_low' | 'pct:1.5' | 'price:2700'; targetRule: '2R' | '1.5R' | 'price:2800'
export function planExit({ market, date, entry, or, stopRule = "or_mid", targetRule = "2R", prevClose, fees }) {
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
  // stop di bawah entry minimal: jika pembulatan menyamakan, turunkan satu tick
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
  const f = fees || market.fees;
  const feePerShare = entry * f.buyPct / 100 + target * f.sellPct / 100 + 2 * (f.perShare || 0);
  const feeAtStop = entry * f.buyPct / 100 + stop * f.sellPct / 100 + 2 * (f.perShare || 0);
  const rGross = (target - entry) / risk;
  const rNet = (target - entry - feePerShare) / (risk + feeAtStop);
  return {
    entry, stop, target, risk, rGross: round(rGross, 2), rNet: round(rNet, 2), stopRule, targetRule,
    feePerShare, feeAtStop, limits: lim, warnings,
  };
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

// Replay sisa hari sebanyak `replays` kali dari pola bar saham itu sendiri.
// fromMin = bar entry (masuk di close-nya); flatMin = bar terakhir yang dipegang.
export function timeMachine({ market, date, parsed, plan, fromMin, flatMin, replays = 10000, seed = 19, window = 2, prevClose, fees }) {
  const f = fees || market.fees;
  const sessions = fullSessions(parsed, date).slice(-59);
  if (sessions.length < 10) throw new Error(`Butuh minimal 10 sesi lengkap, baru ada ${sessions.length}`);
  const pool = buildPool(sessions);
  const slots = slotsFor(market, date).filter(s => s.min > fromMin && s.min <= flatMin);
  if (!slots.length) throw new Error("Tidak ada bar tersisa antara entry dan batas jual");
  const lim = market.limits(prevClose, date);
  const { entry, stop, target, risk, feePerShare, feeAtStop } = plan;
  const keys = slots.map(s => {
    const own = poolKey({ ...s });
    if (s.first) return [own];
    const allMins = slotsFor(market, date).filter(x => !x.first).map(x => x.min);
    const j = allMins.indexOf(s.min);
    const ks = [];
    for (let d = -window; d <= window; d++) { const m = allMins[j + d]; if (m != null && pool[m]) ks.push(String(m)); }
    return ks.length ? ks : [own];
  });
  const r = rng(seed);
  const rTarget = (target - entry - feePerShare) / (risk + feeAtStop);
  let nT = 0, nS = 0, nC = 0, green = 0, sumR = 0;
  const closes = new Float64Array(replays);
  for (let n = 0; n < replays; n++) {
    let p = entry, out = null;
    for (const ks of keys) {
      const arr = pool[ks[Math.floor(r() * ks.length)]];
      if (!arr) continue;
      const [, h, l, c] = arr[Math.floor(r() * arr.length)];
      let hi = p * h, lo = p * l, cl = p * c;
      if (lim) { hi = Math.min(hi, lim.ara); lo = Math.max(lo, lim.arb); cl = Math.min(Math.max(cl, lim.arb), lim.ara); }
      if (!out) {
        if (lo <= stop) out = "stop"; // stop & target di bar yang sama: dihitung rugi (konservatif)
        else if (hi >= target) out = "target";
      }
      p = cl;
    }
    closes[n] = p;
    if (out === "target") { nT++; green++; sumR += rTarget; }
    else if (out === "stop") { nS++; sumR -= 1; }
    else {
      nC++;
      const rr = (p - entry - (entry * f.buyPct / 100 + p * f.sellPct / 100 + 2 * (f.perShare || 0))) / (risk + feeAtStop);
      sumR += rr; if (rr > 0) green++;
    }
  }
  const sorted = Array.from(closes).sort((a, b) => a - b);
  const pc = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mc = {
    replays, seed, window, sessions: sessions.length, barsLeft: slots.length,
    pTarget: nT / replays, pStop: nS / replays, pNeither: nC / replays, pGreen: green / replays,
    avgR: round(sumR / replays, 3), rTarget: round(rTarget, 2),
    medianClose: pc(0.5), p5Close: pc(0.05), p95Close: pc(0.95),
    from: hhmm(fromMin + INTERVAL), until: hhmm(flatMin + INTERVAL),
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
  if (Math.abs(d) >= 0.05 && mc.avgR !== 0 && (mc.avgR > 0) !== (d > 0)) text += ` Rata-rata R tetap ${mc.avgR > 0 ? "+" : ""}${mc.avgR}: replay yang tidak kena keduanya menarik ke arah sebaliknya.`;
  return { tone, text };
}

// Aturan yang sama dijalankan di setiap sesi historis yang lengkap.
export function historyReplay({ market, parsed, date, orMinutes = 15, stopRule = "or_mid", targetRule = "2R", flatPreset, fees }) {
  const sessions = fullSessions(parsed, date).slice(-59);
  const trades = [];
  for (const s of sessions) {
    const flatMin = flatMinute(market, s.date, flatPreset || market.defaultFlat);
    const lastEntryMin = flatMin - 30;
    const or = openingRange(s.bars, orMinutes);
    if (!or) continue;
    const start = s.bars.findIndex(b => b.min >= s.bars[0].min + orMinutes);
    const k = s.bars.findIndex((b, i) => i >= start && b.min <= lastEntryMin && b.c > or.high);
    if (k < 0) continue;
    const e = s.bars[k].c;
    let plan;
    try { plan = planExit({ market, date: s.date, entry: e, or, stopRule, targetRule, prevClose: prevCloseOf(parsed, s.date), fees }); }
    catch { continue; }
    let out = null;
    const rest = s.bars.filter((b, i) => i > k && b.min <= flatMin);
    for (const b of rest) {
      if (b.l <= plan.stop) { out = "stop"; break; }
      if (b.h >= plan.target) { out = "target"; break; }
    }
    const cl = rest.length ? rest[rest.length - 1].c : e;
    const R = out === "target" ? plan.rNet : out === "stop" ? -1
      : (cl - e - (e * (fees || market.fees).buyPct / 100 + cl * (fees || market.fees).sellPct / 100)) / (plan.risk + plan.feeAtStop);
    trades.push({ date: s.date, time: hhmm(s.bars[k].min + INTERVAL), entry: e, stop: plan.stop, target: plan.target, outcome: out || "close", R: round(R, 2) });
  }
  const n = trades.length;
  return {
    sessions: sessions.length, triggered: n,
    target: trades.filter(t => t.outcome === "target").length,
    stop: trades.filter(t => t.outcome === "stop").length,
    close: trades.filter(t => t.outcome === "close").length,
    green: trades.filter(t => t.R > 0).length,
    avgR: n ? round(trades.reduce((a, t) => a + t.R, 0) / n, 3) : null,
    trades,
  };
}

// ------------------------------------------------------------------ sizing

// account: {equity, cash, maxLossPerTrade, maxPositionPct, cashBufferPct}
export function sizeOrder({ market, symbol, plan, account, fees }) {
  const f = fees || market.fees;
  const lossPerShare = plan.risk + plan.feeAtStop;
  const unit = market.lot;
  const unitCost = plan.entry * (1 + f.buyPct / 100) + (f.perShare || 0);
  const limits = [];
  const byLoss = Math.floor(account.maxLossPerTrade / (lossPerShare * unit) + 1e-9);
  limits.push({ id: "maxLoss", label: "batas rugi per trade", units: byLoss });
  if (account.maxPositionPct > 0) limits.push({ id: "position", label: `maks ${account.maxPositionPct}% modal per posisi`, units: Math.floor(account.equity * account.maxPositionPct / 100 / (unitCost * unit) + 1e-9) });
  const usableCash = (account.cash ?? account.equity) - account.equity * (account.cashBufferPct || 0) / 100;
  limits.push({ id: "cash", label: "kas tersedia setelah cadangan", units: Math.floor(Math.max(0, usableCash) / (unitCost * unit) + 1e-9) });
  const pick = limits.reduce((a, b) => (b.units < a.units ? b : a));
  if (pick.units < 1) {
    return { ok: false, reason: pick.id === "maxLoss"
      ? `Stop terlalu jauh untuk batas rugi ${market.money(account.maxLossPerTrade)}: 1 ${market.unitLabel} saja rugi ${market.money(lossPerShare * unit)} kalau kena stop`
      : `Tidak cukup untuk 1 ${market.unitLabel} (${pick.label})`, limits };
  }
  const units = pick.units, shares = units * unit;
  return {
    ok: true, symbol: market.display(symbol), side: "buy", units, shares, decidedBy: pick.label, limits,
    entry: plan.entry, stop: plan.stop, target: plan.target,
    value: shares * plan.entry, maxLoss: shares * lossPerShare,
    expectedWin: shares * (plan.target - plan.entry - plan.feePerShare),
    fees: shares * plan.feePerShare,
  };
}

// ------------------------------------------------------------------ risk gate

// settings: {maxLossPerTrade, dailyLossLimit, maxTradesPerDay, minRR, maxPositionPct, equity, blocked:[]}
// today: {trades, riskUsed, realized}
export function riskCheck({ market, order, plan, settings, today, clock, flatMin, now }) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });
  add(!!order?.ok, "Ukuran order", order?.ok ? `${order.units} ${market.unitLabel}` : order?.reason || "Belum ada order");
  if (order?.ok) {
    add(order.stop < order.entry, "Stop wajib ada & di bawah entry", market.price(order.stop));
    add(order.maxLoss <= settings.maxLossPerTrade + 1e-6, "Rugi di stop ≤ batas per trade", `${market.money(order.maxLoss)} / ${market.money(settings.maxLossPerTrade)}`);
    // risiko terbuka hari ini + order ini + rugi yang sudah terealisasi tidak boleh lewat batas harian
    const used = (today.riskUsed || 0) + order.maxLoss + Math.max(0, -(today.realized || 0));
    add(used <= settings.dailyLossLimit + 1e-6, "Risiko harian ≤ batas rugi harian",`${market.money(used)} / ${market.money(settings.dailyLossLimit)}${today.realized ? ` (termasuk realisasi ${market.money(today.realized)})` : ""}`);
    add((today.trades || 0) < settings.maxTradesPerDay, "Jumlah trade hari ini", `${today.trades || 0} dari maks ${settings.maxTradesPerDay}`);
    add(plan.rNet >= settings.minRR, "Reward:risk bersih fee", `${plan.rNet} (min ${settings.minRR})`);
    if (settings.maxPositionPct > 0) add(order.value <= settings.equity * settings.maxPositionPct / 100 + 1e-6, "Nilai posisi", `${market.money(order.value)} (maks ${settings.maxPositionPct}% modal)`);
    add(!(settings.blocked || []).map(s => s.toUpperCase()).includes(order.symbol), "Saham tidak di daftar blokir", order.symbol);
    if (plan.limits) add(order.stop >= plan.limits.arb && order.target <= plan.limits.ara, "Stop & target di dalam ARA/ARB", `ARB ${market.price(plan.limits.arb)} · ARA ${market.price(plan.limits.ara)}`);
    if (clock) {
      const open = clock.state === "open";
      add(open, "Bursa sedang buka", clock.label);
      if (open && flatMin != null) add(clock.min <= flatMin - 25, "Masih dalam jendela entry", `batas entry ${hhmm(flatMin - 25)}, jual paling lambat ${hhmm(flatMin + INTERVAL)}`);
    }
  }
  const pass = checks.every(c => c.ok);
  return { pass, checks, at: now || null };
}

// Tiket order dalam bahasa biasa (dieksekusi manual di aplikasi broker).
export function ticketText({ market, order, flatMin }) {
  if (!order?.ok) return "";
  const u = market.id === "idx" ? `${order.units} lot (${order.shares.toLocaleString("id-ID")} lembar)` : `${order.shares} lembar`;
  return [
    `BELI ${order.symbol} ${u} limit ${market.price(order.entry)}`,
    `Stop loss ${market.price(order.stop)} · Take profit ${market.price(order.target)}`,
    `Jual sisa paling lambat ${hhmm(flatMin + INTERVAL)} ${market.tzLabel}`,
    `Rugi maks di stop ≈ ${market.money(order.maxLoss)} · nilai posisi ${market.money(order.value)}`,
  ].join("\n");
}

// Evaluasi trade paper dari bar yang sudah terjadi.
export function evaluateTrade({ market, parsed, trade, fees }) {
  const day = parsed.days[trade.date];
  if (!day) return null;
  const f = fees || market.fees;
  const after = day.bars.filter(b => b.min > trade.entryMin && b.min <= trade.flatMin);
  let out = null, exit = null, time = null;
  for (const b of after) {
    if (b.l <= trade.stop) { out = "stop"; exit = trade.stop; time = b.time; break; }
    if (b.h >= trade.target) { out = "target"; exit = trade.target; time = b.time; break; }
  }
  const finished = out || (after.length && after[after.length - 1].min >= trade.flatMin);
  if (!out && finished) { out = "flat"; exit = after[after.length - 1].c; time = hhmm(trade.flatMin + INTERVAL); }
  if (!out) return { status: "open", last: after.length ? after[after.length - 1].c : null };
  const pnl = trade.shares * (exit - trade.entry - trade.entry * f.buyPct / 100 - exit * f.sellPct / 100 - 2 * (f.perShare || 0));
  return { status: "closed", outcome: out, exit, time, pnl, R: round(pnl / trade.maxLoss, 2) };
}

// ------------------------------------------------------------------ util
function round(x, n) { const k = 10 ** n; return Math.round(x * k) / k; }
function pct(x) { return `${(x * 100).toFixed(1)}%`; }
