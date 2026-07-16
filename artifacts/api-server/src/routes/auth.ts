import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";
import { LoginBody, LoginResponse, SignupBody, SignupResponse } from "@workspace/api-zod";
import { hashPassword, verifyPassword, PASSWORD_ALGO } from "../lib/password";
import { createSession, deleteSessionByToken, clearSessionCookie, setSessionCookie, SESSION_COOKIE_NAME } from "../lib/session";
import { createWalletAccountsForUser } from "../lib/wallet";
import { requireSession } from "../middlewares/requireSession";

const router: IRouter = Router();

function toUserResponse(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    age: user.age,
    email: user.email ?? null,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt,
  };
}

router.post("/auth/signup", async (req, res): Promise<void> => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const { name, age, password } = parsed.data;
  // Usernames are case-insensitive: normalize to lowercase before checking
  // uniqueness and storing, so "Alice" and "alice" are the same account.
  const username = parsed.data.username.toLowerCase();

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existing) {
    res.status(409).json({ message: "Username is already taken." });
    return;
  }

  const passwordHash = await hashPassword(password);

  // Wrapped in a transaction so a user can never end up without both
  // wallet accounts (Play Coins, Winning Coins) — either both the user row
  // and its wallets are created together, or neither is.
  const user = await db.transaction(async (tx) => {
    const [createdUser] = await tx
      .insert(usersTable)
      .values({
        name,
        username,
        age,
        passwordHash,
        passwordAlgo: PASSWORD_ALGO,
      })
      .returning();

    if (!createdUser) {
      return undefined;
    }

    await createWalletAccountsForUser(tx, createdUser.id);

    return createdUser;
  });

  if (!user) {
    req.log.error("Failed to create user record after insert");
    res.status(500).json({ message: "Failed to create account." });
    return;
  }

  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(res, token, expiresAt);

  res.status(201).json(SignupResponse.parse(toUserResponse(user)));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const { password } = parsed.data;
  // Normalize the same way as signup so login is case-insensitive too.
  const username = parsed.data.username.toLowerCase();

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (!user) {
    res.status(401).json({ message: "Invalid username or password." });
    return;
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    res.status(401).json({ message: "Invalid username or password." });
    return;
  }

  if (user.accountStatus !== "active") {
    res.status(401).json({ message: "Invalid username or password." });
    return;
  }

  // Creating a new session replaces (upserts) any previous session this
  // user already had, so logging in from a new device invalidates the old
  // one automatically.
  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(res, token, expiresAt);

  res.status(200).json(LoginResponse.parse(toUserResponse(user)));
});

router.post("/auth/logout", requireSession, async (req, res): Promise<void> => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (typeof token === "string") {
    await deleteSessionByToken(token);
  }

  clearSessionCookie(res);
  res.status(204).end();
});

export default router;
