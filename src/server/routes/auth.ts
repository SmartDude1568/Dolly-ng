import { Router } from "express";
import * as crypto from "node:crypto";
import { sql } from "../db.js";

export const authRouter = Router();

// ── POST /auth/register ─────────────────────────────────────────────────

authRouter.post("/register", async (req, res) => {
    const { email, password, display_name } = req.body as {
        email?: string;
        password?: string;
        display_name?: string;
    };

    if (!email || !password) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "email and password are required" },
        });
        return;
    }

    if (password.length < 8) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "Password must be at least 8 characters" },
        });
        return;
    }

    // Check for existing email
    const existing = await sql`SELECT 1 FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
        res.status(409).json({
            error: { code: "CONFLICT", message: "Email is already registered" },
        });
        return;
    }

    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const passwordHash = crypto.createHash("sha256").update(password).digest("hex");

    const rows = await sql`
        INSERT INTO users (user_id, email, password_hash, display_name)
        VALUES (${userId}, ${email}, ${passwordHash}, ${display_name ?? null})
        RETURNING user_id, email, created_at
    `;

    const user = rows[0]!;
    res.status(201).json({
        user_id: user.user_id,
        email: user.email,
        created_at: user.created_at,
    });
});

// ── POST /auth/login ────────────────────────────────────────────────────

authRouter.post("/login", async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "email and password are required" },
        });
        return;
    }

    const hash = crypto.createHash("sha256").update(password).digest("hex");

    const rows = await sql`
        SELECT user_id, password_hash FROM users WHERE email = ${email}
    `;

    const user = rows[0];
    if (!user || user.password_hash !== hash) {
        res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Invalid email or password" },
        });
        return;
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

    await sql`
        INSERT INTO sessions (token, user_id, expires_at)
        VALUES (${token}, ${user.user_id}, ${expiresAt.toISOString()})
    `;

    res.json({
        token,
        expires_at: expiresAt.toISOString(),
        user_id: user.user_id,
    });
});

// ── POST /auth/logout ───────────────────────────────────────────────────

authRouter.post("/logout", async (req, res) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
        const token = header.slice(7);
        await sql`DELETE FROM sessions WHERE token = ${token}`;
    }
    res.status(204).end();
});
