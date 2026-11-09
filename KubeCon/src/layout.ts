/** Pure My-schedule layout (R-3.7). Shared by the client and the tests. */
export interface LayoutInput {
  id: string;
  startsAt: string; // YYYY-MM-DDTHH:MM:SS local
  endsAt: string;
}

export interface LayoutBlock {
  id: string;
  start: number; // minutes since local midnight
  end: number; // capped at 1440
  col: number;
  cols: number;
  conflictsWith: string[];
}

function minutes(t: string): number {
  return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
}

export function layoutDay(items: LayoutInput[]): LayoutBlock[] {
  const rows = items.map((s) => {
    const start = minutes(s.startsAt);
    const end = s.endsAt.slice(0, 10) > s.startsAt.slice(0, 10) ? 1440 : Math.max(start, minutes(s.endsAt));
    return { id: s.id, start, end };
  });
  rows.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const out: LayoutBlock[] = [];
  let group: typeof rows = [];
  let groupEnd = -1;
  const flush = () => {
    if (group.length === 0) return;
    const colEnds: number[] = [];
    const blocks = group.map((r) => {
      let col = colEnds.findIndex((e) => e <= r.start);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(r.end);
      } else colEnds[col] = r.end;
      return { ...r, col, cols: 0, conflictsWith: [] as string[] };
    });
    for (const b of blocks) {
      b.cols = colEnds.length;
      for (const o of blocks) if (o !== b && b.start < o.end && o.start < b.end) b.conflictsWith.push(o.id);
    }
    out.push(...blocks);
    group = [];
  };
  for (const r of rows) {
    if (group.length && r.start >= groupEnd) flush();
    if (!group.length) groupEnd = r.end;
    group.push(r);
    groupEnd = Math.max(groupEnd, r.end);
  }
  flush();
  return out;
}
