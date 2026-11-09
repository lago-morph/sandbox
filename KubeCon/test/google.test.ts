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

  it("links a verified email to the Cloudflare member with that email (same selections)", async () => {
    const { env, db } = makeEnv();
    // The member has used the app with Cloudflare: /api/me records their email.
    const cfCookie = `kp_session=${await signToken({ uid: "cf-user-1", email: "Owner@Example.com", exp: Math.floor(Date.now() / 1000) + 60 }, env.SESSION_SECRET)}`;
    await handleApi(new Request(`${ORIGIN}/api/me`, { headers: { cookie: cfCookie } }), env, new URL(`${ORIGIN}/api/me`));
    expect(db.identities.get("cloudflare|cf-user-1")?.email).toBe("Owner@Example.com");

    const { state, oauth } = await googleLogin(env);
    const { f, calls } = stubGoogle({ sub: "g-123", email: "owner@example.com", email_verified: true });
    const res = await googleCallback(callbackReq(state, oauth), env, f);
    expect(res.status).toBe(302);
    const session = res.headers.getSetCookie().find((c) => c.startsWith("kp_session="))!;
    expect(session).toContain("HttpOnly");
    const me = await handleApi(new Request(`${ORIGIN}/api/me`, { headers: { cookie: session.split(";")[0] } }), env, new URL(`${ORIGIN}/api/me`));
    expect(await me.json()).toEqual({ userId: "cf-user-1", email: "owner@example.com", provider: "google" });
    expect(db.identities.get("google|g-123")?.user_id).toBe("cf-user-1");

    const token = calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    const body = new URLSearchParams(String(token.init?.body));
    expect(body.get("client_secret")).toBe("g-secret");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.init?.redirect).toBe("manual");
  });

  it("refuses an unknown Google account and an unverified email", async () => {
    const { env } = makeEnv();
    let { state, oauth } = await googleLogin(env);
    const unknown = await googleCallback(callbackReq(state, oauth), env, stubGoogle({ sub: "g-9", email: "stranger@gmail.com", email_verified: true }).f);
    expect(unknown.status).toBe(403);
    expect(unknown.headers.get("set-cookie") ?? "").not.toContain("kp_session=");

    ({ state, oauth } = await googleLogin({ ...env, ALLOWED_EMAILS: "stranger@gmail.com" }));
    const unverified = await googleCallback(callbackReq(state, oauth), { ...env, ALLOWED_EMAILS: "stranger@gmail.com" }, stubGoogle({ sub: "g-9", email: "stranger@gmail.com", email_verified: false }).f);
    expect(unverified.status).toBe(403);
  });

  it("allows an ALLOWED_EMAILS Google account as its own user", async () => {
    const { env, db } = makeEnv({ ALLOWED_EMAILS: "friend@gmail.com" });
    const { state, oauth } = await googleLogin(env);
    const res = await googleCallback(callbackReq(state, oauth), env, stubGoogle({ sub: "g-7", email: "Friend@gmail.com", email_verified: true }).f);
    expect(res.status).toBe(302);
    expect(db.identities.get("google|g-7")?.user_id).toBe("google:g-7");
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
