---
name: radar-daytrade
description: >-
  Radar DayTrade untuk saham IDX (dan US). Scan opening-range breakout di watchlist,
  hitung rencana stop/target dengan fraksi harga & ARA/ARB BEI, jalankan Time Machine
  (10.000 replay dari pola 60 hari saham itu sendiri), sizing dalam lot sesuai batas rugi,
  risk check PASS/BLOCK, lalu tulis tiket order untuk dieksekusi MANUAL. Gunakan saat user
  bilang "scan day trade", "cek breakout BBRI", "rencanakan trade EMAS", "berapa lot",
  "time machine", "beli pagi jual siang", "jam bursa sekarang", atau menyebut Radar DayTrade.
  Untuk saham US, skill trader-* asli juga tersedia; skill ini memakai mesin yang sama dengan
  aplikasi web Radar-DayTrade.
argument-hint: "[scan KODE,KODE | plan KODE] [--market idx|us]"
---

# radar-daytrade

Mesin yang sama dengan aplikasi web Radar-DayTrade (folder `Radar-DayTrade` di
`~/apk-radar`). Data: Yahoo Finance 5 menit, 60 hari, gratis dan bisa tertunda.

```bash
DT="${CLAUDE_SKILL_DIR}/../../../Radar-DayTrade/cli.js"
[ -f "$DT" ] || DT="$HOME/apk-radar/Radar-DayTrade/cli.js"

node "$DT" status                                  # jam & sesi BEI sekarang
node "$DT" scan BBRI,BBCA,TPIA,EMAS                # status ORB tiap saham
node "$DT" plan EMAS                               # rencana lengkap + Time Machine + sizing + risk
node "$DT" plan BBRI --entry 2790                  # rencanakan sebelum trigger
node "$DT" plan EMAS --stop or_low --target 1.5R --flat close
node "$DT" plan EMAS --date 2026-11-05 --at 10:30  # putar ulang hari lalu (latihan)
node "$DT" plan TSLA --market us --earnings-ok     # US, default "jual besok" (maks 23:30 WIB)
node "$DT" plan TSLA --market us --flat close      # US jual hari yang sama
node "$DT" plan EMAS --json                        # keluaran mentah
```

Batas risiko dibaca dari `trader/daytrade.json` di folder kerja (kunci `idx` / `us`), atau flag:
`--equity`, `--max-loss`, `--daily-limit`, `--max-trades`, `--min-rr`. Contoh file:

```json
{ "idx": { "equity": 10000000, "maxLossPerTrade": 100000, "dailyLossLimit": 300000,
           "maxTradesPerDay": 3, "minRR": 1.2, "maxPositionPct": 50, "flat": "sesi1" } }
```

## Aturan IDX yang sudah dihitung mesin

- Sesi Senin–Kamis 09:00–12:00 & 13:30–15:50; Jumat 09:00–11:30 & 14:00–15:50 (WIB).
  Bar pra-penutupan tidak dipakai untuk sinyal. Libur bursa 2026–2027 tercatat.
- `--flat sesi1` (default) = jual paling lambat akhir sesi 1 ("beli pagi jual siang");
  `--flat close` = akhir sesi 2.
- Lot 100 lembar, fraksi harga (Rp1/2/5/10/25), ARA/ARB per tanggal berlaku
  (ARB 7% sementara s.d. 31 Des 2026; rencana simetris 2027 — cek ulang pengumuman BEI).
- Fee default beli 0,15% & jual 0,25% (sudah termasuk PPh 0,1%), masuk ke R bersih.

## Mode US "jual besok" (default tab US)

- Beli setelah opening range s.d. 23:30 WIB, jual paling lambat 23:30 WIB hari bursa berikutnya
  (`--exit-at` untuk jam lain). Jam ET dihitung otomatis termasuk pergantian DST.
- Time Machine menyimulasikan sisa malam → gap semalam (diambil dari gap nyata saham itu 60 hari) →
  besok s.d. jam jual. Tampilkan "stop tembus karena gap" dan 5% skenario terburuk.
- Risk check tambahan: konfirmasi tidak ada laporan keuangan (`--earnings-ok`, WAJIB dicek user dulu),
  dan rugi skenario gap terburuk 60 hari ≤ batas rugi harian.
- Komisi IBKR Pro Fixed: $0,005/lembar, min $1/order, maks 1% nilai. Akun cash: pakai dana settled (T+1).
- Tiket: beli + bracket GTC (stop & take profit), jual sisa besok. Stop tidak melindungi dari gap.

## Cara kerja dengan user

1. Mulai dari `status`, lalu `scan` watchlist user (atau kandidat dari Radar IDX bila disebut).
2. Untuk saham yang TRIGGER atau yang user minta, jalankan `plan` dan sampaikan ringkas:
   entry/stop/target, R bersih, hasil Time Machine (target duluan vs stop duluan, verdict),
   sejarah aturan yang sama, jumlah lot, dan PASS/BLOCK beserta alasannya.
3. Kalau BLOCK, berhenti di situ dan jelaskan batas yang dilanggar. Jangan mengakali batas.
4. Kalau PASS, tampilkan tiket. **Tidak ada eksekusi otomatis untuk IDX**: user memasang
   order sendiri di aplikasi broker. Untuk US, order hanya lewat skill `trader-broker`
   dengan aturan tiga gerbang miliknya (risk PASS, "yes" eksplisit, kartu Allow once).
5. Selalu sebut: Time Machine adalah simulasi dari 60 hari terakhir, bukan prediksi;
   stop bisa meleset saat gap atau ARB; kebanyakan day trader rugi. Bukan saran keuangan.

Jangan menulis ke Firestore Radar IDX atau Radar US dari skill ini. Jurnal trade ada di
aplikasi web (koleksi `daytradeTrades`).
