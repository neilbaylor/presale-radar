/**
 * Presale code finder.
 *
 * Sources, best first:
 *  1. Ticketmaster's own presale descriptions ("use code XYZ")       -> scope 'sale'
 *  2. Official help pages that publish the Live Nation password        -> scope 'livenation'
 *  3. Web search per upcoming presale (Brave Search API), top pages    -> scope 'artist'
 *  4. Fan posts on Reddit and Bluesky, where leaks show up first       -> scope 'artist'
 *  5. Pages you add yourself                                          -> scope 'artist'
 *
 * Every candidate gets a 0..1 score from how it was phrased ("code is X"
 * beats "X" somewhere nearby), how many different sites mention it, and
 * your own worked / didn't-work votes.
 */
import type { Ctx } from './types.js';
import { confidenceLabel, getAllFollows, getSetting, interest, now, setSetting, userEventMap } from './db.js';
import { demoCodePage, demoSearch } from './demo.js';
import { enqueue } from './notify.js';
import { canSpend, spend } from './budget.js';
import { feedbackAdjust, recencyFactor, searchBluesky, searchReddit, tourWordBoost, type SocialPost } from './social.js';

// ---------------------------------------------------------------- extraction

const STOPWORDS = new Set(
  `LIVE NATION PRESALE PRESALES PASSWORD PASSWORDS PASSCODE CODE CODES USE USED USING THE AND FOR YOU YOUR NOT ARE THIS THAT WITH
   FROM HAVE WILL CAN GET GOT TICKET TICKETS TICKETMASTER VIP USA CANADA ET PT CT MT EST EDT PST PDT AM PM FAQ NEED HTML
   HTTP HTTPS WWW COM NEW TOUR TOURS SHOW SHOWS CONCERT CONCERTS EVENT EVENTS DATE DATES TIME TODAY TOMORROW MONDAY TUESDAY
   WEDNESDAY THURSDAY FRIDAY SATURDAY SUNDAY JAN FEB MAR APR MAY JUN JUL AUG SEP SEPT OCT NOV DEC JANUARY FEBRUARY MARCH
   APRIL JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER ONSALE SALE SALES OFFER OFFERS ARTIST FAN FANS CLUB SPOTIFY
   AMEX VISA MASTERCARD EMAIL TEXT APP MOBILE LOGIN SIGN UPDATE UPDATED EDIT REPLY POST POSTS QUOTE LINK WORKED WORKS
   WORKING TRY TRIED THANKS THANK HELP OFFICIAL VERIFIED CONFIRMED UNVERIFIED NONE ALSO ANY ONLY JUST ARENA STAGE HALL
   CENTRE CENTER THEATRE THEATER WHAT WHEN WHERE WHO WHY HOW DOES DID ANYONE KNOW HERE THERE THEN THAN BEEN WERE WAS
   SOME MORE MOST BEST FREE SEATS SEAT FLOOR GA PIT CAD USD TAX FEES PRICE PRICES COST LIMIT RESALE PLATINUM GENERAL
   ADMISSION PUBLIC EARLY ACCESS REGISTRATION REGISTER UPGRADE MERCH ALBUM RADIO VENUE LOCAL PROMOTER MEMBER MEMBERS
   ACCOUNT CLICK CHECK NOTE IMPORTANT INFO DETAILS READ MENU HOME SEARCH COOKIES PRIVACY TERMS SUBSCRIBE SHARE TWEET
   ONTARIO TORONTO INSTAGRAM TWITTER FACEBOOK REDDIT TIKTOK YOUTUBE NEWS FWIW IIRC IMHO LMAO LMFAO YALL BLUESKY
   DELETED REMOVED SUBREDDIT THREAD COMMENT COMMENTS UPVOTE MODS`
    .split(/\s+/)
    .filter(Boolean),
);

const TOKEN = /\b[A-Z0-9][A-Z0-9_-]{3,19}\b/g;
const STRONG_BEFORE = /(code|password|passcode|pass code|pw)\s*(is|was|=|:|-|–|—)?\s*(is\s*)?["'“‘(]?\s*$/i;
const USE_BEFORE = /\b(use|try|enter|it'?s|its)\s*(code\s*)?["'“‘(]?\s*$/i;
const KEYWORD = /code|password|passcode|presale/i;

export function looksLikeCode(tok: string): boolean {
  if (!/[A-Z]/.test(tok)) return false; // pure numbers: prices, years, phone numbers
  if (/^(19|20)\d\d[A-Z]{0,2}$/.test(tok)) return false;
  if (/^\d+(AM|PM|ET|PT|K)$/.test(tok)) return false;
  if (STOPWORDS.has(tok)) return false;
  if (/^[A-Z]{1,3}\d{1,3}$/.test(tok) && tok.length <= 4) return false; // seat/section labels like A12
  return true;
}

/** How strongly the surrounding text says "this is a code". */
export function phraseStrength(text: string, index: number): number {
  const before = text.slice(Math.max(0, index - 40), index);
  if (STRONG_BEFORE.test(before)) return 0.9;
  if (USE_BEFORE.test(before) && KEYWORD.test(text.slice(Math.max(0, index - 120), index + 60))) return 0.75;
  const near = text.slice(Math.max(0, index - 80), index + 80);
  if (KEYWORD.test(near)) return 0.45;
  return 0.15;
}

export interface Candidate {
  code: string;
  strength: number;
  snippet: string;
}

export interface Occurrence {
  code: string;
  index: number;
  strength: number;
}

const ENGLISH = new Set(
  'below above here there sent soon required needed coming tomorrow today later tonight unknown none email inbox spam provided available attached included shown listed'.split(' '),
);

/** Codes are usually CAPS, but "code: Spring2026" or "password is “harbour”" count too. */
function acceptToken(tok: string, quoted: boolean): boolean {
  const up = tok.toUpperCase();
  if (STOPWORDS.has(up) || ENGLISH.has(tok.toLowerCase())) return false;
  if (!/[A-Za-z]/.test(tok)) return false;
  if (/^(19|20)\d\d$/.test(tok)) return false;
  return quoted || /[A-Z]/.test(tok) || /\d/.test(tok);
}

const STRONG_CAPTURE =
  /(?:\b(?:codes?|passwords?|passcodes?|pass code|pw)\b\s*(?:is|are|was|were|=|:|-|–|—)?\s*(?:is\s*)?|\b(?:use|try|enter)\s+(?:the\s+)?(?:code\s+|password\s+)?)(["'“‘(]?)([A-Za-z0-9][A-Za-z0-9_-]{3,24})["'”’)]?((?:\s*(?:,|\bor\b|\band\b|\/)\s*["'“‘]?[A-Za-z0-9][A-Za-z0-9_-]{3,24}["'”’]?)*)/gi;
const QUOTED = /["“‘]([A-Za-z0-9][A-Za-z0-9_-]{3,24})["”’]/g;

/** Every code-like token in the text, with how strongly the wording says "this is a code". */
export function codeOccurrences(text: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const m of text.matchAll(STRONG_CAPTURE)) {
    const quoted = !!m[1];
    const main = m[2];
    const start = m.index! + m[0].indexOf(main);
    if (acceptToken(main, quoted)) out.push({ code: main, index: start, strength: 0.9 });
    // "use HYPED or SETBREAK" / "codes: ONE, TWO and THREE"
    if (m[3] && out.length && out[out.length - 1].index === start) {
      let offset = m.index! + m[0].length - m[3].length;
      for (const t of m[3].matchAll(/["'“‘]?([A-Za-z0-9][A-Za-z0-9_-]{3,24})["'”’]?/g)) {
        if (!/^(or|and)$/i.test(t[1]) && acceptToken(t[1], /["'“‘]/.test(t[0]))) out.push({ code: t[1], index: offset + t.index!, strength: 0.85 });
      }
    }
  }
  for (const m of text.matchAll(QUOTED)) {
    const near = text.slice(Math.max(0, m.index! - 80), m.index! + m[0].length + 40);
    if (KEYWORD.test(near) && acceptToken(m[1], true)) out.push({ code: m[1], index: m.index! + 1, strength: 0.8 });
  }
  TOKEN.lastIndex = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (!looksLikeCode(m[0])) continue;
    out.push({ code: m[0], index: m.index!, strength: phraseStrength(text, m.index!) });
  }
  // One entry per position, strongest reading wins.
  const byPos = new Map<number, Occurrence>();
  for (const o of out) {
    const prev = byPos.get(o.index);
    if (!prev || o.strength > prev.strength) byPos.set(o.index, o);
  }
  return [...byPos.values()].sort((a, b) => a.index - b.index);
}

/** Code-like tokens in a window of text, each with its best phrasing strength. Case is kept. */
export function candidatesIn(text: string, opts: { exclude?: Set<string> } = {}): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const o of codeOccurrences(text)) {
    const key = o.code.toUpperCase();
    if (opts.exclude?.has(key)) continue;
    const prev = best.get(key);
    if (!prev || o.strength > prev.strength) {
      best.set(key, { code: o.code, strength: o.strength, snippet: text.slice(Math.max(0, o.index - 70), o.index + o.code.length + 50).replace(/\s+/g, ' ').trim() });
    }
  }
  return [...best.values()];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|td|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

/** The Live Nation password from text like "Need the Live Nation presale password? Use HYPED or SETBREAK." */
export function extractLiveNationCodes(text: string): Candidate[] {
  const out = new Map<string, Candidate>();
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  sentences.forEach((s, i) => {
    if (!/live ?nation/i.test(s) || !/password|code/i.test(s)) return;
    const window = `${s} ${sentences[i + 1] ?? ''}`;
    for (const c of candidatesIn(window)) {
      // "Use X or Y" right after the question is the strongest pattern on these pages.
      const strength = Math.max(c.strength, /\b(use|try)\b/i.test(window) ? 0.85 : 0.5);
      const prev = out.get(c.code);
      if (!prev || strength > prev.strength) out.set(c.code, { ...c, strength });
    }
  });
  return [...out.values()];
}

export interface ArtistRef {
  id: string;
  name: string;
}

/**
 * Codes mentioned near an artist's name. Each code is credited to the closest
 * artist mention (so one artist's code doesn't leak onto the next name in a
 * list), and tokens that end up next to three or more artists on one page are
 * page furniture, not codes.
 */
export function extractArtistCodes(text: string, artists: ArtistRef[]): (Candidate & { artistId: string; hits: number })[] {
  const lower = text.toLowerCase();
  const mentions: { artistId: string; start: number; end: number }[] = [];
  const fullNames = new Map<string, string>();
  const nameWords = new Map<string, Set<string>>();
  for (const a of artists) {
    const needle = a.name.toLowerCase().trim();
    if (needle.length < 3) continue;
    fullNames.set(a.id, a.name.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    nameWords.set(a.id, new Set(a.name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)));
    for (let idx = lower.indexOf(needle); idx !== -1; idx = lower.indexOf(needle, idx + needle.length)) {
      // Whole words only: "Lake Effect" shouldn't match "Lake Effects Tour".
      const before = lower[idx - 1];
      const after = lower[idx + needle.length];
      if ((before && /[a-z0-9]/.test(before)) || (after && /[a-z0-9]/.test(after))) continue;
      mentions.push({ artistId: a.id, start: idx, end: idx + needle.length });
    }
  }
  if (!mentions.length) return [];
  mentions.sort((a, b) => a.start - b.start);

  const perArtist = new Map<string, Map<string, Candidate & { artistId: string; hits: number }>>();
  for (const occ of codeOccurrences(text)) {
    const tok = occ.code;
    const pos = occ.index;
    // Credit the closest artist named before the token; only look ahead ("use X for Artist")
    // when nothing was named shortly before it.
    let best: { artistId: string; start: number; dist: number } | null = null;
    for (const mt of mentions) {
      if (mt.end > pos) break;
      const dist = pos - mt.end;
      if (dist <= 300 && (!best || dist < best.dist)) best = { artistId: mt.artistId, start: mt.start, dist };
    }
    if (!best || best.dist > 150) {
      const ahead = mentions.find((mt) => mt.start >= pos + tok.length && mt.start - pos - tok.length <= 40);
      if (ahead) best = { artistId: ahead.artistId, start: ahead.start, dist: ahead.start - pos };
    }
    if (!best || fullNames.get(best.artistId) === tok.toUpperCase()) continue;
    let strength = occ.strength;
    // "IMAGINE DRAGONS presale" isn't a code called DRAGONS, but "the code is DRAGONS" might be.
    if (strength < 0.75 && nameWords.get(best.artistId)?.has(tok.toUpperCase())) continue;
    if (strength < 0.45) {
      const span = text.slice(Math.min(best.start, pos), Math.max(best.start, pos));
      if (!KEYWORD.test(span)) continue;
      strength = 0.3;
    }
    const map = perArtist.get(best.artistId) ?? new Map();
    const snippet = text.slice(Math.max(0, pos - 70), pos + tok.length + 50).replace(/\s+/g, ' ').trim();
    const key = tok.toUpperCase();
    const r = map.get(key) ?? { code: tok, strength, snippet, artistId: best.artistId, hits: 0 };
    r.hits++;
    if (strength > r.strength) Object.assign(r, { code: tok, strength, snippet });
    map.set(key, r);
    perArtist.set(best.artistId, map);
  }

  const artistsPerCode = new Map<string, number>();
  for (const map of perArtist.values()) for (const key of map.keys()) artistsPerCode.set(key, (artistsPerCode.get(key) ?? 0) + 1);
  const out: (Candidate & { artistId: string; hits: number })[] = [];
  for (const map of perArtist.values())
    for (const c of map.values()) if ((artistsPerCode.get(c.code.toUpperCase()) ?? 0) < 3 || c.strength >= 0.9) out.push(c);
  return out.sort((x, y) => y.strength - x.strength || y.hits - x.hits);
}

/** "Use code SPRING" inside Ticketmaster's own presale description. Exact when present. */
export function extractFromDescription(description: string | null): Candidate[] {
  if (!description || !/code|password|passcode/i.test(description)) return [];
  return candidatesIn(description).filter((c) => c.strength >= 0.75);
}

/** Combine evidence: independent sites multiply confidence; a few repeats on one page help a little. */
export function combineScore(evidence: { domain: string; strength: number; hits: number }[], votes = 0): number {
  const byDomain = new Map<string, number>();
  for (const e of evidence) {
    const s = Math.min(0.95, e.strength + Math.min(0.1, (e.hits - 1) * 0.03));
    byDomain.set(e.domain, Math.max(byDomain.get(e.domain) ?? 0, s));
  }
  let miss = 1;
  for (const s of byDomain.values()) miss *= 1 - s * 0.8;
  let score = 1 - miss;
  if (votes > 0) score = Math.max(score, 0.97);
  if (votes < 0) score = 0;
  return Math.round(score * 1000) / 1000;
}

// ---------------------------------------------------------------- storage

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface Found {
  scope: 'livenation' | 'artist' | 'sale';
  key: string;
  code: string;
  strength: number;
  hits: number;
  url: string;
  snippet: string;
  /** Who said it, when that's more specific than the site (one Reddit user, one Bluesky account). */
  domain?: string;
}

/** Merge new evidence into web_codes. Returns codes that are new or just crossed into "medium". */
async function saveFound(ctx: Ctx, found: Found[]): Promise<{ scope: string; key: string; code: string; score: number }[]> {
  const t = now(ctx);
  const promoted: { scope: string; key: string; code: string; score: number }[] = [];
  for (const f of found) {
    const domain = f.domain ?? domainOf(f.url);
    const existing = await ctx.db.one<{ score: number; hits: number; domains: string[]; votes: number }>(
      'SELECT score, hits, domains, votes FROM web_codes WHERE scope = $1 AND key = $2 AND code = $3',
      [f.scope, f.key, f.code],
    );
    const domains = [...new Set([...(existing?.domains ?? []), domain])];
    // Keep a compact evidence model: previous score stands in for earlier domains.
    const prior = existing?.score ?? 0;
    const fresh = combineScore([{ domain, strength: f.strength, hits: f.hits }], existing?.votes ?? 0);
    const score = existing?.domains.includes(domain) ? Math.max(prior, fresh) : combineScore(
      [{ domain: '_prior', strength: prior / 0.8 > 0.95 ? 0.95 : prior / 0.8, hits: 1 }, { domain, strength: f.strength, hits: f.hits }],
      existing?.votes ?? 0,
    );
    await ctx.db.query(
      `INSERT INTO web_codes (scope, key, code, score, hits, domains, source_url, snippet, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (scope, key, code) DO UPDATE SET
         score = $4, hits = web_codes.hits + excluded.hits, domains = $6, last_seen = $9,
         source_url = CASE WHEN $4 > web_codes.score THEN excluded.source_url ELSE web_codes.source_url END,
         snippet = CASE WHEN $4 > web_codes.score THEN excluded.snippet ELSE web_codes.snippet END`,
      [f.scope, f.key, f.code, score, f.hits, domains, f.url, f.snippet.slice(0, 300), t],
    );
    if ((!existing && score >= 0.4) || (existing && prior < 0.4 && score >= 0.4)) promoted.push({ scope: f.scope, key: f.key, code: f.code, score });
  }
  return promoted;
}

// ---------------------------------------------------------------- fetching

export async function fetchPage(ctx: Ctx, url: string, kind: string): Promise<string> {
  if (ctx.cfg.demo) return demoCodePage(kind, url);
  if (!(await canSpend(ctx, 'web'))) throw new Error('Daily page budget used up');
  await spend(ctx, 'web');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9',
        'accept-language': 'en-CA,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text|html|json|xml/.test(type)) throw new Error(`Skipped ${type || 'unknown'} content`);
    return (await res.text()).slice(0, 3_000_000);
  } finally {
    clearTimeout(timer);
  }
}

interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export async function webSearch(ctx: Ctx, query: string): Promise<SearchHit[]> {
  if (ctx.cfg.demo) return demoSearch(query);
  if (!ctx.cfg.braveApiKey) return [];
  const qs = new URLSearchParams({ q: query, count: '10', freshness: 'pm', country: 'CA', search_lang: 'en' });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
    headers: { accept: 'application/json', 'X-Subscription-Token': ctx.cfg.braveApiKey },
  });
  if (!res.ok) throw new Error(`Brave search HTTP ${res.status}`);
  const data: any = await res.json();
  const results = [...(data?.web?.results ?? []), ...(data?.discussions?.results ?? [])];
  return results.map((r: any) => ({
    url: r.url,
    title: r.title ?? '',
    snippet: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' '),
  }));
}

/** Pages not worth opening: Ticketmaster's own app pages, logins, video. */
const SKIP_HOSTS = /(^|\.)(reddit\.com|bsky\.app|ticketmaster\.(ca|com)|livenation\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com|stubhub|vividseats|seatgeek)/i;

// ---------------------------------------------------------------- jobs

/** 1. Codes written into Ticketmaster's own presale descriptions. */
export async function scanDescriptions(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query<{ id: string; description: string }>(
    `SELECT id, description FROM sales
      WHERE kind = 'presale' AND removed = FALSE AND start_utc > $1
        AND description ~* '(code|password|passcode)'`,
    [now(ctx) - 6 * 3_600_000],
  );
  const found: Found[] = [];
  for (const r of rows)
    for (const c of extractFromDescription(r.description))
      found.push({ scope: 'sale', key: r.id, code: c.code, strength: Math.max(c.strength, 0.9), hits: 1, url: 'https://www.ticketmaster.ca/', snippet: c.snippet });
  await saveFound(ctx, found);
  return found.length;
}

/** Artists worth scanning: ones you follow plus headliners with presales in the next 3 weeks. */
async function artistsToScan(ctx: Ctx): Promise<ArtistRef[]> {
  const rows = await ctx.db.query<{ id: string; name: string }>(
    `SELECT a.id, a.name FROM artists a WHERE EXISTS (SELECT 1 FROM user_artists ua WHERE ua.artist_id = a.id AND ua.mode = 'follow')
     UNION
     SELECT DISTINCT e.attraction_ids[1] AS id, e.attraction_names[1] AS name
       FROM events e JOIN sales s ON s.event_id = e.id
      WHERE s.kind = 'presale' AND s.removed = FALSE AND s.start_utc > $1 AND s.start_utc < $2
        AND cardinality(e.attraction_ids) > 0`,
    [now(ctx) - 2 * 3_600_000, now(ctx) + 21 * 86_400_000],
  );
  return rows.filter((r) => r.id && r.name);
}

/** How often to re-scan, tightening as a code-needing presale approaches. */
export function scanIntervalMin(msUntilNextPresale: number | null, baseMin: number): number {
  if (msUntilNextPresale === null) return baseMin;
  if (msUntilNextPresale < 2 * 3_600_000) return 5;
  if (msUntilNextPresale < 48 * 3_600_000) return Math.min(30, baseMin);
  return baseMin;
}

async function nextCodePresale(ctx: Ctx): Promise<number | null> {
  const row = await ctx.db.one<{ start_utc: number }>(
    `SELECT s.start_utc FROM sales s
      WHERE s.kind = 'presale' AND s.removed = FALSE
        AND s.start_utc > $1 AND COALESCE(s.requirement, 'unknown') IN ('code', 'unknown')
      ORDER BY s.start_utc LIMIT 1`,
    [now(ctx) - 2 * 3_600_000],
  );
  return row ? Math.max(0, row.start_utc - now(ctx)) : null;
}

/** 2 + 4. Fixed pages: official Live Nation password pages and pages you added. */
export async function scanSources(ctx: Ctx, opts: { force?: boolean } = {}): Promise<{ checked: number; errors: string[]; promoted: Awaited<ReturnType<typeof saveFound>> }> {
  const t = now(ctx);
  const interval = scanIntervalMin(await nextCodePresale(ctx), ctx.cfg.codeScrapeIntervalMin);
  const sources = await ctx.db.query<{ url: string; kind: string }>(
    `SELECT url, kind FROM code_sources
      WHERE enabled = TRUE AND ($1::boolean OR last_checked IS NULL OR last_checked < $2)`,
    [!!opts.force, t - interval * 60_000],
  );
  const out = { checked: 0, errors: [] as string[], promoted: [] as Awaited<ReturnType<typeof saveFound>> };
  if (!sources.length) return out;
  const artists = await artistsToScan(ctx);

  for (const src of sources) {
    try {
      const text = htmlToText(await fetchPage(ctx, src.url, src.kind));
      const found: Found[] = [];
      if (src.kind === 'livenation') {
        for (const c of extractLiveNationCodes(text))
          found.push({ scope: 'livenation', key: '', code: c.code, strength: c.strength, hits: 1, url: src.url, snippet: c.snippet });
      } else {
        for (const c of extractArtistCodes(text, artists))
          found.push({ scope: 'artist', key: c.artistId, code: c.code, strength: c.strength, hits: c.hits, url: src.url, snippet: c.snippet });
      }
      out.promoted.push(...(await saveFound(ctx, found)));
      await ctx.db.query('UPDATE code_sources SET last_checked = $1, last_error = NULL, last_found = $2 WHERE url = $3', [t, found.length, src.url]);
      out.checked++;
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 200);
      out.errors.push(`${src.url}: ${msg}`);
      await ctx.db.query('UPDATE code_sources SET last_checked = $1, last_error = $2 WHERE url = $3', [t, msg, src.url]);
    }
  }
  return out;
}

/** Turn one source's text into scored finds for a search plan. */
function findsIn(text: string, p: Plan, url: string, domain: string | null, weight: number, replies = ''): Found[] {
  const out: Found[] = [];
  if (weight <= 0) return out;
  const fb = feedbackAdjust(replies);
  for (const c of extractArtistCodes(text, [{ id: p.artistId, name: p.artist }])) {
    const strength = Math.max(0, Math.min(0.95, c.strength * weight + fb + tourWordBoost(c.code, p.eventNames, p.artist)));
    if (strength < 0.2) continue;
    out.push({ scope: 'artist', key: p.artistId, code: c.code, strength, hits: c.hits, url, snippet: c.snippet, domain: domain ?? undefined });
  }
  return out;
}

interface Plan {
  artistId: string;
  artist: string;
  saleName: string;
  city: string | null;
  startUtc: number;
  saleId: string;
  eventNames: string[];
}

async function dueSearch(ctx: Ctx, query: string, everyMin: number): Promise<boolean> {
  const last = await ctx.db.one<{ ran_at: number }>('SELECT ran_at FROM code_searches WHERE query = $1', [query]);
  return !last || now(ctx) - last.ran_at >= everyMin * 60_000;
}

async function recordSearch(ctx: Ctx, query: string, saleId: string, results: number) {
  await ctx.db.query(
    `INSERT INTO code_searches (query, sale_id, ran_at, results) VALUES ($1, $2, $3, $4)
     ON CONFLICT (query) DO UPDATE SET ran_at = $3, results = $4, sale_id = $2`,
    [query, saleId, now(ctx), results],
  );
}

/** 3 + 4. Search the web and fan posts for each presale that still needs a code. */
export async function searchForCodes(ctx: Ctx): Promise<{ searches: number; promoted: Awaited<ReturnType<typeof saveFound>>; errors: string[] }> {
  const out = { searches: 0, promoted: [] as Awaited<ReturnType<typeof saveFound>>, errors: [] as string[] };
  const t = now(ctx);

  const sales = await ctx.db.query<{ id: string; name: string; start_utc: number; artist_id: string; artist: string; city: string | null; ename: string }>(
    `SELECT s.id, s.name, s.start_utc, e.attraction_ids[1] AS artist_id, e.attraction_names[1] AS artist, e.city, e.name AS ename
       FROM sales s JOIN events e ON e.id = s.event_id
      WHERE s.kind = 'presale' AND s.removed = FALSE
        AND s.start_utc > $1 AND s.start_utc < $2
        AND COALESCE(s.requirement, 'unknown') IN ('code', 'unknown')
        AND NOT (s.name ~* 'live ?nation')
        AND cardinality(e.attraction_ids) > 0
        AND NOT EXISTS (SELECT 1 FROM web_codes w WHERE w.scope = 'sale' AND w.key = s.id AND w.score >= 0.85)
      ORDER BY s.start_utc`,
    [t - 2 * 3_600_000, t + 10 * 86_400_000],
  );

  // One search plan per artist + presale type (tour dates share codes), soonest first.
  const plans = new Map<string, Plan>();
  for (const s of sales) {
    const k = `${s.artist_id}|${s.name.toLowerCase()}`;
    const p = plans.get(k) ?? { artistId: s.artist_id, artist: s.artist, saleName: s.name, city: s.city, startUtc: s.start_utc, saleId: s.id, eventNames: [] };
    if (!p.eventNames.includes(s.ename)) p.eventNames.push(s.ename);
    plans.set(k, p);
  }

  // Fan posts: once per artist, most often in the hours before a presale, when leaks appear.
  const socialDone = new Set<string>();
  for (const p of plans.values()) {
    if (socialDone.has(p.artistId)) continue;
    socialDone.add(p.artistId);
    const until = p.startUtc - t;
    const everyMin = until < 3 * 3_600_000 ? 10 : until < 48 * 3_600_000 ? 30 : 6 * 60;
    for (const [source, run] of [
      ['reddit', () => searchReddit(ctx, p.artist, until < 48 * 3_600_000 ? 4 : 2)],
      ['bluesky', () => searchBluesky(ctx, p.artist)],
    ] as [string, () => Promise<SocialPost[]>][]) {
      const q = `${source}:${p.artist}`;
      if (!(await dueSearch(ctx, q, everyMin))) continue;
      try {
        const posts = await run();
        const found = posts.flatMap((post) => findsIn(post.text, p, post.url, post.domain, recencyFactor(post.createdMs, t), post.replies));
        out.promoted.push(...(await saveFound(ctx, found)));
        await recordSearch(ctx, q, p.saleId, posts.length);
        out.searches++;
      } catch (err: any) {
        out.errors.push(`${source} "${p.artist}": ${String(err?.message ?? err).slice(0, 120)}`);
        await recordSearch(ctx, q, p.saleId, 0);
      }
    }
  }

  if (!ctx.cfg.braveApiKey && !ctx.cfg.demo) return out;
  for (const p of plans.values()) {
    const until = p.startUtc - t;
    const everyMin = until < 2 * 3_600_000 ? 10 : until < 48 * 3_600_000 ? 60 : 12 * 60;
    const tour = p.eventNames.find((n) => n.toLowerCase() !== p.artist.toLowerCase() && n.toLowerCase().includes(p.artist.toLowerCase()));
    const queries = [`"${p.artist}" presale code`, `"${p.artist}" "${p.saleName}" code ${p.city ?? ''}`.trim()];
    // Close to the sale, spend a little more of the daily search budget on it.
    if (until < 48 * 3_600_000) queries.push(tour ? `"${tour}" presale password` : `"${p.artist}" presale password`);
    for (const q of queries) {
      if (!ctx.cfg.demo && !(await canSpend(ctx, 'brave'))) break;
      if (!(await dueSearch(ctx, q, everyMin))) continue;
      try {
        const hits = await webSearch(ctx, q);
        if (!ctx.cfg.demo) await spend(ctx, 'brave');
        out.searches++;
        const found: Found[] = [];
        // Search snippets often contain the code already.
        for (const h of hits) found.push(...findsIn(`${h.title}. ${h.snippet}`, p, h.url, null, 0.9));
        // Then open the most promising pages; Reddit threads are read through the Reddit source.
        const pages = hits.filter((h) => !SKIP_HOSTS.test(domainOf(h.url))).slice(0, 4);
        for (const h of pages) {
          try {
            found.push(...findsIn(htmlToText(await fetchPage(ctx, h.url, 'generic')), p, h.url, null, 1));
          } catch (err: any) {
            out.errors.push(`${domainOf(h.url)}: ${String(err?.message ?? err).slice(0, 80)}`);
          }
        }
        out.promoted.push(...(await saveFound(ctx, found)));
        await recordSearch(ctx, q, p.saleId, hits.length);
      } catch (err: any) {
        out.errors.push(`search "${q}": ${String(err?.message ?? err).slice(0, 120)}`);
      }
    }
  }
  return out;
}

/** Run every code source and tell you about useful finds. */
export async function findCodes(ctx: Ctx, opts: { force?: boolean } = {}) {
  await scanDescriptions(ctx);
  const sources = await scanSources(ctx, opts);
  const search = await searchForCodes(ctx);
  const promoted = [...sources.promoted, ...search.promoted];
  await announce(ctx, promoted);
  return { checked: sources.checked, searches: search.searches, newCodes: promoted.length, errors: [...sources.errors, ...search.errors] };
}

/**
 * Tell the people who'd use a newly found code: anyone with a matching presale
 * they care about in the next 48 hours. Everyone else just sees it in the app.
 */
async function announce(ctx: Ctx, promoted: { scope: string; key: string; code: string; score: number }[]) {
  if (!promoted.length) return;
  const t = now(ctx);
  const upcoming = await ctx.db.query<{ id: string; name: string; event_id: string; venue_id: string | null; attraction_ids: string[]; attraction_names: string[]; ename: string }>(
    `SELECT s.id, s.name, s.event_id, e.venue_id, e.attraction_ids, e.attraction_names, e.name AS ename
       FROM sales s JOIN events e ON e.id = s.event_id
      WHERE s.kind = 'presale' AND s.removed = FALSE AND s.start_utc > $1 AND s.start_utc < $2`,
    [t - 2 * 3_600_000, t + 48 * 3_600_000],
  );
  if (!upcoming.length) return;
  const [follows, ue] = await Promise.all([getAllFollows(ctx), userEventMap(ctx, upcoming.map((s) => s.event_id))]);
  for (const p of promoted) {
    if (p.score < 0.4) continue;
    const matches = upcoming.filter((s) =>
      p.scope === 'livenation' ? /live ?nation/i.test(s.name) : p.scope === 'sale' ? s.id === p.key : !/live ?nation/i.test(s.name) && s.attraction_ids.includes(p.key),
    );
    for (const [uid, f] of follows) {
      const sale = matches.find((s) => {
        const st = ue.get(`${uid}:${s.event_id}`);
        return !st?.got_tickets && interest(s, st, f).level === 'remind';
      });
      if (!sale) continue;
      const who = sale.attraction_names[0] ?? sale.ename;
      await enqueue(ctx, uid, {
        type: 'code_found',
        priority: 'instant',
        dedupeKey: `code:${p.scope}:${p.key}:${p.code}`,
        eventId: sale.event_id,
        saleId: sale.id,
        title: `Code for ${who}: ${p.code}`,
        body: `${sale.name} · ${confidenceLabel(p.score)} confidence, found online`,
      });
    }
  }
}
