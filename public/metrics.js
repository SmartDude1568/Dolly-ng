/* Quality-metrics dashboard.
   Fetches the JSON snapshot from GET /metrics?format=json and renders it.
   The endpoint is unauthenticated operational telemetry, so this page makes a
   plain fetch (no bearer token / Dolly.api) and works even when logged out. */

const esc = window.Dolly ? Dolly.esc : (s) => String(s ?? "");
let timer = null;

// ── Formatting ─────────────────────────────────────────────────────────────
function fmtMs(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m ${s}s`;
}
function fmtSec(sec) {
    if (sec == null) return "—";
    if (sec < 60) return `${sec.toFixed(1)} s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${String(s).padStart(2, "0")}s`;
}
function fmtPct(frac) {
    return frac == null ? "—" : `${Math.round(frac * 100)}%`;
}
function fmtNum(n) {
    return n == null ? "—" : n.toLocaleString();
}
function clockAgo(iso) {
    if (!iso) return "";
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
function fmtUptime(sec) {
    // `started_at` persists across restarts (in the DB), so this is how long
    // metrics have been collected, not raw process uptime.
    if (sec == null) return "";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `tracking ${h}h ${m}m`;
    if (m) return `tracking ${m}m ${s}s`;
    return `tracking ${s}s`;
}

// ── Rendering ──────────────────────────────────────────────────────────────
function kpiCard(label, value, sub, accent) {
    return `
        <div class="stat-card${accent ? ` accent-${accent}` : ""}">
            <div class="stat-value">${esc(value)}</div>
            <div class="stat-label">${esc(label)}</div>
            ${sub ? `<div class="stat-sub mono">${esc(sub)}</div>` : ""}
        </div>`;
}

function statTable(rows) {
    return `<table class="stat-table">${rows
        .map((r) => `<tr><th>${esc(r[0])}</th><td class="mono">${esc(r[1])}</td></tr>`)
        .join("")}</table>`;
}

function render(m) {
    document.getElementById("uptime").textContent = fmtUptime(m.uptime_sec);

    const stemmer = m.durations.stemmer || {};
    const a2c = m.durations.audio2chart || {};
    const audio = m.audio_length_sec || {};

    // KPIs
    document.getElementById("kpis").innerHTML = [
        kpiCard("Cache hit rate", fmtPct(m.cache.hit_rate), `${fmtNum(m.cache.total)} lookups`, "green"),
        kpiCard("Errors", fmtNum(m.errors.total), `${m.errors.by_module.length} module(s)`, m.errors.total > 0 ? "red" : null),
        kpiCard("Songs analyzed", fmtNum(audio.count), audio.avg != null ? `avg ${fmtSec(audio.avg)}` : "no uploads yet"),
        kpiCard("Avg stemmer", fmtMs(stemmer.avg), `${fmtNum(stemmer.count)} run(s)`, "blue"),
        kpiCard("Avg audio2chart", fmtMs(a2c.avg), `${fmtNum(a2c.count)} run(s)`, "yellow"),
    ].join("");

    // Stem cache
    document.getElementById("cache-total").textContent = `${fmtNum(m.cache.total)} lookups`;
    const hitPct = m.cache.total > 0 ? (m.cache.hits / m.cache.total) * 100 : 0;
    document.getElementById("cache-body").innerHTML = `
        <div class="bar">
            <div class="bar-fill hit" style="width:${hitPct}%"></div>
        </div>
        <div class="bar-legend">
            <span><i class="dot-green"></i> ${fmtNum(m.cache.hits)} hits</span>
            <span><i class="dot-red"></i> ${fmtNum(m.cache.misses)} misses</span>
        </div>
        ${m.cache.total === 0 ? `<div class="empty-line muted">No cache lookups recorded yet.</div>` : ""}`;

    // Process durations
    document.getElementById("durations-body").innerHTML = `
        <div class="dur-block">
            <h4>Stemmer API <span class="muted mono">${fmtNum(stemmer.count)} run(s)</span></h4>
            ${statTable([
                ["Average", fmtMs(stemmer.avg)],
                ["Min / Max", `${fmtMs(stemmer.min)} / ${fmtMs(stemmer.max)}`],
                ["Last", fmtMs(stemmer.last)],
            ])}
        </div>
        <div class="dur-block">
            <h4>audio2chart <span class="muted mono">${fmtNum(a2c.count)} run(s)</span></h4>
            ${statTable([
                ["Average", fmtMs(a2c.avg)],
                ["Min / Max", `${fmtMs(a2c.min)} / ${fmtMs(a2c.max)}`],
                ["Last", fmtMs(a2c.last)],
            ])}
        </div>`;

    // Input audio length
    document.getElementById("audio-body").innerHTML = audio.count
        ? statTable([
              ["Songs analyzed", fmtNum(audio.count)],
              ["Average", fmtSec(audio.avg)],
              ["Shortest", fmtSec(audio.min)],
              ["Longest", fmtSec(audio.max)],
              ["Total analyzed", fmtSec(audio.total)],
          ])
        : `<div class="empty-line muted">No audio analyzed yet — upload a song to populate this.</div>`;

    // Errors by module
    document.getElementById("errors-total").textContent = `${fmtNum(m.errors.total)} total`;
    document.getElementById("errors-body").innerHTML = m.errors.by_module.length
        ? m.errors.by_module
              .map(
                  (e) => `
            <div class="err-row">
                <div class="err-head">
                    <span class="chip-mod">${esc(e.module)}</span>
                    <span class="err-count">${fmtNum(e.count)}</span>
                    <span class="muted mono err-when">${clockAgo(e.last_at)}</span>
                </div>
                <div class="err-msg mono">${esc(e.last_message)}</div>
            </div>`,
              )
              .join("")
        : `<div class="empty-line muted">✓ No errors recorded.</div>`;

    // Recent activity (durations + errors merged, newest first)
    const events = [
        ...m.recent_durations.map((d) => ({
            at: d.at,
            kind: "dur",
            text: `${d.metric} finished in ${fmtMs(d.ms)}`,
        })),
        ...m.errors.recent.map((e) => ({
            at: e.at,
            kind: "err",
            text: `${e.module}: ${e.message}`,
        })),
    ]
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 30);

    document.getElementById("activity-body").innerHTML = events.length
        ? `<div class="feed">${events
              .map(
                  (ev) => `
            <div class="feed-row ${ev.kind}">
                <span class="feed-dot"></span>
                <span class="feed-text mono">${esc(ev.text)}</span>
                <span class="feed-when muted mono">${clockAgo(ev.at)}</span>
            </div>`,
              )
              .join("")}</div>`
        : `<div class="empty-line muted">No activity yet.</div>`;
}

// ── Loading ────────────────────────────────────────────────────────────────
async function load() {
    try {
        const res = await fetch("/metrics?format=json", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        render(await res.json());
    } catch (err) {
        if (window.Dolly) Dolly.toast(`Failed to load metrics: ${err.message}`, "error");
    }
}

function manageTimer() {
    const on = document.getElementById("auto").checked;
    if (on && !timer) timer = setInterval(load, 5000);
    else if (!on && timer) { clearInterval(timer); timer = null; }
}

document.getElementById("refresh").onclick = load;
document.getElementById("auto").onchange = manageTimer;

load();
manageTimer();
