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

## Temuan
- Fee IDX (0,15% + 0,25%) menggerus R: 2R kotor bisa jadi ±1,2R bersih → stop sempit sering tidak layak.
- Contoh nyata: TSLA 4→5 Nov 2026 gap di bawah stop → −2,47R (stop tidak melindungi dari gap).
- Data Yahoo IDX intraday tampak terlambat beberapa menit; runner mencatat keterlambatan per sinyal.
- Aturan BEI ARB 7% sementara s.d. 31 Des 2026; rencana 2027 simetris — perbarui IDX_LIMIT_RULES bila BEI mengumumkan.
