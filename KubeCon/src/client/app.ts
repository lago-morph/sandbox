import { layoutDay } from "../layout";

interface S {
  id: string; source: string; title: string; day: string; startsAt: string; endsAt: string;
  room: string; track: string; format: string | null; events: string[]; speakerText: string;
}
interface Full extends S { description: string; speakers: { name: string; company: string; title: string }[] }

const DAYS = [
  ["2026-11-08", "Sun 8"], ["2026-11-09", "Mon 9"], ["2026-11-10", "Tue 10"], ["2026-11-11", "Wed 11"], ["2026-11-12", "Thu 12"],
] as const;
const PX_PER_MIN = 1.3;

const $ = <T = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** HH:MM straight from the local wall-clock string (never via Date, R-2.3). */
// Escaped: these strings come from the third-party feed and are inserted as HTML.
const hm = (t: string) => esc(t.slice(11, 16));

let sessions: S[] = [];
const byId = new Map<string, S>();
type Mark = "favorite" | "interested";
/** One mutually exclusive state per session: absent = nothing, favorite (★ attend), interested (✓ watch later). */
let marks = new Map<string, Mark>();
/** Browse list scroll position per list (day, or "all" days), kept while in My schedule. */
const browseScroll = new Map<string, number>();
const browseKey = () => ($<HTMLInputElement>("alldays").checked ? "all" : day);
let view: "browse" | "mine" = "browse";
let day: string = todaySlc();
let openId: string | null = null;

function todaySlc(): string {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return DAYS.some(([k]) => k === d) ? d : DAYS[0][0];
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) { showSignIn(); throw new Error("signed out"); }
  return res;
}

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as any).t);
  (toast as any).t = setTimeout(() => (t.hidden = true), 3000);
}

function showSignIn() {
  $("signin").hidden = false;
  $("app").hidden = true;
  $("who").hidden = true;
}

function fmtImported(iso: string | null) {
  if (!iso) return "";
  const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return `Last updated ${t}`;
}

function setSessions(list: S[], lastImportAt: string | null) {
  sessions = list;
  byId.clear();
  for (const s of list) byId.set(s.id, s);
  $("imported").textContent = fmtImported(lastImportAt);
  const tracks = [...new Set(list.map((s) => s.track))].sort();
  const events = [...new Set(list.flatMap((s) => s.events))].sort();
  fillSelect($("track"), "All tracks", tracks);
  fillSelect($("event"), "All co-located events", events);
}

function fillSelect(sel: any, label: string, values: string[]) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${label}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join("");
  sel.value = values.includes(cur) ? cur : "";
}

function renderDays() {
  $("days").innerHTML = DAYS.map(([k, label]) => `<button data-day="${k}" class="${k === day ? "on" : ""}">${label}</button>`).join("");
}

function sub(s: S): string {
  const where = [s.room.split("|").map((x) => x.trim()).filter(Boolean).slice(-1)[0], s.events.length ? s.events.join(", ") : s.track]
    .filter(Boolean).join(" · ");
  return where;
}

function renderList() {
  const q = $<HTMLInputElement>("q").value.trim().toLowerCase();
  const all = $<HTMLInputElement>("alldays").checked;
  const track = $<HTMLSelectElement>("track").value;
  const ev = $<HTMLSelectElement>("event").value;
  const rows = sessions.filter((s) =>
    (all || s.day === day) &&
    (!track || s.track === track) &&
    (!ev || s.events.includes(ev)) &&
    (!q || s.title.toLowerCase().includes(q) || s.speakerText.toLowerCase().includes(q)),
  );
  $("count").textContent = `${rows.length} session${rows.length === 1 ? "" : "s"}`;
  const shown = rows.slice(0, 400);
  $("list").innerHTML = shown.map((s) => {
    const m = marks.get(s.id);
    const dayLabel = all ? `${esc(DAYS.find(([k]) => k === s.day)?.[1] ?? s.day)} ` : "";
    return `<li class="item${m === "favorite" ? " sel" : m === "interested" ? " int" : ""}" data-id="${esc(s.id)}">
      <div class="body" data-open="${esc(s.id)}">
        <div class="time">${dayLabel}${hm(s.startsAt)}–${hm(s.endsAt)}</div>
        <div class="title">${esc(s.title)}</div>
        <div class="sub">${esc(sub(s))}</div>
        ${s.speakerText ? `<div class="sub">${esc(s.speakerText)}</div>` : ""}
      </div>
      ${markButtons(s.id)}
    </li>`;
  }).join("") + (rows.length > shown.length ? `<li class="empty">Showing the first ${shown.length}. Narrow the search to see more.</li>` : "")
    + (rows.length === 0 ? `<li class="empty">No sessions match.</li>` : "");
}

function markButtons(id: string): string {
  const m = marks.get(id);
  const fav = m === "favorite";
  const int = m === "interested";
  return `<div class="marks">
    <button class="toggle${fav ? " on" : ""}" data-mark="favorite" data-id="${esc(id)}" aria-pressed="${fav}"
      aria-label="${fav ? "Remove favorite" : "Favorite: plan to attend"}">${fav ? "★" : "☆"}</button>
    <button class="toggle check${int ? " on" : ""}" data-mark="interested" data-id="${esc(id)}" aria-pressed="${int}"
      aria-label="${int ? "Remove interested" : "Interested: watch the recording later"}">✓</button>
  </div>`;
}

function dayMarked(kind: Mark): S[] {
  return [...marks].filter(([, m]) => m === kind).map(([id]) => byId.get(id)).filter((s): s is S => !!s && s.day === day)
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
}

function renderGrid() {
  // My schedule shows starred (favorite) sessions only.
  const mine = dayMarked("favorite");
  const grid = $("grid");
  if (mine.length === 0) {
    grid.style.height = "auto";
    grid.innerHTML = `<p class="empty">No favorites for this day yet. Tap ☆ in Browse to plan what to attend.</p>`;
    return;
  }
  const blocks = layoutDay(mine);
  const lo = Math.min(8 * 60, Math.floor(Math.min(...blocks.map((b) => b.start)) / 60) * 60);
  const hi = Math.max(18 * 60, Math.ceil(Math.max(...blocks.map((b) => b.end)) / 60) * 60);
  grid.style.height = `${(hi - lo) * PX_PER_MIN}px`;
  let html = "";
  for (let m = lo; m <= hi; m += 60) {
    html += `<div class="hour" style="top:${(m - lo) * PX_PER_MIN}px"><span>${String(m / 60).padStart(2, "0")}:00</span></div>`;
  }
  for (const b of blocks) {
    const s = byId.get(b.id)!;
    const conflict = b.conflictsWith.length > 0;
    const h = Math.max(20, (b.end - b.start) * PX_PER_MIN - 2);
    const short = h < 40; // one line: time, badge, truncated title
    html += `<div class="block${conflict ? " conflict" : ""}${short ? " short" : ""}" data-open="${esc(s.id)}"
      style="top:${(b.start - lo) * PX_PER_MIN}px;height:${h}px;left:${(b.col / b.cols) * 100}%;width:${100 / b.cols}%">
      <div class="bh">${hm(s.startsAt)}${conflict ? ` <span class="badge">Conflict</span>` : ""}</div>
      <div class="bt">${esc(s.title)}</div>
      <button class="bcheck" data-mark="interested" data-id="${esc(s.id)}" aria-label="Move to interested (watch later)">✓</button></div>`;
  }
  grid.innerHTML = html;
}

function render() {
  renderDays();
  document.querySelectorAll<HTMLButtonElement>(".view").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("browse").hidden = view !== "browse";
  $("mine").hidden = view !== "mine";
  const counted = [...marks].filter(([id]) => byId.has(id));
  const nFav = counted.filter(([, m]) => m === "favorite").length;
  const nInt = counted.length - nFav;
  $("mycount").textContent = [nFav ? `${nFav}★` : "", nInt ? `${nInt}✓` : ""].filter(Boolean).join(" ");
  if (view === "browse") renderList();
  else renderGrid();
  if (openId) renderDetailToggle();
}

/** Tapping a mark sets it, or clears it if it is already the current state. */
async function setMark(id: string, kind: Mark) {
  const prev = marks.get(id);
  const next = prev === kind ? undefined : kind;
  const apply = (m: Mark | undefined) => { if (m) marks.set(id, m); else marks.delete(id); render(); };
  apply(next);
  try {
    const res = await api(`/api/selections/${encodeURIComponent(id)}`, next
      ? { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) }
      : { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    apply(prev);
    toast("Could not save. Check your connection and try again.");
  }
}

function renderDetailToggle() {
  const box = document.getElementById("detail-marks");
  if (!box || !openId) return;
  const m = marks.get(openId);
  box.innerHTML = `<button class="btn${m === "favorite" ? " primary" : ""}" data-mark="favorite" data-id="${esc(openId)}" aria-pressed="${m === "favorite"}">${m === "favorite" ? "★ Favorite" : "☆ Favorite"}</button>
    <button class="btn${m === "interested" ? " primary" : ""}" data-mark="interested" data-id="${esc(openId)}" aria-pressed="${m === "interested"}">✓ Interested</button>`;
}

async function openDetail(id: string) {
  const s = byId.get(id);
  if (!s) return;
  openId = id;
  const dayLabel = esc(DAYS.find(([k]) => k === s.day)?.[1] ?? s.day);
  const head = `<h2>${esc(s.title)}</h2>
    <dl><dt>When</dt><dd>${dayLabel}, ${hm(s.startsAt)}–${hm(s.endsAt)} (Salt Lake City)</dd>
    <dt>Room</dt><dd>${esc(s.room || "TBA")}</dd>
    <dt>Track</dt><dd>${esc(s.track)}</dd>
    ${s.events.length ? `<dt>Event${s.events.length > 1 ? "s" : ""}</dt><dd>${esc(s.events.join(", "))}</dd>` : ""}
    ${s.format ? `<dt>Format</dt><dd>${esc(s.format)}</dd>` : ""}</dl>
    <p id="detail-marks" class="detail-marks"></p>`;
  $("detail-body").innerHTML = head + `<p class="meta">Loading…</p>`;
  $("detail").hidden = false;
  renderDetailToggle();
  try {
    const res = await api(`/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error();
    const f = (await res.json()) as Full;
    if (openId !== id) return;
    const sp = f.speakers.length
      ? `<h3>Speakers</h3><ul>${f.speakers.map((x) => `<li><strong>${esc(x.name)}</strong>${x.company || x.title ? `<br><span class="meta">${esc([x.title, x.company].filter(Boolean).join(", "))}</span>` : ""}</li>`).join("")}</ul>`
      : "";
    $("detail-body").innerHTML = head + (f.description ? `<p class="desc">${esc(f.description)}</p>` : "") + sp;
    renderDetailToggle();
  } catch {
    if (openId === id) $("detail-body").innerHTML = head + `<p class="meta">Could not load details.</p>`;
    renderDetailToggle();
  }
}

function closeDetail() {
  openId = null;
  $("detail").hidden = true;
}

async function loadSessions() {
  $("count").textContent = "Loading schedule…";
  const res = await api("/api/sessions");
  const body: any = await res.json();
  if (!res.ok) { $("count").textContent = `Could not load the schedule: ${body.error ?? res.status}`; return; }
  setSessions(body.sessions, body.lastImportAt);
}

async function refresh() {
  const btn = $<HTMLButtonElement>("refresh");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    const res = await api("/api/import", { method: "POST" });
    const body: any = await res.json();
    if (!res.ok) toast(`Refresh failed: ${body.error ?? res.status}`);
    else {
      toast(`Updated: ${body.added} added, ${body.updated} changed, ${body.removed} removed (${body.total} total)`);
      await loadSessions();
      render();
    }
  } catch { toast("Refresh failed."); }
  btn.disabled = false;
  btn.textContent = "Refresh schedule";
}

function wire() {
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const mk = t.closest<HTMLElement>("[data-mark]");
    if (mk) { setMark(mk.dataset.id!, mk.dataset.mark as Mark); return; }
    const op = t.closest<HTMLElement>("[data-open]");
    if (op) { openDetail(op.dataset.open!); return; }
    const d = t.closest<HTMLElement>("[data-day]");
    if (d) {
      if (view === "browse") browseScroll.set(browseKey(), window.scrollY);
      day = d.dataset.day!;
      render();
      window.scrollTo(0, view === "browse" ? browseScroll.get(browseKey()) ?? 0 : 0);
      return;
    }
    const v = t.closest<HTMLElement>("[data-view]");
    if (v) {
      const next = v.dataset.view as typeof view;
      if (next === view) return;
      if (view === "browse") browseScroll.set(browseKey(), window.scrollY);
      view = next;
      render();
      window.scrollTo(0, view === "browse" ? browseScroll.get(browseKey()) ?? 0 : 0);
      return;
    }
    if (t.id === "close" || t.id === "detail") closeDetail();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
  for (const id of ["q", "alldays", "track", "event"]) $(id).addEventListener("input", renderList);
  $("refresh").addEventListener("click", refresh);
}

/**
 * Activity ping: tell the server the user did something (not what), at most once a minute.
 * Browsing happens in the browser without server calls, so without this a returning user who only
 * browses would never be counted.
 */
const PING_EVERY_MS = 60_000;
let lastPing = 0;
function ping() {
  const now = Date.now();
  if (now - lastPing < PING_EVERY_MS) return;
  lastPing = now;
  fetch("/api/ping", { method: "POST", credentials: "same-origin", keepalive: true }).catch(() => {});
}
function wireActivity() {
  for (const ev of ["pointerdown", "keydown", "scroll", "input"]) {
    window.addEventListener(ev, ping, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
}

async function main() {
  wire();
  let me: { email: string };
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.status === 401) return showSignIn();
    me = await res.json();
  } catch { return showSignIn(); }
  lastPing = Date.now(); // this page load's API calls already record activity
  wireActivity();
  $("email").textContent = me.email || "Signed in";
  $("who").hidden = false;
  $("app").hidden = false;
  renderDays();
  const [, selRes] = await Promise.all([loadSessions(), api("/api/selections")]);
  if (selRes.ok) {
    const rows = (await selRes.json()) as { id: string; status: Mark }[];
    marks = new Map(rows.map((r) => [r.id, r.status]));
  }
  render();
}

main();
