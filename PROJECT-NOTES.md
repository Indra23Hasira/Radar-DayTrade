# Radar DayTrade — catatan proyek (untuk chat berikutnya)

Repo: github.com/Indra23Hasira/Radar-DayTrade (publik) · App: https://indra23hasira.github.io/Radar-DayTrade/
Lokal: ~/apk-radar/Radar-DayTrade (laptop kantor "ddp"; rencana pindah ±Sep 2027 → PINDAH-LAPTOP.md).
Firebase: menumpang project `radar-idx-hasira` (login sama dengan Radar IDX). Koleksi `daytrade*` milik app ini.

## Keputusan Indra
- Project terpisah dari Radar IDX/US (itu untuk swing/jangka panjang); app ini khusus day trade, tab IDX + US.
- IDX: gaya "beli pagi jual siang" (mode default jual akhir sesi 1). Universe otomatis: nilai transaksi rata-rata ≥ Rp5 miliar.
- US: mode "jual besok" — beli s.d. 23:30 WIB, jual paling lambat 23:30 WIB hari bursa berikutnya. Akun IBKR **cash**,
  paket IBKR Pro (Fixed: $0,005/lembar, min $1, maks 1%). Universe: S&P 500 + Nasdaq-100.
- Eksekusi **manual** (tidak ada API broker). Sistem otomatis hanya paper + Telegram (bot sama dengan Radar BTC/XAU).
- Evaluasi = forward test jurnal otomatis tanpa pilih-pilih; kriteria lulus: ≥60 trade, avg R ≥ +0,10 setelah fee,
  PF ≥ 1,2, DD ≤ 10R, paruh awal & akhir positif.

## Versi
- v0.1 app + mesin (ORB, Time Machine, sizing lot/fraksi/ARA-ARB, risk gate, jurnal) + 11 skill asli + skill radar-daytrade.
- v0.2 filter "terlalu jauh", mode di samping Scan, keterangan breakout di luar jendela.
- v0.2.1 pindah-laptop.sh + PINDAH-LAPTOP.md.
- v0.3 US "jual besok" (gap semalam di Time Machine, komisi IBKR, cek laporan keuangan, bracket GTC).
- v0.4 runner otomatis GitHub Actions (runner/, .github/workflows/), dashboard Mode otomatis + rapor kelayakan,
  arsip bar harian di data/bars/. Setup: SETUP-OTOMATIS.md.
- v0.4.1 (9 Nov 2026) runner tahan kuota Firestore habis: salinan jurnal terenkripsi data/daytrade/state-<pasar>.enc
  (kunci dari secret service account) + outbox sinkron otomatis; app hemat baca. Mulai v0.4.1 saya (Claude) bisa push
  langsung ke repo kalau diminta; lokal Indra perlu `git pull` / installer (pull --rebase) untuk ikut terbaru.
- v0.4.2 (10 Nov 2026) universe IDX dibaca dari "arsip hemat" Radar IDX (`radarBundles/rolling`, ±4 baca per run,
  dulu ±200); jatuh balik ke query lama kalau arsip tidak ada/usang. Bagian dari penghematan kuota semua app
  (radar-bundle.js di repo Radar-IDX-Hasira, lihat ARSIP-HEMAT.md di sana).

## Temuan
- 9 Nov 2026: kuota harian Firestore Spark project radar-idx-hasira HABIS (RESOURCE_EXHAUSTED). Penyebab: Radar IDX
  membaca histori per saham (Step 4 ±17rb, Backtest ±30rb, Diagnosa 120 hari >80rb baca). Kuota dipakai bersama,
  reset tengah malam waktu Pasifik = 15:00 WIB (Mar–Nov) / 16:00 WIB (Nov–Mar). Diperbaiki 10 Nov dengan arsip hemat.
- 9–10 Nov 2026: jadwal cron GitHub Actions terlambat berjam-jam (US bagian 1 jalan 05:41 WIB; IDX 08:15 belum jalan
  09:14 WIB) → hari itu IDX dijalankan manual (workflow_dispatch).
- 10 Nov 2026: pemicu utama dipindah ke **cron-job.org** (akun Indra, zona Asia/Jakarta, notifikasi email kalau gagal):
  "DayTrade IDX sesi 1" `15 8 * * 1-5` dan "DayTrade US sesi 1" `45 19 * * 1-5`, POST ke
  api.github.com/repos/Indra23Hasira/Radar-DayTrade/actions/workflows/<daytrade-idx|daytrade-us>.yml/dispatches,
  body {"ref":"main","inputs":{"part":"1","dry_run":"false"}}, header Authorization: Bearer <fine-grained token
  "cron-job daytrade", hanya repo Radar-DayTrade, Actions read/write, tanpa kedaluwarsa>. Cron GitHub tetap sebagai
  cadangan (runner idempoten). Bagian 2 tidak dijadwalkan di cron-job.org (mode sesi1 / jual besok tidak butuh).
  Respons GitHub menyebut API versi 2022-11-28 "sunset" 10 Mar 2028 → sebelum itu cek/ubah header versi API.
- Fee IDX (0,15% + 0,25%) menggerus R: 2R kotor bisa jadi ±1,2R bersih → stop sempit sering tidak layak.
- Contoh nyata: TSLA 4→5 Nov 2026 gap di bawah stop → −2,47R (stop tidak melindungi dari gap).
- Data Yahoo IDX intraday tampak terlambat beberapa menit; runner mencatat keterlambatan per sinyal.
- Aturan BEI ARB 7% sementara s.d. 31 Des 2026; rencana 2027 simetris — perbarui IDX_LIMIT_RULES bila BEI mengumumkan.
