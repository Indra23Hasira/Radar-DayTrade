// Helper waktu bersama (tanpa library): konversi antar zona via Intl.

const _fmt = {};
export function localParts(tsSec, tz) {
  const f = _fmt[tz] || (_fmt[tz] = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }));
  const p = {};
  for (const x of f.formatToParts(new Date(tsSec * 1000))) p[x.type] = x.value;
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, min: hour * 60 + Number(p.minute) };
}

// tanggal + menit lokal zona `tz` -> detik UTC (aman untuk DST)
export function localToSec(date, min, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60) / 1000;
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const [py, pm, pd] = p.date.split("-").map(Number);
    const got = Date.UTC(py, pm - 1, pd, Math.floor(p.min / 60), p.min % 60) / 1000;
    guess += want - got;
  }
  return guess;
}

export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export function parseHHMM(s) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Jam tidak valid: ${s} (format HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
export function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `${HARI[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}/${m}`;
}
