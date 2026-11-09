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
const hm = (t: string) => t.slice(11, 16);

let sessions: S[] = [];
const byId = new Map<string, S>();
let selected = new Set<string>();
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
    const on = selected.has(s.id);
    const dayLabel = all ? `${DAYS.find(([k]) => k === s.day)?.[1] ?? s.day} ` : "";
    return `<li class="item${on ? " sel" : ""}" data-id="${esc(s.id)}">
      <div class="body" data-open="${esc(s.id)}">
        <div class="time">${dayLabel}${hm(s.startsAt)}–${hm(s.endsAt)}</div>
        <div class="title">${esc(s.title)}</div>
        <div class="sub">${esc(sub(s))}</div>
        ${s.speakerText ? `<div class="sub">${esc(s.speakerText)}</div>` : ""}
      </div>
      <button class="toggle${on ? " on" : ""}" data-toggle="${esc(s.id)}" aria-label="${on ? "Remove from" : "Add to"} my schedule">${on ? "★" : "☆"}</button>
    </li>`;
  }).join("") + (rows.length > shown.length ? `<li class="empty">Showing the first ${shown.length}. Narrow the search to see more.</li>` : "")
    + (rows.length === 0 ? `<li class="empty">No sessions match.</li>` : "");
}

function renderGrid() {
  const mine = [...selected].map((id) => byId.get(id)).filter((s): s is S => !!s && s.day === day);
  const grid = $("grid");
  if (mine.length === 0) {
    grid.style.height = "auto";
    grid.innerHTML = `<p class="empty">Nothing selected for this day yet. Tap ☆ in Browse to add sessions.</p>`;
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
      <div class="bt">${esc(s.title)}</div></div>`;
  }
  grid.innerHTML = html;
}

function render() {
  renderDays();
  document.querySelectorAll<HTMLButtonElement>(".view").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("browse").hidden = view !== "browse";
  $("mine").hidden = view !== "mine";
  const n = [...selected].filter((id) => byId.has(id)).length;
  $("mycount").textContent = n ? `(${n})` : "";
  if (view === "browse") renderList();
  else renderGrid();
  if (openId) renderDetailToggle();
}

async function toggle(id: string) {
  const on = selected.has(id);
  if (on) selected.delete(id); else selected.add(id);
  render();
  try {
    const res = await api(`/api/selections/${encodeURIComponent(id)}`, { method: on ? "DELETE" : "PUT" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    if (on) selected.add(id); else selected.delete(id);
    render();
    toast("Could not save. Check your connection and try again.");
  }
}

function renderDetailToggle() {
  const btn = document.getElementById("detail-toggle");
  if (!btn || !openId) return;
  const on = selected.has(openId);
  btn.textContent = on ? "★ Remove from my schedule" : "☆ Add to my schedule";
  btn.className = `btn ${on ? "" : "primary"}`;
}

async function openDetail(id: string) {
  const s = byId.get(id);
  if (!s) return;
  openId = id;
  const dayLabel = DAYS.find(([k]) => k === s.day)?.[1] ?? s.day;
  const head = `<h2>${esc(s.title)}</h2>
    <dl><dt>When</dt><dd>${dayLabel}, ${hm(s.startsAt)}–${hm(s.endsAt)} (Salt Lake City)</dd>
    <dt>Room</dt><dd>${esc(s.room || "TBA")}</dd>
    <dt>Track</dt><dd>${esc(s.track)}</dd>
    ${s.events.length ? `<dt>Event${s.events.length > 1 ? "s" : ""}</dt><dd>${esc(s.events.join(", "))}</dd>` : ""}
    ${s.format ? `<dt>Format</dt><dd>${esc(s.format)}</dd>` : ""}</dl>
    <p><button id="detail-toggle" class="btn"></button></p>`;
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
    const tog = t.closest<HTMLElement>("[data-toggle]");
    if (tog) { toggle(tog.dataset.toggle!); return; }
    const op = t.closest<HTMLElement>("[data-open]");
    if (op) { openDetail(op.dataset.open!); return; }
    const d = t.closest<HTMLElement>("[data-day]");
    if (d) { day = d.dataset.day!; render(); window.scrollTo(0, 0); return; }
    const v = t.closest<HTMLElement>("[data-view]");
    if (v) { view = v.dataset.view as typeof view; render(); window.scrollTo(0, 0); return; }
    if (t.id === "detail-toggle" && openId) { toggle(openId); return; }
    if (t.id === "close" || t.id === "detail") closeDetail();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
  for (const id of ["q", "alldays", "track", "event"]) $(id).addEventListener("input", renderList);
  $("refresh").addEventListener("click", refresh);
}

async function main() {
  wire();
  let me: { email: string };
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.status === 401) return showSignIn();
    me = await res.json();
  } catch { return showSignIn(); }
  $("email").textContent = me.email || "Signed in";
  $("who").hidden = false;
  $("app").hidden = false;
  renderDays();
  const [, selRes] = await Promise.all([loadSessions(), api("/api/selections")]);
  if (selRes.ok) selected = new Set(await selRes.json());
  render();
}

main();
