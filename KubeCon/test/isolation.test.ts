// Authorization and CSRF checks against real SQL (node:sqlite), not the JS fake.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { SECURITY_HEADERS } from "../src/index";
import { signToken } from "../src/auth";
import { touchUser } from "../src/usage";
import type { Env } from "../src/types";
import { sqliteD1 } from "./sqliteD1";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";
const SECRET = "test-session-secret-0123456789abcdef";
const exp = () => Math.floor(Date.now() / 1000) + 60;

function setup() {
  const { d1, raw } = sqliteD1();
  raw.exec(`INSERT INTO sessions (id, source, title, day, starts_at, ends_at, track) VALUES
    ('s1','main','One','2026-11-09','2026-11-09T09:00:00','2026-11-09T09:30:00','T'),
    ('s2','main','Two','2026-11-09','2026-11-09T10:00:00','2026-11-09T10:30:00','T')`);
  const env = { SESSION_SECRET: SECRET, DB: d1, ASSETS: { fetch: async () => new Response("x") } } as unknown as Env;
  const cookie = async (uid: string, prov: string) => `kp_session=${await signToken({ typ: "session", uid, email: "", prov, exp: exp() }, SECRET)}`;
  const call = (method: string, path: string, c: string, opts: { origin?: string | null; body?: string } = {}) => {
    const headers: Record<string, string> = { cookie: c };
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body }), env);
  };
  const rows = () => raw.prepare("SELECT user_id, session_id, status FROM selections ORDER BY user_id, session_id").all();
  return { raw, d1, cookie, call, rows };
}

describe("users cannot see or change each other's selections (real SQL)", () => {
  it("isolates GET, PUT and DELETE by user", async () => {
    const { cookie, call, rows } = setup();
    const a = await cookie("cf-aaa", "cloudflare");
    const b = await cookie("google:bbb", "google");
    expect((await call("PUT", "/api/selections/s1", a, { body: JSON.stringify({ status: "favorite" }) })).status).toBe(204);
    expect(await (await call("GET", "/api/selections", b)).json()).toEqual([]);
    expect((await call("DELETE", "/api/selections/s1", b)).status).toBe(204); // idempotent, but only B's rows
    expect((await call("PUT", "/api/selections/s1", b, { body: JSON.stringify({ status: "interested" }) })).status).toBe(204);
    expect(rows()).toEqual([
      { user_id: "cf-aaa", session_id: "s1", status: "favorite" },
      { user_id: "google:bbb", session_id: "s1", status: "interested" },
    ]);
    expect(await (await call("GET", "/api/selections", a)).json()).toEqual([{ id: "s1", status: "favorite" }]);
  });
});

describe("CSRF: state-changing calls need a same-origin Origin header", () => {
  it("rejects missing, null and foreign Origin for PUT, DELETE and POST, writing nothing", async () => {
    const { cookie, call, rows, raw } = setup();
    const a = await cookie("cf-aaa", "cloudflare");
    await call("PUT", "/api/selections/s2", a);
    const before = JSON.stringify(rows());
    for (const origin of [null, "null", "https://evil.example"]) {
      expect((await call("PUT", "/api/selections/s1", a, { origin })).status).toBe(403);
      expect((await call("DELETE", "/api/selections/s2", a, { origin })).status).toBe(403);
      expect((await call("POST", "/api/import", a, { origin })).status).toBe(403);
      const pingsBefore = (raw.prepare("SELECT COUNT(*) AS n FROM activity").get() as any).n;
      expect((await call("POST", "/api/ping", a, { origin })).status).toBe(403);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM activity").get() as any).n).toBe(pingsBefore);
    }
    expect(JSON.stringify(rows())).toBe(before);
  });
});

describe("provider and user-id namespaces must match", () => {
  it("rejects a Google token with a Cloudflare user id and vice versa", async () => {
    const { call } = setup();
    for (const [uid, prov] of [["cf-aaa", "google"], ["google:bbb", "cloudflare"], ["google:bbb", undefined]]) {
      const c = `kp_session=${await signToken({ typ: "session", uid, email: "", ...(prov ? { prov } : {}), exp: exp() }, SECRET)}`;
      expect((await call("GET", "/api/me", c)).status).toBe(401);
    }
  });
});

describe("abuse limits", () => {
  it("writes at most one activity row and one users update per user per minute", async () => {
    const { d1, raw } = setup();
    const t0 = Date.parse("2026-11-09T10:00:00Z");
    for (let i = 0; i < 50; i++) await touchUser(d1, "google:x", "google", t0 + i * 1000); // 50 requests in 50 s
    expect((raw.prepare("SELECT COUNT(*) AS n FROM activity").get() as any).n).toBe(1);
    await touchUser(d1, "google:x", "google", t0 + 61_000);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM activity").get() as any).n).toBe(2);
    expect((raw.prepare("SELECT last_seen_ms FROM users").get() as any).last_seen_ms).toBe(t0 + 61_000);
  });

  it("refuses request bodies over 1 KB", async () => {
    const { cookie, call } = setup();
    const a = await cookie("cf-aaa", "cloudflare");
    const res = await call("PUT", "/api/selections/s1", a, { body: JSON.stringify({ status: "favorite", pad: "x".repeat(2000) }) });
    expect(res.status).toBe(413);
  });
});

describe("error pages", () => {
  it("never echo free text from the OAuth error redirect", async () => {
    const { call } = setup();
    for (const path of ["/auth/callback", "/auth/google/callback"]) {
      const res = await call("GET", `${path}?error=access_denied&error_description=Your%20account%20is%20locked%2C%20call%20555`, "");
      const html = await res.text();
      expect(html).toContain("(access_denied)");
      expect(html).not.toContain("555");
      const spoof = await (await call("GET", `${path}?error=Visit%20evil.example%20now`, "")).text();
      expect(spoof).not.toContain("evil.example");
    }
  });
});

describe("static asset headers", () => {
  it("public/_headers matches the Worker's security headers", () => {
    const file = readFileSync("public/_headers", "utf8").toLowerCase();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(file).toContain(`${k}: ${v}`.toLowerCase());
  });
});
