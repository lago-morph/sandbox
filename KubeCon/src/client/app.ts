import { durationBarPercent, layoutDay } from "../layout";

interface S {
  id: string; source: string; title: string; day: string; startsAt: string; endsAt: string;
  room: string; track: string; format: string | null; events: string[]; speakerText: string;
  /** The session has a slide download (shown as a dot next to the time). */
  hasSlides?: boolean;
}

const slidesDot = (s: S) => (s.hasSlides ? `<span class="slides-dot" title="Slides available" aria-label="Slides available"></span>` : "");
interface Full extends S {
  description: string;
  speakers: { name: string; company: string; title: string }[];
  slidesUrl?: string;
  recordingUrl?: string;
}

/** An external link, only for https URLs (the server already filters, this is a second check). */
function extLink(url: string | undefined, label: string): string {
  if (!url || !/^https:\/\//i.test(url)) return "";
  return `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

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

/** Days with conference tracks, where the multi-select track filter applies. */
const TRACK_DAYS = new Set(["2026-11-10", "2026-11-11", "2026-11-12"]);
/** Tracks selected in the Tracks sheet; empty means all tracks. Applies to Browse, Tue–Thu sessions only. */
const trackFilter = new Set<string>(loadTrackFilter());

/** The Tracks selection is remembered on this device only (a viewer convenience; never required). */
const TRACKS_KEY = "kp_tracks";
function loadTrackFilter(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("kp_tracks") ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveTrackFilter() {
  try {
    localStorage.setItem(TRACKS_KEY, JSON.stringify([...trackFilter]));
  } catch {
    // Storage may be unavailable (private mode); the filter still works for this page view.
  }
}
/** Start time and screen position of the Browse card at mid-screen when the Tracks sheet opened. */
let trackAnchor: { startsAt: string; top: number } | null = null;

function renderList() {
  const q = $<HTMLInputElement>("q").value.trim().toLowerCase();
  const all = $<HTMLInputElement>("alldays").checked;
  // On Tue–Thu the Tracks button replaces the single-track dropdown, so the dropdown is ignored there.
  const track = TRACK_DAYS.has(day) ? "" : $<HTMLSelectElement>("track").value;
  const ev = $<HTMLSelectElement>("event").value;
  const rows = sessions.filter((s) =>
    (all || s.day === day) &&
    (!track || s.track === track) &&
    (trackFilter.size === 0 || !TRACK_DAYS.has(s.day) || trackFilter.has(s.track)) &&
    (!ev || s.events.includes(ev)) &&
    (!q || s.title.toLowerCase().includes(q) || s.speakerText.toLowerCase().includes(q)),
  );
  $("count").textContent = `${rows.length} session${rows.length === 1 ? "" : "s"}`;
  const shown = rows.slice(0, 400);
  $("list").innerHTML = shown.map((s) => {
    const m = marks.get(s.id);
    const dayLabel = all ? `${esc(DAYS.find(([k]) => k === s.day)?.[1] ?? s.day)} ` : "";
    const bar = durationBarPercent(s.startsAt, s.endsAt);
    return `<li class="item${m === "favorite" ? " sel" : m === "interested" ? " int" : ""}" data-id="${esc(s.id)}">
      ${bar > 0 ? `<span class="dur" style="width:${bar.toFixed(2)}%" aria-hidden="true"></span>` : ""}
      <div class="body" data-open="${esc(s.id)}">
        <div class="time">${dayLabel}${hm(s.startsAt)}–${hm(s.endsAt)}${slidesDot(s)}</div>
        <div class="title">${esc(s.title)}</div>
        <div class="sub">${esc(sub(s))}</div>
        ${s.speakerText ? `<div class="sub">${esc(s.speakerText)}</div>` : ""}
      </div>
      ${markButtons(s.id)}
    </li>`;
  }).join("") + (rows.length > shown.length ? `<li class="empty">Showing the first ${shown.length}. Narrow the search to see more.</li>` : "")
    + (rows.length === 0 ? `<li class="empty">No sessions match.</li>` : "");
}

/** Checkmark drawn as SVG so it sits exactly in the middle of the round button (a text glyph does not). */
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
  '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function markButtons(id: string): string {
  const m = marks.get(id);
  const fav = m === "favorite";
  const int = m === "interested";
  return `<div class="marks">
    <button class="toggle${fav ? " on" : ""}" data-mark="favorite" data-id="${esc(id)}" aria-pressed="${fav}"
      aria-label="${fav ? "Remove favorite" : "Favorite: plan to attend"}">${fav ? "★" : "☆"}</button>
    <button class="toggle check${int ? " on" : ""}" data-mark="interested" data-id="${esc(id)}" aria-pressed="${int}"
      aria-label="${int ? "Remove interested" : "Interested: watch the recording later"}">${CHECK_ICON}</button>
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
    const short = h < 40; // one line: time, truncated title
    html += `<div class="block${conflict ? " conflict" : ""}${short ? " short" : ""}" data-open="${esc(s.id)}"
      style="top:${(b.start - lo) * PX_PER_MIN}px;height:${h}px;left:${(b.col / b.cols) * 100}%;width:${100 / b.cols}%">
      <div class="bh">${hm(s.startsAt)}${slidesDot(s)}</div>
      <div class="bt">${esc(s.title)}</div></div>`;
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
  renderTracksButton();
}

function renderTracksButton() {
  const btn = $<HTMLButtonElement>("tracks-btn");
  btn.hidden = view !== "browse" || !TRACK_DAYS.has(day);
  $("track").hidden = TRACK_DAYS.has(day);
  btn.textContent = trackFilter.size ? `Tracks (${trackFilter.size})` : "Tracks";
  btn.classList.toggle("on", trackFilter.size > 0);
}

/** The Browse card at the middle of the screen (or the last one above it). */
function midScreenCard(): HTMLElement | null {
  const mid = window.innerHeight / 2;
  const cards = [...document.querySelectorAll<HTMLElement>("#list .item")];
  return cards.find((el) => el.getBoundingClientRect().bottom >= mid) ?? cards[cards.length - 1] ?? null;
}

/** After the list changes, put the first card at or after the anchor time where the anchor card was. */
function keepAnchor() {
  if (!trackAnchor) return;
  const cards = [...document.querySelectorAll<HTMLElement>("#list .item")];
  if (!cards.length) return;
  const target = cards.find((el) => (byId.get(el.dataset.id!)?.startsAt ?? "") >= trackAnchor!.startsAt) ?? cards[cards.length - 1];
  window.scrollTo(0, Math.max(0, window.scrollY + target.getBoundingClientRect().top - trackAnchor.top));
}

/** Sort tracks by name, ignoring leading emoji and symbols ("⚡ Lightning Talks" sorts under L). */
const sortKey = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, "");

function renderTracksList() {
  const tracks = [...new Set(sessions.filter((s) => TRACK_DAYS.has(s.day)).map((s) => s.track))]
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const counts = new Map<string, number>();
  for (const s of sessions) if (s.day === day) counts.set(s.track, (counts.get(s.track) ?? 0) + 1);
  $("tracks-list").innerHTML = tracks.map((t) => {
    const n = counts.get(t) ?? 0;
    return `<label class="track-row${n ? "" : " none"}"><input type="checkbox" data-track="${esc(t)}"${trackFilter.has(t) ? " checked" : ""}>
      <span class="track-name">${esc(t)}</span><span class="meta">${n}</span></label>`;
  }).join("");
}

function openTracks() {
  const card = midScreenCard();
  const s = card ? byId.get(card.dataset.id!) : undefined;
  trackAnchor = card && s ? { startsAt: s.startsAt, top: card.getBoundingClientRect().top } : null;
  renderTracksList();
  $("tracks").hidden = false;
}

function closeTracks() {
  $("tracks").hidden = true;
  trackAnchor = null;
}

function tracksChanged() {
  renderList();
  renderTracksButton();
  keepAnchor();
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
    const links = [extLink(f.slidesUrl, "⬇ Slides"), extLink(f.recordingUrl, "▶ Recording")].filter(Boolean).join(" ");
    $("detail-body").innerHTML = head + (links ? `<p class="detail-links">${links}</p>` : "") +
      (f.description ? `<p class="desc">${esc(f.description)}</p>` : "") + sp;
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDetail(); closeTracks(); } });
  $("tracks-btn").addEventListener("click", openTracks);
  for (const id of ["tracks-close", "tracks-done"]) $(id).addEventListener("click", closeTracks);
  $("tracks").addEventListener("click", (e) => { if (e.target === $("tracks")) closeTracks(); });
  $("tracks-list").addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    const t = box.dataset.track;
    if (!t) return;
    if (box.checked) trackFilter.add(t); else trackFilter.delete(t);
    saveTrackFilter();
    tracksChanged();
  });
  $("tracks-clear").addEventListener("click", () => {
    trackFilter.clear();
    saveTrackFilter();
    renderTracksList();
    tracksChanged();
  });
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

/** Share button: create a 5-minute download link for this user's marked sessions. */
async function openExport() {
  const input = $<HTMLInputElement>("export-url");
  input.value = "Creating link…";
  $("export-expiry").textContent = "";
  $("export").hidden = false;
  try {
    const res = await api("/api/export", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
    input.value = url;
    const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(expiresAt));
    $("export-expiry").textContent = `Valid for 5 minutes, until ${t} Salt Lake City time.`;
  } catch {
    input.value = "";
    $("export-expiry").textContent = "Could not create a link. Check your connection and try again.";
  }
}

async function copyExportLink() {
  const input = $<HTMLInputElement>("export-url");
  if (!/^https:\/\//.test(input.value)) return;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
    document.execCommand("copy");
  }
  toast("Link copied");
}

async function main() {
  wire();
  $("share").addEventListener("click", openExport);
  $("notice-ok").addEventListener("click", () => ($("notice").hidden = true));
  $("export-copy").addEventListener("click", copyExportLink);
  $("export-close").addEventListener("click", () => ($("export").hidden = true));
  $("export").addEventListener("click", (e) => { if (e.target === $("export")) $("export").hidden = true; });
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
  showNotices();
}

/**
 * "What's new": show the first unseen notice, and record it as seen as soon as it is shown,
 * so each user sees it exactly once (on whichever device they open next).
 */
async function showNotices() {
  try {
    const res = await api("/api/notices");
    if (!res.ok) return;
    const [n] = (await res.json()) as { id: string; title: string; text: string }[];
    if (!n) return;
    $("notice-title").textContent = n.title;
    $("notice-text").textContent = n.text;
    $("notice").hidden = false;
    await api(`/api/notices/${encodeURIComponent(n.id)}/seen`, { method: "POST" });
  } catch {
    // Notices are optional.
  }
}

main();
