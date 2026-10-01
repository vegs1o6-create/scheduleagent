import type { CalendarEvent } from "./calendar";
import type { Config, Env } from "./env";
import type { Note, Store } from "./store";
import { MAX_NOTE_LENGTH } from "./store";
import { addDays, formatDateNo, todayIn, zonedParts, zonedRfc3339 } from "./dates";
import { timingSafeEqual } from "./webhook";
import { log } from "./log";
import type { WeatherDay } from "./weather";

/** Google Calendar sine faste farger for colorId 1–11. */
export const GOOGLE_COLORS: Record<string, string> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d50000",
};
const DEFAULT_COLOR = "#039be5";

export interface DisplayEvent {
  title: string;
  /** "17:00–18:30", "fra 17:00" eller null for heldag. */
  time: string | null;
  location: string | null;
  color: string;
  /** Slutttidspunkt (ISO) for å tone ned hendelser som er ferdige i dag. */
  endsAt: string | null;
}

export interface DisplayDay {
  date: string;
  label: string;
  relative: string | null;
  events: DisplayEvent[];
}

export interface DisplayData {
  generatedAt: string;
  today: string;
  legend: { name: string; color: string }[];
  days: DisplayDay[];
  notes: Note[];
  /** Hvor mange av kalenderne som ikke kunne leses (de andre vises likevel). */
  calendarErrors: number;
  /** Værvarsel fra Yr for de neste 7 dagene, eller null (ikke satt opp / feilet). */
  weather: WeatherDay[] | null;
}

/** Det infoskjermen trenger, samlet slik at testene kan bytte ut deler. */
export interface DisplayDeps {
  config: Config;
  store: Store;
  /** Henter hendelser fra én kalender. */
  listEvents: (calendarId: string, timeMin: string, timeMax: string) => Promise<CalendarEvent[]>;
  calendarIds: string[];
  days: number;
  /** Henter værvarselet (null når posisjon ikke er satt eller kallet feiler). */
  weather?: () => Promise<WeatherDay[] | null>;
  now: () => Date;
}

const hhmm = (p: { hour: number; minute: number }) =>
  `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Grupperer hendelser per dag i Oslo-tid. Heldagshendelser over flere dager vises hver dag. */
export function groupByDay(
  events: CalendarEvent[],
  today: string,
  dayCount: number,
  timeZone: string,
): DisplayDay[] {
  const days: DisplayDay[] = [];
  const byDate = new Map<string, DisplayDay>();
  for (let i = 0; i < dayCount; i++) {
    const date = addDays(today, i);
    const day: DisplayDay = {
      date,
      label: capitalize(formatDateNo(date)),
      relative: i === 0 ? "I dag" : i === 1 ? "I morgen" : null,
      events: [],
    };
    days.push(day);
    byDate.set(date, day);
  }

  const timed: { sort: string; date: string; ev: DisplayEvent }[] = [];
  for (const ev of events) {
    const base = {
      title: ev.summary?.trim() || "(uten tittel)",
      location: ev.location?.trim() || null,
      color: GOOGLE_COLORS[ev.colorId ?? ""] ?? DEFAULT_COLOR,
    };
    if (ev.start.date) {
      // Heldag: end.date er eksklusiv.
      const last = ev.end.date ? addDays(ev.end.date, -1) : ev.start.date;
      for (let d = ev.start.date < today ? today : ev.start.date; d <= last; d = addDays(d, 1)) {
        if (!byDate.has(d)) break;
        timed.push({ sort: `${d} 00`, date: d, ev: { ...base, time: null, endsAt: null } });
      }
      continue;
    }
    if (!ev.start.dateTime) continue;
    const start = zonedParts(new Date(ev.start.dateTime), timeZone);
    const end = ev.end.dateTime ? zonedParts(new Date(ev.end.dateTime), timeZone) : null;
    let time = hhmm(start);
    if (end && end.date === start.date && hhmm(end) !== time) time += `–${hhmm(end)}`;
    else if (end && end.date !== start.date) time = `fra ${time}`;
    // Hendelser som startet før i dag, men fortsatt pågår, vises i dag.
    const date = start.date < today ? today : start.date;
    timed.push({
      sort: `${date} 1${start.date < today ? "00:00" : time}`,
      date,
      ev: { ...base, time, endsAt: ev.end.dateTime ? new Date(ev.end.dateTime).toISOString() : null },
    });
  }
  timed.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  for (const t of timed) byDate.get(t.date)?.events.push(t.ev);
  return days;
}

export async function displayData(deps: DisplayDeps): Promise<DisplayData> {
  const { config } = deps;
  const now = deps.now();
  const today = todayIn(now, config.timezone);
  const timeMin = zonedRfc3339(today, "00:00", config.timezone);
  const timeMax = zonedRfc3339(addDays(today, deps.days), "00:00", config.timezone);
  const [results, notes, weather] = await Promise.all([
    Promise.allSettled(deps.calendarIds.map((id) => deps.listEvents(id, timeMin, timeMax))),
    deps.store.getNotes(),
    deps.weather ? deps.weather().catch(() => null) : Promise.resolve(null),
  ]);
  // Én kalender som feiler (f.eks. manglende tilgang) skal ikke ta ned hele skjermen.
  const lists: CalendarEvent[][] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") lists.push(r.value);
    else log("display_calendar_failed", { calendarId: deps.calendarIds[i], error: String(r.reason) });
  });
  if (!lists.length) throw (results[0] as PromiseRejectedResult).reason;
  const legend = config.children
    .filter((c) => c.colorId && GOOGLE_COLORS[c.colorId])
    .map((c) => ({ name: c.name, color: GOOGLE_COLORS[c.colorId!]! }));
  if (config.bothColorId && GOOGLE_COLORS[config.bothColorId]) {
    legend.push({ name: "Begge", color: GOOGLE_COLORS[config.bothColorId]! });
  }
  return {
    generatedAt: now.toISOString(),
    today,
    legend,
    days: groupByDay(lists.flat(), today, deps.days, config.timezone),
    notes,
    calendarErrors: results.length - lists.length,
    weather,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Infoskjermen:
 *   GET  /skjerm?key=…              – HTML-siden
 *   GET  /skjerm/data?key=…         – kalender og notater som JSON
 *   POST /skjerm/notater?key=…      – {"text": "…"} legger til et notat
 *   POST /skjerm/notater/slett?key=… – {"id": "…"} fjerner et notat
 * Alt er beskyttet med DISPLAY_KEY.
 */
export async function handleDisplay(request: Request, env: Env, deps: DisplayDeps): Promise<Response> {
  const url = new URL(request.url);
  const expected = env.DISPLAY_KEY?.trim() ?? "";
  if (!expected) {
    return new Response(
      "Infoskjermen er ikke satt opp. Legg inn en secret DISPLAY_KEY i Cloudflare (Settings → Variables and Secrets), " +
        "og åpn /skjerm?key=<DISPLAY_KEY>.\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const key = (url.searchParams.get("key") ?? "").trim();
  if (!timingSafeEqual(key, expected)) {
    log("display_rejected", { path: url.pathname });
    return new Response("Feil eller manglende nøkkel. Bruk /skjerm?key=<DISPLAY_KEY>.\n", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (request.method === "GET" && path === "/skjerm") {
    return new Response(DISPLAY_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (request.method === "GET" && path === "/skjerm/data") {
    try {
      return json(await displayData(deps));
    } catch (err) {
      log("display_data_failed", { error: String(err) });
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }
  if (request.method === "POST" && path === "/skjerm/notater") {
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "Tomt notat" }, 400);
    if (text.length > MAX_NOTE_LENGTH) return json({ error: `Maks ${MAX_NOTE_LENGTH} tegn` }, 400);
    const note = await deps.store.addNote(text, "skjerm", deps.now());
    log("note_added", { id: note.id, source: "skjerm" });
    return json({ note, notes: await deps.store.getNotes() });
  }
  if (request.method === "POST" && path === "/skjerm/notater/slett") {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof body?.id === "string" ? body.id : "";
    const removed = await deps.store.removeNote(id);
    log("note_removed", { id, found: Boolean(removed), source: "skjerm" });
    return json({ removed: Boolean(removed), notes: await deps.store.getNotes() });
  }
  return new Response("not found", { status: 404 });
}

/**
 * Selve siden. Skrevet uten byggesteg og med JavaScript som også virker i
 * eldre Safari (ingen optional chaining, ingen flex-gap), slik at et gammelt
 * iPad kan brukes som infoskjerm.
 */
export const DISPLAY_HTML = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Familien">
<meta name="robots" content="noindex">
<title>Familien</title>
<style>
:root {
  --bg: #f4f1ea; --panel: #ffffff; --text: #1f2328; --muted: #6b6f76; --line: #e3ded3;
  --accent: #b5532a; --note: #fff6d6; --note-line: #f0e2a8; --today: #fbeee6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111315; --panel: #1b1e21; --text: #eceff1; --muted: #9aa1a8; --line: #2c3136;
    --accent: #f08a5d; --note: #2a2618; --note-line: #3d3720; --today: #2a1f1a;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust: 100%; -webkit-user-select: none; user-select: none; }
.wrap { display: grid; grid-template-columns: 3fr 2fr; grid-template-rows: auto 1fr; grid-gap: 16px;
  height: 100vh; padding: 20px 24px; padding-top: max(20px, env(safe-area-inset-top)); }
header { grid-column: 1 / -1; display: flex; align-items: flex-end; justify-content: space-between; }
.clock { font-size: 64px; font-weight: 600; line-height: 1; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
.date { font-size: 22px; color: var(--muted); margin-top: 6px; }
.right { display: flex; flex-direction: column; align-items: flex-end; }
.weather { display: flex; }
.wday { width: 84px; text-align: center; padding: 6px 2px; border-radius: 12px; }
.wday + .wday { margin-left: 4px; }
.wday.today { background: var(--panel); }
.wday .wd { font-size: 15px; color: var(--muted); font-weight: 600; }
.wday .ic { font-size: 30px; line-height: 1.25; }
.wday .t { font-size: 18px; font-variant-numeric: tabular-nums; }
.wday .t .lo { color: var(--muted); font-size: 15px; }
.wday .p { font-size: 13px; color: #1e88e5; min-height: 16px; }
.legend { text-align: right; font-size: 16px; color: var(--muted); margin-top: 8px; }
.legend span { display: inline-block; margin-left: 14px; }
.dot { display: inline-block; width: 12px; height: 12px; border-radius: 6px; margin-right: 6px; vertical-align: -1px; }
.status { font-size: 13px; color: var(--muted); margin-top: 6px; }
.status.err { color: #d50000; }
.panel { background: var(--panel); border-radius: 18px; padding: 18px 20px; overflow-y: auto;
  -webkit-overflow-scrolling: touch; min-height: 0; }
h2 { margin: 0 0 10px; font-size: 15px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); font-weight: 600; }
.day { padding: 10px 0 12px; border-top: 1px solid var(--line); }
.day:first-of-type { border-top: 0; }
.day.today { background: var(--today); margin: 0 -20px; padding: 10px 20px 12px; border-radius: 12px; border-top: 0; }
.dayhead { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
.dayhead .rel { color: var(--accent); margin-right: 8px; }
.dayhead .lbl { color: var(--muted); font-weight: 500; }
.ev { display: flex; align-items: baseline; padding: 4px 0; font-size: 21px; line-height: 1.3; }
.ev .bar { width: 6px; align-self: stretch; border-radius: 3px; margin-right: 12px; flex: none; }
.ev .time { width: 132px; flex: none; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 19px; }
.ev .title { flex: 1; min-width: 0; }
.ev .loc { display: block; font-size: 15px; color: var(--muted); }
.ev.past { opacity: 0.4; }
.empty { color: var(--muted); font-size: 17px; padding: 2px 0; }
.notes { display: flex; flex-direction: column; }
.noteshead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.noteshead h2 { margin: 0; }
button.add { background: var(--accent); color: #fff; border: 0; border-radius: 22px; font-size: 18px;
  padding: 10px 18px; font-weight: 600; -webkit-appearance: none; }
.note { background: var(--note); border: 1px solid var(--note-line); border-radius: 12px; padding: 12px 14px;
  margin-bottom: 10px; font-size: 21px; line-height: 1.35; white-space: pre-wrap; word-wrap: break-word; cursor: pointer; }
.note small { display: block; font-size: 13px; color: var(--muted); margin-top: 4px; }
.hint { font-size: 14px; color: var(--muted); margin-top: auto; padding-top: 10px; }
@media (max-width: 760px) {
  .wrap { grid-template-columns: 1fr; grid-template-rows: auto auto auto; height: auto; padding: 16px; }
  .clock { font-size: 44px; }
  .legend { display: none; }
  header { flex-direction: column; align-items: flex-start; }
  .right { align-items: flex-start; margin-top: 12px; max-width: 100%; overflow-x: auto; }
  .wday { width: 64px; }
  .ev .time { width: 110px; }
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <div class="clock" id="clock">--:--</div>
      <div class="date" id="date"></div>
    </div>
    <div class="right">
      <div class="weather" id="weather"></div>
      <div class="legend" id="legend"></div>
      <div class="status" id="status" style="text-align:right"></div>
    </div>
  </header>
  <section class="panel" id="calendar"><div class="empty">Laster kalenderen …</div></section>
  <section class="panel notes">
    <div class="noteshead"><h2>Husk</h2><button class="add" id="add">+ Notat</button></div>
    <div id="notes"></div>
    <div class="hint">Trykk på et notat for å fjerne det. Fra Telegram: /notat tekst</div>
  </section>
</div>
<script>
(function () {
  var KEY = new URLSearchParams(location.search).get("key") || "";
  var REFRESH_MS = 2 * 60 * 1000;
  var RELOAD_MS = 6 * 60 * 60 * 1000;
  var WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  var MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
  var lastOk = null;
  var lastToday = null;
  var calendarErrors = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function api(path, body) {
    var opts = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {};
    return fetch(path + "?key=" + encodeURIComponent(KEY), opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function tick() {
    var d = new Date();
    $("clock").textContent = pad(d.getHours()) + ":" + pad(d.getMinutes());
    var w = WEEKDAYS[d.getDay()];
    $("date").textContent = w.charAt(0).toUpperCase() + w.slice(1) + " " + d.getDate() + ". " + MONTHS[d.getMonth()];
    updateStatus();
  }

  function updateStatus() {
    var el = $("status");
    if (!lastOk) return;
    var mins = Math.round((Date.now() - lastOk) / 60000);
    if (mins >= 10) {
      el.className = "status err";
      el.textContent = "Ikke oppdatert på " + mins + " min";
    } else if (calendarErrors) {
      el.className = "status err";
      el.textContent = "Klarte ikke å lese " + calendarErrors + (calendarErrors === 1 ? " kalender" : " kalendere");
    } else {
      el.className = "status";
      el.textContent = "";
    }
  }

  function renderCalendar(data) {
    var now = Date.now();
    var html = "";
    for (var i = 0; i < data.days.length; i++) {
      var day = data.days[i];
      // Etter i morgen: hopp over tomme dager for å spare plass.
      if (!day.events.length && i > 1) continue;
      html += '<div class="day' + (i === 0 ? " today" : "") + '"><div class="dayhead">' +
        (day.relative ? '<span class="rel">' + esc(day.relative) + '</span><span class="lbl">' + esc(day.label) + "</span>"
          : esc(day.label)) + "</div>";
      if (!day.events.length) html += '<div class="empty">Ingenting i kalenderen</div>';
      for (var j = 0; j < day.events.length; j++) {
        var ev = day.events[j];
        var past = ev.endsAt && new Date(ev.endsAt).getTime() < now;
        html += '<div class="ev' + (past ? " past" : "") + '"><span class="bar" style="background:' + esc(ev.color) + '"></span>' +
          '<span class="time">' + esc(ev.time || "Hele dagen") + "</span>" +
          '<span class="title">' + esc(ev.title) + (ev.location ? '<span class="loc">' + esc(ev.location) + "</span>" : "") +
          "</span></div>";
      }
      html += "</div>";
    }
    $("calendar").innerHTML = html;
    var legend = "";
    for (var k = 0; k < data.legend.length; k++) {
      legend += '<span><i class="dot" style="background:' + esc(data.legend[k].color) + '"></i>' + esc(data.legend[k].name) + "</span>";
    }
    $("legend").innerHTML = legend;
  }

  // Yr-symbolkoder → emoji. Koden kan ha _day/_night/_polartwilight til slutt.
  var ICONS = [
    ["thunder", "⛈️"], ["snow", "❄️"], ["sleet", "🌨️"], ["rainshowers", "🌦️"], ["rain", "🌧️"],
    ["fog", "🌫️"], ["partlycloudy", "⛅"], ["cloudy", "☁️"], ["fair", "🌤️"], ["clearsky", "☀️"]
  ];
  function icon(code) {
    if (!code) return "";
    if (code.indexOf("clearsky_night") === 0) return "🌙";
    for (var i = 0; i < ICONS.length; i++) if (code.indexOf(ICONS[i][0]) !== -1) return ICONS[i][1];
    return "";
  }
  var SHORT = ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"];
  function renderWeather(days, today) {
    if (!days || !days.length) { $("weather").innerHTML = ""; return; }
    var html = "";
    for (var i = 0; i < days.length && i < 7; i++) {
      var w = days[i];
      var p = w.date.split("-");
      var name = w.date === today ? "I dag" : SHORT[new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()];
      html += '<div class="wday' + (w.date === today ? " today" : "") + '"><div class="wd">' + name + "</div>" +
        '<div class="ic">' + icon(w.symbol) + "</div>" +
        '<div class="t">' + (w.max === null ? "" : w.max + "°") + ' <span class="lo">' + (w.min === null ? "" : w.min + "°") + "</span></div>" +
        '<div class="p">' + (w.precipitation >= 0.5 ? String(w.precipitation).replace(".", ",") + " mm" : "") + "</div></div>";
    }
    $("weather").innerHTML = html;
  }

  function renderNotes(notes) {
    var html = "";
    if (!notes.length) html = '<div class="empty">Ingen notater.</div>';
    for (var i = notes.length - 1; i >= 0; i--) {
      var n = notes[i];
      var d = new Date(n.createdAt);
      html += '<div class="note" data-id="' + esc(n.id) + '">' + esc(n.text) +
        "<small>" + d.getDate() + "." + (d.getMonth() + 1) + "</small></div>";
    }
    $("notes").innerHTML = html;
  }

  function refresh() {
    return api("/skjerm/data").then(function (data) {
      lastOk = Date.now();
      // Ny dag: last siden på nytt (henter også eventuelle nye versjoner av siden).
      if (lastToday && data.today !== lastToday) { location.reload(); return; }
      lastToday = data.today;
      calendarErrors = data.calendarErrors || 0;
      renderCalendar(data);
      renderNotes(data.notes);
      renderWeather(data.weather, data.today);
      updateStatus();
    }).catch(function (err) {
      var el = $("status");
      el.className = "status err";
      el.textContent = "Feil: " + err.message;
    });
  }

  $("add").addEventListener("click", function () {
    var text = window.prompt("Nytt notat:");
    if (!text || !text.trim()) return;
    api("/skjerm/notater", { text: text.trim() }).then(function (r) { renderNotes(r.notes); })
      .catch(function (err) { alert("Kunne ikke lagre: " + err.message); });
  });

  $("notes").addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== this && !el.getAttribute("data-id")) el = el.parentNode;
    if (!el || el === this) return;
    if (!window.confirm("Fjerne dette notatet?")) return;
    api("/skjerm/notater/slett", { id: el.getAttribute("data-id") }).then(function (r) { renderNotes(r.notes); })
      .catch(function (err) { alert("Kunne ikke fjerne: " + err.message); });
  });

  // Hold skjermen våken der nettleseren støtter det (Safari 16.4+).
  function wake() {
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request("screen").catch(function () {});
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { wake(); refresh(); }
  });

  tick();
  setInterval(tick, 10 * 1000);
  refresh();
  setInterval(refresh, REFRESH_MS);
  setTimeout(function () { location.reload(); }, RELOAD_MS);
  wake();
})();
</script>
</body>
</html>
`;
