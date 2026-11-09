# Setup mode otomatis (paper) — Radar DayTrade

Runner jalan sendiri di GitHub Actions (gratis, repo publik), tanpa laptop/browser menyala.
Tugasnya: pilih saham paling aktif → scan opening-range breakout tiap 5 menit → rencana + Time Machine
+ sizing + risk check → **catat otomatis sebagai trade paper** → kirim ke Telegram → nilai hasilnya.
**Tidak pernah mengirim order ke broker.** Eksekusi tetap manual, kalau Anda setuju.

## 1. Perbarui Firestore Rules (sekali)

Firebase Console → project **radar-idx-hasira** → Firestore Database → **Rules**.
Hapus dua blok lama `daytradeSettings` dan `daytradeTrades`, ganti dengan isi `firestore.rules.daytrade`
(satu blok untuk semua koleksi `daytrade…`). Posisinya tetap di dalam `match /databases/{database}/documents { … }`. Klik **Publish**.

## 2. Service account Firebase → secret GitHub

1. Firebase Console → ⚙ **Project settings** → tab **Service accounts** → **Generate new private key** → file JSON terunduh.
2. GitHub → repo **Radar-DayTrade** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `FIREBASE_SERVICE_ACCOUNT_KEY`
   - Secret: tempel **seluruh isi** file JSON tadi (buka dengan TextEdit, Cmd+A, Cmd+C).
3. Hapus file JSON dari Downloads setelahnya. Kunci ini punya akses penuh ke project Firebase — jangan pernah di-commit atau dikirim ke chat.

## 3. Telegram (bot yang sama dengan Radar BTC / Radar XAU)

Tambahkan dua secret lagi di repo Radar-DayTrade (secret tidak bisa disalin antar-repo, isi ulang nilainya):
- `TELEGRAM_BOT_TOKEN` — token bot (dari @BotFather → /mybots → API Token)
- `TELEGRAM_CHAT_ID` — chat ID yang sama dengan alert Radar BTC/XAU

Pesan diberi label `[DayTrade IDX]` / `[DayTrade US]`.

## 4. Uji sekali

GitHub → tab **Actions** → **DayTrade IDX otomatis (paper)** → **Run workflow** → part `1`, dry_run `false`.
- Di luar jam bursa: runner langsung selesai dan Telegram menerima "runner otomatis aktif".
- Kalau gagal: Telegram menerima "runner gagal" + pesan error (maks 1x / 6 jam), dan log ada di tab Actions.

Ulangi untuk **DayTrade US otomatis (paper)**.

## Jadwal (otomatis, Senin–Jumat)

| Workflow | Bagian 1 | Bagian 2 |
| --- | --- | --- |
| IDX | 08:15 WIB → scan sesi 1, jual paling lambat akhir sesi 1 | 12:45 WIB → hanya bekerja kalau Mode = akhir sesi 2 |
| US | 19:45 WIB → scan 21:45–23:30 WIB, menilai posisi semalam s.d. 23:30 WIB | 01:30 WIB → hanya kalau Mode = jual hari ini |

Tiap jadwal punya cadangan +20/25 menit (GitHub kadang menunda cron); cadangan langsung berhenti kalau bagian itu sudah selesai.

## Cara kerja singkat

- **Universe IDX**: saham dengan rata-rata nilai transaksi 20 hari ≥ Rp5 miliar, dibaca dari `tickerRollingStats`
  Radar IDX (hanya dibaca). Upload Excel harian Radar IDX tetap perlu supaya daftar ini segar — ringkasan Telegram memberi
  peringatan kalau datanya lebih dari 5 hari.
- **Universe US**: S&P 500 + Nasdaq-100 (±520 saham).
- **Kandidat**: setelah opening range 15 menit, saham diurutkan menurut aktivitas relatif (nilai transaksi 15 menit pertama
  dibanding rata-rata hariannya); 40 teratas dipantau tiap 5 menit. Watchlist manual **tidak** ikut, supaya uji tetap sistematis.
- **Harga entry paper** = harga bar terakhir saat sinyal terdeteksi + slippage (IDX 1 tick, US 0,05%), bukan harga breakout.
  Data Yahoo bisa terlambat beberapa menit; keterlambatan dicatat per sinyal dan ditampilkan di app.
- **Risk check** sama dengan mode manual, plus untuk US "jual besok": jadwal laporan keuangan dicek otomatis dari Yahoo
  (kalau tidak bisa dicek → BLOCK) dan rugi skenario gap terburuk 60 hari ≤ batas rugi harian.
- **Jurnal**: koleksi `daytradeTrades` (`auto: true`), sinyal di `daytradeSignals`, status runner di `daytradeRunner`.
- **Arsip**: bar 5 menit para kandidat disimpan di `data/bars/` tiap hari (untuk backtest jangka panjang nanti).

## Kriteria lulus (ditetapkan sebelum mulai)

Minimal 60 trade otomatis · rata-rata R ≥ +0,10 setelah fee · profit factor ≥ 1,2 · drawdown terdalam ≤ 10R ·
paruh awal dan paruh akhir sama-sama positif. Lihat panel **Rapor kelayakan** di app atau ringkasan harian Telegram.

## Kalau kuota Firestore habis

Project `radar-idx-hasira` memakai paket gratis (Spark): ±50.000 baca & 20.000 tulis per hari, **dipakai bersama Radar IDX**,
reset tiap **15:00 WIB**. Kalau habis, runner tetap jalan: sinyal & hasil tetap ke Telegram, jurnal disimpan terenkripsi di
`data/daytrade/state-<pasar>.enc` (kunci dari secret service account), lalu disinkron otomatis ke Firestore saat kuota pulih.
Selama itu app belum bisa menampilkan data terbaru. Cek pemakaian: Firebase Console → Firestore → **Usage**.

## Mematikan sementara

App → Pengaturan → hapus centang **Mode otomatis aktif** (per pasar), atau GitHub → Actions → workflow → **Disable workflow**.

## Catatan

- Log GitHub Actions di repo publik bisa dilihat orang lain; runner sengaja tidak menulis angka uang/ukuran posisi di log.
- Batas trade/hari, batas rugi harian, dan modal untuk mode otomatis memakai **Pengaturan** pasar yang sama di app.
