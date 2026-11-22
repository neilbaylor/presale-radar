import type { Db } from './database.js';

export interface Config {
  port: number;
  publicUrl: string | null;
  appSecret: string | null;       // signs notification buttons; generated and stored if unset
  tmApiKey: string | null;
  inventoryApiKey: string | null; // Ticketmaster Inventory Status API (approval required)
  braveApiKey: string | null;     // web search for presale codes
  seatgeekClientId: string | null; // second source + resale prices
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string;
  homeLat: number;
  homeLon: number;
  radiusKm: number;
  timeZone: string;
  musicOnly: boolean;
  syncIntervalMin: number;
  tickSeconds: number;
  codeScrapeIntervalMin: number;
  demo: boolean;
}

export interface Ctx {
  db: Db;
  cfg: Config;
  secret: string;
  now?: () => number;
}

export type SaleKind = 'presale' | 'public';
export type Requirement = 'code' | 'card' | 'register' | 'none' | 'unknown';
export type UserState = 'auto' | 'tracked' | 'dismissed';

/** How much a user cares about a show. remind = reminders + calendar, feed = digest only. */
export type Level = 'remind' | 'feed' | 'hidden';

export interface Prefs {
  reminderMinutes: number[]; // urgent pushes this many minutes before a sale you care about
  openPush: boolean;         // also push the moment a sale opens
  quietStart: number;        // local hour, 0-23
  quietEnd: number;
  digestHour: number;        // local hour of the evening digest
  timeZone: string;
}

export const DEFAULT_PREFS: Omit<Prefs, 'timeZone'> = {
  reminderMinutes: [15],
  openPush: false,
  quietStart: 22,
  quietEnd: 8,
  digestHour: 19,
};

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'owner' | 'member';
  prefs: Prefs;
  calendar_token: string;
  onboarded: boolean;
  last_digest: string | null;
  last_push_at: number | null;
}

export interface NormalizedEvent {
  id: string;
  name: string;
  url: string | null;
  image: string | null;
  localDate: string | null;
  localTime: string | null;
  startUtc: number | null;
  venueId: string | null;
  venueName: string | null;
  city: string | null;
  attractionIds: string[];
  attractionNames: string[];
  status: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
}

export interface NormalizedSale {
  id: string;
  eventId: string;
  kind: SaleKind;
  name: string;
  slug: string;
  description: string | null;
  url: string | null;
  startUtc: number | null;
  endUtc: number | null;
  startTbd: boolean;
  requirement: Requirement;
}

export interface EventRow {
  id: string;
  name: string;
  url: string | null;
  image: string | null;
  local_date: string | null;
  local_time: string | null;
  start_utc: number | null;
  venue_id: string | null;
  venue_name: string | null;
  city: string | null;
  attraction_ids: string[];
  attraction_names: string[];
  status: string | null;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  availability: string | null;
  resale_status: string | null;
  availability_at: number | null;
  source?: string;
  sg_id?: string | null;
  sg_url?: string | null;
  resale_low?: number | null;
  resale_count?: number | null;
  resale_at?: number | null;
  first_seen: number;
  last_seen: number;
}

export interface SaleRow {
  id: string;
  event_id: string;
  kind: SaleKind;
  name: string;
  description: string | null;
  url: string | null;
  start_utc: number | null;
  end_utc: number | null;
  start_tbd: boolean;
  requirement: Requirement | null;
  removed: boolean;
}

export interface UserEventRow {
  user_id: number;
  event_id: string;
  state: UserState;
  got_tickets: boolean;
  watch_soldout: boolean;
  seen: boolean;
  resale_watch?: boolean | null;
  resale_target?: number | null;
  resale_alerted?: number | null;
}

export interface Source {
  type: 'venue' | 'artist';
  id: string;
  name: string;
  lastSynced: number | null;
}

export interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  actions?: { action: string; title: string; url: string }[];
  urgent?: boolean;
}
