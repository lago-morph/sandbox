import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/index";
import { signToken } from "../src/auth";
import { NOTICES } from "../src/notices";
import type { Env } from "../src/types";
import { sqliteD1 } from "./sqliteD1";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";
const SECRET = "test-session-secret-0123456789abcdef";
const SINCE = NOTICES.find((n) => n.id === "download-link")!.since;
const BELL = NOTICES.find((n) => n.id === "email-summaries")!;

afterEach(() => vi.useRealTimers());

function setup() {
  const { d1, raw } = sqliteD1();
  const env = { SESSION_SECRET: SECRET, DB: d1 } as Env;
  const call = async (uid: string, method: string, path: string, origin = ORIGIN) => {
    const prov = uid.startsWith("google:") ? "google" : "cloudflare";
    const cookie = `kp_session=${await signToken({ typ: "session", uid, email: "", prov, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
    const url = new URL(`${ORIGIN}${path}`);
    return handleApi(new Request(url, { method, headers: { cookie, origin } }), env, url);
  };
  return { raw, call };
}

describe("what's new notice", () => {
  it("is shown exactly once to a returning user, on any device", async () => {
    const { raw, call } = setup();
    raw.exec(`INSERT INTO users (user_id, provider, first_seen_ms, last_seen_ms, visits) VALUES ('cf-old', 'cloudflare', ${SINCE - 86_400_000}, ${SINCE - 3_600_000}, 4)`);
    const first = (await (await call("cf-old", "GET", "/api/notices")).json()) as { id: string; text: string }[];
    expect(first.map((n) => n.id)).toEqual(["download-link", "email-summaries"]);
    expect(first[0].text).toMatch(/download/i);
    expect(first[1].text).toMatch(/bell/i);
    expect((await call("cf-old", "POST", "/api/notices/download-link/seen")).status).toBe(204);
    expect(((await (await call("cf-old", "GET", "/api/notices")).json()) as { id: string }[]).map((n) => n.id)).toEqual(["email-summaries"]);
    expect((await call("cf-old", "POST", "/api/notices/email-summaries/seen")).status).toBe(204);
    expect(await (await call("cf-old", "GET", "/api/notices")).json()).toEqual([]); // a second device asks: nothing
    expect((await call("cf-old", "POST", "/api/notices/download-link/seen")).status).toBe(204); // idempotent
    expect((raw.prepare("SELECT COUNT(*) AS n FROM notices_seen").get() as any).n).toBe(2);
  });

  it("counts a user with selections from before the feature as returning, even without a users row", async () => {
    const { raw, call } = setup();
    raw.exec(`INSERT INTO selections (user_id, session_id, created_at, status) VALUES ('google:old', 's1', '2026-11-10T09:00:00.000Z', 'favorite')`);
    expect(((await (await call("google:old", "GET", "/api/notices")).json()) as { id: string }[]).map((n) => n.id)).toEqual(["download-link", "email-summaries"]);
  });

  it("is not shown to a brand-new user", async () => {
    const { call } = setup();
    expect(await (await call("google:new", "GET", "/api/notices")).json()).toEqual([]);
  });

  it("only marks known notices, and only from the app's own origin", async () => {
    const { call } = setup();
    expect((await call("cf-old", "POST", "/api/notices/nope/seen")).status).toBe(404);
    expect((await call("cf-old", "POST", "/api/notices/download-link/seen", "https://evil.example")).status).toBe(403);
  });

  it("offers the bell notice to users who had seen the download notice, but not after summaries end", async () => {
    const { raw, call } = setup();
    raw.exec(`INSERT INTO users (user_id, provider, first_seen_ms, last_seen_ms, visits) VALUES ('cf-mid', 'cloudflare', ${BELL.since - 60_000}, ${BELL.since - 30_000}, 2)`);
    raw.exec(`INSERT INTO notices_seen (user_id, notice_id, seen_at) VALUES ('cf-mid', 'download-link', '2026-11-13T00:00:00Z')`);
    expect(((await (await call("cf-mid", "GET", "/api/notices")).json()) as { id: string }[]).map((n) => n.id)).toEqual(["email-summaries"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(BELL.until! + 1000));
    expect(await (await call("cf-mid", "GET", "/api/notices")).json()).toEqual([]);
  });
});
