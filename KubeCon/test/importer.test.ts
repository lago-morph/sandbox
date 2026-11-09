import { describe, expect, it } from "vitest";
import main from "./fixtures/main.json";
import colocated from "./fixtures/colocated.json";
import maintainer from "./fixtures/maintainer.json";
import sponsor from "./fixtures/sponsor.json";
import { COLOCATED_TRACK, mergeFeeds, parseFeed, storeSessions, fetchAllFeeds } from "../src/importer";
import type { Session } from "../src/types";
import { FakeD1 } from "./fakeD1";

const all = () => ({
  main: parseFeed("main", main),
  colocated: parseFeed("colocated", colocated),
  maintainer: parseFeed("maintainer", maintainer),
  sponsor: parseFeed("sponsor", sponsor),
});
const find = (list: Session[], id: string) => list.find((s) => s.id === id)!;

describe("parseFeed", () => {
  it("keeps times unchanged and derives day from the start; after-midnight stays on start day", () => {
    const m = parseFeed("main", main);
    const s = find(m, "100");
    expect(s.startsAt).toBe("2026-11-10T10:00:00");
    expect(s.endsAt).toBe("2026-11-10T10:30:00");
    expect(s.day).toBe("2026-11-10");
    const late = find(m, "104");
    expect(late.day).toBe("2026-11-10");
    expect(late.endsAt).toBe("2026-11-11T01:00:00");
  });

  it("reads company and title from answers, falling back to the tagline", () => {
    const s = find(parseFeed("main", main), "100");
    expect(s.speakers).toEqual([
      { name: "Ada Lovelace", company: "Analytical Engines", title: "Principal Engineer" },
      { name: "Grace Hopper", company: "", title: "Rear Admiral, US Navy" },
    ]);
    expect(s.speakerText).toBe("Ada Lovelace (Analytical Engines), Grace Hopper");
    expect(s.room).toBe("Salt Palace | Level 1 | Grand Ballroom H");
    expect(s.track).toBe("Observability");
    expect(s.format).toBeNull();
    expect(s.events).toEqual([]);
  });

  it("classifies co-located sessions, shared breaks and registration", () => {
    const c = parseFeed("colocated", colocated);
    const talk = find(c, "200");
    expect(talk.track).toBe(COLOCATED_TRACK);
    expect(talk.events).toEqual(["ArgoCon"]);
    expect(talk.format).toBe("Breakout Session");
    expect(talk.speakerText).toBe("Linus Pauling (Intuit)");
    expect(find(c, "203").format).toBe("Lightning Talk");
    const brk = find(c, "201");
    expect(brk.track).toBe("Breaks");
    expect(brk.events).toEqual(["ArgoCon", "Observability Day"]);
    expect(find(c, "202").track).toBe("Registration");
  });

  it("sets maintainer track, event and format", () => {
    const m = parseFeed("maintainer", maintainer);
    expect(find(m, "300")).toMatchObject({ track: "Maintainer Summit", events: ["CNCF Maintainer Summit"], format: "Main Track" });
    expect(find(m, "301").format).toBeNull();
  });

  it("skips sessions without times, stringifies numeric ids, defaults track to Other", () => {
    const m = parseFeed("main", main);
    expect(m.find((s) => s.id === "103")).toBeUndefined();
    const late = find(m, "104");
    expect(late.id).toBe("104");
    expect(late.track).toBe("Other");
    expect(late.room).toBe("");
  });

  it("skips sessions whose times are not local date-times (e.g. injected markup)", () => {
    const feed = structuredClone(main) as any;
    feed.sessions.push(
      { id: "x1", title: "Evil", startsAt: "<img src='", endsAt: "2026-11-09T10:00:00", speakers: [], categoryItems: [], roomId: null },
      { id: "x2", title: "Evil", startsAt: "2026-11-09T10:00:00", endsAt: "~*/alert() '", speakers: [], categoryItems: [], roomId: null },
    );
    const ids = parseFeed("main", feed).map((s) => s.id);
    expect(ids).not.toContain("x1");
    expect(ids).not.toContain("x2");
    expect(ids).toContain("100");
  });

  it("reads the slides link and recording URL, accepting only https", () => {
    const s = find(parseFeed("main", main), "100");
    expect(s.slidesUrl).toBe("https://sessionize.com/download/abc~slides.pdf");
    expect(s.recordingUrl).toBe("https://www.youtube.com/watch?v=abc");
    expect(find(parseFeed("main", main), "102")).toMatchObject({ slidesUrl: "", recordingUrl: "" });
    const bad = find(parseFeed("colocated", colocated), "200");
    expect(bad).toMatchObject({ slidesUrl: "", recordingUrl: "" });
  });

  it("throws naming the feed on malformed JSON", () => {
    expect(() => parseFeed("colocated", { sessions: "nope" })).toThrow(/colocated/);
    expect(() => parseFeed("sponsor", null)).toThrow(/sponsor/);
  });
});

describe("mergeFeeds", () => {
  it("drops main umbrella placeholders when colocated has sessions, keeps them otherwise", () => {
    expect(mergeFeeds(all()).some((s) => s.id === "101")).toBe(false);
    expect(mergeFeeds({ ...all(), colocated: [] }).some((s) => s.id === "101")).toBe(true);
  });

  it("drops colocated Registration when main has registration", () => {
    const ids = mergeFeeds(all()).map((s) => s.id);
    expect(ids).not.toContain("202");
    expect(ids).toContain("102");
    const noMainReg = { ...all(), main: all().main.filter((s) => s.track !== "Registration") };
    expect(mergeFeeds(noMainReg).map((s) => s.id)).toContain("202");
  });

  it("keeps a sponsor duplicate once (main copy) and sorts by start then id", () => {
    const merged = mergeFeeds(all());
    const dupes = merged.filter((s) => s.id === "500");
    expect(dupes).toHaveLength(1);
    expect(dupes[0].title).toBe("Sponsor Day (main copy)");
    expect(merged.some((s) => s.id === "501")).toBe(true);
    const keys = merged.map((s) => `${s.startsAt}|${s.id.padStart(12, "0")}`);
    expect(keys).toEqual([...keys].sort());
    // Same start (Mon 09:00): 105 before 500.
    const mon9 = merged.filter((s) => s.startsAt === "2026-11-09T09:00:00").map((s) => s.id);
    expect(mon9).toEqual(["105", "500"]);
  });
});

describe("storeSessions", () => {
  it("refuses an empty merged result", async () => {
    const db = new FakeD1();
    await expect(storeSessions(db as any, [])).rejects.toThrow(/0 sessions/);
  });

  it("upserts by id, reports counts, and never touches selections", async () => {
    const db = new FakeD1();
    db.selections.set("u1|100", { user_id: "u1", session_id: "100", status: "favorite", created_at: "x" });
    db.selections.set("u1|gone", { user_id: "u1", session_id: "gone", status: "interested", created_at: "x" });
    const merged = mergeFeeds(all());
    const r1 = await storeSessions(db as any, merged);
    expect(r1).toEqual({ added: merged.length, updated: 0, removed: 0, total: merged.length });
    expect(db.batches.every((n) => n <= 100)).toBe(true);

    const changed = merged.filter((s) => s.id !== "501").map((s) => (s.id === "100" ? { ...s, title: "Renamed" } : s));
    const r2 = await storeSessions(db as any, changed);
    expect(r2).toEqual({ added: 0, updated: 1, removed: 1, total: changed.length });
    expect(db.sessions.get("100")!.title).toBe("Renamed");
    expect(db.sessions.has("501")).toBe(false);
    expect([...db.selections.keys()]).toEqual(["u1|100", "u1|gone"]);
    expect(db.meta.get("last_import_at")).toBeTruthy();
  });

  it("keeps the stored schedule when a feed fails", async () => {
    const db = new FakeD1();
    await storeSessions(db as any, mergeFeeds(all()));
    const before = db.sessions.size;
    const fixtures: Record<string, unknown> = { svi82w6c: main, ayajbd6b: colocated, qtujim6y: maintainer, etvmcsmr: { bad: true } };
    const fakeFetch = (async (url: string) => {
      const code = url.split("/")[5];
      return new Response(JSON.stringify(fixtures[code]), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchAllFeeds(fakeFetch)).rejects.toThrow(/sponsor/);
    expect(db.sessions.size).toBe(before);
  });
});
