/* Dashboard logic: upload songs, start conversions, browse the library. */

if (!Dolly.requireAuth()) { /* redirected */ }

const userId = Dolly.getUser();
if (userId) document.getElementById("nav-user").textContent = userId;

// In-memory mirrors of the two collections, kept fresh by refresh()/poll.
let files = [];
let conversions = [];
let view = "charts";
let pollTimer = null;

// ── Logout ─────────────────────────────────────────────────────────────
document.getElementById("logout").onclick = async () => {
    try { await Dolly.api("/auth/logout", { method: "POST" }); } catch {}
    Dolly.clearSession();
    location.href = "index.html";
};

// ── Dropzone ───────────────────────────────────────────────────────────
const dropzone = document.getElementById("dropzone");
const fileInput = dropzone.querySelector('input[type="file"]');
const fileName = document.getElementById("file-name");

fileInput.addEventListener("change", () => {
    fileName.textContent = fileInput.files[0]?.name ?? "";
});
["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        fileName.textContent = fileInput.files[0].name;
    }
});

// ── Upload ─────────────────────────────────────────────────────────────
const uploadForm = document.getElementById("upload-form");
uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!fileInput.files[0]) { Dolly.toast("Pick a file first", "error"); return; }
    const btn = document.getElementById("upload-btn");
    const form = new FormData(uploadForm);
    if (!form.get("name")) form.delete("name");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Uploading…';
    try {
        const r = await Dolly.api("/files/upload", { method: "POST", body: form });
        Dolly.toast(`Uploaded “${r.name}”`, "success");
        uploadForm.reset();
        fileName.textContent = "";
        await refreshFiles();
        // Pre-select the freshly uploaded song in the conversion form.
        document.getElementById("source-select").value = r.file_id;
    } catch (err) {
        Dolly.toast(err.message, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Upload song";
    }
});

// ── Start conversion ───────────────────────────────────────────────────
const conversionForm = document.getElementById("conversion-form");
conversionForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(conversionForm);
    const input_file_id = fd.get("input_file_id");
    if (!input_file_id) { Dolly.toast("Choose a source song", "error"); return; }
    const instruments = fd.getAll("instruments");
    if (instruments.length === 0) { Dolly.toast("Pick at least one instrument", "error"); return; }

    const btn = document.getElementById("convert-btn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Starting…';
    try {
        await Dolly.api("/conversions", {
            method: "POST",
            body: JSON.stringify({ input_file_id, instruments, difficulty: fd.get("difficulty") }),
        });
        Dolly.toast("Chart generation started 🎸", "success");
        view = "charts";
        syncSegmented();
        await refreshConversions();
    } catch (err) {
        Dolly.toast(err.message, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Generate chart";
    }
});

// ── Segmented control ──────────────────────────────────────────────────
const segmented = document.getElementById("segmented");
segmented.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    view = b.dataset.view;
    syncSegmented();
    render();
});
function syncSegmented() {
    segmented.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("active", b.dataset.view === view));
}

// ── Data loading ───────────────────────────────────────────────────────
async function refreshFiles() {
    const r = await Dolly.api("/files?per_page=100");
    files = r.files;
    populateSourceSelect();
    document.getElementById("count-songs").textContent = files.length;
    if (view === "songs") render();
}

async function refreshConversions() {
    const r = await Dolly.api("/conversions?per_page=100");
    conversions = r.conversions;
    document.getElementById("count-charts").textContent = conversions.length;
    if (view === "charts") render();
    managePolling();
}

function populateSourceSelect() {
    const sel = document.getElementById("source-select");
    const current = sel.value;
    if (files.length === 0) {
        sel.innerHTML = '<option value="">— upload a song first —</option>';
        return;
    }
    sel.innerHTML = '<option value="">— choose a song —</option>' +
        files.map((f) => `<option value="${f.file_id}">${Dolly.esc(f.name)}</option>`).join("");
    if (current && files.some((f) => f.file_id === current)) sel.value = current;
}

// Poll while any conversion is still running.
function managePolling() {
    const active = conversions.some((c) => c.status === "in_progress");
    if (active && !pollTimer) {
        pollTimer = setInterval(refreshConversions, 4000);
    } else if (!active && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

// ── Rendering ──────────────────────────────────────────────────────────
function render() {
    const el = document.getElementById("explorer");
    const items = view === "charts" ? conversions : files;

    if (items.length === 0) {
        el.innerHTML = view === "charts"
            ? `<div class="empty"><div class="big">🎼</div>No charts yet.<br>Upload a song and hit <strong>Generate chart</strong>.</div>`
            : `<div class="empty"><div class="big">🎵</div>No songs uploaded yet.</div>`;
        return;
    }

    el.innerHTML = (view === "charts" ? items.map(chartRow) : items.map(songRow)).join("");
    wireRowActions();
}

function songRow(f) {
    return `
        <div class="row">
            <div class="row-icon">🎵</div>
            <div class="row-main">
                <div class="name">${Dolly.esc(f.name)}</div>
                <div class="meta">${Dolly.bytes(f.size_bytes)} · ${Dolly.esc(f.mime_type)} · ${Dolly.timeAgo(f.created_at)}</div>
            </div>
            <div class="row-actions">
                <button class="btn btn-ghost btn-sm" data-dl-file="${f.file_id}" data-name="${Dolly.esc(f.name)}">Download</button>
                <button class="btn btn-ghost btn-sm" data-del-file="${f.file_id}">Delete</button>
            </div>
        </div>`;
}

function chartRow(c) {
    const src = files.find((f) => f.file_id === c.input_file_id);
    const title = src ? src.name : c.input_file_id;
    const chips = c.tasks.map((t) =>
        `<span class="chip ${t.status}">${t.type.replace(/_/g, " ")}</span>`).join("");
    const action = c.download_url
        ? `<button class="btn btn-primary btn-sm" data-dl-conv="${c.download_url}" data-id="${c.conversion_id}">Download .sng</button>`
        : c.status === "failed"
            ? ""
            : `<span class="muted mono" style="font-size:12px"><span class="spin"></span></span>`;
    return `
        <div class="row">
            <div class="row-icon chart">🎸</div>
            <div class="row-main">
                <div class="name">${Dolly.esc(title)}</div>
                <div class="meta">${c.conversion_id} · ${Dolly.timeAgo(c.created_at)}</div>
                <div class="task-chips">${chips}</div>
            </div>
            <div class="row-actions">
                <span class="pill ${c.status}">${c.status.replace(/_/g, " ")}</span>
                ${action}
            </div>
        </div>`;
}

function wireRowActions() {
    const el = document.getElementById("explorer");
    el.querySelectorAll("[data-dl-file]").forEach((b) => b.onclick = async () => {
        try {
            await Dolly.download(`/v1/files/${b.dataset.dlFile}/download`, b.dataset.name);
        } catch (err) { Dolly.toast(err.message, "error"); }
    });
    el.querySelectorAll("[data-del-file]").forEach((b) => b.onclick = async () => {
        if (!confirm("Delete this song? This cannot be undone.")) return;
        try {
            await Dolly.api(`/files/${b.dataset.delFile}`, { method: "DELETE" });
            Dolly.toast("Song deleted", "success");
            await refreshFiles();
        } catch (err) { Dolly.toast(err.message, "error"); }
    });
    el.querySelectorAll("[data-dl-conv]").forEach((b) => b.onclick = async () => {
        b.disabled = true;
        try {
            const name = await Dolly.download(b.dataset.dlConv, `${b.dataset.id}.sng`);
            Dolly.toast(`Downloaded ${name}`, "success");
        } catch (err) { Dolly.toast(err.message, "error"); }
        finally { b.disabled = false; }
    });
}

// ── Boot ───────────────────────────────────────────────────────────────
document.getElementById("refresh-all").onclick = () =>
    Promise.all([refreshFiles(), refreshConversions()]).catch(() => {});

syncSegmented();
Promise.all([refreshFiles(), refreshConversions()]).catch((err) =>
    Dolly.toast(err.message, "error"));
