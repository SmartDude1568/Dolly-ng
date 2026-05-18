/**
 * Auth middleware — validates bearer tokens against the Neon sessions table.
 */

import type { Request, Response, NextFunction } from "express";
import { sql } from "./db.js";
import type { AuthContext } from "./types.js";

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

    const rows = await sql`
        SELECT token, user_id, expires_at
        FROM sessions
        WHERE token = ${token}
    `;

    const session = rows[0];
    if (!session) {
        res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Missing or invalid auth token" },
        });
        return;
    }

    if (new Date(session.expires_at as string) < new Date()) {
        await sql`DELETE FROM sessions WHERE token = ${token}`;
        res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Token has expired" },
        });
        return;
    }

    req.auth = {
        user_id: session.user_id as string,
        token,
        expires_at: (session.expires_at as Date).toISOString(),
    };
    next();
}
