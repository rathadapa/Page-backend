import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import { eq } from "drizzle-orm";
import { db, userSessionsTable, type UserSession } from "@workspace/db";

export const SESSION_COOKIE_NAME = "sid";

// Sliding expiration window: 6 months of inactivity. Any authenticated
// request extends the session's expiry back out to this window (see
// `touchSession`), so it only lapses if the account goes unused.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 * 6;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  // 256 bits of entropy, URL-safe — cryptographically unguessable and
  // convenient to carry in a cookie.
  return randomBytes(32).toString("base64url");
}

export function newSessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

/**
 * Creates a new session for the given user, replacing any existing session
 * that user already has (enforced by the unique `userId` constraint on
 * `user_sessions`). This is what makes logging in from a new device
 * automatically invalidate a previous session.
 *
 * Returns the raw session token — only its hash is ever persisted.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = newSessionExpiry();

  await db
    .insert(userSessionsTable)
    .values({ userId, tokenHash, expiresAt })
    .onConflictDoUpdate({
      target: userSessionsTable.userId,
      set: { tokenHash, expiresAt },
    });

  return { token, expiresAt };
}

/**
 * Looks up a non-expired session by its raw token. Returns null if the
 * token doesn't match a session or the matching session has expired.
 */
export async function findActiveSessionByToken(token: string): Promise<UserSession | null> {
  const tokenHash = hashToken(token);

  const [session] = await db
    .select()
    .from(userSessionsTable)
    .where(eq(userSessionsTable.tokenHash, tokenHash))
    .limit(1);

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return session;
}

/** Extends a session's expiry (sliding expiration) and returns the new value. */
export async function touchSession(sessionId: string): Promise<Date> {
  const expiresAt = newSessionExpiry();

  await db
    .update(userSessionsTable)
    .set({ expiresAt })
    .where(eq(userSessionsTable.id, sessionId));

  return expiresAt;
}

/** Deletes the session matching the given raw token, if any. */
export async function deleteSessionByToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db.delete(userSessionsTable).where(eq(userSessionsTable.tokenHash, tokenHash));
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}
