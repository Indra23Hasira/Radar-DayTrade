// Sumber data untuk runner: Yahoo (chart, harian, jadwal laporan keuangan, berita),
// daftar S&P 500 + Nasdaq-100. Versi "fixture" dipakai untuk simulasi offline.
import fs from "node:fs";
import path from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getText(url, headers = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.text();
      last = new Error(`HTTP ${r.status}`);
      if (r.status === 404) break;
      if (r.status === 429 || r.status >= 500) await sleep(1500 * 2 ** i);
    } catch (e) { last = e; await sleep(1000 * 2 ** i); }
  }
  throw last;
}
const getJSON = async (url, h) => JSON.parse(await getText(url, h));

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; }
    }
  }));
  return out;
}

export function yahooLive() {
  let host = 0, session = null;
  const hosts = ["query1", "query2"];
  async function chart(ysym, range = "60d", interval = "5m") {
    const q = `/v8/finance/chart/${encodeURIComponent(ysym)}?range=${range}&interval=${interval}&includePrePost=false`;
    try { return await getJSON(`https://${hosts[host]}.finance.yahoo.com${q}`); }
    catch (e) { host = 1 - host; return getJSON(`https://${hosts[host]}.finance.yahoo.com${q}`); }
  }
  async function crumb(force) {
    if (session && !force) return session;
    const r = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
    const list = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
    const cookie = list.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
    const c = (await getText("https://query2.finance.yahoo.com/v1/test/getcrumb", { Cookie: cookie })).trim();
    if (!c || c.includes("<")) throw new Error("crumb Yahoo gagal");
    return (session = { cookie, crumb: c });
  }
  // Tanggal laporan keuangan (YYYY-MM-DD, tanggal AS) yang jatuh di [from, to]
  async function earnings(ysym, from, to) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const s = await crumb(attempt > 0);
        const j = await getJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ysym)}?modules=calendarEvents&crumb=${encodeURIComponent(s.crumb)}`, { Cookie: s.cookie }, 2);
        const ev = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
        const dates = (ev?.earningsDate || []).map(d => new Date(d.raw * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
        return { ok: true, dates, hit: dates.filter(d => d >= from && d <= to), estimate: !!ev?.isEarningsDateEstimate };
      } catch (e) { if (attempt) return { ok: false, error: e.message }; }
    }
  }
  async function news(ysym, hours = 24) {
    try {
      const x = await getText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ysym)}&region=US&lang=en-US`, {}, 2);
      const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
        title: (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
        date: Date.parse((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || ""),
      }));
      return items.filter(i => i.title && Date.now() - i.date < hours * 3600e3).slice(0, 2);
    } catch { return []; }
  }
  async function usUniverse() {
    const out = new Map();
    const csv = await getText("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv");
    csv.split("\n").slice(1).forEach(l => { const s = l.split(",")[0]?.trim(); if (s) out.set(s.replace(".", "-"), "S&P 500"); });
    try {
      const j = await getJSON("https://api.nasdaq.com/api/quote/list-type/nasdaq100", { Accept: "application/json" });
      (j?.data?.data?.rows || []).forEach(r => { if (r.symbol) out.set(r.symbol.replace(".", "-"), out.has(r.symbol) ? "S&P 500 + Nasdaq-100" : "Nasdaq-100"); });
    } catch (e) { console.log("Nasdaq-100 tidak terambil:", e.message); }
    return [...out.keys()];
  }
  return { chart, earnings, news, usUniverse, live: true };
}

// Simulasi: semua chart dari file JSON (respons Yahoo 60 hari 5 menit) di satu folder.
export function yahooFixtures(dir) {
  const file = (ysym) => [path.join(dir, `${ysym}.json`), path.join(dir, `${ysym.replace(/\.JK$/, "")}.json`)].find(f => fs.existsSync(f));
  return {
    chart: async (ysym) => { const f = file(ysym); if (!f) throw new Error(`fixture ${ysym} tidak ada`); return JSON.parse(fs.readFileSync(f, "utf8")); },
    earnings: async () => ({ ok: true, dates: [], hit: [] }),
    news: async () => [],
    usUniverse: async () => fs.readdirSync(dir).filter(f => f.endsWith(".json") && !f.includes(".JK")).map(f => f.replace(/\.json$/, "")),
    idxUniverse: () => fs.readdirSync(dir).filter(f => f.endsWith(".JK.json")).map(f => f.replace(/\.JK\.json$/, "")),
    live: false,
  };
}
