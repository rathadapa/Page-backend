import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// One row per user: the unique constraint on `userId` is what enforces
// "one active session per user" — creating a new session for a user
// replaces (upserts) their existing row instead of adding another one,
// which is what makes logging in from a new device invalidate the
// previous session automatically.
export const userSessionsTable = pgTable("user_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  // Only a hash of the opaque session token is stored, never the raw
  // token — mirrors how passwords are stored, so a database read alone
  // can't be used to hijack a session.
  tokenHash: text("token_hash").notNull().unique(),
  // Sliding expiration: extended on every authenticated request while
  // the session is used, so it only lapses after inactivity.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserSessionSchema = createInsertSchema(userSessionsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertUserSession = z.infer<typeof insertUserSessionSchema>;
export type UserSession = typeof userSessionsTable.$inferSelect;
