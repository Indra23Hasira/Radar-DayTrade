# Pindah laptop — APK RADAR

Rencana: pindah dari MacBook kantor (akun "ddp") ke laptop pribadi, perkiraan **September 2027**.

## Yang TIDAK perlu dipindah

- **App online** (GitHub Pages) jalan di perangkat mana pun: https://indra23hasira.github.io/Radar-DayTrade/
- **Kode** ada di GitHub akun Indra23Hasira (Radar-IDX-Hasira, Radar-US, Radar-Konglo, Radar-Pengendali, Radar-DayTrade).
- **Data** (pengaturan, watchlist, jurnal trade, data radar) ada di Firestore, ikut akun login.
- Nama "Ddp" di commit lama hanya label dari setting git laptop kantor — tidak perlu diubah.

## Yang ADA di laptop dan perlu dipindah

| Barang | Lokasi di laptop lama | Cara pindah |
| --- | --- | --- |
| Salinan repo | `~/apk-radar/<repo>` | clone ulang dari GitHub (otomatis oleh script) |
| Skill Claude Code (12) | `~/apk-radar/.claude/skills` | dipasang ulang oleh `install.sh` |
| Kantor AI + hooks | `~/apk-radar/.kantor-ai`, `~/apk-radar/.claude/settings.json`, `~/kantor-tes` | ikut file backup |
| Token GitHub | Keychain Mac | **jangan dipindah** — buat token baru |

## Langkah (3 perintah)

**Di laptop LAMA** (sebelum diserahkan):
```
bash ~/apk-radar/Radar-DayTrade/pindah-laptop.sh backup
```
Script mengecek repo yang belum di-push, lalu membuat `~/Desktop/apk-radar-backup-TANGGAL.zip`.
Kirim file itu ke laptop baru (AirDrop / Google Drive).

**Di laptop BARU**:
1. Pasang `xcode-select --install` (git), Node.js LTS dari nodejs.org, dan Claude Code.
2. Jalankan:
```
curl -fsSL https://raw.githubusercontent.com/Indra23Hasira/Radar-DayTrade/main/pindah-laptop.sh -o pindah-laptop.sh
bash pindah-laptop.sh pasang ~/Downloads/apk-radar-backup-TANGGAL.zip
```
3. Buat token GitHub baru (github.com/settings/tokens/new, centang **repo**) — dipakai saat push pertama
   (username `Indra23Hasira`, password = token).

## Bersihkan laptop kantor (WAJIB)

- Hapus token GitHub lama di github.com/settings/tokens (token itu bisa menulis ke SEMUA repo).
- Logout Radar DayTrade, Radar IDX, GitHub, Firebase di browser.
- Hapus kredensial Keychain: `printf 'protocol=https\nhost=github.com\n' | git credential-osxkeychain erase`
- Opsional: hapus folder `~/apk-radar` dan `~/kantor-tes`.

## Skenario: laptop kantor di-reset dulu, Mac baru di rumah (beda negara)

Laptop dikembalikan (perkiraan Agustus 2027) dan di-reset total sebelum Mac pribadi tersedia.
Tidak ada waktu di mana kedua laptop menyala bersamaan, jadi:

**Sebelum reset (di laptop kantor):**
1. `bash ~/apk-radar/Radar-DayTrade/pindah-laptop.sh backup` — semua baris harus ✓ (tidak ada repo belum di-push).
2. Upload `~/Desktop/apk-radar-backup-TANGGAL.zip` ke **Google Drive / iCloud pribadi** (atau email ke diri sendiri).
   Buka dari HP untuk memastikan file benar-benar ada **sebelum** menekan reset.
3. Hapus token GitHub lama di github.com/settings/tokens (bisa juga dari HP setelahnya).
4. Reset Mac (menghapus Keychain, login browser, dan semua file sekaligus).

**Selama belum ada laptop:** app online tetap jalan dari HP (Fold / iPhone); semua data di Firestore & GitHub aman.
Yang tidak bisa sementara: skill Claude Code & Kantor AI (butuh laptop).

**Di Mac baru (kapan pun):** unduh file backup dari Drive/iCloud ke folder Downloads, lalu ikuti
"Di laptop BARU" di atas. Langkahnya sama persis.

## Kalau ada yang berubah sebelum pindah

Repo baru ditambah? Tambahkan namanya di baris `REPOS=` dalam `pindah-laptop.sh`, lalu commit.
