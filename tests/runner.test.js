// Simulasi runner otomatis secara offline (data Yahoo asli yang disimpan di tests/fixtures).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
function sim(market, date, state, extra = []) {
  return execFileSync("node", ["runner/run.js", "--market", market, "--simulate", date, "--fixtures", "tests/fixtures", "--state", state, "--no-archive", ...extra], { cwd: root, encoding: "utf8" });
}

test("runner IDX 6 Nov: DEFI terlalu jauh, jurnal & ringkasan", () => {
  const st = path.join(os.tmpdir(), `dt-idx-${Date.now()}.json`);
  const out = sim("idx", "2026-11-06", st);
  const s = JSON.parse(fs.readFileSync(st, "utf8"));
  const sig = Object.values(s.signals);
  const defi = sig.find(x => x.symbol === "DEFI");
  assert.equal(defi?.status, "extended");
  assert.ok(out.includes("Ringkasan Jum 6/11"));
  for (const t of s.trades) {
    assert.equal(t.auto, true);
    assert.equal(t.result?.status, "closed");       // mode jual siang: semua selesai hari itu
    assert.ok(t.entryMin <= 10 * 60 + 55);          // Jumat: entry paling lambat bar 10:55
  }
  assert.equal(s.runner.idx.parts["2026-11-06"].p1, "done");
  // jalan ulang (jadwal cadangan) tidak menggandakan apa pun
  sim("idx", "2026-11-06", st);
  const s2 = JSON.parse(fs.readFileSync(st, "utf8"));
  assert.equal(s2.trades.length, s.trades.length);
});

test("runner US 4→5 Nov: posisi semalam dinilai di malam berikutnya", () => {
  const st = path.join(os.tmpdir(), `dt-us-${Date.now()}.json`);
  sim("us", "2026-11-04", st, ["--start", "08:45"]);
  let s = JSON.parse(fs.readFileSync(st, "utf8"));
  const t = s.trades.find(x => x.symbol === "TSLA");
  assert.ok(t, "TSLA harus tercatat");
  assert.equal(t.overnight, true);
  assert.equal(t.flatDate, "2026-11-05");
  assert.notEqual(t.result?.status, "closed");
  sim("us", "2026-11-05", st, ["--start", "08:45"]);
  s = JSON.parse(fs.readFileSync(st, "utf8"));
  const r = s.trades.find(x => x.symbol === "TSLA").result;
  assert.equal(r.status, "closed");
  assert.equal(r.outcome, "stop");
  assert.equal(r.gap, true);                         // 5 Nov dibuka di bawah stop
});
