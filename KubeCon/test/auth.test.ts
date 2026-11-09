import { describe, expect, it } from "vitest";
import worker, { handleApi } from "../src/index";
import { callback, signToken } from "../src/auth";
import type { Env } from "../src/types";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";
const env = {
  OAUTH_CLIENT_ID: "client-123",
  OAUTH_CLIENT_SECRET: "shh-client-secret",
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  ACCOUNT_ID: "acct-1",
  ALLOWED_EMAILS: "",
  DB: {} as D1Database,
  ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
} as Env;

async function doLogin() {
  const res = await worker.fetch(new Request(`${ORIGIN}/auth/login`), env);
  const setCookie = res.headers.get("set-cookie")!;
  const oauth = setCookie.split(";")[0];
  const loc = new URL(res.headers.get("location")!);
  return { res, oauth, loc, state: loc.searchParams.get("state")! };
}

function stubFetch(memberships: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const url = String(input);
    if (url === "https://dash.cloudflare.com/oauth2/token")
      return Response.json({ access_token: "cf-access", token_type: "bearer", id_token: "x.eyJzdWIiOiJ1c2VyLTEifQ.y" });
    if (url === "https://api.cloudflare.com/client/v4/user")
      return Response.json({ success: true, result: { id: "user-1", email: "owner@example.com" } });
    if (url.startsWith("https://api.cloudflare.com/client/v4/memberships"))
      return Response.json({ success: true, result: memberships, result_info: { page: 1, total_pages: 1 } });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("auth", () => {
  it("login sets kp_oauth and redirects to Cloudflare with PKCE S256, redirect_uri and scopes", async () => {
    const { res, loc } = await doLogin();
    expect(res.status).toBe(302);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(loc.searchParams.get("scope")).toBe("user-details.read memberships.read");
    expect(loc.searchParams.get("client_id")).toBe("client-123");
    const c = res.headers.get("set-cookie")!;
    expect(c).toMatch(/^kp_oauth=/);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Path=/auth");
    expect(c).toContain("Max-Age=600");
  });

  it("callback rejects a missing or mismatched state", async () => {
    const { oauth } = await doLogin();
    const { f, calls } = stubFetch([]);
    const missing = await callback(new Request(`${ORIGIN}/auth/callback?code=abc&state=zzz`), env, f);
    expect(missing.status).toBe(400);
    const wrong = await callback(new Request(`${ORIGIN}/auth/callback?code=abc&state=zzz`, { headers: { cookie: oauth } }), env, f);
    expect(wrong.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("callback posts code_verifier, client_secret, redirect_uri and grant_type to the token URL", async () => {
    const { oauth, state } = await doLogin();
    const { f, calls } = stubFetch([{ account: { id: "acct-1" }, status: "accepted" }]);
    await callback(new Request(`${ORIGIN}/auth/callback?code=the-code&state=${state}`, { headers: { cookie: oauth } }), env, f);
    const tokenCall = calls.find((c) => c.url === "https://dash.cloudflare.com/oauth2/token")!;
    expect(tokenCall.init?.method).toBe("POST");
    expect(tokenCall.init?.redirect).toBe("manual");
    const body = new URLSearchParams(String(tokenCall.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("client_secret")).toBe("shh-client-secret");
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a non-member with 403 and signs in an accepted member", async () => {
    const a = await doLogin();
    const nonMember = stubFetch([{ account: { id: "other" }, status: "accepted" }, { account: { id: "acct-1" }, status: "pending" }]);
    const r403 = await callback(new Request(`${ORIGIN}/auth/callback?code=c&state=${a.state}`, { headers: { cookie: a.oauth } }), env, nonMember.f);
    expect(r403.status).toBe(403);
    expect(await r403.text()).toContain("Not a member of this Cloudflare account");
    expect(r403.headers.get("set-cookie") ?? "").not.toContain("kp_session=");

    const b = await doLogin();
    const member = stubFetch([{ account: { id: "acct-1" }, status: "accepted" }]);
    const ok = await callback(new Request(`${ORIGIN}/auth/callback?code=c&state=${b.state}`, { headers: { cookie: b.oauth } }), env, member.f);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
    const cookies = ok.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("kp_session="))!;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Max-Age=604800");
    expect(cookies.some((c) => c.startsWith("kp_oauth=;") && c.includes("Max-Age=0"))).toBe(true);
    // The session cookie authenticates /api/me.
    const me = await handleApi(new Request(`${ORIGIN}/api/me`, { headers: { cookie: session.split(";")[0] } }), env, new URL(`${ORIGIN}/api/me`));
    expect(await me.json()).toEqual({ userId: "user-1", email: "owner@example.com" });
  });

  it("allows an ALLOWED_EMAILS user without membership", async () => {
    const a = await doLogin();
    const { f } = stubFetch([]);
    const res = await callback(new Request(`${ORIGIN}/auth/callback?code=c&state=${a.state}`, { headers: { cookie: a.oauth } }), { ...env, ALLOWED_EMAILS: "x@y.z, OWNER@example.com" }, f);
    expect(res.status).toBe(302);
  });

  it("rejects a tampered or expired cookie at /api/me", async () => {
    const good = await signToken({ uid: "u", email: "e@x", exp: Math.floor(Date.now() / 1000) + 60 }, env.SESSION_SECRET);
    const [payload, sig] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "admin", email: "e@x", exp: 9999999999 })).toString("base64url");
    const url = new URL(`${ORIGIN}/api/me`);
    const call = (c: string) => handleApi(new Request(url, { headers: { cookie: `kp_session=${c}` } }), env, url);
    expect((await call(good)).status).toBe(200);
    expect((await call(`${forged}.${sig}`)).status).toBe(401);
    expect((await call(`${payload}.${sig.slice(0, -2)}AA`)).status).toBe(401);
    const expired = await signToken({ uid: "u", email: "e@x", exp: Math.floor(Date.now() / 1000) - 1 }, env.SESSION_SECRET);
    expect((await call(expired)).status).toBe(401);
  });

  it("logout clears the cookie", async () => {
    for (const method of ["POST", "GET"]) {
      const res = await worker.fetch(new Request(`${ORIGIN}/auth/logout`, { method }), env);
      expect(res.status).toBe(302);
      expect(res.headers.get("set-cookie")).toMatch(/^kp_session=; .*Max-Age=0/);
    }
  });

  it("requires a matching Origin on state-changing API calls", async () => {
    const cookie = `kp_session=${await signToken({ uid: "u", email: "", exp: Math.floor(Date.now() / 1000) + 60 }, env.SESSION_SECRET)}`;
    const url = new URL(`${ORIGIN}/api/import`);
    const res = await handleApi(new Request(url, { method: "POST", headers: { cookie, origin: "https://evil.example" } }), env, url);
    expect(res.status).toBe(403);
  });
});
