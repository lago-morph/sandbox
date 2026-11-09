/** /admin: usage stats, for Cloudflare sign-ins only (account members or ALLOWED_EMAILS). */
import { currentUser } from "./auth";
import { ENGAGED_MIN_VISITS, getStats } from "./usage";
import type { Env } from "./types";

function page(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KubeCon planner admin</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="center admin">${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function adminPage(req: Request, env: Env): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) {
    return new Response(null, { status: 302, headers: { location: "/auth/login?next=/admin", "cache-control": "no-store" } });
  }
  if ((user.prov ?? "cloudflare") !== "cloudflare") {
    return page(403, `<h1>Cloudflare sign-in required</h1>
<p>The admin page is only available when signed in with Cloudflare.</p>
<p><a class="btn primary" href="/auth/login?next=/admin">Sign in with Cloudflare</a></p>`);
  }
  const s = await getStats(env.DB);
  const asOf = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  return page(200, `<h1>Usage</h1>
<dl class="stats">
  <dt>Registered users</dt><dd id="registered">${s.registered}</dd>
  <dt>Used the app ${ENGAGED_MIN_VISITS} or more times</dt><dd id="engaged">${s.engaged}</dd>
</dl>
<p class="meta">A user is registered once they have signed in. A new use is counted when they are active more than 15 minutes after their previous activity. As of ${asOf} Salt Lake City time.</p>
<p><a class="btn" href="/">Back to the planner</a></p>`);
}
