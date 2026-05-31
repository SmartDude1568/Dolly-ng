/* Shared client helpers for the Dolly frontend.
   Exposes a global `Dolly` object used by every page. Classic script (no
   modules) so pages can drop it in with a plain <script> tag. */

(function () {
    const API = "/v1";
    const TOKEN_KEY = "dolly_token";
    const USER_KEY = "dolly_user";

    const getToken = () => localStorage.getItem(TOKEN_KEY);
    const getUser = () => localStorage.getItem(USER_KEY);

    function setSession(token, userId) {
        localStorage.setItem(TOKEN_KEY, token);
        if (userId) localStorage.setItem(USER_KEY, userId);
    }
    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    }

    // ── API wrapper ──────────────────────────────────────────────────────
    async function api(path, options = {}) {
        const headers = { ...(options.headers || {}) };
        const token = getToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
        if (options.body && !(options.body instanceof FormData)) {
            headers["Content-Type"] = "application/json";
        }

        const res = await fetch(API + path, { ...options, headers });

        if (res.status === 401) {
            // Session expired or invalid — bounce to auth.
            clearSession();
            if (!location.pathname.endsWith("auth.html")) {
                location.href = "auth.html";
            }
            throw new Error("Session expired. Please log in again.");
        }
        if (!res.ok) {
            const err = await res
                .json()
                .catch(() => ({ error: { message: res.statusText } }));
            throw new Error(err.error?.message || err.error || "Request failed");
        }
        if (res.status === 204) return null;
        return res.json();
    }

    // Authenticated binary download (Blob → save as file).
    async function download(url, fallbackName) {
        const token = getToken();
        const res = await fetch(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
        const blob = await res.blob();
        const cd = res.headers.get("Content-Disposition") || "";
        const match = cd.match(/filename="?([^"]+)"?/);
        const filename = match ? match[1] : fallbackName || "download";
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
        return filename;
    }

    // ── Toast ────────────────────────────────────────────────────────────
    let toastTimer = null;
    function toast(text, kind = "") {
        let el = document.getElementById("toast");
        if (!el) {
            el = document.createElement("div");
            el.id = "toast";
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.className = "show " + kind;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = kind; }, 3800);
    }

    // ── Route guards ─────────────────────────────────────────────────────
    function requireAuth() {
        if (!getToken()) { location.href = "auth.html"; return false; }
        return true;
    }
    function redirectIfAuthed() {
        if (getToken()) location.href = "dashboard.html";
    }

    // ── Formatting ───────────────────────────────────────────────────────
    function bytes(n) {
        if (n == null) return "—";
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    }
    function timeAgo(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        const s = Math.floor((Date.now() - d.getTime()) / 1000);
        if (s < 60) return "just now";
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
        return d.toLocaleDateString();
    }
    function esc(str) {
        return String(str ?? "").replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }

    window.Dolly = {
        api, download, toast,
        getToken, getUser, setSession, clearSession,
        requireAuth, redirectIfAuthed,
        bytes, timeAgo, esc,
    };
})();
