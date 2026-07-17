import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Exactly two coin types exist, per product decision — no deposit, bonus,
// or promotional wallets. Play Coins are spendable (funded by deposits,
// used for entry fees); Winning Coins are earned from match/tournament
// winnings and are the only balance that can ever be withdrawn.
export const walletCoinTypeEnum = pgEnum("wallet_coin_type", ["play_coins", "winning_coins"]);

export const walletAccountsTable = pgTable(
  "wallet_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    walletType: walletCoinTypeEnum("wallet_type").notNull(),
    // Whole coins only (1 coin = ₹1, no fractional coins, no paise). This
    // is a denormalized cache of the wallet_transactions ledger sum, kept
    // in sync inside the same DB transaction as each ledger insert.
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    // Amount locked by active reservations (pending withdrawals, tournament
    // entries, admin/fraud holds). available_balance = balance - reserved_balance.
    // Managed only through the reservation service; never updated directly.
    reservedBalance: bigint("reserved_balance", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Exactly one wallet of each type per user.
    unique("wallet_accounts_user_id_wallet_type_unique").on(table.userId, table.walletType),
    // Hard DB-level backstop: negative balances must never be possible.
    check("wallet_accounts_balance_non_negative", sql`${table.balance} >= 0`),
    // reserved_balance must never go negative.
    check("wallet_accounts_reserved_balance_non_negative", sql`${table.reservedBalance} >= 0`),
    // Settled balance must always cover the reserved portion.
    // IMPORTANT: during reservation confirmation, reserved_balance MUST be
    // decremented before balance is decremented, because PostgreSQL evaluates
    // CHECK constraints at statement level (not transaction commit). Reversing
    // the order causes a mid-transaction constraint violation when multiple
    // active reservations exist.
    check("wallet_accounts_balance_gte_reserved", sql`${table.balance} >= ${table.reservedBalance}`),
  ],
);

export const insertWalletAccountSchema = createInsertSchema(walletAccountsTable).omit({
  id: true,
  balance: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWalletAccount = z.infer<typeof insertWalletAccountSchema>;
export type WalletAccount = typeof walletAccountsTable.$inferSelect;

// Append-only ledger. Every row is immutable once written — there is no
// status field, because the Wallet module only records completed balance
// changes. Pending/failed/retry states for deposits, payouts, or
// tournament settlement belong to the modules that own those workflows;
// they call into Wallet only once a change is final.
export const walletTransactionsTable = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAccountId: uuid("wallet_account_id")
      .notNull()
      .references(() => walletAccountsTable.id, { onDelete: "restrict" }),
    // Signed whole-coin amount: positive = credit, negative = debit.
    amount: bigint("amount", { mode: "number" }).notNull(),
    // Snapshot of the resulting balance, for cheap audits without having
    // to replay the ledger.
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    // Free text, intentionally not an enum: the reason/source for a
    // balance change is owned by whichever module recorded it (Payments,
    // Tournament, a same-user conversion, etc.), not by the Wallet module.
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    // Lets a caller safely retry "record this completed change" without
    // double-crediting/debiting (e.g. a webhook redelivery).
    idempotencyKey: text("idempotency_key").notNull().unique(),
    // Links a correcting entry back to the transaction it reverses. Still
    // just another completed transaction, not a status change.
    reversalOfTransactionId: uuid("reversal_of_transaction_id").references(
      (): AnyPgColumn => walletTransactionsTable.id,
    ),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("wallet_transactions_amount_not_zero", sql`${table.amount} <> 0`),
    // Supports getWalletTransactions pagination (WHERE wallet_account_id = $1
    // ORDER BY created_at DESC LIMIT $2) without a full table scan.
    // Also covers the FK integrity check PostgreSQL performs on every
    // INSERT/UPDATE/DELETE against this table.
    index("wallet_transactions_account_created_idx").on(
      table.walletAccountId,
      table.createdAt,
    ),
  ],
);

export const insertWalletTransactionSchema = createInsertSchema(walletTransactionsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertWalletTransaction = z.infer<typeof insertWalletTransactionSchema>;
export type WalletTransaction = typeof walletTransactionsTable.$inferSelect;
