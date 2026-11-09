#!/bin/bash
# Pindah laptop untuk APK RADAR (Radar IDX, US, Konglo, Pengendali, DayTrade + Kantor AI + skill).
#
#   Di laptop LAMA :  bash pindah-laptop.sh backup
#                     -> membuat ~/Desktop/apk-radar-backup-TANGGAL.zip (Kantor AI, setting Claude, skill)
#   Di laptop BARU :  bash pindah-laptop.sh pasang [file-backup.zip]
#                     -> cek alat, set git, clone semua repo, pasang skill, pulihkan Kantor AI
#
# Aman diulang. Tidak menghapus apa pun.
set -e
APK="${APK_RADAR:-$HOME/apk-radar}"
GH="https://github.com/Indra23Hasira"
REPOS="Radar-IDX-Hasira Radar-US Radar-Konglo Radar-Pengendali Radar-DayTrade"
say(){ printf "\n\033[1;33m▸ %s\033[0m\n" "$1"; }
ok(){ printf "   \033[32m✓\033[0m %s\n" "$1"; }
bad(){ printf "   \033[31m✗\033[0m %s\n" "$1"; }

backup() {
  say "Backup dari laptop lama"
  [ -d "$APK" ] || { bad "$APK tidak ada"; exit 1; }
  OUT="$HOME/Desktop/apk-radar-backup-$(date +%Y%m%d).zip"
  cd "$HOME"
  ITEMS=""
  for p in "apk-radar/.kantor-ai" "apk-radar/.claude" "apk-radar/trader" "kantor-tes"; do
    [ -e "$p" ] && ITEMS="$ITEMS $p"
  done
  # Repo yang belum di-push ikut dicek, supaya tidak ada kerja yang tertinggal
  for r in $REPOS; do
    if [ -d "$APK/$r/.git" ]; then
      (cd "$APK/$r"
       [ -n "$(git status --porcelain)" ] && bad "$r punya perubahan belum di-commit"
       git fetch -q origin 2>/dev/null || true
       [ -n "$(git log origin/main..main --oneline 2>/dev/null)" ] && bad "$r punya commit belum di-push (jalankan: cd $APK/$r && git push)"
       true)
    fi
  done
  # shellcheck disable=SC2086
  zip -qr "$OUT" $ITEMS -x "*/node_modules/*" "*/.git/*" "*.DS_Store"
  ok "Backup: $OUT"
  echo "   Pindahkan file itu ke laptop baru (AirDrop / Google Drive / flashdisk)."
  echo
  echo "   Setelah laptop baru siap, BERSIHKAN laptop lama:"
  echo "   1) Hapus token GitHub lama: https://github.com/settings/tokens"
  echo "   2) Logout Radar DayTrade / Radar IDX / GitHub / Firebase di browser"
  echo "   3) Hapus kredensial GitHub dari Keychain: printf 'protocol=https\nhost=github.com\n' | git credential-osxkeychain erase"
}

pasang() {
  ZIP="$1"
  say "1/5 Cek alat"
  local miss=0
  command -v git  >/dev/null && ok "git"  || { bad "git belum ada → jalankan: xcode-select --install"; miss=1; }
  command -v node >/dev/null && ok "node $(node -v)" || { bad "Node.js belum ada → install dari https://nodejs.org (versi LTS)"; miss=1; }
  command -v claude >/dev/null && ok "Claude Code" || bad "Claude Code belum ada (opsional untuk app, wajib untuk skill) → https://claude.com/claude-code"
  [ $miss = 1 ] && { echo; echo "   Pasang yang kurang, lalu jalankan script ini lagi."; exit 1; }

  say "2/5 Identitas git"
  if [ -z "$(git config --global user.name)" ]; then
    git config --global user.name "Indra"
    git config --global user.email "indraanggriawan17@gmail.com"
    ok "diset ke Indra"
  else
    ok "sudah ada: $(git config --global user.name)"
  fi

  say "3/5 Clone repo ke $APK"
  mkdir -p "$APK"
  for r in $REPOS; do
    if [ -d "$APK/$r/.git" ]; then (cd "$APK/$r" && git pull -q --ff-only 2>/dev/null || true); ok "$r (sudah ada, di-update)"
    elif git clone -q "$GH/$r.git" "$APK/$r" 2>/dev/null; then ok "$r"
    else bad "$r gagal di-clone (cek nama repo / koneksi)"; fi
  done
  mkdir -p "$APK/Radar-Crypto"

  say "4/5 Pulihkan Kantor AI & setting dari backup"
  if [ -n "$ZIP" ] && [ -f "$ZIP" ]; then
    (cd "$HOME" && unzip -qo "$ZIP")
    ok "dipulihkan dari $(basename "$ZIP")"
  else
    bad "file backup tidak diberikan — Kantor AI dilewati (bisa dipasang ulang nanti)"
  fi

  say "5/5 Pasang skill day trade"
  bash "$APK/Radar-DayTrade/install.sh" </dev/null || true

  printf "\n\033[1;32mSelesai.\033[0m\n"
  echo "   - App online tidak perlu dipindah: https://indra23hasira.github.io/Radar-DayTrade/"
  echo "   - Untuk push pertama dari laptop ini, buat token baru: https://github.com/settings/tokens/new (centang 'repo')"
  echo "     username Indra23Hasira, password = token."
  echo "   - Mulai kerja: cd \"$APK\" && claude"
}

case "$1" in
  backup) backup ;;
  pasang) pasang "$2" ;;
  *) echo "Pakai: bash pindah-laptop.sh backup   (di laptop lama)"
     echo "       bash pindah-laptop.sh pasang [apk-radar-backup-XXXX.zip]   (di laptop baru)" ;;
esac
