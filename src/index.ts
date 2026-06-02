import "dotenv/config";
import { createApp } from "./server/app.js";
import { resumeInterruptedConversions } from "./server/resume.js";
import { hydrateMetrics, startMetricsPersistence, flushMetrics } from "./server/metrics-store.js";

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const app = createApp();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const server = app.listen(PORT, () => {
    console.log(`Dolly API listening on :${PORT}`);
    console.log(`  v1 endpoints: /v1/auth, /v1/files, /v1/tasks, /v1/conversions`);
    console.log(`  legacy:       /split, /jobs/:id`);
    console.log(`  metrics:      /metrics`);

    // Restore persisted quality metrics, then keep flushing them to the
    // database so the counts survive future restarts.
    hydrateMetrics()
        .then(() => startMetricsPersistence())
        .catch((err) => console.error("[startup] metrics hydrate failed:", err));

    // Re-launch any conversion that was interrupted by a previous shutdown.
    resumeInterruptedConversions().catch((err) => {
        console.error("[startup] resume sweep failed:", err);
    });
});

// On graceful shutdown, persist the final metrics state so the seconds since
// the last periodic flush aren't lost.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n[shutdown] ${signal} received — flushing metrics…`);
        flushMetrics()
            .catch(() => {})
            .finally(() => server.close(() => process.exit(0)));
    });
}
