/**
 * Reads dates written for people: "Wednesday, January 21, 2026 at 10:00 p.m.",
 * "Jan 21 at 10am ET", "Friday 23 January 2026, 10:00". Times are treated as
 * wall-clock time in the given time zone (Ticketmaster says "local venue time").
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const ZONES: Record<string, string> = {
  et: 'America/Toronto', est: 'America/Toronto', edt: 'America/Toronto', eastern: 'America/Toronto',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
};

/** Milliseconds to add to UTC to get wall time in `timeZone` at instant `ms`. */
export function tzOffset(ms: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
    .formatToParts(new Date(ms))
    .reduce<Record<string, number>>((a, x) => (x.type !== 'literal' && (a[x.type] = Number(x.value)), a), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in a zone to a UTC instant (handles DST). */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d, h, min);
  const first = guess - tzOffset(guess, timeZone);
  return guess - tzOffset(first, timeZone);
}

export interface ParsedDate {
  utc: number;
  hasTime: boolean;
  index: number; // where in the text it was found
  text: string;
}

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const TIME_RE = '(?:\\s*(?:at|@|,|from|-|–)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?|noon|midnight)?)?';
const ZONE_RE = '(?:\\s*(local(?: venue)? time|et|est|edt|ct|cst|cdt|mt|mst|mdt|pt|pst|pdt|eastern|central|mountain|pacific)\\b)?';

// "January 21, 2026 at 10:00 p.m." / "Jan 21 10am"
const MDY = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?${TIME_RE}${ZONE_RE}`, 'gi');
// "21 January 2026, 10:00"
const DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s*(\\d{4}))?${TIME_RE}${ZONE_RE}`, 'gi');

function toHour(hRaw: string | undefined, ampm: string | undefined): number | null {
  if (ampm && /noon/i.test(ampm)) return 12;
  if (ampm && /midnight/i.test(ampm)) return 0;
  if (hRaw === undefined) return null;
  let h = Number(hRaw);
  if (h > 23) return null;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  return h;
}

/**
 * Every date in `text`. A date without a year is taken as the next occurrence
 * on or after `ref` (minus a day of slack). `defaultHour` fills in a missing time.
 */
export function findDates(text: string, opts: { timeZone: string; ref: number; defaultHour?: number; defaultMinute?: number }): ParsedDate[] {
  const out: ParsedDate[] = [];
  const add = (m: RegExpExecArray, monthName: string, dayRaw: string, yearRaw: string | undefined, hRaw: string | undefined, minRaw: string | undefined, ampm: string | undefined, zoneRaw: string | undefined) => {
    const month = MONTHS[monthName.toLowerCase().replace(/\.$/, '')] ?? MONTHS[monthName.toLowerCase().slice(0, 3)];
    const day = Number(dayRaw);
    if (month === undefined || day < 1 || day > 31) return;
    // A bare number after the date is only a time if it has a.m./p.m. or minutes.
    const timeIsReal = hRaw !== undefined && (ampm || minRaw !== undefined);
    let hour = timeIsReal ? toHour(hRaw, ampm) : ampm && /noon|midnight/i.test(ampm) ? toHour(undefined, ampm) : null;
    let minute = timeIsReal ? Number(minRaw ?? 0) : 0;
    // "...January 23, 2026 and runs from 10:00 a.m." / "Feb 3 at noon PT": a time shortly after the date.
    if (hour === null) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const t = after.match(/^[\s,]*(?:and\s+)?(?:(?:it\s+)?(?:runs|begins|starts|opens)\s+)?(?:from|at|@)?\s*(?:(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)|(noon|midnight))\s*(local(?: venue)? time|et|est|edt|ct|cst|cdt|mt|mst|mdt|pt|pst|pdt|eastern|central|mountain|pacific)?\b/i);
      if (t) {
        hour = t[4] ? toHour(undefined, t[4]) : toHour(t[1], t[3]);
        minute = t[4] ? 0 : Number(t[2] ?? 0);
        if (t[5] && !zoneRaw) zoneRaw = t[5];
      }
    }
    const zone = zoneRaw ? ZONES[zoneRaw.toLowerCase()] ?? opts.timeZone : opts.timeZone;
    const h = hour ?? opts.defaultHour ?? 0;
    const mi = hour === null ? opts.defaultMinute ?? 0 : minute;
    let year = yearRaw ? Number(yearRaw) : new Date(opts.ref).getUTCFullYear();
    let utc = zonedToUtc(year, month, day, h, mi, zone);
    if (!yearRaw && utc < opts.ref - 86_400_000) utc = zonedToUtc(++year, month, day, h, mi, zone);
    out.push({ utc, hasTime: hour !== null, index: m.index, text: m[0].trim() });
  };
  for (const m of text.matchAll(MDY)) add(m, m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
  for (const m of text.matchAll(DMY)) add(m, m[2], m[1], m[3], m[4], m[5], m[6], m[7]);
  // Keep the longest match where two patterns overlap.
  out.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  return out.filter((d, i) => !out.slice(0, i).some((p) => d.index >= p.index && d.index < p.index + p.text.length));
}
