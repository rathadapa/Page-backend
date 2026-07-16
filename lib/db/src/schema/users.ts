import { pgEnum, pgTable, text, integer, timestamp, uuid, smallint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mobileVerificationStatusEnum = pgEnum("mobile_verification_status", [
  "not_started",
  "pending",
  "verified",
]);

export const accountStatusEnum = pgEnum("account_status", [
  "active",
  "suspended",
  "deactivated",
]);

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  age: integer("age").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordAlgo: text("password_algo").notNull(),
  // Collected during the first deposit flow, not at signup.
  // Nullable for all existing and new users until they initiate a deposit.
  // Unique when present: two accounts may not share the same email address.
  email: text("email").unique(),
  mobileNumber: text("mobile_number").unique(),
  mobileVerifiedAt: timestamp("mobile_verified_at", { withTimezone: true }),
  mobileVerificationStatus: mobileVerificationStatusEnum("mobile_verification_status")
    .notNull()
    .default("not_started"),
  accountStatus: accountStatusEnum("account_status").notNull().default("active"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  failedLoginAttempts: smallint("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
