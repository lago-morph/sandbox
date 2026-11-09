/** Sign in with Google (OAuth 2.0 authorization code + PKCE, OpenID Connect userinfo). */
import { checkOAuthState, errorPage, signedIn, startOAuth } from "./auth";
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
 * Any Google account may sign in. Each Google account is its own user ("google:<sub>"), with its own
 * selections; it is never linked to a Cloudflare user or another identity, even with the same email.
 */
export function googleUserId(sub: string): string {
  return `google:${sub}`;
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
    const info = (await infoRes.json()) as { sub?: string; email?: string };
    const sub = typeof info.sub === "string" ? info.sub : "";
    if (!sub) return errorPage(502, "Google did not return an account id.");
    const email = typeof info.email === "string" ? info.email : "";
    return signedIn(env, googleUserId(sub), email, "google");
  } catch {
    return errorPage(502, "Sign-in failed while talking to Google.");
  }
}
