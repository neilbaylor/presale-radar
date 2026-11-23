# Presale Radar

An installable phone app that watches Ticketmaster for shows at your venues and by your artists, finds presale codes, and reminds you only when it matters. It's for you plus a few invited friends.

It never buys tickets for you. Joining queues and checking out stay with you, which keeps it legal (Ontario bans ticket bots) and keeps your Ticketmaster account safe.

## What it does

- **Follows venues and artists.** Shows by artists you follow get reminders automatically. Shows at your venues appear in your feed and evening roundup, and you tap 🔔 on the ones you want.
- **Calm notifications.**
  - **Urgent:** sent right away, even in quiet hours. This covers a sale starting in 15 minutes, released seats, and sale times moved to within 24 hours.
  - **Instant:** sent soon, outside quiet hours, at most once an hour and merged when several arrive. Examples: a new show by an artist you follow, or a code found for a presale in the next 48 hours.
  - **Evening roundup:** one push at 7 PM: "Tomorrow: 2 sales · 3 new shows".
  - **Never overnight:** quiet from 10 PM to 8 AM. Nothing is sent twice. Hidden shows and muted artists disappear everywhere.
- **Sale-day screen.** Shows a countdown, the best code with backups, and a prep checklist. One tap copies the code and opens Ticketmaster. Calendar events and pushes both link here.
- **Code finder.**
  1. Ticketmaster's own presale text, which is exact when it includes a code.
  2. The official Live Nation password, from Ticketmaster's help pages.
  3. Web searches for each upcoming presale that needs a code, using the Brave Search API: it reads the result snippets and opens the top pages.
  4. Any public pages you add, such as forum threads or code roundups.

  Each code gets a confidence score based on how it's phrased ("code is X"), how many independent sites mention it, and your 👍/👎 votes. Codes found online are labelled "unverified". Card presales and Verified Fan presales never show shared codes. Scans speed up as a presale gets close: every 3 hours normally, every 30 minutes in the last 48 hours, and every 5 minutes in the last 2 hours.
- **Resale watch (SeatGeek).** For shows you care about that are already on sale, it checks the lowest resale price every 30 minutes, and every 10 minutes in the last 48 hours. It pings you when the price hits your target (face value by default), then again only for a real new low (at least $10 or 10% cheaper). If prices climb well back up, it resets, so the next dip alerts again. On show day the ping comes right away; otherwise it follows quiet hours. Ontario law caps resale at what the seller paid, so the target is usually face value or lower.
- **Shows sold outside Ticketmaster.** SeatGeek lists most events wherever they're sold, so shows at your venues sold through AXS, Dice or a box office still appear. These show "via SeatGeek" and have no presale times.
- **Sold-out watch.** When a sold-out show you care about gets tickets back, it sends an urgent push. This needs Ticketmaster's Inventory Status API, which is approval-only (see below).
- **Calendar.**
  - **iPhone/iCloud direct sync.** Paste an app-specific password once. The app keeps a "Presales" calendar in iCloud up to date: events are added, moved and removed within minutes, and right away when you act in the app.
  - **Subscribed feed** for Google, Outlook and others. This updates whenever their calendar app re-checks it.
  - Each event links to a **sale screen that works without signing in**. That matters on iPhone, where links open in Safari rather than the Home Screen app. Each event also has **"Got tickets"** and **"Not interested"** links that update the app and clean up the calendar.
  - If push is off, events include a 15-minute alarm. If it's on, they don't, so you're never pinged twice.
- **Sale screen and launch mode.** In the last 15 minutes the sale screen goes full-screen with a giant timer, a tap-to-copy code and one button, and keeps the screen awake.
- **Home and new shows.** A week strip with dots on sale days. New shows at your venues collect into a swipe deck: right for reminders, left to pass, Maybe to keep, with undo.
- **Accounts.** The first person to open the app becomes the owner. Others join with a one-time invite link from Settings. You stay signed in for about a year.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. In Railway, create a **New Project**, choose **Deploy from GitHub repo**, and pick the repo.
3. Add a database: in the project, choose **+ New**, then **Database**, then **PostgreSQL**.
4. In the app service, open **Variables** and add the following:
   - `DATABASE_URL`: set it to `${{Postgres.DATABASE_URL}}` (a reference to the database).
   - `TM_API_KEY`: get a free key at developer.ticketmaster.com. Use the "Consumer Key".
   - `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: run `npm run vapid` locally and paste both lines.
   - `VAPID_SUBJECT`: `mailto:you@example.com`.
   - `BRAVE_API_KEY` (recommended): from api-dashboard.search.brave.com. The monthly free credit covers this app's roughly 30 searches a day.
   - `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (optional): a free "script" app from reddit.com/prefs/apps. Reddit and Bluesky are searched for leaked codes either way, but Reddit often blocks cloud servers that don't sign in.
   - `X_BEARER_TOKEN` (optional, paid): from console.x.com after buying credits. X charges about half a cent per post read, so it's only searched in the two days before a presale and capped by `X_DAILY_POSTS` (default 300 a day, about $1.50).
   - `SEATGEEK_CLIENT_ID` (recommended): from seatgeek.com/account/develop. It turns on resale prices and shows sold outside Ticketmaster.
5. Under **Settings**, then **Networking**, click **Generate Domain**.
6. Open the domain on your phone and create your account.
   - **iPhone:** open it in Safari, tap Share, then **Add to Home Screen**, and open it from the Home Screen. iOS only allows notifications from the installed app.
   - **Android:** Chrome offers to install it.

Build and start commands are in `railway.json`. Migrations run automatically at startup. Keep it at **one replica**. A Postgres lock also prevents two copies from running the scheduler at once.

### Connecting iPhone Calendar

In the app, go to Settings, then Calendar, then **Connect iPhone Calendar**. Create an app-specific password at account.apple.com, under Sign-In and Security, then App-Specific Passwords, and paste it in. It's stored encrypted and only works for calendars. To revoke it, delete it at account.apple.com.

### Sold-out watch (optional)

Email `devportalinquiry@ticketmaster.com` to request access to the **Inventory Status API**. Once approved, set `TM_INVENTORY_API_KEY`. Until then, the app still alerts you about added dates, new sale windows and status changes.

### Other settings

See `.env.example`. These variables cover your location (`HOME_LAT`, `HOME_LON`, `RADIUS_KM`), the default time zone, sync frequency, and `MUSIC_ONLY`.

## Run it locally

```bash
npm install
npm run dev          # demo mode: made-up shows, in-memory database, no keys needed
npm test             # 39 tests: embedded Postgres, a simulated iCloud server, push crypto
```

Demo mode has a **Demo tick** button that simulates a new show being announced, so you can see the triage and alert flow.

To run against real data locally, set `DATABASE_URL`, `TM_API_KEY` and the VAPID keys, then run `npm run build && npm start`.

## How it works

```
src/
  index.ts         boot: config, database, migrations, web server, scheduler
  server.ts        HTTP API (Hono) and static app
  jobs.ts          5-minute tick: sync, sold-out watch, reminders, code finder, delivery, cleanup
  tm.ts            Ticketmaster Discovery API client (rate-limited) and normalizing
  sync.ts          store shows once (shared), detect changes, fan out per person by interest
  notify.ts        outbox: urgent / instant / roundup / silent, quiet hours, hourly cap
  reminders.ts     sale reminders with the best code
  codes.ts         code finder: extraction, scoring, web search, page scanning
  availability.ts  sold-out watch (Inventory Status API)
  seatgeek.ts      second source: match SeatGeek events to shows, add ones Ticketmaster lacks, resale watch
  ics.ts           calendar events per person (feed + sync), with signed links
  caldav.ts        CalDAV client for iCloud (discovery, create calendar, put/delete)
  calsync.ts       keeps each connected calendar in step; resyncs right after your actions
  secrets.ts       encrypted calendar passwords, signed links
  auth.ts          accounts, sessions, invites, signed notification buttons
  push.ts          Web Push (VAPID + aes128gcm) with no third-party library
  schema.ts        Postgres schema (migrations)
public/            the installable app: no build step, a service worker for offline and push
```

**SeatGeek limits.** SeatGeek only gives the cheapest price and the number of listings for each event, not sections or seat counts, so a resale alert means "go look now". Prices are compared to Ticketmaster's face value as given, so check the currency on the listing.

**Ticketmaster limits.** The Discovery API allows 5,000 calls a day and 5 a second. Each venue or artist is refreshed about once an hour, and if usage gets high the app backs off to every 3 hours.

**Codes.** Codes found on the web may be meant for specific people, and Ticketmaster can cancel orders made with codes that weren't issued to you. Codes you type yourself always take priority.
