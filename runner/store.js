// Penyimpanan runner: Firestore (project radar-idx-hasira, lewat service account) atau file JSON (simulasi/dry run).
import fs from "node:fs";

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
    async addTrade(t) { const r = await db.collection("daytradeTrades").add(clean(t)); return r.id; },
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
    async addTrade(t) { const id = `sim-${st.trades.length + 1}`; st.trades.push({ ...JSON.parse(JSON.stringify(t)), id }); save(); return id; },
    async updateTrade(id, patch) { const t = st.trades.find(x => x.id === id); Object.assign(t, JSON.parse(JSON.stringify(patch))); save(); },
    async signals(m, date) { return Object.values(st.signals).filter(s => s.market === m && s.date === date); },
    async setSignal(id, doc) { st.signals[id] = JSON.parse(JSON.stringify(doc)); save(); },
    async idxUniverse() { return { rows: [], asOf: null }; },
    dump: () => st,
  };
}
