/* Tempo verification modal + metronome.

   Plays an uploaded song with a click track locked to a BPM so the user can
   confirm (or correct) the detected tempo before charting. The confirmed value
   is saved back to the file via PATCH /files/:id.

   Exposes Dolly.openTempo({ fileId, name, bpm, source, onSaved }):
     - source: a Blob/File (just-uploaded) or a URL string (existing song).
     - bpm:    seed tempo (may be null → defaults to 120).
     - onSaved(newBpm): called after a successful save.

   The scheduler re-anchors the AudioContext clock to the <audio> element's
   currentTime on every tick, so clicks track the song without long-term drift. */

(function () {
    const BEATS_PER_BAR = 4;
    const LOOKAHEAD_MS = 25;
    const SCHEDULE_AHEAD_SEC = 0.15;

    class Metronome {
        constructor(audioEl, onBeat) {
            this.audio = audioEl;
            this.onBeat = onBeat; // (beatInBar) => void
            this.ctx = null;
            this.bpm = 120;
            this.timer = null;
            this.lastBeat = -1;
        }

        get spb() {
            return 60 / this.bpm;
        }

        setBpm(bpm) {
            this.bpm = bpm;
            // Beat indices are tempo-relative; force a recompute next tick.
            this.lastBeat = -1;
        }

        async start() {
            if (!this.ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                this.ctx = new AC();
            }
            if (this.ctx.state === "suspended") await this.ctx.resume();
            this.lastBeat = -1;
            if (!this.timer) {
                this.timer = setInterval(() => this._tick(), LOOKAHEAD_MS);
            }
        }

        stop() {
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
        }

        async close() {
            this.stop();
            if (this.ctx) {
                try { await this.ctx.close(); } catch {}
                this.ctx = null;
            }
        }

        _tick() {
            if (!this.ctx || this.audio.paused) return;
            const spb = this.spb;
            const curAudio = this.audio.currentTime;
            const curCtx = this.ctx.currentTime;

            // First unplayed beat at or after the current position.
            let beat = Math.max(this.lastBeat + 1, Math.ceil(curAudio / spb - 1e-6));
            while (beat * spb <= curAudio + SCHEDULE_AHEAD_SEC) {
                const beatCtx = curCtx + (beat * spb - curAudio);
                if (beatCtx >= curCtx) {
                    this._click(beatCtx, beat % BEATS_PER_BAR === 0);
                    const delayMs = Math.max(0, (beatCtx - curCtx) * 1000);
                    const beatInBar = ((beat % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
                    setTimeout(() => this.onBeat(beatInBar), delayMs);
                }
                this.lastBeat = beat;
                beat++;
            }
        }

        _click(when, accent) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.frequency.value = accent ? 1600 : 1000;
            const peak = accent ? 0.6 : 0.35;
            gain.gain.setValueAtTime(0.0001, when);
            gain.gain.exponentialRampToValueAtTime(peak, when + 0.001);
            gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
            osc.connect(gain).connect(this.ctx.destination);
            osc.start(when);
            osc.stop(when + 0.06);
        }
    }

    // ── Tap tempo: average inter-tap interval over a short rolling window ────
    function makeTapTempo() {
        let taps = [];
        return function tap() {
            const now = performance.now();
            // Reset if the user paused for >2s between taps.
            if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
            taps.push(now);
            if (taps.length > 6) taps.shift();
            if (taps.length < 2) return null;
            const intervals = [];
            for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
            const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            return Math.round((60000 / avg) * 10) / 10;
        };
    }

    function clampBpm(v) {
        if (!Number.isFinite(v)) return null;
        return Math.min(400, Math.max(20, v));
    }

    // <audio> refuses a blob whose type is empty or application/octet-stream
    // (common for uploads) with "no supported sources", even when the bytes are
    // a valid MP3/WAV. Re-wrap the blob with an audio MIME type guessed from the
    // filename so the browser will attempt to decode it.
    const EXT_MIME = {
        mp3: "audio/mpeg", wav: "audio/wav", wave: "audio/wav",
        flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg",
        opus: "audio/ogg", m4a: "audio/mp4", mp4: "audio/mp4",
        aac: "audio/aac", weba: "audio/webm", webm: "audio/webm",
    };
    function ensureAudioType(blob, name) {
        const t = (blob.type || "").toLowerCase();
        if (t.startsWith("audio/") || t.startsWith("video/")) return blob;
        const ext = (name || "").toLowerCase().split(".").pop();
        const type = EXT_MIME[ext] || "audio/mpeg";
        return new Blob([blob], { type });
    }

    // ── Modal ───────────────────────────────────────────────────────────────
    function openTempo({ fileId, name, bpm, source, onSaved }) {
        let objectUrl = null;
        const revokeNeeded = typeof source !== "string";
        if (typeof source === "string") {
            objectUrl = source; // remote URL; nothing to revoke
        } else {
            objectUrl = URL.createObjectURL(ensureAudioType(source, name));
        }

        let current = clampBpm(Number(bpm)) || 120;

        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal metro" role="dialog" aria-modal="true">
                <button class="modal-close" title="Close">✕</button>
                <h2 class="metro-title">Verify tempo</h2>
                <p class="metro-sub">${Dolly.esc(name || "Song")}</p>

                <div class="metro-beats">
                    ${Array.from({ length: BEATS_PER_BAR }, (_, i) =>
                        `<span class="beat${i === 0 ? " accent" : ""}"></span>`).join("")}
                </div>

                <div class="metro-bpm">
                    <button class="btn btn-ghost metro-step" data-step="-1">−</button>
                    <div class="metro-readout">
                        <input type="number" class="metro-input" min="20" max="400" step="0.5" value="${current}">
                        <span class="metro-unit">BPM</span>
                    </div>
                    <button class="btn btn-ghost metro-step" data-step="1">+</button>
                </div>

                <div class="metro-transport">
                    <button class="btn btn-primary metro-play">▶ Play with click</button>
                    <button class="btn btn-ghost metro-tap">Tap tempo</button>
                </div>

                <p class="metro-hint">Play the song and listen — the click should land on the beat.
                   Nudge the BPM or tap along until it locks in.</p>

                <div class="modal-actions">
                    <button class="btn btn-ghost metro-cancel">Cancel</button>
                    <button class="btn btn-primary metro-save">Save tempo</button>
                </div>
                <audio class="metro-audio" preload="auto"></audio>
            </div>`;
        document.body.appendChild(overlay);

        const $ = (sel) => overlay.querySelector(sel);
        const audio = $(".metro-audio");
        audio.src = objectUrl;
        audio.load();
        audio.addEventListener("error", () => {
            // MEDIA_ERR_SRC_NOT_SUPPORTED (4) → the browser can't decode this
            // format (e.g. FLAC in Safari). Tell the user rather than failing mute.
            if (audio.error && audio.error.code === audio.error.MEDIA_ERR_SRC_NOT_SUPPORTED) {
                Dolly.toast("Your browser can't play this audio format — tempo can still be set manually.", "error");
            }
        });
        const beats = [...overlay.querySelectorAll(".beat")];
        const input = $(".metro-input");
        const playBtn = $(".metro-play");
        const tap = makeTapTempo();

        const metro = new Metronome(audio, (beatInBar) => {
            const el = beats[beatInBar];
            if (!el) return;
            el.classList.add("hit");
            setTimeout(() => el.classList.remove("hit"), 110);
        });
        metro.setBpm(current);

        function setBpm(v, fromInput) {
            const c = clampBpm(v);
            if (!c) return;
            current = c;
            metro.setBpm(current);
            if (!fromInput) input.value = current;
        }

        // BPM controls
        input.addEventListener("input", () => {
            const v = Number(input.value);
            if (Number.isFinite(v)) setBpm(v, true);
        });
        overlay.querySelectorAll(".metro-step").forEach((b) =>
            b.addEventListener("click", () => setBpm(current + Number(b.dataset.step), false)));
        $(".metro-tap").addEventListener("click", () => {
            const v = tap();
            if (v) setBpm(v, false);
        });

        // Transport
        async function play() {
            try {
                await metro.start();
                await audio.play();
                playBtn.innerHTML = "❚❚ Pause";
            } catch (err) {
                Dolly.toast("Could not play audio: " + err.message, "error");
            }
        }
        function pause() {
            audio.pause();
            metro.stop();
            playBtn.innerHTML = "▶ Play with click";
        }
        playBtn.addEventListener("click", () => (audio.paused ? play() : pause()));
        audio.addEventListener("ended", () => {
            metro.stop();
            playBtn.innerHTML = "▶ Play with click";
        });

        // Lifecycle
        function close() {
            metro.close();
            audio.pause();
            audio.src = "";
            if (revokeNeeded && objectUrl) URL.revokeObjectURL(objectUrl);
            document.removeEventListener("keydown", onKey);
            overlay.remove();
        }
        function onKey(e) {
            if (e.key === "Escape") close();
        }
        document.addEventListener("keydown", onKey);
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
        $(".modal-close").addEventListener("click", close);
        $(".metro-cancel").addEventListener("click", close);

        $(".metro-save").addEventListener("click", async () => {
            const btn = $(".metro-save");
            btn.disabled = true;
            const prev = btn.textContent;
            btn.innerHTML = '<span class="spin"></span> Saving…';
            try {
                const r = await Dolly.api(`/files/${fileId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ bpm: current }),
                });
                Dolly.toast(`Saved tempo: ${r.bpm} BPM`, "success");
                if (typeof onSaved === "function") onSaved(r.bpm);
                close();
            } catch (err) {
                Dolly.toast(err.message, "error");
                btn.disabled = false;
                btn.textContent = prev;
            }
        });
    }

    window.Dolly = window.Dolly || {};
    window.Dolly.openTempo = openTempo;
})();
