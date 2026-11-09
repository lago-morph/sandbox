export type FeedKind = "main" | "colocated" | "maintainer" | "sponsor";

export interface Speaker {
  name: string;
  company: string;
  title: string;
}

export interface Session {
  id: string;
  source: FeedKind;
  title: string;
  description: string;
  day: string;
  startsAt: string;
  endsAt: string;
  room: string;
  track: string;
  format: string | null;
  events: string[];
  speakers: Speaker[];
  speakerText: string;
}

/** List view: everything except description and the structured speakers. */
export type SessionSummary = Omit<Session, "description" | "speakers">;

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ACCOUNT_ID: string;
  ALLOWED_EMAILS?: string;
  GOOGLE_APP_ID: string;
  GOOGLE_APP_SECRET: string;
}
