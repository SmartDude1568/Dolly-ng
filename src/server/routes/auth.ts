import { Router } from "express";
import * as crypto from "node:crypto";
import { promisify } from "node:util";
import { sql } from "../db.js";

export const authRouter = Router();

// ── Password hashing (scrypt with per-user random salt) ─────────────────

const SCRYPT_KEYLEN = 64;
const scryptAsync = promisify(crypto.scrypt) as (
    password: crypto.BinaryLike,
    salt: crypto.BinaryLike,
    keylen: number,
) => Promise<Buffer>;
const DUMMY_PASSWORD_HASH =
    "42424242424242424242424242424242:41a134a2a7b6e0a74ac32b17f162958dd056992516e2ea50e38499a965328142fb5ffd995a5472d161670f5b7533e7f4c06419e0b018d7dd8a96e3439b3f8bf4";
const REGISTER_RESPONSE = {
    status: "ok",
    message: "If registration can be completed, the account is ready to use.",
};

/** Derive a `salt:hash` (both hex) string for a password using scrypt. */
async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
    return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Constant-time verification of a password against a stored `salt:hash`. */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(":");
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = await scryptAsync(password, salt, expected.length);
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/** Hash a session token before storing/looking it up (tokens are high-entropy). */
function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

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

    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const passwordHash = await hashPassword(password);

    try {
        await sql`
            INSERT INTO users (user_id, email, password_hash, display_name)
            VALUES (${userId}, ${email}, ${passwordHash}, ${display_name ?? null})
        `;
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }
    }

    res.status(201).json(REGISTER_RESPONSE);
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

    const rows = await sql`
        SELECT user_id, password_hash FROM users WHERE email = ${email}
    `;

    const user = rows[0];
    const storedHash = user ? (user.password_hash as string) : DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(password, storedHash);
    if (!user || !passwordMatches) {
        res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Invalid email or password" },
        });
        return;
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

    // Store only the hash of the token; the plaintext is returned to the client.
    await sql`
        INSERT INTO sessions (token, user_id, expires_at)
        VALUES (${hashToken(token)}, ${user.user_id}, ${expiresAt.toISOString()})
    `;

    res.json({
        token,
        expires_at: expiresAt.toISOString(),
        user_id: user.user_id,
    });
});

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const { code, constraint, message } = error as {
        code?: unknown;
        constraint?: unknown;
        message?: unknown;
    };
    return (
        code === "23505" ||
        constraint === "users_email_key" ||
        (typeof message === "string" && message.toLowerCase().includes("duplicate"))
    );
}

// ── POST /auth/logout ───────────────────────────────────────────────────

authRouter.post("/logout", async (req, res) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
        const token = header.slice(7);
        await sql`DELETE FROM sessions WHERE token = ${hashToken(token)}`;
    }
    res.status(204).end();
});
