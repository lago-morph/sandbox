// npm run smoke (R-7.5): live checks against the deployed Worker.
import { wrangler } from "./wr.mjs";

const APP = process.env.APP_NAME || "kubecon-planner";
const ORIGIN = `https://${APP}.cloud-app-asdf.workers.dev`;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const home = await fetch(`${ORIGIN}/`);
check("GET / is 200 HTML", home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html"), `${home.status}`);

const me = await fetch(`${ORIGIN}/api/me`);
check("GET /api/me without cookie is 401", me.status === 401, `${me.status}`);

const login = await fetch(`${ORIGIN}/auth/login`, { redirect: "manual" });
const loc = login.headers.get("location") ?? "";
check("GET /auth/login is 302 to dash.cloudflare.com/oauth2/auth", login.status === 302 && loc.startsWith("https://dash.cloudflare.com/oauth2/auth"), `${login.status}`);

const out = await wrangler(
  ["d1", "execute", "kubecon-planner", "--remote", "--json", "--command", "SELECT day, COUNT(*) AS n FROM sessions GROUP BY day ORDER BY day"],
  { quiet: true },
);
const rows = JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? [];
for (const r of rows) console.log(`      ${r.day}  ${r.n}`);
const biggest = rows.reduce((a, b) => (b.n > (a?.n ?? -1) ? b : a), null);
check("D1 has 5 days with Monday 2026-11-09 the largest", rows.length === 5 && biggest?.day === "2026-11-09", `${rows.reduce((s, r) => s + r.n, 0)} sessions`);

process.exit(failed ? 1 : 0);
