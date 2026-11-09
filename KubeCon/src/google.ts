/** Sign in with Google (OAuth 2.0 authorization code + PKCE, OpenID Connect userinfo). */
import { checkOAuthState, errorPage, signedIn, startOAuth } from "./auth";
import { findCloudflareUserByEmail, findIdentity, recordIdentity } from "./identities";
import type { Env } from "./types";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleRedirectUri(req: Request): string {
  return `${new URL(req.url).origin}/auth/google/callback`;
}

/** GET /auth/google/login */
export async function googleLogin(req: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_APP_ID) return errorPage(500, "Google sign-in is not configured.");
  const { state, challenge, cookie } = await startOAuth(env, "google");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.GOOGLE_APP_ID,
    redirect_uri: googleRedirectUri(req),
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: { location: `${GOOGLE_AUTHORIZE_URL}?${q.toString().replace(/\+/g, "%20")}`, "set-cookie": cookie, "cache-control": "no-store" },
  });
}

/**
 * Who may sign in with Google, and as which user (selections are keyed by user_id):
 * 1. A Google identity seen before keeps its linked user.
 * 2. A verified email matching a Cloudflare member who has signed in before links to that member's user,
 *    so the same person sees the same selections whichever provider they use.
 * 3. A verified email in ALLOWED_EMAILS gets its own user ("google:<sub>").
 * Anyone else is refused.
 */
async function resolveGoogleUser(env: Env, sub: string, email: string): Promise<string | null> {
  const known = await findIdentity(env.DB, "google", sub);
  if (known) return known;
  const member = await findCloudflareUserByEmail(env.DB, email);
  if (member) return member;
  const allowed = (env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(email.toLowerCase())) return `google:${sub}`;
  return null;
}

/** GET /auth/google/callback */
export async function googleCallback(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) return errorPage(400, `Google returned: ${err}`);
  const verifier = await checkOAuthState(req, env, "google");
  const code = url.searchParams.get("code") ?? "";
  if (!verifier) return errorPage(400, "The sign-in request expired or did not match. Please try again.");
  if (!code) return errorPage(400, "No authorization code was returned.");

  try {
    const tokenRes = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: googleRedirectUri(req),
        client_id: env.GOOGLE_APP_ID,
        client_secret: env.GOOGLE_APP_SECRET,
        code_verifier: verifier,
      }).toString(),
      redirect: "manual",
    });
    if (!tokenRes.ok) return errorPage(502, `Google token exchange failed (HTTP ${tokenRes.status}).`);
    const accessToken = ((await tokenRes.json()) as any)?.access_token;
    if (typeof accessToken !== "string" || !accessToken) return errorPage(502, "Google returned no access token.");

    const infoRes = await fetchImpl(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "manual" });
    if (!infoRes.ok) return errorPage(502, `Could not read your Google account (HTTP ${infoRes.status}).`);
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean | string };
    const sub = typeof info.sub === "string" ? info.sub : "";
    const email = typeof info.email === "string" ? info.email : "";
    if (!sub || !email) return errorPage(502, "Google did not return an account id and email.");
    if (info.email_verified !== true && info.email_verified !== "true") return errorPage(403, "Your Google email address is not verified.");

    const uid = await resolveGoogleUser(env, sub, email);
    if (!uid) {
      return errorPage(403, "This Google account is not allowed. Sign in with Cloudflare once first (same email), or ask the owner to add your email.");
    }
    await recordIdentity(env.DB, "google", sub, uid, email);
    return signedIn(env, uid, email, "google");
  } catch {
    return errorPage(502, "Sign-in failed while talking to Google.");
  }
}
