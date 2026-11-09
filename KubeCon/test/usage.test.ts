import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { handleApi } from "../src/index";
import { signToken } from "../src/auth";
import { getStats, touchUser } from "../src/usage";
import type { Env } from "../src/types";
import { sqliteD1 } from "./sqliteD1";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";
const MIN = 60_000;
const SECRET = "test-session-secret-0123456789abcdef";

describe("migration 0004 backfill", () => {
  it("creates one user per existing selections user, with 1 visit, without touching selections", async () => {
    const { raw } = sqliteD1(3);
    raw.exec(`INSERT INTO selections (user_id, session_id, created_at, status) VALUES
      ('cf-1','a','2026-11-09T17:40:00.000Z','favorite'), ('cf-1','b','2026-11-09T18:00:00.000Z','interested'),
      ('google:9','a','2026-11-09T21:00:00.000Z','favorite')`);
    raw.exec(readFileSync("migrations/0004_users.sql", "utf8"));
    const users = raw.prepare("SELECT * FROM users ORDER BY user_id").all() as any[];
    expect(users.map((u) => [u.user_id, u.provider, u.visits])).toEqual([["cf-1", "cloudflare", 1], ["google:9", "google", 1]]);
    expect(users[0].first_seen_ms).toBe(Date.parse("2026-11-09T17:40:00.000Z"));
    expect(users[0].last_seen_ms).toBe(Date.parse("2026-11-09T18:00:00.000Z"));
    expect((raw.prepare("SELECT COUNT(*) AS n FROM selections").get() as any).n).toBe(3);
  });
});

describe("touchUser", () => {
  it("counts a new visit only after more than 15 minutes of inactivity", async () => {
    const { d1, raw } = sqliteD1();
    const visits = () => (raw.prepare("SELECT visits FROM users WHERE user_id = 'u'").get() as any).visits;
    const t0 = Date.parse("2026-11-09T10:00:00Z");
    await touchUser(d1, "u", "google", t0);
    expect(visits()).toBe(1);
    await touchUser(d1, "u", "google", t0 + 10 * MIN); // still the same visit
    await touchUser(d1, "u", "google", t0 + 25 * MIN); // 15 min after last activity: not more than 15
    expect(visits()).toBe(1);
    await touchUser(d1, "u", "google", t0 + 40 * MIN + 1); // > 15 min since last activity
    expect(visits()).toBe(2);
    await touchUser(d1, "u", "google", t0 + 30 * MIN); // late, out-of-order request: no change
    expect(visits()).toBe(2);
    expect((raw.prepare("SELECT last_seen_ms FROM users").get() as any).last_seen_ms).toBe(t0 + 40 * MIN + 1);
  });

  it("reports registered users and users with 3 or more visits", async () => {
    const { d1 } = sqliteD1();
    const t0 = Date.parse("2026-11-09T08:00:00Z");
    for (let i = 0; i < 6; i++) await touchUser(d1, "heavy", "cloudflare", t0 + i * 20 * MIN); // 6 visits
    for (let i = 0; i < 3; i++) await touchUser(d1, "three", "google", t0 + i * 20 * MIN); // exactly 3: counted
    for (let i = 0; i < 2; i++) await touchUser(d1, "two", "google", t0 + i * 20 * MIN); // 2: not counted
    await touchUser(d1, "once", "google", t0);
    expect(await getStats(d1)).toEqual({ registered: 4, engaged: 2 });
  });

  it("is recorded on authenticated API requests", async () => {
    const { d1, raw } = sqliteD1();
    const env = { SESSION_SECRET: SECRET, DB: d1 } as Env;
    const cookie = `kp_session=${await signToken({ uid: "google:1", email: "", prov: "google", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
    await handleApi(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }), env, new URL(`${ORIGIN}/api/me`));
    expect(raw.prepare("SELECT user_id, provider, visits FROM users").all()).toEqual([{ user_id: "google:1", provider: "google", visits: 1 }]);
    expect(raw.prepare("SELECT user_id FROM activity").all()).toEqual([{ user_id: "google:1" }]);
  });

  it("accepts the activity ping (POST with matching Origin) and logs who and when only", async () => {
    const { d1, raw } = sqliteD1();
    const env = { SESSION_SECRET: SECRET, DB: d1 } as Env;
    const cookie = `kp_session=${await signToken({ typ: "session", uid: "cf-1", email: "", prov: "cloudflare", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
    const ping = (origin: string) =>
      handleApi(new Request(`${ORIGIN}/api/ping`, { method: "POST", headers: { cookie, origin } }), env, new URL(`${ORIGIN}/api/ping`));
    expect((await ping(ORIGIN)).status).toBe(204);
    expect((await ping("https://evil.example")).status).toBe(403);
    expect(raw.prepare("PRAGMA table_info(activity)").all().map((c: any) => c.name)).toEqual(["user_id", "at_ms"]);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM activity").get() as any).n).toBeGreaterThanOrEqual(1);
    expect((await handleApi(new Request(`${ORIGIN}/api/ping`, { method: "POST", headers: { origin: ORIGIN } }), env, new URL(`${ORIGIN}/api/ping`))).status).toBe(401);
  });
});

describe("/admin", () => {
  async function setup() {
    const { d1 } = sqliteD1();
    const env = { SESSION_SECRET: SECRET, DB: d1, OAUTH_CLIENT_ID: "cf", ASSETS: { fetch: async () => new Response("x") } } as unknown as Env;
    const cookieFor = async (prov?: string) =>
      `kp_session=${await signToken({ uid: prov === "google" ? "google:u1" : "u1", email: "", ...(prov ? { prov } : {}), exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
    const get = (cookie?: string) => worker.fetch(new Request(`${ORIGIN}/admin`, { headers: cookie ? { cookie } : {} }), env);
    return { d1, env, cookieFor, get };
  }

  it("sends signed-out visitors to Cloudflare sign-in and back to /admin", async () => {
    const { get, env } = await setup();
    const res = await get();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login?next=/admin");
    const login = await worker.fetch(new Request(`${ORIGIN}/auth/login?next=/admin`), env);
    expect(login.headers.get("location")).toMatch(/^https:\/\/dash\.cloudflare\.com\/oauth2\/auth/);
  });

  it("refuses Google sessions", async () => {
    const { get, cookieFor } = await setup();
    const res = await get(await cookieFor("google"));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('id="registered"');
  });

  it("shows stats to Cloudflare sessions (including cookies from before providers were recorded)", async () => {
    const { get, cookieFor, d1 } = await setup();
    const t0 = Date.parse("2026-11-09T08:00:00Z");
    for (let i = 0; i < 6; i++) await touchUser(d1, "a", "google", t0 + i * 20 * MIN);
    await touchUser(d1, "b", "cloudflare", t0);
    for (const c of [await cookieFor("cloudflare"), await cookieFor()]) {
      const res = await get(c);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<dd id="registered">2</dd>');
      expect(html).toContain('<dd id="engaged">1</dd>');
    }
  });
});
