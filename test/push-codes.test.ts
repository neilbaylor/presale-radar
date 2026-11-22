import { describe, expect, it } from 'vitest';
import { createECDH, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
// @ts-ignore no types
import ece from 'http_ece';
import { encryptPayload, vapidJwt } from '../src/push.js';
import { b64urlDecode, b64urlEncode } from '../src/util.js';
import {
  candidatesIn, combineScore, extractArtistCodes, extractFromDescription, extractLiveNationCodes, htmlToText, scanIntervalMin,
} from '../src/codes.js';
import { fold } from '../src/ics.js';

describe('web push encryption', () => {
  it('produces aes128gcm that a standard decoder can read', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const sub = { p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth) };
    const msg = JSON.stringify({ title: 'Glass Harbour: Artist Presale in 15 min', body: 'Code: HARBOUR26' });
    const body = await encryptPayload(new TextEncoder().encode(msg), sub);
    const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth });
    expect(plain.toString('utf8')).toBe(msg);
  });

  it('signs a VAPID JWT that verifies with the public key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubJwk = publicKey.export({ format: 'jwk' }) as any;
    const privJwk = privateKey.export({ format: 'jwk' }) as any;
    const raw = new Uint8Array([4, ...b64urlDecode(pubJwk.x), ...b64urlDecode(pubJwk.y)]);
    const jwt = await vapidJwt('https://fcm.googleapis.com', 'mailto:me@example.com', b64urlEncode(raw), privJwk.d, Date.parse('2026-12-01T00:00:00Z'));
    const [h, p, s] = jwt.split('.');
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: pubJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(s)));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(b64urlDecode(p)).toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:me@example.com' });
  });
});

describe('code extraction', () => {
  it('reads the Live Nation password from the official help page wording', () => {
    const text = htmlToText('<p>Live Nation Presale</p><p>Need the Live Nation presale password? Use <b>HYPED</b> or <b>SETBREAK</b>.</p><p>Spotify Presale</p>');
    expect(extractLiveNationCodes(text).map((c) => c.code).sort()).toEqual(['HYPED', 'SETBREAK']);
  });

  it('prefers "code is X" phrasing and ignores page furniture', () => {
    const text =
      'MENU HOME TOUR. Anyone going? The Glass Harbour presale code is HARBOUR26 and it worked in Toronto. ' +
      'Glass Harbour tickets FAQ. Maple Static code: STATICTOUR. Lake Effect presale LOGIN SUBSCRIBE PRIVACY.';
    const found = extractArtistCodes(text, [
      { id: 'A1', name: 'Glass Harbour' },
      { id: 'A2', name: 'Maple Static' },
      { id: 'A3', name: 'Lake Effect' },
    ]);
    const a1 = found.filter((c) => c.artistId === 'A1');
    expect(a1[0]).toMatchObject({ code: 'HARBOUR26', strength: 0.9 });
    expect(found.some((c) => ['MENU', 'HOME', 'FAQ', 'LOGIN', 'SUBSCRIBE', 'PRIVACY'].includes(c.code))).toBe(false);
    expect(found.find((c) => c.artistId === 'A2')?.code).toBe('STATICTOUR');
  });

  it('drops tokens that sit next to many artists (nav, ads) unless strongly phrased', () => {
    const text = 'Alpha One presale SPONSOR. Beta Two presale SPONSOR. Gamma Three presale SPONSOR. Gamma Three code is GAMMA3X.';
    const found = extractArtistCodes(text, [
      { id: 'a', name: 'Alpha One' },
      { id: 'b', name: 'Beta Two' },
      { id: 'c', name: 'Gamma Three' },
    ]);
    expect(found.some((c) => c.code === 'SPONSOR')).toBe(false);
    expect(found.find((c) => c.artistId === 'c')?.code).toBe('GAMMA3X');
  });

  it('never treats years, times or prices as codes', () => {
    expect(candidatesIn('presale code 2026 at 10AM for $45 in section A12').map((c) => c.code)).toEqual([]);
  });

  it("takes exact codes from Ticketmaster's presale description", () => {
    expect(extractFromDescription('Enter the password SPRINGTIME to unlock tickets.').map((c) => c.code)).toEqual(['SPRINGTIME']);
    expect(extractFromDescription('Sign up for the fan club newsletter.')).toEqual([]);
  });

  it('builds confidence from independent sites, and votes override', () => {
    const one = combineScore([{ domain: 'a.com', strength: 0.9, hits: 1 }]);
    const two = combineScore([{ domain: 'a.com', strength: 0.9, hits: 1 }, { domain: 'b.com', strength: 0.45, hits: 1 }]);
    const sameSite = combineScore([{ domain: 'a.com', strength: 0.9, hits: 1 }, { domain: 'a.com', strength: 0.9, hits: 1 }]);
    expect(two).toBeGreaterThan(one);
    expect(sameSite).toBe(one);
    expect(combineScore([{ domain: 'a.com', strength: 0.2, hits: 1 }], 1)).toBe(0.97);
    expect(combineScore([{ domain: 'a.com', strength: 0.9, hits: 1 }], -1)).toBe(0);
  });

  it('scans faster as a presale approaches', () => {
    expect(scanIntervalMin(null, 180)).toBe(180);
    expect(scanIntervalMin(30 * 3_600_000, 180)).toBe(30);
    expect(scanIntervalMin(60 * 60_000, 180)).toBe(5);
  });
});

describe('calendar folding', () => {
  it('folds long lines without splitting characters', () => {
    const folded = fold('SUMMARY:' + '🎟 Glass Harbour: Artist Presale '.repeat(5));
    for (const line of folded.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe('SUMMARY:' + '🎟 Glass Harbour: Artist Presale '.repeat(5));
  });
});
