import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  findActiveSessionByToken,
  setSessionCookie,
  touchSession,
} from "../lib/session";

export interface AuthenticatedUser {
  id: string;
  username: string;
  name: string;
  age: number;
  email: string | null;
  mobileNumber: string | null;
  mobileVerificationStatus: "not_started" | "pending" | "verified";
  accountStatus: "active" | "suspended" | "deactivated";
  createdAt: Date;
}

/**
 * Server-side session auth middleware. Validates the `sid` cookie against
 * `user_sessions`, extends the session's sliding expiration on success, and
 * attaches the authenticated user to `req.user`. Responds 401 otherwise.
 */
export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (!token || typeof token !== "string") {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  const session = await findActiveSessionByToken(token);

  if (!session) {
    clearSessionCookie(res);
    res.status(401).json({ message: "Session is invalid or has expired." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.userId))
    .limit(1);

  if (!user || user.accountStatus !== "active") {
    clearSessionCookie(res);
    res.status(401).json({ message: "Session is invalid or has expired." });
    return;
  }

  const expiresAt = await touchSession(session.id);
  setSessionCookie(res, token, expiresAt);

  req.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    age: user.age,
    email: user.email ?? null,
    mobileNumber: user.mobileNumber ?? null,
    mobileVerificationStatus: user.mobileVerificationStatus,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt,
  };

  next();
}
