import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { handleApi } from "../src/index";
import { signToken } from "../src/auth";
import { describeChanges, nightly, RUN_DAYS, sendSummaries, shouldRunNightly } from "../src/summaries";
import type { Env } from "../src/types";
import { sqliteD1 } from "./sqliteD1";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";
const SECRET = "test-session-secret-0123456789abcdef";
const OWNER = "owner-contact@example.org";

afterEach(() => vi.useRealTimers());

function setup(opts: { failSend?: boolean } = {}) {
  const { d1, raw } = sqliteD1();
  raw.exec(`INSERT INTO sessions (id, source, title, day, starts_at, ends_at, room, track, links) VALUES
    ('s1','main','Tracing at Scale','2026-11-10','2026-11-10T10:00:00','2026-11-10T10:30:00','Room A','T','{"Slides":"https://sessionize.com/download/s1.pdf"}'),
    ('s2','main','GitOps in Anger','2026-11-11','2026-11-11T14:00:00','2026-11-11T14:30:00','Room B','T','{}'),
    ('s3','main','Late Addition','2026-11-12','2026-11-12T09:00:00','2026-11-12T09:30:00','Room C','T','{}')`);
  raw.exec(`INSERT INTO selections (user_id, session_id, created_at, status) VALUES
    ('cf-aaa','s1','2026-11-10T01:00:00Z','favorite'), ('cf-aaa','s2','2026-11-10T01:01:00Z','interested')`);
  const sent: any[] = [];
  const env = {
    SESSION_SECRET: SECRET,
    DB: d1,
    APP_ORIGIN: ORIGIN,
    CONTACT_EMAIL: OWNER,
    ASSETS: { fetch: async () => new Response("x") },
    EMAIL: {
      send: async (m: any) => {
        if (opts.failSend) throw Object.assign(new Error("boom"), { code: "E_DELIVERY_FAILED" });
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    },
  } as unknown as Env;
  const cookieFor = async (uid: string, email: string) => {
    const prov = uid.startsWith("google:") ? "google" : "cloudflare";
    return `kp_session=${await signToken({ typ: "session", uid, email, prov, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`;
  };
  const api = async (cookie: string, method: string, path: string, body?: unknown) => {
    const url = new URL(`${ORIGIN}${path}`);
    return handleApi(new Request(url, { method, headers: { cookie, origin: ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) }), env, url);
  };
  const status = () => (raw.prepare("SELECT status FROM email_subs WHERE user_id = 'cf-aaa'").get() as any)?.status;
  return { env, raw, sent, cookieFor, api, status };
}
const linkIn = (text: string, kind: string) => text.match(new RegExp(`${ORIGIN}/notify/${kind}/[A-Za-z0-9_.-]+`))![0];

async function optIn(t: ReturnType<typeof setup>) {
  const cookie = await t.cookieFor("cf-aaa", "aaa@example.com");
  expect(((await (await t.api(cookie, "POST", "/api/notify", { on: true })).json()) as any).status).toBe("pending");
  const confirm = linkIn(t.sent[t.sent.length - 1].text, "confirm");
  const res = await worker.fetch(new Request(confirm, { method: "POST" }), t.env);
  expect(res.status).toBe(200);
  return cookie;
}

describe("nightly schedule", () => {
  it("runs at midnight Central on exactly the 7 summary nights", () => {
    expect(RUN_DAYS).toHaveLength(7);
    for (const d of RUN_DAYS) expect(shouldRunNightly(Date.parse(`${d}T06:00:00Z`))).toBe(true); // 00:00 CST
    expect(shouldRunNightly(Date.parse("2026-11-12T06:00:00Z"))).toBe(false);
    expect(shouldRunNightly(Date.parse("2026-11-20T06:00:00Z"))).toBe(false);
    expect(shouldRunNightly(Date.parse("2026-11-14T07:00:00Z"))).toBe(false); // 01:00 CST
  });

  it("refreshes then summarizes on a summary night, and sends nothing if the refresh fails", async () => {
    const t = setup();
    let imports = 0;
    const ok = async () => (imports++, { added: 0, updated: 0, removed: 0, total: 3 });
    expect(await nightly(Date.parse("2026-11-14T06:00:00Z"), t.env, ok)).toMatch(/^summaries: 0 emailed/);
    expect(await nightly(Date.parse("2026-11-21T06:00:00Z"), t.env, ok)).toMatch(/^skipped/);
    expect(imports).toBe(1);
    const failing = async () => { throw new Error('Feed "main" failed: HTTP 503'); };
    expect(await nightly(Date.parse("2026-11-14T06:00:00Z"), t.env, failing)).toMatch(/^refresh failed, no summaries sent/);
  });
});

describe("opt in", () => {
  it("sends one confirmation email; summaries start only after the link is used", async () => {
    const t = setup();
    const cookie = await t.cookieFor("cf-aaa", "aaa@example.com");
    expect(await (await t.api(cookie, "GET", "/api/notify")).json()).toMatchObject({ status: "off", email: "aaa@example.com", open: true });
    await t.api(cookie, "POST", "/api/notify", { on: true });
    await t.api(cookie, "POST", "/api/notify", { on: true }); // within 10 minutes: no second email
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ to: "aaa@example.com", from: { email: "planner@shareplay.com" } });
    expect(t.sent[0].text).toContain(OWNER);
    expect(t.status()).toBe("pending");
    const confirm = linkIn(t.sent[0].text, "confirm");
    const get = await worker.fetch(new Request(confirm), t.env); // a link scanner's GET changes nothing
    expect(await get.text()).toContain('<form method="post">');
    expect(t.status()).toBe("pending");
    expect((await worker.fetch(new Request(confirm, { method: "POST" }), t.env)).status).toBe(200);
    expect(t.status()).toBe("active");
    expect((t.raw.prepare("SELECT COUNT(*) AS n FROM email_snapshots WHERE user_id = 'cf-aaa'").get() as any).n).toBe(2);
  });

  it("refuses without an email address, after the last night, and reports send failures", async () => {
    const t = setup();
    expect((await t.api(await t.cookieFor("google:x", ""), "POST", "/api/notify", { on: true })).status).toBe(400);
    expect((await t.api(await t.cookieFor("cf-aaa", "a@b.co"), "POST", "/api/notify", { on: "yes" })).status).toBe(400);
    const f = setup({ failSend: true });
    expect((await f.api(await f.cookieFor("cf-aaa", "a@b.co"), "POST", "/api/notify", { on: true })).status).toBe(502);
    expect(f.status()).toBeUndefined();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T06:00:01Z"));
    const late = setup();
    expect((await late.api(await late.cookieFor("cf-aaa", "a@b.co"), "POST", "/api/notify", { on: true })).status).toBe(409);
  });

  it("turns off immediately, and old confirmation links stop working", async () => {
    const t = setup();
    const cookie = await t.cookieFor("cf-aaa", "aaa@example.com");
    await t.api(cookie, "POST", "/api/notify", { on: true });
    const confirm = linkIn(t.sent[0].text, "confirm");
    expect(((await (await t.api(cookie, "POST", "/api/notify", { on: false })).json()) as any).status).toBe("off");
    expect((await worker.fetch(new Request(confirm, { method: "POST" }), t.env)).status).toBe(410);
    expect(t.status()).toBe("off");
  });
});

describe("summaries", () => {
  it("emails only changes (mainly links), once, with unsubscribe and the owner contact", async () => {
    const t = setup();
    const cookie = await optIn(t);
    t.sent.length = 0;
    expect(await sendSummaries(t.env)).toMatchObject({ subscribers: 1, emailed: 0 }); // nothing changed

    await t.api(cookie, "PUT", "/api/selections/s3", { status: "favorite" }); // baseline at selection time
    t.raw.exec(`UPDATE sessions SET links = '{"Slides":"https://sessionize.com/download/s1-v2.pdf","Recording":"https://www.youtube.com/watch?v=abc"}' WHERE id = 's1'`);
    t.raw.exec(`UPDATE sessions SET room = 'Room Z', starts_at = '2026-11-11T15:00:00', ends_at = '2026-11-11T15:30:00' WHERE id = 's2'`);
    t.raw.exec(`UPDATE sessions SET links = '{"Slides":"https://sessionize.com/download/s3.pdf"}' WHERE id = 's3'`);

    expect(await sendSummaries(t.env)).toMatchObject({ emailed: 1 });
    const m = t.sent[0];
    expect(m.to).toBe("aaa@example.com");
    expect(m.subject).toBe("KubeCon planner: updates to 3 of your sessions");
    expect(m.text).toContain("New Recording link: https://www.youtube.com/watch?v=abc");
    expect(m.text).toContain("Updated Slides link: https://sessionize.com/download/s1-v2.pdf");
    expect(m.text).toContain("Room changed: Room B → Room Z");
    expect(m.text).toContain("Time changed: 2026-11-11 14:00–14:30 → 2026-11-11 15:00–15:30");
    expect(m.text).toContain("New Slides link: https://sessionize.com/download/s3.pdf");
    expect(m.text).toContain(`contact ${OWNER}`);
    expect(m.html).toContain('<a href="https://www.youtube.com/watch?v=abc">');
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.headers["List-Unsubscribe"]).toMatch(new RegExp(`^<${ORIGIN}/notify/unsubscribe/`));

    expect(await sendSummaries(t.env)).toMatchObject({ emailed: 1 - 1 }); // same night again: nothing new
    t.raw.exec("DELETE FROM sessions WHERE id = 's2'");
    await sendSummaries(t.env);
    expect(t.sent[1].text).toContain("GitOps in Anger");
    expect(t.sent[1].text).toContain("Removed from the schedule");
    await sendSummaries(t.env);
    expect(t.sent).toHaveLength(2);

    // One-click unsubscribe from the mail client: POST with no cookie or Origin.
    const unsub = m.headers["List-Unsubscribe"].slice(1, -1);
    const res = await worker.fetch(new Request(unsub, { method: "POST", body: "List-Unsubscribe=One-Click" }), t.env);
    expect(res.status).toBe(200);
    expect(t.status()).toBe("off");
    t.raw.exec(`UPDATE sessions SET links = '{}' WHERE id = 's1'`);
    expect(await sendSummaries(t.env)).toMatchObject({ subscribers: 0, emailed: 0 });
  });

  it("keeps the old baseline when sending fails, so the change is reported next time", async () => {
    const t = setup();
    await optIn(t);
    const send = t.env.EMAIL.send;
    (t.env as any).EMAIL = { send: async () => { throw Object.assign(new Error("down"), { code: "E_INTERNAL_SERVER_ERROR" }); } };
    t.raw.exec(`UPDATE sessions SET links = '{"Recording":"https://www.youtube.com/watch?v=x"}' WHERE id = 's2'`);
    expect(await sendSummaries(t.env)).toMatchObject({ failed: 1 });
    (t.env as any).EMAIL = { send };
    expect(await sendSummaries(t.env)).toMatchObject({ emailed: 1 });
  });

  it("describes link, time, room and title changes", () => {
    const fp = (o: object) => JSON.stringify({ t: "A", d: "2026-11-10", s: "2026-11-10T10:00:00", e: "2026-11-10T10:30:00", r: "R1", l: {}, ...o });
    expect(describeChanges(fp({}), fp({}))).toEqual([]);
    expect(describeChanges(fp({ l: { Slides: "https://a" } }), fp({ l: {} }))).toEqual(["Slides link removed"]);
    expect(describeChanges(fp({}), fp({ t: "B" }))).toEqual(['Title changed (was "A")']);
    expect(describeChanges(fp({}), "REMOVED")).toEqual(["Removed from the schedule"]);
  });
});

describe("link tokens", () => {
  it("are not sessions, and session tokens are not links", async () => {
    const t = setup();
    const cookie = await t.cookieFor("cf-aaa", "aaa@example.com");
    await t.api(cookie, "POST", "/api/notify", { on: true });
    const confirmToken = linkIn(t.sent[0].text, "confirm").split("/").pop()!;
    const me = new URL(`${ORIGIN}/api/me`);
    expect((await handleApi(new Request(me, { headers: { cookie: `kp_session=${confirmToken}` } }), t.env, me)).status).toBe(401);
    const session = cookie.split("=")[1];
    for (const kind of ["confirm", "unsubscribe"]) {
      expect((await worker.fetch(new Request(`${ORIGIN}/notify/${kind}/${session}`, { method: "POST" }), t.env)).status).toBe(410);
    }
    expect((await worker.fetch(new Request(`${ORIGIN}/notify/unsubscribe/${confirmToken}`, { method: "POST" }), t.env)).status).toBe(410);
    expect(t.status()).toBe("pending");
  });
});
