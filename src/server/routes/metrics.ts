/**
 * GET /metrics — quality-metrics dashboard + JSON snapshot.
 *
 * Content-negotiated so the same URL serves a human and a machine:
 *   • A browser navigation (Accept: text/html) gets the styled dashboard page
 *     (public/metrics.html), which fetches the JSON below and renders it.
 *   • An API client (Accept: application/json, or ?format=json) gets the raw
 *     {@link MetricsSnapshot}.
 *
 * The metrics are operational telemetry (counts + durations, no user data), so
 * this route is intentionally unauthenticated and rate-limit-exempt, like
 * /health — it is mounted before those middlewares in app.ts.
 */

import { Router, type Request } from "express";
import * as path from "node:path";
import { metrics } from "../../metrics.js";

export const metricsRouter = Router();

function wantsJson(req: Request): boolean {
    if (req.query.format === "json") return true;
    // Prefer HTML when the client accepts it (browsers send both); only fall to
    // JSON when that's the better match or HTML wasn't requested at all.
    return req.accepts(["html", "json"]) === "json";
}

metricsRouter.get("/", (req, res) => {
    if (wantsJson(req)) {
        res.json(metrics.snapshot());
        return;
    }
    res.sendFile(path.resolve("public/metrics.html"));
});
