/**
 * Where leaked presale codes actually show up first: fan threads and posts.
 *
 *  - Reddit: search posts from the last month, then read the comments of the
 *    most relevant threads (codes are almost always in comments, often with
 *    "worked!" or "didn't work" replies under them).
 *  - Bluesky: public post search, newest first.
 *  - X: only with X_BEARER_TOKEN, since X charges per post read. Used just in
 *    the two days before a presale and capped per day (X_DAILY_POSTS).
 *
 * Both are public. Neither needs a key, though Reddit often blocks cloud
 * servers without one, so REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (a free
 * "script" app) switch it to Reddit's official API. A source that refuses us
 * (401/403/429) rests for a few hours instead of being hammered.
 */
import type { Ctx } from './types.js';
import { getSetting, now, setSetting } from './db.js';
import { canSpend, spend } from './budget.js';

export interface SocialPost {
  /** Link to the post or comment. */
  url: string;
  /** Where it came from, used as the "site" when combining evidence. Each author counts once. */
  domain: string;
  text: string;
  /** Text of direct replies, to read "worked" / "didn't work". */
  replies: string;
  createdMs: number;
}

const UA = 'PresaleRadar/1.0 (personal presale tracker)';
const COOLDOWN_MS = 6 * 3_600_000;

// ---------------------------------------------------------------- parsing (pure)

/** Reddit search listing -> posts. */
export function parseRedditListing(json: any): (SocialPost & { permalink: string; comments: number })[] {
  const children = json?.data?.children ?? [];
  return children
    .filter((c: any) => c?.kind === 't3' && c.data)
    .map((c: any) => {
      const d = c.data;
      return {
        url: `https://www.reddit.com${d.permalink}`,
        permalink: d.permalink as string,
        domain: `reddit.com/u/${d.author ?? 'unknown'}`,
        text: `${d.title ?? ''}\n${d.selftext ?? ''}`,
        replies: '',
        createdMs: Math.round((d.created_utc ?? 0) * 1000),
        comments: d.num_comments ?? 0,
      };
    });
}

/** Reddit thread ([post, comments]) -> every comment, flattened, with its direct replies' text. */
export function parseRedditThread(json: any): SocialPost[] {
  const out: SocialPost[] = [];
  const walk = (listing: any) => {
    for (const c of listing?.data?.children ?? []) {
      if (c?.kind !== 't1' || !c.data) continue;
      const d = c.data;
      const kids = (d.replies?.data?.children ?? []).filter((k: any) => k?.kind === 't1').map((k: any) => k.data?.body ?? '');
      out.push({
        url: `https://www.reddit.com${d.permalink ?? ''}`,
        domain: `reddit.com/u/${d.author ?? 'unknown'}`,
        text: d.body ?? '',
        replies: kids.join('\n'),
        createdMs: Math.round((d.created_utc ?? 0) * 1000),
      });
      if (d.replies && typeof d.replies === 'object') walk(d.replies);
    }
  };
  if (Array.isArray(json)) walk(json[1]);
  return out;
}

/** Bluesky searchPosts -> posts. */
export function parseBlueskySearch(json: any): SocialPost[] {
  return (json?.posts ?? []).map((p: any) => {
    const handle = p.author?.handle ?? 'unknown';
    const rkey = String(p.uri ?? '').split('/').pop();
    return {
      url: `https://bsky.app/profile/${handle}/post/${rkey}`,
      domain: `bsky.app/${handle}`,
      text: p.record?.text ?? '',
      replies: '',
      createdMs: Date.parse(p.record?.createdAt ?? p.indexedAt ?? '') || 0,
    };
  });
}

/** X recent search -> posts. */
export function parseXSearch(json: any): SocialPost[] {
  return (json?.data ?? []).map((p: any) => ({
    url: `https://x.com/i/web/status/${p.id}`,
    domain: `x.com/${p.author_id ?? 'unknown'}`,
    text: p.text ?? '',
    replies: '',
    createdMs: Date.parse(p.created_at ?? '') || 0,
  }));
}

// ---------------------------------------------------------------- fetching

async function resting(ctx: Ctx, source: string): Promise<boolean> {
  const until = await getSetting<number>(ctx, `rest:${source}`, 0);
  return until > now(ctx);
}

async function getJson(ctx: Ctx, source: string, url: string, headers: Record<string, string> = {}): Promise<any> {
  if (!(await canSpend(ctx, 'social'))) throw new Error('Daily social budget used up');
  await spend(ctx, 'social');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
    if ([401, 403, 429].includes(res.status)) {
      await setSetting(ctx, `rest:${source}`, now(ctx) + COOLDOWN_MS);
      throw new Error(`${source} said ${res.status}; resting for a few hours`);
    }
    if (!res.ok) throw new Error(`${source} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let redditToken: { value: string; expires: number } | null = null;

async function redditAuth(ctx: Ctx): Promise<{ base: string; headers: Record<string, string> }> {
  const id = ctx.cfg.redditClientId;
  const secret = ctx.cfg.redditClientSecret;
  if (!id || !secret) return { base: 'https://www.reddit.com', headers: {} };
  if (!redditToken || redditToken.expires < Date.now() + 60_000) {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`Reddit sign-in HTTP ${res.status}`);
    const data: any = await res.json();
    redditToken = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  }
  return { base: 'https://oauth.reddit.com', headers: { authorization: `Bearer ${redditToken.value}` } };
}

/**
 * Posts and comments about an artist's presale from the last month.
 * Opens up to `threads` of the most relevant threads to read their comments.
 */
export async function searchReddit(ctx: Ctx, artist: string, threads = 3): Promise<SocialPost[]> {
  if (ctx.cfg.demo || (await resting(ctx, 'reddit'))) return [];
  const { base, headers } = await redditAuth(ctx);
  const q = `"${artist}" (presale OR code OR password)`;
  const qs = new URLSearchParams({ q, sort: 'new', t: 'month', limit: '25', raw_json: '1', type: 'link' });
  const posts = parseRedditListing(await getJson(ctx, 'reddit', `${base}/search${base.includes('oauth') ? '' : '.json'}?${qs}`, headers));
  const name = artist.toLowerCase();
  const relevant = posts
    .filter((p) => p.text.toLowerCase().includes(name) && /presale|pre-sale|code|password/i.test(p.text))
    .sort((a, b) => b.comments - a.comments || b.createdMs - a.createdMs);
  const out: SocialPost[] = [...relevant];
  for (const p of relevant.filter((p) => p.comments > 0).slice(0, threads)) {
    const tqs = new URLSearchParams({ limit: '200', sort: 'new', raw_json: '1' });
    const thread = await getJson(ctx, 'reddit', `${base}${p.permalink.replace(/\/$/, '')}${base.includes('oauth') ? '' : '.json'}?${tqs}`, headers);
    // Comments inside an artist's thread are about that artist even when they don't repeat the name.
    for (const c of parseRedditThread(thread)) out.push({ ...c, text: `${artist}: ${c.text}` });
  }
  return out;
}

export async function searchBluesky(ctx: Ctx, artist: string): Promise<SocialPost[]> {
  if (ctx.cfg.demo || (await resting(ctx, 'bluesky'))) return [];
  const qs = new URLSearchParams({ q: `"${artist}" presale code`, sort: 'latest', limit: '50' });
  return parseBlueskySearch(await getJson(ctx, 'bluesky', `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?${qs}`));
}

/** Newest 10 original posts about the artist's presale. Each post read costs money, so the daily cap is checked first. */
export async function searchX(ctx: Ctx, artist: string): Promise<SocialPost[]> {
  if (ctx.cfg.demo || !ctx.cfg.xBearerToken || (await resting(ctx, 'x'))) return [];
  if (!(await canSpend(ctx, 'x', 10))) throw new Error('Daily X post limit reached');
  const qs = new URLSearchParams({
    query: `"${artist}" (presale OR code OR password) -is:retweet`,
    max_results: '10',
    sort_order: 'recency',
    'tweet.fields': 'created_at,author_id',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`https://api.x.com/2/tweets/search/recent?${qs}`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${ctx.cfg.xBearerToken}`, 'user-agent': UA },
    });
    if ([401, 402, 403, 429].includes(res.status)) {
      await setSetting(ctx, 'rest:x', now(ctx) + COOLDOWN_MS);
      throw new Error(`X said ${res.status}${res.status === 402 ? ' (out of credits)' : ''}; resting for a few hours`);
    }
    if (!res.ok) throw new Error(`X HTTP ${res.status}`);
    const posts = parseXSearch(await res.json());
    await spend(ctx, 'x', posts.length);
    return posts;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- weighing

const GOOD = /\b(worked|works|working|got in|it's valid|valid|confirmed|legit|thank you|thanks|ty)\b|✅|🙏|❤️/i;
const BAD = /\b(didn'?t work|doesn'?t work|not working|invalid|fake|wrong|expired|no luck|nope|didnt work|doesnt work)\b|❌/i;

/** Replies like "worked!" push a code up; "invalid" pulls it down hard. */
export function feedbackAdjust(replies: string): number {
  if (!replies) return 0;
  const lines = replies.split('\n');
  const bad = lines.filter((l) => BAD.test(l)).length;
  const good = lines.filter((l) => !BAD.test(l) && GOOD.test(l)).length;
  if (bad > good) return -0.6;
  if (good > 0) return Math.min(0.2, 0.1 * good);
  return 0;
}

/** Fresh posts matter; codes rotate between tours, so old posts mostly mislead. */
export function recencyFactor(createdMs: number, t: number): number {
  if (!createdMs) return 0.7;
  const days = (t - createdMs) / 86_400_000;
  if (days <= 3) return 1;
  if (days <= 14) return 0.9;
  if (days <= 35) return 0.7;
  return 0;
}

/**
 * Codes are often a word from the tour or album name ("LOOM" for the LOOM
 * World Tour). A candidate that matches a word in the show's name gets a nudge.
 */
export function tourWordBoost(code: string, eventNames: string[], artist: string): number {
  const c = code.toUpperCase();
  const artistWords = new Set(artist.toUpperCase().split(/[^A-Z0-9]+/));
  for (const n of eventNames) {
    const words = n.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !artistWords.has(w) && !/^(TOUR|WORLD|LIVE|NORTH|AMERICAN|AMERICA|WITH|SPECIAL|GUEST|GUESTS|PRESENTS|THE)$/.test(w));
    if (words.some((w) => c === w || c.startsWith(w) || c.endsWith(w))) return 0.1;
  }
  return 0;
}
