/**
 * Nightly email summaries (migration 0008).
 *
 * - Users opt in from the app (bell button). Opting in sends a confirmation email; nothing else is
 *   sent until the link in it is used, which proves the address belongs to them.
 * - A Cron Trigger runs at 06:00 UTC = midnight Central (CST, UTC-6). Runs only happen on the 7
 *   nights listed in RUN_DAYS (Central dates); each refreshes the schedule from Sessionize and then
 *   emails every confirmed subscriber whose favorite/interested sessions changed: mainly new,
 *   updated or removed links (slides, recording, live stream, GitHub, demo, website), plus time,
 *   room or title changes and sessions removed from the schedule. No change, no email.
 * - Every email has a one-click unsubscribe link (also as List-Unsubscribe headers) and names the
 *   owner's contact address (secret CONTACT_EMAIL, kept out of the public repo).
 */
import { signToken, verifyToken } from "./auth";
import { runImport } from "./importer";
import type { Env } from "./types";

/** Central-time dates of the 7 nightly runs (each at 00:00 CST). */
export const RUN_DAYS = ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];
/** After the last run nobody can opt in any more. 2026-11-19 00:00 CST = 06:00 UTC. */
export const LAST_RUN_MS = Date.parse("2026-11-19T06:00:00Z");
export const LAST_RUN_LABEL = "midnight Central time on Thursday, Nov 19";
export const FROM = { email: "planner@shareplay.com", name: "KubeCon Planner" };
const CONFIRM_TTL_S = 2 * 24 * 3600;
const UNSUB_TTL_S = 30 * 24 * 3600;
const RESEND_AFTER_MS = 10 * 60 * 1000;

/** SQL for a session row's fingerprint: what a change is detected against. Used everywhere. */
const FP = "json_object('t', x.title, 'd', x.day, 's', x.starts_at, 'e', x.ends_at, 'r', x.room, 'l', json(x.links))";
const REMOVED = "REMOVED";

export function centralParts(ms: number): { date: string; hour: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** True for the scheduled midnight-Central runs on the 7 summary nights. */
export function shouldRunNightly(ms: number): boolean {
  const c = centralParts(ms);
  return c.hour === 0 && RUN_DAYS.includes(c.date);
}

export const summariesOpen = (nowMs = Date.now()) => nowMs < LAST_RUN_MS;

// ---------- small helpers ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const nowIso = () => new Date().toISOString();

function page(status: number, title: string, bodyHtml: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="center admin"><h1>${esc(title)}</h1>${bodyHtml}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function footerText(env: Env, unsubUrl?: string) {
  const lines = [
    `You're getting this because you turned on nightly summaries in the KubeCon planner (${env.APP_ORIGIN}). Summaries stop after ${LAST_RUN_LABEL}.`,
  ];
  if (unsubUrl) lines.push(`Unsubscribe: ${unsubUrl}`);
  if (env.CONTACT_EMAIL) lines.push(`If these emails start spamming you or don't stop when you want them to, contact ${env.CONTACT_EMAIL}.`);
  return lines.join("\n");
}

function footerHtml(env: Env, unsubUrl?: string) {
  return `<hr><p style="color:#6b7280;font-size:13px">You're getting this because you turned on nightly summaries in the
<a href="${esc(env.APP_ORIGIN)}">KubeCon planner</a>. Summaries stop after ${esc(LAST_RUN_LABEL)}.
${unsubUrl ? `<a href="${esc(unsubUrl)}">Unsubscribe</a>.` : ""}
${env.CONTACT_EMAIL ? `If these emails start spamming you or don't stop when you want them to, contact <a href="mailto:${esc(env.CONTACT_EMAIL)}">${esc(env.CONTACT_EMAIL)}</a>.` : ""}</p>`;
}

async function logEmail(env: Env, userId: string, kind: string, ok: boolean, detail = "") {
  try {
    await env.DB.prepare("INSERT INTO email_log (user_id, kind, at, ok, detail) VALUES (?, ?, ?, ?, ?)").bind(userId, kind, nowIso(), ok ? 1 : 0, detail.slice(0, 200)).run();
  } catch (e) {
    console.error("email_log failed", (e as Error).message);
  }
}

async function unsubscribeUrl(env: Env, userId: string) {
  const t = await signToken({ typ: "notify-unsub", uid: userId, exp: Math.floor(Date.now() / 1000) + UNSUB_TTL_S }, env.SESSION_SECRET);
  return `${env.APP_ORIGIN}/notify/unsubscribe/${t}`;
}

// ---------- opt in / out (signed-in API) ----------

interface SubRow {
  email: string;
  status: string;
  requested_at: string | null;
}

async function getSub(env: Env, userId: string): Promise<SubRow | null> {
  return env.DB.prepare("SELECT email, status, requested_at FROM email_subs WHERE user_id = ?").bind(userId).first<SubRow>();
}

export async function notifyState(env: Env, userId: string, signedInEmail: string) {
  const sub = await getSub(env, userId);
  return {
    status: (sub?.status ?? "off") as "off" | "pending" | "active",
    email: sub && sub.status !== "off" ? sub.email : signedInEmail,
    open: summariesOpen(),
    lastRun: LAST_RUN_LABEL,
  };
}

/** POST /api/notify {on}. Turning on sends a confirmation email; turning off is immediate. */
export async function setNotify(env: Env, userId: string, signedInEmail: string, on: boolean): Promise<{ status: number; body: unknown }> {
  if (!on) {
    await env.DB.prepare("UPDATE email_subs SET status = 'off', updated_at = ? WHERE user_id = ?").bind(nowIso(), userId).run();
    return { status: 200, body: await notifyState(env, userId, signedInEmail) };
  }
  if (!summariesOpen()) return { status: 409, body: { error: "Nightly summaries have ended." } };
  const email = signedInEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: "Your sign-in has no email address." } };

  const sub = await getSub(env, userId);
  if (sub?.status === "active" && sub.email === email) return { status: 200, body: await notifyState(env, userId, signedInEmail) };
  const recent = sub?.status === "pending" && sub.email === email && sub.requested_at && Date.now() - Date.parse(sub.requested_at) < RESEND_AFTER_MS;
  if (recent) return { status: 200, body: await notifyState(env, userId, signedInEmail) };

  const t = await signToken({ typ: "notify-confirm", uid: userId, email, exp: Math.floor(Date.now() / 1000) + CONFIRM_TTL_S }, env.SESSION_SECRET);
  const link = `${env.APP_ORIGIN}/notify/confirm/${t}`;
  try {
    await env.EMAIL.send({
      to: email,
      from: FROM,
      subject: "Confirm nightly KubeCon planner summaries",
      text: `Confirm that you want nightly summaries of changes to your favorite and interested KubeCon sessions (mostly new slide and video links):\n\n${link}\n\nThis link works for 2 days. If you didn't ask for this, ignore this email and nothing more will be sent.\n\n${footerText(env)}`,
      html: `<p>Confirm that you want nightly summaries of changes to your ★ favorite and ✓ interested KubeCon sessions (mostly new slide and video links).</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#f38020;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Confirm summaries</a></p>
<p>This link works for 2 days. If you didn't ask for this, ignore this email and nothing more will be sent.</p>${footerHtml(env)}`,
    });
    await logEmail(env, userId, "confirm", true);
  } catch (e) {
    await logEmail(env, userId, "confirm", false, `${(e as any).code ?? ""} ${(e as Error).message}`);
    return { status: 502, body: { error: "Could not send the confirmation email. Try again later." } };
  }
  await env.DB.prepare(
    "INSERT INTO email_subs (user_id, email, status, requested_at, confirmed_at, updated_at) VALUES (?1, ?2, 'pending', ?3, NULL, ?3) " +
      "ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, status = 'pending', requested_at = excluded.requested_at, updated_at = excluded.updated_at",
  )
    .bind(userId, email, nowIso())
    .run();
  return { status: 200, body: await notifyState(env, userId, signedInEmail) };
}

/** Record the current state of all of a user's selected sessions (the baseline for changes). */
async function snapshotAll(env: Env, userId: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO email_snapshots (user_id, session_id, fingerprint)
     SELECT sel.user_id, sel.session_id, COALESCE((SELECT ${FP} FROM sessions x WHERE x.id = sel.session_id), '${REMOVED}')
     FROM selections sel WHERE sel.user_id = ?`,
  )
    .bind(userId)
    .run();
}

/** SQL run when a confirmed subscriber selects a session: its current state is the baseline. */
export const SEED_SNAPSHOT_SQL = `INSERT OR IGNORE INTO email_snapshots (user_id, session_id, fingerprint)
  SELECT ?1, x.id, ${FP} FROM sessions x
  WHERE x.id = ?2 AND EXISTS (SELECT 1 FROM email_subs WHERE user_id = ?1 AND status = 'active')`;

// ---------- confirm / unsubscribe pages (the link is the credential) ----------

/** GET shows a button (so link scanners can't act); POST acts. Also accepts RFC 8058 one-click POSTs. */
export async function notifyLinkPage(req: Request, env: Env, action: "confirm" | "unsubscribe", token: string): Promise<Response> {
  const typ = action === "confirm" ? "notify-confirm" : "notify-unsub";
  const t = await verifyToken<{ typ: string; uid: string; email?: string; exp: number }>(token, env.SESSION_SECRET);
  if (!t || t.typ !== typ || typeof t.uid !== "string" || !t.uid) {
    return page(410, "Link expired", `<p>This link is invalid or has expired. You can change summaries from the bell button in the <a href="/">planner</a>.</p>`);
  }
  if (req.method === "GET") {
    const label = action === "confirm" ? "Confirm nightly summaries" : "Unsubscribe from nightly summaries";
    return page(200, label, `<form method="post"><button class="btn primary big" type="submit">${label}</button></form>`);
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (action === "unsubscribe") {
    await env.DB.prepare("UPDATE email_subs SET status = 'off', updated_at = ? WHERE user_id = ?").bind(nowIso(), t.uid).run();
    return page(200, "Unsubscribed", `<p>You won't get any more summaries. You can turn them back on from the bell button in the <a href="/">planner</a>.</p>`);
  }
  const sub = await getSub(env, t.uid);
  if (sub?.status === "active" && sub.email === t.email) return page(200, "Already on", `<p>Nightly summaries are already on. <a href="/">Back to the planner</a></p>`);
  if (!sub || sub.status !== "pending" || sub.email !== t.email || !summariesOpen()) {
    return page(410, "Link no longer valid", `<p>This confirmation is no longer valid. Turn summaries on again from the bell button in the <a href="/">planner</a>.</p>`);
  }
  await env.DB.prepare("UPDATE email_subs SET status = 'active', confirmed_at = ?2, updated_at = ?2 WHERE user_id = ?1").bind(t.uid, nowIso()).run();
  await snapshotAll(env, t.uid);
  return page(200, "Summaries are on", `<p>You'll get an email after midnight Central time whenever your ★ favorite or ✓ interested sessions change, until ${esc(LAST_RUN_LABEL)}. <a href="/">Back to the planner</a></p>`);
}

// ---------- nightly ----------

interface Fingerprint {
  t: string;
  d: string;
  s: string;
  e: string;
  r: string;
  l: Record<string, string>;
}

/** Human-readable changes between two fingerprints (links first). */
export function describeChanges(prevRaw: string, curRaw: string): string[] {
  if (prevRaw === curRaw) return [];
  if (curRaw === REMOVED) return prevRaw === REMOVED ? [] : ["Removed from the schedule"];
  if (prevRaw === REMOVED) return ["Back on the schedule"];
  const prev = JSON.parse(prevRaw) as Fingerprint;
  const cur = JSON.parse(curRaw) as Fingerprint;
  const out: string[] = [];
  const kinds = [...new Set([...Object.keys(cur.l ?? {}), ...Object.keys(prev.l ?? {})])];
  for (const k of kinds) {
    const a = prev.l?.[k];
    const b = cur.l?.[k];
    if (!a && b) out.push(`New ${k} link: ${b}`);
    else if (a && b && a !== b) out.push(`Updated ${k} link: ${b}`);
    else if (a && !b) out.push(`${k} link removed`);
  }
  const hm = (x: string) => x.slice(11, 16);
  if (prev.s !== cur.s || prev.e !== cur.e) out.push(`Time changed: ${prev.d} ${hm(prev.s)}–${hm(prev.e)} → ${cur.d} ${hm(cur.s)}–${hm(cur.e)}`);
  if (prev.r !== cur.r) out.push(`Room changed: ${prev.r || "TBA"} → ${cur.r || "TBA"}`);
  if (prev.t !== cur.t) out.push(`Title changed (was "${prev.t}")`);
  return out;
}

interface Change {
  title: string;
  when: string;
  status: string;
  lines: string[];
}

function summaryEmail(env: Env, changes: Change[], unsubUrl: string) {
  const n = changes.length;
  const subject = `KubeCon planner: updates to ${n} of your session${n === 1 ? "" : "s"}`;
  const linkify = (line: string) => esc(line).replace(/(https:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`);
  const html =
    `<p>Changes since the last summary to your ★ favorite and ✓ interested sessions (times are Salt Lake City time):</p>` +
    changes
      .map((c) => `<h3 style="margin:16px 0 4px">${c.status === "favorite" ? "★" : "✓"} ${esc(c.title)}</h3><div style="color:#6b7280">${esc(c.when)}</div><ul>${c.lines.map((l) => `<li>${linkify(l)}</li>`).join("")}</ul>`)
      .join("") +
    `<p><a href="${esc(env.APP_ORIGIN)}">Open the planner</a></p>` +
    footerHtml(env, unsubUrl);
  const text =
    `Changes since the last summary to your favorite and interested sessions (times are Salt Lake City time):\n\n` +
    changes.map((c) => `${c.status === "favorite" ? "★" : "✓"} ${c.title} (${c.when})\n${c.lines.map((l) => `  - ${l}`).join("\n")}`).join("\n\n") +
    `\n\nOpen the planner: ${env.APP_ORIGIN}\n\n${footerText(env, unsubUrl)}`;
  return { subject, html, text };
}

/** Email every confirmed subscriber whose selected sessions changed; update their baselines. */
export async function sendSummaries(env: Env): Promise<{ subscribers: number; emailed: number; failed: number }> {
  const { results: subs } = await env.DB.prepare("SELECT user_id, email FROM email_subs WHERE status = 'active'").all<{ user_id: string; email: string }>();
  let emailed = 0;
  let failed = 0;
  for (const sub of subs ?? []) {
    const { results: rows } = await env.DB.prepare(
      `SELECT sel.session_id AS id, sel.status AS status, CASE WHEN x.id IS NULL THEN '${REMOVED}' ELSE ${FP} END AS fp
       FROM selections sel LEFT JOIN sessions x ON x.id = sel.session_id WHERE sel.user_id = ?`,
    )
      .bind(sub.user_id)
      .all<{ id: string; status: string; fp: string }>();
    const { results: snaps } = await env.DB.prepare("SELECT session_id, fingerprint FROM email_snapshots WHERE user_id = ?")
      .bind(sub.user_id)
      .all<{ session_id: string; fingerprint: string }>();
    const prev = new Map((snaps ?? []).map((s) => [s.session_id, s.fingerprint]));

    const changes: Change[] = [];
    const updates: D1PreparedStatement[] = [];
    for (const r of rows ?? []) {
      const before = prev.get(r.id);
      if (before === r.fp) continue;
      updates.push(env.DB.prepare("INSERT OR REPLACE INTO email_snapshots (user_id, session_id, fingerprint) VALUES (?, ?, ?)").bind(sub.user_id, r.id, r.fp));
      if (before === undefined) continue; // first time seen: baseline only
      const lines = describeChanges(before, r.fp);
      if (!lines.length) continue;
      const info = JSON.parse(r.fp === REMOVED ? before : r.fp) as Fingerprint;
      changes.push({ title: info.t, when: `${info.d} ${info.s.slice(11, 16)}–${info.e.slice(11, 16)}`, status: r.status, lines });
    }
    if (changes.length) {
      changes.sort((a, b) => a.when.localeCompare(b.when));
      const unsub = await unsubscribeUrl(env, sub.user_id);
      const msg = summaryEmail(env, changes, unsub);
      try {
        await env.EMAIL.send({
          to: sub.email,
          from: FROM,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
        emailed++;
        await logEmail(env, sub.user_id, "summary", true, `${changes.length} sessions`);
      } catch (e) {
        failed++;
        await logEmail(env, sub.user_id, "summary", false, `${(e as any).code ?? ""} ${(e as Error).message}`);
        continue; // keep the old baseline so the changes are reported next time
      }
    }
    for (let i = 0; i < updates.length; i += 100) await env.DB.batch(updates.slice(i, i + 100));
  }
  return { subscribers: (subs ?? []).length, emailed, failed };
}

/** The Cron Trigger: on summary nights, refresh the schedule, then send summaries. */
export async function nightly(scheduledTime: number, env: Env, importImpl = runImport): Promise<string> {
  if (!shouldRunNightly(scheduledTime)) return "skipped: not a summary night";
  try {
    const r = await importImpl(env.DB);
    console.log(`nightly refresh: ${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.total} total`);
  } catch (e) {
    return `refresh failed, no summaries sent: ${(e as Error).message}`;
  }
  const s = await sendSummaries(env);
  return `summaries: ${s.emailed} emailed, ${s.failed} failed, ${s.subscribers} subscribers`;
}
