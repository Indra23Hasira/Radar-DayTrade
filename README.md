# Radar DayTrade

App day trade intraday untuk **IDX** (utama) dan **US** (beta) dalam satu halaman, terpisah dari
Radar US / Radar IDX yang dipakai untuk swing. Pola sama dengan app lain: HTML statis di GitHub Pages
+ Firebase (menumpang project `radar-idx-hasira`, login akun yang sama).

Alur satu trade: **watchlist → scan ORB → rencana stop/target → Time Machine → sizing (lot) →
risk check PASS/BLOCK → tiket order manual → jurnal paper (hasil dihitung otomatis)**.

Tab US punya mode **jual besok** (default): beli malam ini s.d. 23:30 WIB, jual paling lambat 23:30 WIB
besoknya, dengan simulasi gap semalam dan komisi IBKR Pro Fixed (min $1, maks 1%).

**Mode otomatis (paper, v0.4)**: runner GitHub Actions memilih sendiri saham paling aktif (IDX: nilai transaksi ≥ Rp5 miliar
dari Radar IDX; US: S&P 500 + Nasdaq-100), mencatat setiap sinyal yang lolos risk check sebagai trade paper, mengirim
sinyal/hasil/ringkasan ke Telegram, dan menghitung rapor kelayakan. Setup sekali: lihat `SETUP-OTOMATIS.md`.

Tidak ada order yang dikirim ke broker. Bukan saran keuangan.

## Isi

```
index.html              app (tab IDX & US), login Firebase, jurnal
lib/markets.js          aturan pasar: sesi BEI/NYSE, libur, lot, fraksi, ARA/ARB per tanggal, fee
lib/time.js             konversi zona waktu (WIB/ET, DST)
lib/engine.js           ORB, rencana exit, Time Machine, riwayat aturan, sizing, risk gate, evaluasi trade
runner/                 runner otomatis (GitHub Actions): universe, kandidat, sinyal, jurnal, Telegram
.github/workflows/      jadwal runner IDX & US
lib/report.js           rapor kelayakan & kriteria lulus
lib/defaults.js         pengaturan bawaan bersama (app, CLI, runner)
cli.js                  versi terminal mesin yang sama (dipakai skill Claude Code)
tests/                  tes offline dengan data Yahoo asli (npm test)
skills/radar-daytrade   skill Claude Code untuk IDX/US (memanggil cli.js)
skills/trader-*         11 skill asli day-trader-skill (MIT, Jake Schincariol) untuk saham US
pindah-laptop.sh        backup (laptop lama) & pasang ulang (laptop baru) — lihat PINDAH-LAPTOP.md
install.sh              pasang ke ~/apk-radar + skill + divisi Kantor AI + GitHub
firestore.rules.daytrade  rules tambahan untuk koleksi daytradeSettings & daytradeTrades
```

## Data Firestore (project radar-idx-hasira)

| Koleksi | Isi | Akses |
| --- | --- | --- |
| `daytradeSettings/{idx\|us}` | batas risiko, fee, watchlist | tulis |
| `daytradeTrades/{id}` | trade paper + hasil | tulis |
| `daytradeSignals/{pasar_tanggal_kode}` | semua sinyal otomatis (PASS/BLOCK/terlambat) | runner tulis, app baca |
| `daytradeRunner/{idx\|us}` | status & heartbeat runner | runner tulis, app baca |
| `topPicks`, `watchlist` | milik Radar IDX | **hanya dibaca** (tombol Import) |
| `tickerRollingStats`, `systemMeta` | milik Radar IDX | **hanya dibaca** runner (universe IDX) |

Kalau rules belum ditambah, app tetap jalan dan menyimpan di perangkat (localStorage).

## Aturan IDX (cek ulang bila BEI mengubah)

- Sesi Sen–Kam 09:00–12:00 & 13:30–15:50, Jumat 09:00–11:30 & 14:00–15:50 WIB.
- ARB 7% berlaku 19 Okt – 31 Des 2026 (Rp11–14: Rp1); mulai 2027 rencana simetris = ARA. Ubah
  `IDX_LIMIT_RULES` di `lib/markets.js` kalau ada pengumuman baru.
- Libur bursa 2027 masih dari kalender yang beredar; perbarui `IDX_HOLIDAYS` setelah BEI resmi.

## Time Machine

Sisa hari diulang 10.000x: tiap bar 5 menit diambil acak dari bar di jam yang sama (±2 bar) pada
59 sesi terakhir saham itu, dengan bar pembukaan sesi 1 & 2 diperlakukan khusus (gap setelah
istirahat), dibatasi ARA/ARB. Stop & target di bar yang sama dihitung rugi. Ditambah riwayat:
aturan yang sama dijalankan di setiap sesi nyata. Simulasi, bukan prediksi.
