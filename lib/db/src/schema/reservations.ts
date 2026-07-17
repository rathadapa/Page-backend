import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { walletAccountsTable } from "./wallets";

// Lifecycle of a reservation. Once confirmed or released, the status is final.
export const reservationStatusEnum = pgEnum("reservation_status", [
  "active",
  "confirmed",
  "released",
]);

// Why a reservation was created. Adding a new hold type is purely additive —
// no schema migration needed beyond extending this enum.
export const reservationReasonTypeEnum = pgEnum("reservation_reason_type", [
  "withdrawal",
  "tournament_entry",
  "admin_hold",
  "fraud_hold",
  "bonus_hold",
]);

// Tracks every active or historical balance hold. One row = one hold of
// `amount` coins against a specific wallet account. The hold is "live"
// while status = 'active'; it is settled (balance debited) when confirmed,
// or simply released (balance restored) when cancelled.
//
// This table is the source of truth for why reserved_balance on
// wallet_accounts has a given value at any point in time.
export const walletReservationsTable = pgTable(
  "wallet_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAccountId: uuid("wallet_account_id")
      .notNull()
      .references(() => walletAccountsTable.id, { onDelete: "restrict" }),
    // Positive whole-coin amount held. Matches the eventual debit on confirm.
    amount: bigint("amount", { mode: "number" }).notNull(),
    status: reservationStatusEnum("status").notNull().default("active"),
    // The module that created this hold (withdrawal, tournament, admin, etc.)
    reasonType: reservationReasonTypeEnum("reason_type").notNull(),
    // ID of the owning entity in the originating module (e.g. withdrawal ID).
    // Nullable because some hold types (admin_hold, fraud_hold) may not have
    // a corresponding row in another table at creation time.
    reasonId: uuid("reason_id"),
    // Client-supplied key that makes reservation creation idempotent.
    // A retried "create reservation" with the same key returns the existing
    // row without double-incrementing reserved_balance.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Reservations of zero or negative amounts make no sense.
    check("wallet_reservations_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const insertWalletReservationSchema = createInsertSchema(
  walletReservationsTable,
).omit({
  id: true,
  status: true,
  confirmedAt: true,
  releasedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWalletReservation = z.infer<typeof insertWalletReservationSchema>;
export type WalletReservation = typeof walletReservationsTable.$inferSelect;
