import { pgEnum, pgTable, text, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const depositStatusEnum = pgEnum("deposit_status", [
  "pending",
  "success",
  "failed",
]);

export const depositsTable = pgTable("deposits", {
  id: uuid("id").primaryKey().defaultRandom(),

  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "restrict" }),

  // Whole rupees. Allowed packages (₹50/100/200/500/1000/2000/5000) are
  // validated at the API layer; no DB CHECK here so the list can change
  // without a migration.
  amount: integer("amount").notNull(),

  // Play Coins to credit on success. 1 coin = ₹1 in the current design,
  // so this equals `amount` today. Stored explicitly so future promotions
  // (bonus coins, multipliers) can diverge from the rupee amount without a
  // schema change.
  coinsToCredit: integer("coins_to_credit").notNull(),

  status: depositStatusEnum("status").notNull().default("pending"),

  // UUID we generate and send to PayU as `txnid`. One-to-one with a deposit
  // row; used as the primary join key when an incoming webhook arrives so we
  // can look up the deposit without scanning on PayU-assigned fields.
  merchantOrderId: text("merchant_order_id").notNull().unique(),

  // PayU's own unique identifier for the completed payment, echoed back in
  // the webhook as `mihpayid`. NULL until the webhook is received.
  // UNIQUE at DB level: a second webhook carrying the same mihpayid is a
  // duplicate and is rejected / ignored by the unique constraint.
  mihpayId: text("mihpayid").unique(),

  // PayU's `txnid` echo from the webhook. Stored for reconciliation but not
  // used as the primary join key (merchantOrderId is authoritative).
  payuTxnId: text("payu_txn_id"),

  // Populated when status = 'failed' (sourced from PayU `field9` or a local
  // validation message). NULL for pending and success rows.
  failureReason: text("failure_reason"),

  // Set to the current timestamp when status transitions to 'success' or
  // 'failed'. Remains NULL while status is 'pending'.
  completedAt: timestamp("completed_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertDepositSchema = createInsertSchema(depositsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDeposit = z.infer<typeof insertDepositSchema>;
export type Deposit = typeof depositsTable.$inferSelect;
