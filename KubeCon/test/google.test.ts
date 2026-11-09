import { describe, expect, it } from "vitest";
import worker, { handleApi } from "../src/index";
import { googleCallback } from "../src/google";
import { signToken } from "../src/auth";
import type { Env } from "../src/types";
import { FakeD1 } from "./fakeD1";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";

function makeEnv(extra: Partial<Env> = {}) {
  const db = new FakeD1();
  const env = {
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    OAUTH_CLIENT_ID: "cf-client",
    OAUTH_CLIENT_SECRET: "cf-secret",
    GOOGLE_APP_ID: "g-client.apps.googleusercontent.com",
    GOOGLE_APP_SECRET: "g-secret",
    ACCOUNT_ID: "acct-1",
    ALLOWED_EMAILS: "",
    DB: db as unknown as D1Database,
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ...extra,
  } as Env;
  return { env, db };
}

async function googleLogin(env: Env) {
  const res = await worker.fetch(new Request(`${ORIGIN}/auth/google/login`), env);
  const loc = new URL(res.headers.get("location")!);
  return { res, loc, oauth: res.headers.get("set-cookie")!.split(";")[0], state: loc.searchParams.get("state")! };
}

function stubGoogle(info: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "g-access", id_token: "x.y.z" });
    if (String(input) === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json(info);
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const callbackReq = (state: string, oauth: string) =>
  new Request(`${ORIGIN}/auth/google/callback?code=g-code&state=${state}`, { headers: { cookie: oauth } });

describe("Google sign-in", () => {
  it("redirects to Google with PKCE S256, its own redirect URI and openid email scope", async () => {
    const { env } = makeEnv();
    const { res, loc } = await googleLogin(env);
    expect(res.status).toBe(302);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("client_id")).toBe("g-client.apps.googleusercontent.com");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(loc.searchParams.get("scope")).toBe("openid email");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(res.headers.get("set-cookie")).toMatch(/^kp_oauth=.*Path=\/auth/);
  });

  it("signs in any Google account as its own user, never linked to a Cloudflare user with the same email", async () => {
    const { env, db } = makeEnv();
    db.sessions.set("s1", { id: "s1" });
    // A Cloudflare member with the same email already has a selection.
    db.selections.set("cf-user-1|s1", { user_id: "cf-user-1", session_id: "s1", status: "favorite", created_at: "x" });

    const { state, oauth } = await googleLogin(env);
    const { f, calls } = stubGoogle({ sub: "g-123", email: "owner@example.com", email_verified: false });
    const res = await googleCallback(callbackReq(state, oauth), env, f);
    expect(res.status).toBe(302);
    const session = res.headers.getSetCookie().find((c) => c.startsWith("kp_session="))!;
    expect(session).toContain("HttpOnly");
    const cookie = session.split(";")[0];
    const call = (path: string) => handleApi(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), env, new URL(`${ORIGIN}${path}`));
    expect(await (await call("/api/me")).json()).toEqual({ userId: "google:g-123", email: "owner@example.com", provider: "google" });
    expect(await (await call("/api/selections")).json()).toEqual([]);

    const token = calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    const body = new URLSearchParams(String(token.init?.body));
    expect(body.get("client_secret")).toBe("g-secret");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.init?.redirect).toBe("manual");
  });

  it("gives two Google accounts separate profiles", async () => {
    const { env } = makeEnv();
    const ids: string[] = [];
    for (const sub of ["g-1", "g-2"]) {
      const { state, oauth } = await googleLogin(env);
      const res = await googleCallback(callbackReq(state, oauth), env, stubGoogle({ sub, email: "same@gmail.com" }).f);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("kp_session="))!.split(";")[0];
      const me = await handleApi(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }), env, new URL(`${ORIGIN}/api/me`));
      ids.push(((await me.json()) as { userId: string }).userId);
    }
    expect(ids).toEqual(["google:g-1", "google:g-2"]);
  });

  it("rejects a callback without a Google account id", async () => {
    const { env } = makeEnv();
    const { state, oauth } = await googleLogin(env);
    const res = await googleCallback(callbackReq(state, oauth), env, stubGoogle({ email: "x@gmail.com" }).f);
    expect(res.status).toBe(502);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("kp_session=");
  });

  it("does not accept a Cloudflare kp_oauth cookie on the Google callback", async () => {
    const { env } = makeEnv();
    const cf = await worker.fetch(new Request(`${ORIGIN}/auth/login`), env);
    const oauth = cf.headers.get("set-cookie")!.split(";")[0];
    const state = new URL(cf.headers.get("location")!).searchParams.get("state")!;
    const { f, calls } = stubGoogle({ sub: "g-1", email: "a@b.c", email_verified: true });
    expect((await googleCallback(callbackReq(state, oauth), env, f)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
