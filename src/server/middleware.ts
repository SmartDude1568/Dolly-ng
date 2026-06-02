/**
 * Auth middleware — validates bearer tokens against the Neon sessions table.
 */

import type { Request, Response, NextFunction } from "express";
import * as crypto from "node:crypto";
import { sql } from "./db.js";
import type { AuthContext } from "./types.js";

/** Hash a bearer token for sessions-table lookup (must match auth.ts). */
function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

/** Coerce a DB `expires_at` value (Date or string, across drivers) to a Date. */
function toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string);
}

/** Extend Express Request to carry the authenticated user context. */
declare global {
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

/**
 * Middleware that requires a valid `Authorization: Bearer <token>` header.
 * On success, populates `req.auth` with the session's {@link AuthContext}.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Missing or invalid auth token" },
        });
        return;
    }

    const token = header.slice(7);
    const tokenHash = hashToken(token);

    const rows = await sql`
        SELECT token, user_id, expires_at
        FROM sessions
        WHERE token = ${tokenHash}
    `;

    const session = rows[0];
    if (!session) {
        res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Missing or invalid auth token" },
        });
        return;
    }

    const expiresAt = toDate(session.expires_at);
    if (expiresAt < new Date()) {
        await sql`DELETE FROM sessions WHERE token = ${tokenHash}`;
        res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Token has expired" },
        });
        return;
    }

    req.auth = {
        user_id: session.user_id as string,
        token,
        expires_at: expiresAt.toISOString(),
    };
    next();
}
