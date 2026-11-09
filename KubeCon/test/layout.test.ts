import { describe, expect, it } from "vitest";
import { layoutDay } from "../src/layout";

const s = (id: string, start: string, end: string, endDay = "2026-11-09") => ({
  id,
  startsAt: `2026-11-09T${start}:00`,
  endsAt: `${endDay}T${end}:00`,
});
const byId = (blocks: ReturnType<typeof layoutDay>) => Object.fromEntries(blocks.map((b) => [b.id, b]));

describe("layoutDay", () => {
  it("gives one column when nothing overlaps", () => {
    const b = byId(layoutDay([s("a", "09:00", "10:00"), s("b", "11:00", "12:00")]));
    expect(b.a).toMatchObject({ col: 0, cols: 1, conflictsWith: [], start: 540, end: 600 });
    expect(b.b).toMatchObject({ col: 0, cols: 1, conflictsWith: [] });
  });

  it("puts two overlapping sessions side by side as conflicts", () => {
    const b = byId(layoutDay([s("a", "09:00", "10:00"), s("b", "09:30", "10:30")]));
    expect(b.a).toMatchObject({ col: 0, cols: 2, conflictsWith: ["b"] });
    expect(b.b).toMatchObject({ col: 1, cols: 2, conflictsWith: ["a"] });
  });

  it("does not treat touching sessions as conflicts", () => {
    const b = byId(layoutDay([s("a", "09:00", "10:00"), s("b", "10:00", "11:00")]));
    expect(b.a).toMatchObject({ cols: 1, conflictsWith: [] });
    expect(b.b).toMatchObject({ cols: 1, conflictsWith: [] });
  });

  it("lays out a chain of three in two columns; the middle conflicts with both", () => {
    const b = byId(layoutDay([s("a", "09:00", "10:00"), s("b", "09:30", "10:30"), s("c", "10:15", "11:00")]));
    expect(b.a).toMatchObject({ col: 0, cols: 2, conflictsWith: ["b"] });
    expect(b.b).toMatchObject({ col: 1, cols: 2 });
    expect(b.b.conflictsWith.sort()).toEqual(["a", "c"]);
    expect(b.c).toMatchObject({ col: 0, cols: 2, conflictsWith: ["b"] });
  });

  it("caps a session ending on the next day at 1440", () => {
    const [b] = layoutDay([s("late", "22:00", "01:00", "2026-11-10")]);
    expect(b).toMatchObject({ start: 1320, end: 1440 });
  });

  it("orders longer sessions first at the same start", () => {
    const b = byId(layoutDay([s("short", "09:00", "09:30"), s("long", "09:00", "11:00")]));
    expect(b.long.col).toBe(0);
    expect(b.short.col).toBe(1);
  });
});
