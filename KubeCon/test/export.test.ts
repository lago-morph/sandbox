import { describe, expect, it } from "vitest";
import worker, { handleApi } from "../src/index";
import { signToken } from "../src/auth";
import { createExportLink, exportDownload } from "../src/export";
import type { Env } from "../src/types";
import { sqliteD1 } from "./sqliteD1";
import main from "./fixtures/main.json";
import colocated from "./fixtures/colocated.json";
import maintainer from "./fixtures/maintainer.json";
import sponsor from "./fixtures/sponsor.json";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";
const SECRET = "test-session-secret-0123456789abcdef";
const FEEDS: Record<string, unknown> = { svi82w6c: main, ayajbd6b: colocated, qtujim6y: maintainer, etvmcsmr: sponsor };

function setup() {
  const { d1, raw } = sqliteD1();
  raw.exec(`INSERT INTO selections (user_id, session_id, created_at, status) VALUES
    ('cf-aaa','100','2026-11-10T01:00:00Z','favorite'),
    ('cf-aaa','200','2026-11-10T01:01:00Z','interested'),
    ('cf-aaa','500','2026-11-10T01:02:00Z','favorite'),
    ('cf-aaa','gone','2026-11-10T01:03:00Z','interested'),
    ('google:other','300','2026-11-10T01:04:00Z','favorite')`);
  const env = { SESSION_SECRET: SECRET, DB: d1, ASSETS: { fetch: async () => new Response("x") } } as unknown as Env;
  let fetches = 0;
  const fakeFetch = (async (url: string) => {
    fetches++;
    return Response.json(FEEDS[String(url).split("/")[5]]);
  }) as unknown as typeof fetch;
  return { env, raw, fakeFetch, fetches: () => fetches };
}
const tokenOf = (url: string) => url.split("/export/")[1];

describe("download link", () => {
  it("POST /api/export returns a 5-minute /export/ link for the signed-in user", async () => {
    const { env } = setup();
    const cookie = `kp_session=${await signToken({ typ: "session", uid: "cf-aaa", email: "", prov: "cloudflare", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
    const url = new URL(`${ORIGIN}/api/export`);
    const res = await handleApi(new Request(url, { method: "POST", headers: { cookie, origin: ORIGIN } }), env, url);
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.url.startsWith(`${ORIGIN}/export/`)).toBe(true);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
    // Needs a session and a same-origin request like other state-changing calls.
    expect((await handleApi(new Request(url, { method: "POST", headers: { origin: ORIGIN } }), env, url)).status).toBe(401);
    expect((await handleApi(new Request(url, { method: "POST", headers: { cookie, origin: "https://evil.example" } }), env, url)).status).toBe(403);
  });

  it("downloads the user's favorite and interested sessions with full live Sessionize data, writing nothing", async () => {
    const { env, raw, fakeFetch } = setup();
    const before = raw.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    const { url } = await createExportLink(env, ORIGIN, "cf-aaa");
    const res = await exportDownload(tokenOf(url), env, fakeFetch);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="kubecon-na-2026-my-sessions-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = (await res.json()) as any;
    expect(body.counts).toEqual({ favorite: 2, interested: 1 });
    expect(body.sessions.map((x: any) => [x.session.id, x.status, x.feed])).toEqual([
      ["500", "favorite", "main"], // sponsor duplicate: the main copy, as in the importer
      ["200", "interested", "colocated"],
      ["100", "favorite", "main"],
    ]);
    const s100 = body.sessions.find((x: any) => x.session.id === "100");
    expect(s100.session.description).toBe("How we trace."); // raw session object
    expect(s100.session.recordingUrl).toBe("https://www.youtube.com/watch?v=abc");
    expect(s100.speakers[0]).toMatchObject({ id: "sp-a", fullName: "Ada Lovelace", tagLine: "Engineer at Analytical" }); // full speaker
    expect(s100.room).toEqual({ id: 1, name: "Salt Palace | Level 1 | Grand Ballroom H" });
    expect(s100.categories).toEqual([{ category: "All Sessions", item: "Observability" }]);
    expect(s100.questionAnswers).toEqual([{ question: "Presentation Slides", answer: "https://sessionize.com/download/abc~slides.pdf" }]);
    expect(body.notFoundInFeeds).toEqual(["gone"]);
    // Each record links to the Sessionize endpoint it came from (there is no per-session endpoint).
    expect(body.sessions.map((x: any) => x.sourceUrl)).toEqual([
      "https://sessionize.com/api/v2/svi82w6c/view/All",
      "https://sessionize.com/api/v2/ayajbd6b/view/All",
      "https://sessionize.com/api/v2/svi82w6c/view/All",
    ]);
    expect(body.sources.map((x: any) => x.feed)).toEqual(["main", "colocated", "maintainer", "sponsor"]);
    expect(JSON.stringify(body)).not.toContain('"300"'); // another user's selection
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before);
  });

  it("is served at GET /export/<token> outside /api", async () => {
    const { env } = setup();
    const { url } = await createExportLink(env, ORIGIN, "cf-aaa");
    // Expired token through the real router (no Sessionize fetch needed to reject it).
    const old = await createExportLink(env, ORIGIN, "cf-aaa", Date.now() - 6 * 60_000);
    expect((await worker.fetch(new Request(old.url), env)).status).toBe(410);
    expect((await worker.fetch(new Request(`${ORIGIN}/export/not-a-token`), env)).status).toBe(410);
    expect(new URL(url).pathname.startsWith("/export/")).toBe(true);
  });

  it("does not accept session or OAuth tokens as download links, nor download links as sessions", async () => {
    const { env, fakeFetch, fetches } = setup();
    const session = await signToken({ typ: "session", uid: "cf-aaa", email: "", prov: "cloudflare", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const legacy = await signToken({ uid: "cf-aaa", email: "", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const oauth = await signToken({ typ: "oauth", state: "s", verifier: "v", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    for (const t of [session, legacy, oauth]) expect((await exportDownload(t, env, fakeFetch)).status).toBe(410);
    expect(fetches()).toBe(0);
    const { url } = await createExportLink(env, ORIGIN, "cf-aaa");
    const me = new URL(`${ORIGIN}/api/me`);
    expect((await handleApi(new Request(me, { headers: { cookie: `kp_session=${tokenOf(url)}` } }), env, me)).status).toBe(401);
  });

  it("reports a Sessionize failure without a partial file", async () => {
    const { env } = setup();
    const { url } = await createExportLink(env, ORIGIN, "cf-aaa");
    const failing = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const res = await exportDownload(tokenOf(url), env, failing);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/^Feed "/);
  });
});
