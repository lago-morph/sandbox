import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { signToken } from "../src/auth";
import type { Env } from "../src/types";
import { sqliteD1 } from "./sqliteD1";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";
const SECRET = "test-session-secret-0123456789abcdef";

function setup() {
  const { d1 } = sqliteD1();
  const env = {
    SESSION_SECRET: SECRET, DB: d1, OAUTH_CLIENT_ID: "cf", GOOGLE_APP_ID: "g",
    ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) },
  } as unknown as Env;
  const get = (path: string, cookie?: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }), env);
  return { env, get };
}
const exp = () => Math.floor(Date.now() / 1000) + 60;

describe("token type confusion", () => {
  it("rejects a kp_oauth state token (from /auth/login) used as kp_session", async () => {
    const { get } = setup();
    for (const path of ["/auth/login", "/auth/google/login", "/auth/login?next=/admin"]) {
      const login = await get(path);
      const oauth = login.headers.get("set-cookie")!.match(/^kp_oauth=([^;]+)/)![1];
      const cookie = `kp_session=${oauth}`;
      expect((await get("/api/me", cookie)).status).toBe(401);
      expect((await get("/api/sessions", cookie)).status).toBe(401);
      expect((await get("/admin", cookie)).status).toBe(302); // treated as signed out
    }
  });

  it("rejects signed tokens without a user id or with an unknown type or provider", async () => {
    const { get } = setup();
    for (const payload of [
      { email: "x", exp: exp() },
      { uid: "", exp: exp() },
      { uid: 5, exp: exp() },
      { typ: "oauth", uid: "u", exp: exp() },
      { typ: "other", uid: "u", exp: exp() },
      { uid: "u", prov: "github", exp: exp() },
    ]) {
      expect((await get("/api/me", `kp_session=${await signToken(payload, SECRET)}`)).status).toBe(401);
    }
  });

  it("still accepts session cookies issued before token types existed", async () => {
    const { get } = setup();
    const legacy = `kp_session=${await signToken({ uid: "cf-1", email: "a@b", exp: exp() }, SECRET)}`;
    expect((await get("/api/me", legacy)).status).toBe(200);
  });

  it("does not accept a session token as the OAuth state cookie", async () => {
    const { get } = setup();
    const session = await signToken({ typ: "session", uid: "u", state: "s", verifier: "v".repeat(43), exp: exp() }, SECRET);
    const res = await get("/auth/callback?code=c&state=s", `kp_oauth=${session}`);
    expect(res.status).toBe(400);
  });
});

describe("hardening", () => {
  it("answers 404, not a crash, for malformed % sequences in ids", async () => {
    const { get, env } = setup();
    const cookie = `kp_session=${await signToken({ typ: "session", uid: "u", exp: exp() }, SECRET)}`;
    expect((await get("/api/sessions/%E0%A4%A", cookie)).status).toBe(404);
    const put = await worker.fetch(
      new Request(`${ORIGIN}/api/selections/%E0%A4%A`, { method: "PUT", headers: { cookie, origin: ORIGIN } }),
      env,
    );
    expect(put.status).toBe(404);
  });

  it("sets security headers on pages, API and auth responses", async () => {
    const { get } = setup();
    for (const path of ["/", "/api/me", "/auth/login", "/admin"]) {
      const res = await get(path);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });
});
