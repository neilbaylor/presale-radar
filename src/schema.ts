/**
 * Postgres schema, applied in order at startup. Never edit a shipped
 * migration; add a new one to the end of the list.
 *
 * Shared:   venues, artists, events, sales, code finder tables.
 * Per user: follows, show state, typed codes, push devices, activity/outbox.
 */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- people

CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  pw_hash        TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  prefs          JSONB NOT NULL DEFAULT '{}',
  calendar_token TEXT NOT NULL UNIQUE,
  onboarded      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     BIGINT NOT NULL,
  last_digest    TEXT,
  last_push_at   BIGINT
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  last_seen   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE invites (
  token_hash  TEXT PRIMARY KEY,
  created_by  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  note        TEXT,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  used_at     BIGINT
);

-- sources (shared)

CREATE TABLE venues (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  city         TEXT,
  last_synced  BIGINT,
  last_error   TEXT
);

CREATE TABLE artists (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  image        TEXT,
  last_synced  BIGINT,
  last_error   TEXT
);

CREATE TABLE user_venues (
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  venue_id    TEXT NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  remind_all  BOOLEAN NOT NULL DEFAULT FALSE,
  added_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, venue_id)
);

CREATE TABLE user_artists (
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  artist_id  TEXT NOT NULL REFERENCES artists (id) ON DELETE CASCADE,
  mode       TEXT NOT NULL CHECK (mode IN ('follow', 'mute')),
  added_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, artist_id)
);

-- shows (shared)

CREATE TABLE events (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  url              TEXT,
  image            TEXT,
  local_date       TEXT,
  local_time       TEXT,
  start_utc        BIGINT,
  venue_id         TEXT,
  venue_name       TEXT,
  city             TEXT,
  attraction_ids   TEXT[] NOT NULL DEFAULT '{}',
  attraction_names TEXT[] NOT NULL DEFAULT '{}',
  status           TEXT,
  price_min        DOUBLE PRECISION,
  price_max        DOUBLE PRECISION,
  currency         TEXT,
  availability     TEXT,
  resale_status    TEXT,
  availability_at  BIGINT,
  first_seen       BIGINT NOT NULL,
  last_seen        BIGINT NOT NULL
);
CREATE INDEX events_start ON events (start_utc);
CREATE INDEX events_venue ON events (venue_id);
CREATE INDEX events_attractions ON events USING GIN (attraction_ids);

CREATE TABLE sales (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('presale', 'public')),
  name        TEXT NOT NULL,
  description TEXT,
  url         TEXT,
  start_utc   BIGINT,
  end_utc     BIGINT,
  start_tbd   BOOLEAN NOT NULL DEFAULT FALSE,
  requirement TEXT,
  removed     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX sales_event ON sales (event_id);
CREATE INDEX sales_start ON sales (start_utc);

-- per-user show state

CREATE TABLE user_events (
  user_id        BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'auto' CHECK (state IN ('auto', 'tracked', 'dismissed')),
  got_tickets    BOOLEAN NOT NULL DEFAULT FALSE,
  watch_soldout  BOOLEAN NOT NULL DEFAULT TRUE,
  seen           BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);

CREATE TABLE user_sale_codes (
  user_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sale_id  TEXT NOT NULL,
  code     TEXT NOT NULL,
  PRIMARY KEY (user_id, sale_id)
);

CREATE TABLE user_artist_codes (
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  artist_id  TEXT NOT NULL,
  sale_slug  TEXT NOT NULL,
  code       TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, artist_id, sale_slug)
);

-- code finder (shared). scope = livenation | artist | sale; key = '' | artist id | sale id

CREATE TABLE web_codes (
  scope       TEXT NOT NULL,
  key         TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL,
  score       DOUBLE PRECISION NOT NULL DEFAULT 0,
  hits        INTEGER NOT NULL DEFAULT 1,
  domains     TEXT[] NOT NULL DEFAULT '{}',
  source_url  TEXT NOT NULL,
  snippet     TEXT,
  first_seen  BIGINT NOT NULL,
  last_seen   BIGINT NOT NULL,
  votes       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, code)
);

CREATE TABLE code_votes (
  user_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope    TEXT NOT NULL,
  key      TEXT NOT NULL,
  code     TEXT NOT NULL,
  vote     SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
  PRIMARY KEY (user_id, scope, key, code)
);

CREATE TABLE code_sources (
  url          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'generic' CHECK (kind IN ('livenation', 'generic')),
  label        TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  added_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  last_checked BIGINT,
  last_error   TEXT,
  last_found   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO code_sources (url, kind, label) VALUES
  ('https://help.ticketmaster.ca/hc/en-us/articles/10321615648785', 'livenation', 'Ticketmaster Canada help'),
  ('https://help.ticketmaster.com/hc/en-us/articles/9670692314897', 'livenation', 'Ticketmaster help');

CREATE TABLE code_searches (
  query    TEXT PRIMARY KEY,
  sale_id  TEXT,
  ran_at   BIGINT NOT NULL,
  results  INTEGER NOT NULL DEFAULT 0
);

-- notifications (per user). activity doubles as the outbox.
-- priority: urgent = push now (even in quiet hours), instant = push when allowed,
-- digest = wait for the evening digest, silent = never pushed.

CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  BIGINT NOT NULL,
  failures    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE activity (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ts         BIGINT NOT NULL,
  type       TEXT NOT NULL,
  priority   TEXT NOT NULL DEFAULT 'digest' CHECK (priority IN ('urgent', 'instant', 'digest', 'silent')),
  dedupe_key TEXT,
  event_id   TEXT,
  sale_id    TEXT,
  title      TEXT NOT NULL,
  body       TEXT,
  url        TEXT,
  pushed_at  BIGINT,
  read       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX activity_dedupe ON activity (user_id, dedupe_key);
CREATE INDEX activity_user_ts ON activity (user_id, ts DESC);

CREATE TABLE job_runs (
  job        TEXT PRIMARY KEY,
  last_start BIGINT,
  last_end   BIGINT,
  last_error TEXT,
  summary    JSONB
);
`,
  /* 2: SeatGeek as a second source, and resale watch */ `
ALTER TABLE venues ADD COLUMN sg_id TEXT;
ALTER TABLE venues ADD COLUMN sg_lookup_at BIGINT;
ALTER TABLE venues ADD COLUMN sg_synced BIGINT;
ALTER TABLE artists ADD COLUMN sg_id TEXT;
ALTER TABLE artists ADD COLUMN sg_lookup_at BIGINT;
ALTER TABLE artists ADD COLUMN sg_synced BIGINT;

ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'ticketmaster';
ALTER TABLE events ADD COLUMN sg_id TEXT;
ALTER TABLE events ADD COLUMN sg_url TEXT;
ALTER TABLE events ADD COLUMN resale_low DOUBLE PRECISION;
ALTER TABLE events ADD COLUMN resale_count INTEGER;
ALTER TABLE events ADD COLUMN resale_at BIGINT;
CREATE INDEX events_sg ON events (sg_id);
CREATE INDEX events_date ON events (local_date);

-- resale_watch: NULL = automatic (on for sold-out shows you care about), TRUE/FALSE = your choice
ALTER TABLE user_events ADD COLUMN resale_watch BOOLEAN;
ALTER TABLE user_events ADD COLUMN resale_target DOUBLE PRECISION;
ALTER TABLE user_events ADD COLUMN resale_alerted DOUBLE PRECISION;
`,
  /* 3: direct calendar sync (iCloud via CalDAV; Google/Outlook later) */ `
CREATE TABLE calendar_accounts (
  user_id      BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,              -- icloud | caldav
  server       TEXT NOT NULL,
  username     TEXT NOT NULL,
  secret_enc   TEXT NOT NULL,              -- app-specific password, AES-GCM encrypted
  home_url     TEXT,
  calendar_url TEXT,
  status       TEXT NOT NULL DEFAULT 'ok',
  last_error   TEXT,
  last_sync    BIGINT,
  created_at   BIGINT NOT NULL
);

-- What we've written to each person's calendar, so we only send changes.
CREATE TABLE calendar_items (
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  uid        TEXT NOT NULL,
  href       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, uid)
);
`,
  /* 4: smarter scheduling, venue websites, sign-up deadlines */ `
ALTER TABLE venues ADD COLUMN next_sync BIGINT;
ALTER TABLE venues ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE venues ADD COLUMN last_change BIGINT;
ALTER TABLE artists ADD COLUMN next_sync BIGINT;
ALTER TABLE artists ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artists ADD COLUMN last_change BIGINT;
ALTER TABLE artists ADD COLUMN help_checked BIGINT;

-- One-off markers for global jobs (e.g. "re-checked this sale 10 minutes before").
CREATE TABLE job_marks (
  key  TEXT PRIMARY KEY,
  at   BIGINT NOT NULL
);

-- API calls per provider per day, so every job shares one budget.
CREATE TABLE api_usage (
  provider TEXT NOT NULL,
  day      TEXT NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);

-- Venue websites to read for events (schema.org JSON-LD or an .ics feed).
CREATE TABLE venue_pages (
  url          TEXT PRIMARY KEY,
  venue_id     TEXT,
  label        TEXT,
  added_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  next_check   BIGINT,
  last_checked BIGINT,
  last_error   TEXT,
  last_found   INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0
);

-- Facts read from Ticketmaster help articles: sign-up deadlines and presale times per artist.
CREATE TABLE artist_notes (
  artist_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('signup_deadline', 'presale_time', 'general_sale')),
  label      TEXT NOT NULL,
  at_utc     BIGINT NOT NULL,
  url        TEXT,
  signup_url TEXT,
  sentence   TEXT,
  found_at   BIGINT NOT NULL,
  PRIMARY KEY (artist_id, kind, label, at_utc)
);
CREATE INDEX artist_notes_at ON artist_notes (at_utc);
`,
  /* 5: short calendar links, and knowing what each calendar event stands for */ `
CREATE TABLE short_links (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,             -- sale | got | hide
  target     TEXT NOT NULL,             -- sale id, or comma-separated event ids
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, kind, target)
);

-- What each calendar event stands for, so deleting it in Calendar can hide the show.
ALTER TABLE calendar_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale';   -- sale | signup
ALTER TABLE calendar_items ADD COLUMN target TEXT NOT NULL DEFAULT '';     -- event ids, or the sign-up key
`,
];
