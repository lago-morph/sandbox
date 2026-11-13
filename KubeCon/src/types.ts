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
  /** https link to the slide download, or "". */
  slidesUrl: string;
  /** https link to the recording, or "". */
  recordingUrl: string;
  /** Every https link for the session, keyed by kind (see LINK_KINDS in importer.ts). */
  links: Record<string, string>;
}

/** List view: everything except description and the structured speakers. */
export type SessionSummary = Omit<Session, "description" | "speakers" | "slidesUrl" | "recordingUrl" | "links">;

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
  /** Email Service send binding (restricted to the planner sender address in wrangler.jsonc). */
  EMAIL: SendEmail;
  /** Public origin of the app, for links in emails sent from the nightly job. */
  APP_ORIGIN: string;
  /** Owner's contact address shown in emails (secret; kept out of the public repo). */
  CONTACT_EMAIL?: string;
  /** Verified destination that mail to *@shareplay.com is forwarded to (secret). */
  FORWARD_TO?: string;
}
