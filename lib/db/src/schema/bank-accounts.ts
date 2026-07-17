import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Stores verified bank accounts that users have pre-registered for withdrawals.
 * A user may have multiple saved accounts; they choose one per withdrawal request.
 *
 * Soft delete is used rather than physical deletion because:
 *   1. withdrawals.bank_account_id has ON DELETE RESTRICT — physical deletion
 *      of a referenced account would be blocked by the DB anyway.
 *   2. Historical withdrawals must retain a link to the account used, even if
 *      the user later removes it from their profile.
 *
 * KYC readiness: `is_verified` / `verified_at` are stored now so that a future
 * KYC gate in `initiateWithdrawal` can enforce `isVerified === true` without any
 * schema migration. Currently, all accounts are created with `is_verified = false`
 * and withdrawals do not check this field.
 */
export const userBankAccountsTable = pgTable(
  "user_bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    accountHolderName: text("account_holder_name").notNull(),
    // Stored as plain text. Encryption at rest (application-level or TDE)
    // is a future infrastructure concern; the column name and type will not
    // need to change when that is added.
    bankAccountNumber: text("bank_account_number").notNull(),
    // Standard Indian IFSC: 4 letters + '0' + 6 alphanumeric.
    bankIfscCode: text("bank_ifsc_code").notNull(),
    // Optional: populated from user input. Useful for display; not used in
    // payout API calls (which use account number + IFSC).
    bankName: text("bank_name"),
    // ── KYC readiness fields ──────────────────────────────────────────────
    // Not enforced yet. Adding enforcement only requires a check inside
    // initiateWithdrawal — no schema migration needed.
    isVerified: boolean("is_verified").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // ── Soft delete ──────────────────────────────────────────────────────
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Primary query pattern: list all accounts for a user (WHERE user_id = $1
    // AND is_deleted = false ORDER BY created_at).
    index("user_bank_accounts_user_id_idx").on(table.userId),
    // DB-level IFSC format guard. Standard Indian IFSC: 4 uppercase letters,
    // literal '0', 6 uppercase alphanumeric characters.
    check(
      "user_bank_accounts_ifsc_format",
      sql`${table.bankIfscCode} ~ '^[A-Z]{4}0[A-Z0-9]{6}$'`,
    ),
    // Account number must not be blank (whitespace-only).
    check(
      "user_bank_accounts_account_number_not_empty",
      sql`length(trim(${table.bankAccountNumber})) > 0`,
    ),
    // Holder name must not be blank.
    check(
      "user_bank_accounts_holder_name_not_empty",
      sql`length(trim(${table.accountHolderName})) > 0`,
    ),
  ],
);

export const insertUserBankAccountSchema = createInsertSchema(userBankAccountsTable).omit({
  id: true,
  // KYC fields are set internally, never by the caller.
  isVerified: true,
  verifiedAt: true,
  // Soft-delete fields are managed internally.
  isDeleted: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserBankAccount = z.infer<typeof insertUserBankAccountSchema>;
export type UserBankAccount = typeof userBankAccountsTable.$inferSelect;
