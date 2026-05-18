// Simple frontend for the Dolly API.

const API = "/v1";
let token = localStorage.getItem("dolly_token");

// ── UI helpers ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function showMessage(text, isError = false) {
    const el = $("message");
    el.textContent = text;
    el.className = isError ? "error" : "";
    setTimeout(() => { el.textContent = ""; }, 4000);
}

function updateAuthUI() {
    if (token) {
        $("auth-status").textContent = "Logged in";
        $("logout-btn").hidden = false;
        $("auth-section").hidden = true;
        $("app-section").hidden = false;
        refreshFiles();
        refreshConversions();
    } else {
        $("auth-status").textContent = "Not logged in";
        $("logout-btn").hidden = true;
        $("auth-section").hidden = false;
        $("app-section").hidden = true;
    }
}

// ── API wrappers ────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (options.body && !(options.body instanceof FormData)) {
        headers["Content-Type"] = "application/json";
    }

    const res = await fetch(API + path, { ...options, headers });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
        throw new Error(err.error?.message || "Request failed");
    }
    if (res.status === 204) return null;
    return res.json();
}

// ── Auth ────────────────────────────────────────────────────────────────

$("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
        await apiFetch("/auth/register", { method: "POST", body: JSON.stringify(data) });
        showMessage("Registered! Now log in.");
        e.target.reset();
    } catch (err) {
        showMessage(err.message, true);
    }
});

$("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
        const result = await apiFetch("/auth/login", { method: "POST", body: JSON.stringify(data) });
        token = result.token;
        localStorage.setItem("dolly_token", token);
        showMessage("Logged in.");
        updateAuthUI();
    } catch (err) {
        showMessage(err.message, true);
    }
});

$("logout-btn").addEventListener("click", async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    token = null;
    localStorage.removeItem("dolly_token");
    updateAuthUI();
});

// ── Files ───────────────────────────────────────────────────────────────

$("upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
        const result = await apiFetch("/files/upload", { method: "POST", body: form });
        showMessage(`Uploaded: ${result.file_id}`);
        e.target.reset();
        refreshFiles();
    } catch (err) {
        showMessage(err.message, true);
    }
});

async function refreshFiles() {
    try {
        const result = await apiFetch("/files");
        const list = $("file-list");
        list.innerHTML = "";
        for (const f of result.files) {
            const li = document.createElement("li");
            li.textContent = `${f.file_id} — ${f.name} (${f.size_bytes} bytes)`;
            list.appendChild(li);
        }
        if (result.files.length === 0) {
            list.innerHTML = "<li>(no files)</li>";
        }
    } catch (err) {
        showMessage(err.message, true);
    }
}

$("refresh-files").addEventListener("click", refreshFiles);

// ── Conversions ─────────────────────────────────────────────────────────

$("conversion-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.instruments = data.instruments.split(",").map(s => s.trim()).filter(Boolean);
    try {
        const result = await apiFetch("/conversions", { method: "POST", body: JSON.stringify(data) });
        showMessage(`Conversion started: ${result.conversion_id}`);
        refreshConversions();
    } catch (err) {
        showMessage(err.message, true);
    }
});

async function refreshConversions() {
    try {
        const result = await apiFetch("/conversions");
        const list = $("conversion-list");
        list.innerHTML = "";
        for (const c of result.conversions) {
            const li = document.createElement("li");
            const taskSummary = c.tasks.map(t => `${t.type}:${t.status}`).join(", ");
            li.textContent = `${c.conversion_id} — ${c.status} — [${taskSummary}]`;
            list.appendChild(li);
        }
        if (result.conversions.length === 0) {
            list.innerHTML = "<li>(no conversions)</li>";
        }
    } catch (err) {
        showMessage(err.message, true);
    }
}

$("refresh-conversions").addEventListener("click", refreshConversions);

// ── Chart generation (Modal-backed audio2chart) ─────────────────────────

const chartForm = $("chart-form");
const chartJobBox = $("chart-job");
const chartStage = $("chart-stage");
const chartProgress = $("chart-progress");
const chartProgressText = $("chart-progress-text");
const chartResult = $("chart-result");

let chartPollTimer = null;

chartForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (chartPollTimer) { clearInterval(chartPollTimer); chartPollTimer = null; }

    const formData = new FormData();
    const file = chartForm.audio.files[0];
    if (!file) { showMessage("Pick an audio file first", true); return; }
    formData.append("audio", file);

    const opts = {};
    if (chartForm.name.value) opts.name = chartForm.name.value;
    if (chartForm.artist.value) opts.artist = chartForm.artist.value;
    if (chartForm.temperature.value) opts.temperature = parseFloat(chartForm.temperature.value);
    if (chartForm.top_k.value) opts.top_k = parseInt(chartForm.top_k.value, 10);
    formData.append("opts", JSON.stringify(opts));

    chartJobBox.hidden = false;
    chartStage.textContent = "Uploading…";
    chartProgress.value = 0;
    chartProgress.removeAttribute("value"); // indeterminate
    chartProgressText.textContent = "";
    chartResult.textContent = "";

    let jobId;
    try {
        const res = await fetch("/charts", { method: "POST", body: formData });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        ({ jobId } = await res.json());
    } catch (err) {
        chartStage.textContent = "Failed to start";
        chartResult.textContent = err.message;
        return;
    }

    chartStage.textContent = "Queued on Modal…";

    chartPollTimer = setInterval(async () => {
        try {
            const res = await fetch(`/charts/${jobId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const job = await res.json();

            if (job.progress) {
                const { stage, step, total } = job.progress;
                chartStage.textContent = `Stage: ${stage}`;
                if (total > 0) {
                    chartProgress.max = total;
                    chartProgress.value = step;
                    const pct = Math.round((step / total) * 100);
                    chartProgressText.textContent = `${step} / ${total}  (${pct}%)`;
                } else {
                    chartProgress.removeAttribute("value");
                    chartProgressText.textContent = "";
                }
            }

            if (job.status === "complete") {
                clearInterval(chartPollTimer); chartPollTimer = null;
                chartStage.textContent = "Done";
                chartProgress.value = chartProgress.max;
                chartResult.innerHTML = `<a href="${job.chartUrl}" download>Download notes.chart</a>`;
            } else if (job.status === "error") {
                clearInterval(chartPollTimer); chartPollTimer = null;
                chartStage.textContent = "Failed";
                chartResult.textContent = job.error || "unknown error";
            }
        } catch (err) {
            clearInterval(chartPollTimer); chartPollTimer = null;
            chartStage.textContent = "Polling failed";
            chartResult.textContent = err.message;
        }
    }, 1500);
});

// ── Boot ────────────────────────────────────────────────────────────────

updateAuthUI();
