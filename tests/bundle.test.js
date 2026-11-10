// Universe IDX dari arsip hemat Radar IDX (radarBundles/rolling) — harus sama dengan query lama.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { rollingFromBundle, decodeBundle } from "../runner/store.js";

// Firestore admin tiruan, cukup untuk doc().get() dan collection().orderBy().limit().select().get()
function fakeDb(docs) {
  const snap = (id, d) => ({ id, exists: d !== undefined, data: () => d, get: (f) => d?.[f] });
  return {
    doc: (p) => ({ get: async () => snap(p.split("/").pop(), docs[p]) }),
    collection: (c) => {
      const q = { ob: null, n: Infinity };
      const api = {
        orderBy: (f, dir) => { q.ob = [f, dir]; return api; },
        limit: (n) => { q.n = n; return api; },
        select: () => api,
        get: async () => {
          let list = Object.entries(docs).filter(([k]) => k.startsWith(c + "/") && k.split("/").length === 2).map(([k, d]) => ({ id: k.split("/")[1], d }));
          if (q.ob) { const [f, dir] = q.ob; list = list.filter((x) => x.d[f] !== undefined).sort((a, b) => (a.d[f] < b.d[f] ? -1 : a.d[f] > b.d[f] ? 1 : 0) * (dir === "desc" ? -1 : 1)); }
          list = list.slice(0, q.n);
          return { empty: !list.length, docs: list.map((x) => snap(x.id, x.d)) };
        },
      };
      return api;
    },
  };
}
const gz64 = (o) => zlib.gzipSync(JSON.stringify(o)).toString("base64");

test("arsip rolling dibaca & diverifikasi; usang → null (pakai query lama)", async () => {
  const rows = { BBRI: { ticker: "BBRI", avgValue20d: 9e11, updatedAt: "2026-11-09T10:00:01.000Z" }, GOTO: { ticker: "GOTO", avgValue20d: 3e9, updatedAt: "2026-11-09T10:00:02.000Z" }, X: { ticker: "X", avgValue20d: { __n: "NaN" }, updatedAt: "2026-11-09T10:00:00.000Z" } };
  const entries = Object.entries(rows);
  const str = gz64(entries);
  const docs = {
    "radarBundles/meta": { rolling: { s: "abc", maxUpd: "2026-11-09T10:00:02.000Z" } },
    "radarBundles/rolling": { s: "abc", enc: "gz64", parts: 2, p0: str.slice(0, 40) },
    "radarBundles/rolling__p1": { s: "abc", p: str.slice(40) },
  };
  for (const [id, d] of entries) docs[`tickerRollingStats/${id}`] = d;
  const got = await rollingFromBundle(fakeDb(docs));
  assert.equal(got.length, 3);
  assert.equal(got[0][1].avgValue20d, 9e11);
  assert.ok(Number.isNaN(got[2][1].avgValue20d));
  // Radar IDX versi lama menulis Step 4 setelah arsip dibuat → arsip tidak dipakai
  docs["tickerRollingStats/GOTO"] = { ...rows.GOTO, updatedAt: "2026-11-10T10:00:00.000Z" };
  assert.equal(await rollingFromBundle(fakeDb(docs)), null);
  // belum ada arsip
  assert.equal(await rollingFromBundle(fakeDb({})), null);
  assert.deepEqual(decodeBundle("json", "[1]"), [1]);
});
