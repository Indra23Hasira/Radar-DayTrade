#!/bin/bash
# Pasang Radar-DayTrade + skill day trading ke ~/apk-radar.
# Aman diulang: tidak menghapus repo radar lain, skill lama dengan nama sama di-backup dulu.
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
APK="${APK_RADAR:-$HOME/apk-radar}"
DEST="$APK/Radar-DayTrade"
SKILLS="$APK/.claude/skills"

say(){ printf "\n\033[1;33m▸ %s\033[0m\n" "$1"; }

command -v node >/dev/null || { echo "Node.js belum terpasang. Install dulu: https://nodejs.org"; exit 1; }
mkdir -p "$APK"

say "1/5 Salin project ke $DEST"
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  (cd "$SRC" && tar --exclude ".git" --exclude ".DS_Store" -cf - .) | (cd "$DEST" && tar -xf -)
fi
echo "   ok"

say "2/5 Pasang skill ke $SKILLS"
mkdir -p "$SKILLS"
STAMP=$(date +%Y%m%d-%H%M%S)
for d in "$DEST"/skills/trader-* "$DEST"/skills/radar-daytrade; do
  name=$(basename "$d")
  if [ -d "$SKILLS/$name" ]; then
    mkdir -p "$APK/.claude/skills-backup-$STAMP"
    mv "$SKILLS/$name" "$APK/.claude/skills-backup-$STAMP/"
  fi
  cp -R "$d" "$SKILLS/$name"
  echo "   + $name"
done
cp "$DEST/skills/LICENSE-day-trader-skill" "$SKILLS/" 2>/dev/null || true

say "3/5 Tes mesin (offline)"
(cd "$DEST" && node --test --test-reporter=tap tests/*.test.js 2>&1 | grep -E "^# (pass|fail)") || echo "   (tes dilewati, lanjut)"

say "4/5 Tambah divisi Radar DayTrade di Kantor AI (kalau ada)"
TEAM=$(find "$APK" -maxdepth 3 -name team.json -not -path "*/node_modules/*" 2>/dev/null | head -1)
if [ -n "$TEAM" ]; then
  cp "$TEAM" "$TEAM.bak-$STAMP"
  node -e '
    const fs=require("fs"), f=process.argv[1], t=JSON.parse(fs.readFileSync(f,"utf8"));
    if(!Array.isArray(t.divisi)){ console.log("   format team.json tidak dikenal, dilewati"); process.exit(0); }
    if(t.divisi.some(d=>d.id==="daytrade")){ console.log("   sudah ada, dilewati"); process.exit(0); }
    const div={ id:"daytrade", nama:"Radar DayTrade", folder:"Radar-DayTrade", warna:"#E8A33D", karyawan:[
      { id:"mesin-dt", nama:"Mesin Intraday", kata:["engine","markets","cli"] },
      { id:"penguji-dt", nama:"Penguji DayTrade", kata:["test","fixtures"] },
      { id:"skill-dt", nama:"Staf Skill Trading", kata:["skills/","skill.md"] },
      { id:"pemindai-dt", nama:"Pemindai DayTrade", kata:["index"], utama:true } ] };
    const i=t.divisi.findIndex(d=>d.id==="umum");
    i<0 ? t.divisi.push(div) : t.divisi.splice(i,0,div);
    fs.writeFileSync(f, JSON.stringify(t,null,2)); console.log("   + divisi daytrade di "+f);
  ' "$TEAM"
else
  echo "   team.json tidak ditemukan, dilewati"
fi

say "5/5 GitHub"
cd "$DEST"
VER=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
if [ ! -d .git ]; then
  git init -q -b main
  git add -A
  git commit -q -m "Radar-DayTrade v$VER: app day trade IDX + US, mesin ORB/Time Machine, skill Claude Code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XPVSZABorv78pfjy6B52y7"
  echo "   repo lokal dibuat (commit pertama)"
elif [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "Radar-DayTrade v$VER: update

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XPVSZABorv78pfjy6B52y7"
  echo "   perubahan v$VER di-commit"
else
  echo "   tidak ada perubahan file"
fi
if git remote get-url origin >/dev/null 2>&1; then
  # repo GitHub sudah tersambung: kirim update, GitHub Pages ikut ter-update dalam 1-2 menit
  if git push -q origin main 2>/dev/null || git push origin main; then
    echo "   terkirim ke GitHub. App online ter-update dalam 1-2 menit (refresh halaman)."
  else
    echo "   push gagal — jalankan manual: cd \"$DEST\" && git push origin main"
  fi
elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  read -r -p "   Buat repo PUBLIK Indra23Hasira/Radar-DayTrade di GitHub & aktifkan Pages? (y/n) " ans
  if [ "$ans" = "y" ]; then
    gh repo view Indra23Hasira/Radar-DayTrade >/dev/null 2>&1 || gh repo create Indra23Hasira/Radar-DayTrade --public --source=. --remote=origin
    git remote get-url origin >/dev/null 2>&1 || git remote add origin https://github.com/Indra23Hasira/Radar-DayTrade.git
    git push -u origin main
    gh api -X POST repos/Indra23Hasira/Radar-DayTrade/pages -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
      && echo "   Pages aktif: https://indra23hasira.github.io/Radar-DayTrade/ (tunggu 1-2 menit)" \
      || echo "   Aktifkan Pages manual: Settings > Pages > branch main / root"
  fi
else
  echo "   GitHub CLI (gh) tidak ada/belum login. Manual:"
  echo "   1) Buat repo kosong 'Radar-DayTrade' di github.com (akun Indra23Hasira)"
  echo "   2) cd \"$DEST\" && git remote add origin https://github.com/Indra23Hasira/Radar-DayTrade.git && git push -u origin main"
  echo "   3) Settings > Pages > branch main / root"
fi

printf "\n\033[1;32mSelesai.\033[0m Langkah terakhir: tempel isi firestore.rules.daytrade ke Firestore Rules project radar-idx-hasira.\n"
printf "Coba skill: cd \"%s\" && claude, lalu ketik: scan day trade BBRI,BBCA,EMAS\n\n" "$APK"
