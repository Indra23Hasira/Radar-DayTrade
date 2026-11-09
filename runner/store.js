// Penyimpanan runner: Firestore (project radar-idx-hasira, lewat service account) atau file JSON (simulasi/dry run).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// id trade otomatis deterministik: sama di Firestore dan di salinan lokal
export const tradeId = (t) => `${t.market}_${t.date}_${t.symbol}`;

export async function firestoreStore() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("Secret FIREBASE_SERVICE_ACCOUNT_KEY belum diisi");
  const { default: admin } = await import("firebase-admin");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === Infinity ? null : v)));
  return {
    kind: "firestore",
    async settings(m) { const s = await db.doc(`daytradeSettings/${m}`).get(); return s.exists ? s.data() : {}; },
    async runner(m) { const s = await db.doc(`daytradeRunner/${m}`).get(); return s.exists ? s.data() : null; },
    async setRunner(m, patch) { await db.doc(`daytradeRunner/${m}`).set(clean(patch), { merge: true }); },
    async autoTrades(m) {
      const q = await db.collection("daytradeTrades").where("auto", "==", true).where("market", "==", m).get();
      return q.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async addTrade(t) { const id = t.id || tradeId(t); const { id: _, ...doc } = t; await db.doc(`daytradeTrades/${id}`).set(clean(doc)); return id; },
    async updateTrade(id, patch) { await db.doc(`daytradeTrades/${id}`).set(clean(patch), { merge: true }); },
    async signals(m, date) {
      const q = await db.collection("daytradeSignals").where("market", "==", m).where("date", "==", date).get();
      return q.docs.map(d => d.data());
    },
    async setSignal(id, doc) { await db.doc(`daytradeSignals/${id}`).set(clean(doc)); },
    // Universe IDX dari Radar IDX (hanya dibaca): rata-rata nilai transaksi 20 hari dari upload Excel harian
    async idxUniverse(minValue) {
      const q = await db.collection("tickerRollingStats").where("avgValue20d", ">=", minValue).select("ticker", "avgValue20d").get();
      const meta = await db.doc("systemMeta/marketRegime").get();
      return { rows: q.docs.map(d => ({ symbol: d.data().ticker || d.id, avgValue: d.data().avgValue20d })), asOf: meta.exists ? meta.data().date : null };
    },
  };
}

export function fileStore(file) {
  const load = () => (file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { settings: {}, runner: {}, trades: [], signals: {} });
  let st = load();
  const save = () => { if (file) fs.writeFileSync(file, JSON.stringify(st, null, 1)); };
  return {
    kind: "file",
    async settings(m) { return st.settings[m] || {}; },
    async runner(m) { return st.runner[m] || null; },
    async setRunner(m, patch) {
      const cur = st.runner[m] || {};
      const merge = (a, b) => { for (const k in b) a[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? merge(a[k] || {}, b[k]) : b[k]; return a; };
      st.runner[m] = merge(cur, JSON.parse(JSON.stringify(patch))); save();
    },
    async autoTrades(m) { return st.trades.filter(t => t.auto && t.market === m).map(t => ({ ...t })); },
    async addTrade(t) { const id = t.id || tradeId(t); st.trades.push({ ...JSON.parse(JSON.stringify(t)), id }); save(); return id; },
    async updateTrade(id, patch) { const t = st.trades.find(x => x.id === id); Object.assign(t, JSON.parse(JSON.stringify(patch))); save(); },
    async signals(m, date) { return Object.values(st.signals).filter(s => s.market === m && s.date === date); },
    async setSignal(id, doc) { st.signals[id] = JSON.parse(JSON.stringify(doc)); save(); },
    async idxUniverse() { return { rows: [], asOf: null }; },
    dump: () => st,
  };
}

// ---------------------------------------------------------------- tahan kuota Firestore habis
// Firestore (Spark) bisa kehabisan kuota harian karena dipakai bersama Radar IDX; reset 15:00 WIB.
// Runner tetap jalan dengan salinan lokal terenkripsi (data/daytrade/state-<pasar>.enc, di-commit ke repo).
// Tulisan yang gagal masuk antrean (outbox) dan disinkronkan otomatis saat Firestore tersedia lagi.
const ALG = "aes-256-gcm";
function keyFrom(material) { return crypto.createHash("sha256").update("radar-daytrade-state:" + material).digest(); }
function readEnc(file, key) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const d = crypto.createDecipheriv(ALG, key, Buffer.from(j.iv, "base64"));
    d.setAuthTag(Buffer.from(j.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, "base64")), d.final()]).toString("utf8"));
  } catch { return null; }
}
function writeEnc(file, key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }));
}
const deepMerge = (a, b) => { for (const k in b) a[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? deepMerge(a[k] && typeof a[k] === "object" ? a[k] : {}, b[k]) : b[k]; return a; };
const plain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === Infinity ? null : v)));

export async function resilientStore({ market, file, keyMaterial, log = console.log }) {
  const key = keyFrom(keyMaterial);
  const st = readEnc(file, key) || { settings: {}, runner: {}, trades: {}, signals: {}, outbox: [], universe: null };
  let fire = null, down = null, downAt = 0;
  try { fire = await firestoreStore(); } catch (e) { down = e.message; downAt = Date.now(); }
  const failed = (e) => { if (!down) { down = e.message || String(e); downAt = Date.now(); log(`Firestore tidak tersedia (${down}) — pakai salinan lokal, sinkron nanti`); } };
  // coba lagi tiap 30 menit (kuota bisa pulih di tengah jalan, mis. 15:00 WIB)
  const live = () => { if (fire && down && Date.now() - downAt > 30 * 60e3) down = null; return !!fire && !down; };
  async function write(op) {
    if (op.type === "runner") {
      const last = st.outbox.find(o => o.type === "runner");
      if (last) { deepMerge(last.patch, plain(op.patch)); } else st.outbox.push({ ...op, patch: plain(op.patch) });
    } else st.outbox.push(plain(op));
    await flush();
  }
  async function apply(op) {
    if (op.type === "runner") return fire.setRunner(market, op.patch);
    if (op.type === "trade") return fire.addTrade({ ...op.doc, id: op.id });
    if (op.type === "tradePatch") return fire.updateTrade(op.id, op.patch);
    if (op.type === "signal") return fire.setSignal(op.id, op.doc);
  }
  async function flush() {
    while (st.outbox.length && live()) {
      try { await apply(st.outbox[0]); st.outbox.shift(); } catch (e) { failed(e); }
    }
  }
  const pendingIds = () => new Set(st.outbox.filter(o => o.id).map(o => o.id));
  const api = {
    kind: "resilient",
    degraded: () => !!down,
    pending: () => st.outbox.length,
    async settings(m) {
      if (live()) { try { st.settings = await fire.settings(m); } catch (e) { failed(e); } }
      return st.settings || {};
    },
    async runner(m) {
      if (live()) { try { const r = await fire.runner(m); if (r) st.runner = deepMerge(r, st.outbox.find(o => o.type === "runner")?.patch || {}); } catch (e) { failed(e); } }
      return Object.keys(st.runner || {}).length ? st.runner : null;
    },
    async setRunner(m, patch) { st.runner = deepMerge(st.runner || {}, plain(patch)); await write({ type: "runner", patch }); },
    async autoTrades(m) {
      await flush();
      if (live()) {
        try {
          const pend = pendingIds();
          for (const t of await fire.autoTrades(m)) if (!pend.has(t.id)) st.trades[t.id] = t;
        } catch (e) { failed(e); }
      }
      return Object.values(st.trades).filter(t => t.market === m).map(t => ({ ...t }));
    },
    async addTrade(t) { const id = t.id || tradeId(t); const doc = plain({ ...t, id: undefined }); st.trades[id] = { ...doc, id }; await write({ type: "trade", id, doc }); return id; },
    async updateTrade(id, patch) { st.trades[id] = { ...(st.trades[id] || {}), ...plain(patch) }; await write({ type: "tradePatch", id, patch }); },
    async signals(m, date) {
      if (live()) { try { for (const x of await fire.signals(m, date)) st.signals[`${x.market}_${x.date}_${x.symbol}`] = x; } catch (e) { failed(e); } }
      return Object.values(st.signals).filter(x => x.market === m && x.date === date);
    },
    async setSignal(id, doc) { st.signals[id] = plain(doc); await write({ type: "signal", id, doc }); },
    async idxUniverse(minValue) {
      if (live()) { try { const u = await fire.idxUniverse(minValue); if (u.rows.length) st.universe = { ...u, cachedAt: new Date().toISOString(), minValue }; } catch (e) { failed(e); } }
      if (st.universe && st.universe.minValue === minValue) return { ...st.universe, cached: !!down };
      return { rows: [], asOf: null };
    },
    async save() {
      // simpan sinyal 10 hari terakhir saja supaya file tetap kecil
      const keep = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
      for (const k of Object.keys(st.signals)) if (st.signals[k].date < keep) delete st.signals[k];
      writeEnc(file, key, st);
    },
  };
  await flush();
  return api;
}
