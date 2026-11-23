/**
 * Minimal CalDAV client: enough to find your calendars, create a "Presales"
 * calendar, and add, update or remove events in it. Built for iCloud
 * (caldav.icloud.com with an app-specific password); works with most CalDAV servers.
 *
 * Redirects are followed by hand: fetch drops the Authorization header on
 * cross-origin redirects, and iCloud redirects to a per-account host.
 */

export interface DavCreds {
  username: string;
  password: string;
}

export class DavError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const ICLOUD_SERVER = 'https://caldav.icloud.com/';

async function dav(
  method: string,
  url: string,
  creds: DavCreds,
  opts: { body?: string; depth?: '0' | '1'; contentType?: string } = {},
): Promise<{ status: number; text: string; url: string }> {
  let target = url;
  for (let hop = 0; hop < 5; hop++) {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
      'User-Agent': 'PresaleRadar/1.0',
    };
    if (opts.depth) headers.Depth = opts.depth;
    if (opts.body) headers['Content-Type'] = opts.contentType ?? 'application/xml; charset=utf-8';
    const res = await fetch(target, { method, headers, body: opts.body, redirect: 'manual' });
    if ([301, 302, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) break;
      target = new URL(loc, target).toString();
      continue;
    }
    return { status: res.status, text: await res.text(), url: target };
  }
  throw new DavError('Too many redirects', 0);
}

function firstHref(xml: string, prop: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${prop}[^>]*>[\\s\\S]*?<(?:[\\w-]+:)?href[^>]*>\\s*([^<\\s]+)\\s*</(?:[\\w-]+:)?href>`, 'i');
  return xml.match(re)?.[1] ?? null;
}

function authError(status: number): DavError {
  return new DavError(
    status === 401 || status === 403
      ? 'Apple rejected the sign-in. Check the Apple ID email and use an app-specific password, not your normal password.'
      : `Calendar server error (${status})`,
    status,
  );
}

/** Find the URL where this account's calendars live. */
export async function discoverHome(server: string, creds: DavCreds): Promise<string> {
  const principalBody =
    '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
  const p = await dav('PROPFIND', server, creds, { body: principalBody, depth: '0' });
  if (p.status !== 207) throw authError(p.status);
  const principal = firstHref(p.text, 'current-user-principal');
  if (!principal) throw new DavError("Couldn't find your calendar account on the server.", p.status);
  const principalUrl = new URL(principal, p.url).toString();

  const homeBody =
    '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
  const h = await dav('PROPFIND', principalUrl, creds, { body: homeBody, depth: '0' });
  if (h.status !== 207) throw authError(h.status);
  const home = firstHref(h.text, 'calendar-home-set');
  if (!home) throw new DavError("Couldn't find your calendars on the server.", h.status);
  const url = new URL(home, h.url).toString();
  return url.endsWith('/') ? url : `${url}/`;
}

/** Make sure our "Presales" calendar exists; returns its URL. */
export async function ensureCalendar(homeUrl: string, creds: DavCreds, name = 'Presales'): Promise<string> {
  const url = `${homeUrl}presale-radar/`;
  const check = await dav('PROPFIND', url, creds, {
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    depth: '0',
  });
  if (check.status === 207) return url;
  if (check.status !== 404) throw authError(check.status);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:set><d:prop>
    <d:displayname>${name}</d:displayname>
    <a:calendar-color>#FF5A36FF</a:calendar-color>
    <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
  </d:prop></d:set>
</c:mkcalendar>`;
  const made = await dav('MKCALENDAR', url, creds, { body });
  if (made.status !== 201 && made.status !== 200) throw authError(made.status);
  return url;
}

export function eventHref(calendarUrl: string, uid: string): string {
  return `${calendarUrl}${encodeURIComponent(uid.replace(/@.*$/, ''))}.ics`;
}

export async function putEvent(href: string, ics: string, creds: DavCreds): Promise<void> {
  const r = await dav('PUT', href, creds, { body: ics, contentType: 'text/calendar; charset=utf-8' });
  if (![200, 201, 204].includes(r.status)) throw authError(r.status);
}

export async function deleteResource(href: string, creds: DavCreds): Promise<void> {
  const r = await dav('DELETE', href, creds);
  if (![200, 204, 404].includes(r.status)) throw authError(r.status);
}

/** Paths of every event currently in the calendar, or null if the calendar itself is gone. */
export async function listEventPaths(calendarUrl: string, creds: DavCreds): Promise<Set<string> | null> {
  const r = await dav('PROPFIND', calendarUrl, creds, {
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>',
    depth: '1',
  });
  if (r.status === 404) return null;
  if (r.status !== 207) throw authError(r.status);
  const self = new URL(calendarUrl).pathname.replace(/\/?$/, '/');
  const paths = new Set<string>();
  for (const m of r.text.matchAll(/<(?:[\w-]+:)?href[^>]*>\s*([^<\s]+)\s*<\/(?:[\w-]+:)?href>/gi)) {
    const path = decodeURIComponent(new URL(m[1], r.url).pathname);
    if (path.replace(/\/?$/, '/') !== self) paths.add(path);
  }
  return paths;
}
