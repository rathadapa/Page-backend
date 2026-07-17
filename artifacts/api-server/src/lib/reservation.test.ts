import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  walletAccountsTable,
  walletTransactionsTable,
  walletReservationsTable,
} from "@workspace/db";
import { hashPassword, PASSWORD_ALGO } from "./password";
import {
  createWalletAccountsForUser,
  recordCompletedTransaction,
  convertWinningToPlay,
  InsufficientBalanceError,
  InsufficientAvailableBalanceError,
} from "./wallet";
import {
  createReservation,
  confirmReservation,
  releaseReservation,
  getReservation,
} from "./reservation";

// ── Test fixtures ──────────────────────────────────────────────────────────────

const prefix = `tres${Date.now()}`;

let userId = "";
let winningAccountId = "";
let playAccountId = "";
let walletAccountIds: string[] = [];

// Seeded balance at the start of all tests (credited once in beforeAll).
const INITIAL_WINNING_BALANCE = 2000;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");

  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-u`,
      name: "Reservation Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}@test.example`,
      mobileNumber: `+91900${prefix.slice(-7)}`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  userId = user!.id;

  const accounts = await createWalletAccountsForUser(db, userId);
  walletAccountIds = accounts.map((a) => a.id);

  const winning = accounts.find((a) => a.walletType === "winning_coins")!;
  const play = accounts.find((a) => a.walletType === "play_coins")!;
  winningAccountId = winning.id;
  playAccountId = play.id;

  // Seed initial Winning Coins balance.
  await db.transaction(async (tx) => {
    await recordCompletedTransaction(tx, {
      walletAccountId: winningAccountId,
      amount: INITIAL_WINNING_BALANCE,
      idempotencyKey: `${prefix}:seed`,
      referenceType: "test_seed",
      description: "Initial test balance",
    });
  });
});

afterAll(async () => {
  if (!userId) return;

  // Delete in FK-safe order.
  // wallet_reservations references wallet_transactions (confirmed_by_transaction_id)
  // so reservations must be deleted before transactions.
  await db
    .delete(walletReservationsTable)
    .where(inArray(walletReservationsTable.walletAccountId, walletAccountIds));
  await db
    .delete(walletTransactionsTable)
    .where(inArray(walletTransactionsTable.walletAccountId, walletAccountIds));
  await db
    .delete(walletAccountsTable)
    .where(inArray(walletAccountsTable.id, walletAccountIds));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

// ── Helper: read wallet account fresh from DB ────────────────────────────────

async function getAccount(accountId: string) {
  const [account] = await db
    .select()
    .from(walletAccountsTable)
    .where(eq(walletAccountsTable.id, accountId));
  return account!;
}

// ── createReservation ─────────────────────────────────────────────────────────

describe("createReservation", () => {
  it("creates an active reservation and increments reserved_balance", async () => {
    const before = await getAccount(winningAccountId);

    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 100,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:create:basic`,
      });
    });

    expect(reservation.status).toBe("active");
    expect(reservation.walletAccountId).toBe(winningAccountId);
    expect(reservation.amount).toBe(100);
    expect(reservation.reasonType).toBe("withdrawal");

    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(before.reservedBalance + 100);
    expect(after.balance).toBe(before.balance); // settled balance unchanged

    // Cleanup
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("is idempotent: same idempotencyKey returns existing reservation without double-incrementing", async () => {
    const key = `${prefix}:create:idempotent`;

    const first = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 50,
        reasonType: "tournament_entry",
        idempotencyKey: key,
      });
    });

    const beforeRetry = await getAccount(winningAccountId);

    const second = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 50,
        reasonType: "tournament_entry",
        idempotencyKey: key,
      });
    });

    // Must be the same reservation row.
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");

    // reserved_balance must not have changed (no double-increment).
    const afterRetry = await getAccount(winningAccountId);
    expect(afterRetry.reservedBalance).toBe(beforeRetry.reservedBalance);

    // Cleanup
    await db.transaction(async (tx) => {
      await releaseReservation(tx, first.id);
    });
  });

  it("throws InsufficientAvailableBalanceError when amount exceeds available balance", async () => {
    // Reserve almost all available balance first.
    const account = await getAccount(winningAccountId);
    const available = account.balance - account.reservedBalance;

    await expect(
      db.transaction(async (tx) => {
        return createReservation(tx, {
          walletAccountId: winningAccountId,
          amount: available + 1, // one coin more than available
          reasonType: "withdrawal",
          idempotencyKey: `${prefix}:create:exceed`,
        });
      }),
    ).rejects.toThrow(InsufficientAvailableBalanceError);

    // reserved_balance must be unchanged.
    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(account.reservedBalance);
  });

  it("allows reserving exactly the full available balance", async () => {
    const account = await getAccount(winningAccountId);
    const available = account.balance - account.reservedBalance;

    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: available,
        reasonType: "admin_hold",
        idempotencyKey: `${prefix}:create:exact`,
      });
    });

    expect(reservation.status).toBe("active");
    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(account.reservedBalance + available);
    // available_balance is now 0
    expect(after.balance - after.reservedBalance).toBe(0);

    // Cleanup
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("accumulates multiple concurrent active reservations on the same account", async () => {
    const before = await getAccount(winningAccountId);

    const r1 = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 100,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:create:multi:1`,
      });
    });

    const r2 = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 200,
        reasonType: "tournament_entry",
        idempotencyKey: `${prefix}:create:multi:2`,
      });
    });

    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(before.reservedBalance + 100 + 200);
    expect(after.balance - after.reservedBalance).toBe(before.balance - before.reservedBalance - 300);

    // Cleanup both
    await db.transaction(async (tx) => {
      await releaseReservation(tx, r1.id);
    });
    await db.transaction(async (tx) => {
      await releaseReservation(tx, r2.id);
    });
  });

  it("stores reasonId when provided", async () => {
    const reasonId = "00000000-0000-0000-0000-000000000042";
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 10,
        reasonType: "withdrawal",
        reasonId,
        idempotencyKey: `${prefix}:create:reasonid`,
      });
    });

    expect(reservation.reasonId).toBe(reasonId);

    // Cleanup
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });
});

// ── releaseReservation ────────────────────────────────────────────────────────

describe("releaseReservation", () => {
  it("releases an active reservation and decrements reserved_balance", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 150,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:release:basic`,
      });
    });

    const before = await getAccount(winningAccountId);

    const released = await db.transaction(async (tx) => {
      return releaseReservation(tx, reservation.id);
    });

    expect(released.status).toBe("released");
    expect(released.releasedAt).not.toBeNull();

    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(before.reservedBalance - 150);
    expect(after.balance).toBe(before.balance); // no ledger change
  });

  it("is idempotent: re-releasing an already-released reservation is a no-op", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 75,
        reasonType: "fraud_hold",
        idempotencyKey: `${prefix}:release:idempotent`,
      });
    });

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });

    const beforeRetry = await getAccount(winningAccountId);

    // Second release — should be a no-op.
    const released2 = await db.transaction(async (tx) => {
      return releaseReservation(tx, reservation.id);
    });

    expect(released2.status).toBe("released");

    const afterRetry = await getAccount(winningAccountId);
    // reserved_balance must not have changed (no double-decrement).
    expect(afterRetry.reservedBalance).toBe(beforeRetry.reservedBalance);
  });

  it("throws when trying to release an already-confirmed reservation", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 50,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:release:confirmed`,
      });
    });

    // Confirm it first.
    await db.transaction(async (tx) => {
      await confirmReservation(tx, {
        reservationId: reservation.id,
        transactionIdempotencyKey: `${prefix}:release:confirmed:tx`,
        description: "Test confirm before release attempt",
      });
    });

    // Now trying to release should throw.
    await expect(
      db.transaction(async (tx) => {
        return releaseReservation(tx, reservation.id);
      }),
    ).rejects.toThrow(/already been confirmed/i);
  });

  it("available balance increases after a reservation is released", async () => {
    const before = await getAccount(winningAccountId);

    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 200,
        reasonType: "bonus_hold",
        idempotencyKey: `${prefix}:release:avail`,
      });
    });

    const afterCreate = await getAccount(winningAccountId);
    expect(afterCreate.balance - afterCreate.reservedBalance).toBe(
      before.balance - before.reservedBalance - 200,
    );

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });

    const afterRelease = await getAccount(winningAccountId);
    expect(afterRelease.balance - afterRelease.reservedBalance).toBe(
      before.balance - before.reservedBalance,
    );
    expect(afterRelease.balance).toBe(before.balance); // ledger balance unchanged
  });
});

// ── confirmReservation ────────────────────────────────────────────────────────

describe("confirmReservation", () => {
  it("debits balance, decrements reserved_balance, and marks reservation confirmed", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 300,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:confirm:basic`,
      });
    });

    const before = await getAccount(winningAccountId);

    const { reservation: confirmed, transaction: tx } = await db.transaction(async (dbTx) => {
      return confirmReservation(dbTx, {
        reservationId: reservation.id,
        transactionIdempotencyKey: `${prefix}:confirm:basic:tx`,
        referenceType: "withdrawal",
        description: "Withdrawal confirmed",
      });
    });

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).not.toBeNull();

    // Ledger entry must reflect the debit.
    expect(tx.amount).toBe(-300);
    expect(tx.referenceType).toBe("withdrawal");

    const after = await getAccount(winningAccountId);
    // Balance reduced by the reservation amount.
    expect(after.balance).toBe(before.balance - 300);
    // reserved_balance also reduced (reservation no longer active).
    expect(after.reservedBalance).toBe(before.reservedBalance - 300);
    // available_balance stays the same as before (balance and reserved both -300).
    expect(after.balance - after.reservedBalance).toBe(before.balance - before.reservedBalance);
  });

  it("handles multiple active reservations without a CHECK constraint violation (operation order)", async () => {
    // Create two reservations so reserved_balance = amount_A + amount_B.
    // Confirming one must not violate balance >= reserved_balance at any
    // intermediate statement.
    const rA = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 120,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:confirm:multi:A`,
      });
    });

    const rB = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 80,
        reasonType: "tournament_entry",
        idempotencyKey: `${prefix}:confirm:multi:B`,
      });
    });

    const before = await getAccount(winningAccountId);
    expect(before.reservedBalance).toBeGreaterThanOrEqual(200); // rA + rB

    // Confirm rA — must succeed without a constraint violation even though rB
    // is still active.
    const { reservation: confirmedA } = await db.transaction(async (dbTx) => {
      return confirmReservation(dbTx, {
        reservationId: rA.id,
        transactionIdempotencyKey: `${prefix}:confirm:multi:A:tx`,
        description: "Multi-confirm test A",
      });
    });

    expect(confirmedA.status).toBe("confirmed");

    const after = await getAccount(winningAccountId);
    // rA (120) debited from balance; rA reservation no longer in reserved.
    // rB (80) still active in reserved.
    expect(after.balance).toBe(before.balance - 120);
    expect(after.reservedBalance).toBe(before.reservedBalance - 120); // only rA released from reserved

    // Cleanup rB.
    await db.transaction(async (tx) => {
      await releaseReservation(tx, rB.id);
    });
  });

  it("is idempotent: re-confirming with the same transactionIdempotencyKey returns existing data", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 50,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:confirm:idempotent`,
      });
    });

    // First confirmation.
    const { transaction: tx1 } = await db.transaction(async (dbTx) => {
      return confirmReservation(dbTx, {
        reservationId: reservation.id,
        transactionIdempotencyKey: `${prefix}:confirm:idempotent:tx`,
        description: "Idempotent test",
      });
    });

    const before = await getAccount(winningAccountId);

    // Second confirmation — must return the same ledger entry without double-debiting.
    const { transaction: tx2 } = await db.transaction(async (dbTx) => {
      return confirmReservation(dbTx, {
        reservationId: reservation.id,
        transactionIdempotencyKey: `${prefix}:confirm:idempotent:tx`,
        description: "Idempotent test",
      });
    });

    expect(tx2.id).toBe(tx1.id);

    const after = await getAccount(winningAccountId);
    // No balance change on the second call.
    expect(after.balance).toBe(before.balance);
    expect(after.reservedBalance).toBe(before.reservedBalance);
  });

  it("throws when trying to confirm a released reservation", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 40,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:confirm:released`,
      });
    });

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });

    await expect(
      db.transaction(async (dbTx) => {
        return confirmReservation(dbTx, {
          reservationId: reservation.id,
          transactionIdempotencyKey: `${prefix}:confirm:released:tx`,
        });
      }),
    ).rejects.toThrow(/released.*cannot be confirmed/i);
  });

  it("throws when reservation does not exist", async () => {
    await expect(
      db.transaction(async (dbTx) => {
        return confirmReservation(dbTx, {
          reservationId: "00000000-0000-0000-0000-000000000000",
          transactionIdempotencyKey: `${prefix}:confirm:notexist:tx`,
        });
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});

// ── available balance and conversion ──────────────────────────────────────────

describe("available balance and conversion", () => {
  it("conversion is blocked by reserved funds (InsufficientAvailableBalanceError)", async () => {
    const account = await getAccount(winningAccountId);
    const available = account.balance - account.reservedBalance;

    // Reserve all available coins.
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: available,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:avail:block`,
      });
    });

    // Any conversion must now fail — no available coins left.
    await expect(
      convertWinningToPlay(userId, 1, `${prefix}:avail:block:conv`),
    ).rejects.toThrow(InsufficientAvailableBalanceError);

    // Balance unchanged.
    const after = await getAccount(winningAccountId);
    expect(after.balance).toBe(account.balance);

    // Cleanup.
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("conversion succeeds for available (non-reserved) coins", async () => {
    const account = await getAccount(winningAccountId);
    const available = account.balance - account.reservedBalance;

    // Reserve half, convert the other half.
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: Math.floor(available / 2),
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:avail:partial`,
      });
    });

    const afterReserve = await getAccount(winningAccountId);
    const convertable = afterReserve.balance - afterReserve.reservedBalance;

    // Conversion for the non-reserved half must succeed.
    const result = await convertWinningToPlay(userId, convertable, `${prefix}:avail:partial:conv`);

    expect(result.winningCoins.balance).toBe(afterReserve.balance - convertable);
    expect(result.winningCoins.reserved).toBe(afterReserve.reservedBalance);
    expect(result.winningCoins.available).toBe(0);
    expect(result.playCoins.balance).toBeGreaterThan(0);

    // Cleanup reservation (balance already debited by conversion; reservation still active).
    // Note: the conversion debited balance down to = reserved amount, so
    // balance === reserved_balance now. Available = 0. Release it.
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("available = balance - reserved across multiple active reservations", async () => {
    const account = await getAccount(winningAccountId);
    const startAvailable = account.balance - account.reservedBalance;

    const r1 = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 30,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:avail:calc:1`,
      });
    });

    const r2 = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 70,
        reasonType: "tournament_entry",
        idempotencyKey: `${prefix}:avail:calc:2`,
      });
    });

    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(account.reservedBalance + 30 + 70);
    expect(after.balance - after.reservedBalance).toBe(startAvailable - 100);

    // Cleanup.
    await db.transaction(async (tx) => {
      await releaseReservation(tx, r1.id);
    });
    await db.transaction(async (tx) => {
      await releaseReservation(tx, r2.id);
    });
  });

  it("conversion result correctly reflects reserved and available amounts", async () => {
    const account = await getAccount(winningAccountId);
    const available = account.balance - account.reservedBalance;

    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 50,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:avail:conv:meta`,
      });
    });

    const afterReserve = await getAccount(winningAccountId);

    // Convert 10 coins (available - 50 reserved).
    const result = await convertWinningToPlay(userId, 10, `${prefix}:avail:conv:meta:conv`);

    expect(result.winningCoins.balance).toBe(afterReserve.balance - 10);
    expect(result.winningCoins.reserved).toBe(50);
    expect(result.winningCoins.available).toBe(afterReserve.balance - 10 - 50);
    expect(result.playCoins.reserved).toBe(0); // play coins never have reservations

    // Cleanup.
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });
});

// ── rollback behaviour ────────────────────────────────────────────────────────

describe("rollback behaviour", () => {
  it("reservation creation rolls back completely if the outer transaction aborts", async () => {
    const before = await getAccount(winningAccountId);

    await expect(
      db.transaction(async (tx) => {
        await createReservation(tx, {
          walletAccountId: winningAccountId,
          amount: 100,
          reasonType: "withdrawal",
          idempotencyKey: `${prefix}:rollback:create`,
        });
        // Force the outer transaction to abort.
        throw new Error("Simulated outer transaction failure");
      }),
    ).rejects.toThrow("Simulated outer transaction failure");

    const after = await getAccount(winningAccountId);
    // reserved_balance must be unchanged — the increment was rolled back.
    expect(after.reservedBalance).toBe(before.reservedBalance);
    expect(after.balance).toBe(before.balance);

    // No reservation row must exist.
    const rows = await db
      .select()
      .from(walletReservationsTable)
      .where(eq(walletReservationsTable.idempotencyKey, `${prefix}:rollback:create`));
    expect(rows).toHaveLength(0);
  });

  it("reservation confirmation rolls back if the outer transaction aborts after confirmation", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 60,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:rollback:confirm:res`,
      });
    });

    const before = await getAccount(winningAccountId);

    await expect(
      db.transaction(async (dbTx) => {
        await confirmReservation(dbTx, {
          reservationId: reservation.id,
          transactionIdempotencyKey: `${prefix}:rollback:confirm:tx`,
          description: "Should be rolled back",
        });
        // Force abort after the confirmation operations are done.
        throw new Error("Simulated failure after confirmation");
      }),
    ).rejects.toThrow("Simulated failure after confirmation");

    const after = await getAccount(winningAccountId);
    // Everything rolled back: balance and reserved_balance unchanged.
    expect(after.balance).toBe(before.balance);
    expect(after.reservedBalance).toBe(before.reservedBalance);

    // Reservation must still be 'active' — the status update was rolled back.
    const row = await getReservation(reservation.id);
    expect(row!.status).toBe("active");

    // No ledger entry must exist.
    const txRows = await db
      .select()
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.idempotencyKey, `${prefix}:rollback:confirm:tx`));
    expect(txRows).toHaveLength(0);

    // Cleanup the reservation (it's still active).
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });
});

// ── getReservation ────────────────────────────────────────────────────────────

describe("getReservation", () => {
  it("returns null for a non-existent reservation ID", async () => {
    const result = await getReservation("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("returns the reservation by ID", async () => {
    const created = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 25,
        reasonType: "admin_hold",
        idempotencyKey: `${prefix}:get:basic`,
      });
    });

    const fetched = await getReservation(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.amount).toBe(25);

    // Cleanup
    await db.transaction(async (tx) => {
      await releaseReservation(tx, created.id);
    });
  });
});

// ── CHECK constraint backstop ─────────────────────────────────────────────────

describe("CHECK constraint protection", () => {
  it("application-level check prevents over-reservation before the DB constraint can fire", async () => {
    const account = await getAccount(winningAccountId);
    const available = account.balance - account.reservedBalance;

    // Try to reserve one coin more than available.
    // The application check in createReservation must throw before the
    // UPDATE statement, so the DB constraint never fires.
    await expect(
      db.transaction(async (tx) => {
        return createReservation(tx, {
          walletAccountId: winningAccountId,
          amount: available + 1,
          reasonType: "withdrawal",
          idempotencyKey: `${prefix}:constraint:over`,
        });
      }),
    ).rejects.toThrow(InsufficientAvailableBalanceError);

    // No change to the wallet account.
    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(account.reservedBalance);
    expect(after.balance).toBe(account.balance);
  });

  it("recordCompletedTransaction blocks debits that would violate balance >= reserved_balance", async () => {
    const account = await getAccount(winningAccountId);
    const available = account.balance - account.reservedBalance;

    // Reserve all available balance.
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: available,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:constraint:rct`,
      });
    });

    // Attempt a direct debit via recordCompletedTransaction — must throw
    // InsufficientAvailableBalanceError, not a raw DB constraint error.
    await expect(
      db.transaction(async (tx) => {
        return recordCompletedTransaction(tx, {
          walletAccountId: winningAccountId,
          amount: -1, // Just 1 coin — balance would be fine but would go below reserved
          idempotencyKey: `${prefix}:constraint:rct:tx`,
          description: "Should throw InsufficientAvailableBalanceError",
        });
      }),
    ).rejects.toThrow(InsufficientAvailableBalanceError);

    // No ledger entry must exist.
    const txRows = await db
      .select()
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.idempotencyKey, `${prefix}:constraint:rct:tx`));
    expect(txRows).toHaveLength(0);

    // Balance unchanged.
    const after = await getAccount(winningAccountId);
    expect(after.balance).toBe(account.balance);

    // Cleanup.
    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });
});

// ── Transaction guard ─────────────────────────────────────────────────────────

describe("transaction guard", () => {
  it("createReservation throws immediately when called with bare db (not a transaction)", async () => {
    await expect(
      
      createReservation(db, {
        walletAccountId: winningAccountId,
        amount: 10,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:guard:create`,
      }),
    ).rejects.toThrow(/must be called inside a db\.transaction\(\)/i);

    // No DB state must have changed — the guard fires before any statement.
    const rows = await db
      .select()
      .from(walletReservationsTable)
      .where(eq(walletReservationsTable.idempotencyKey, `${prefix}:guard:create`));
    expect(rows).toHaveLength(0);
  });

  it("releaseReservation throws immediately when called with bare db", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 10,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:guard:release:setup`,
      });
    });

    const before = await getAccount(winningAccountId);

    await expect(
      
      releaseReservation(db, reservation.id),
    ).rejects.toThrow(/must be called inside a db\.transaction\(\)/i);

    // reserved_balance unchanged — the guard fired before any statement.
    const after = await getAccount(winningAccountId);
    expect(after.reservedBalance).toBe(before.reservedBalance);

    const row = await getReservation(reservation.id);
    expect(row!.status).toBe("active");

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("confirmReservation throws immediately when called with bare db", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 10,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:guard:confirm:setup`,
      });
    });

    const before = await getAccount(winningAccountId);

    await expect(
      
      confirmReservation(db, {
        reservationId: reservation.id,
        transactionIdempotencyKey: `${prefix}:guard:confirm:tx`,
      }),
    ).rejects.toThrow(/must be called inside a db\.transaction\(\)/i);

    // No balance change, no ledger entry, reservation still active.
    const after = await getAccount(winningAccountId);
    expect(after.balance).toBe(before.balance);
    expect(after.reservedBalance).toBe(before.reservedBalance);

    const row = await getReservation(reservation.id);
    expect(row!.status).toBe("active");

    const txRows = await db
      .select()
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.idempotencyKey, `${prefix}:guard:confirm:tx`));
    expect(txRows).toHaveLength(0);

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });
});

// ── confirmed_by_transaction_id audit link ────────────────────────────────────

describe("confirmed_by_transaction_id audit link", () => {
  it("is NULL on a freshly created reservation", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 20,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:audit:create`,
      });
    });

    expect(reservation.confirmedByTransactionId).toBeNull();

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("is NULL on a released reservation (no ledger entry was written)", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 20,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:audit:release`,
      });
    });

    const released = await db.transaction(async (tx) => {
      return releaseReservation(tx, reservation.id);
    });

    expect(released.confirmedByTransactionId).toBeNull();
  });

  it("is set to the ledger transaction ID atomically at confirmation", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 30,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:audit:confirm`,
      });
    });

    const { reservation: confirmed, transaction: walletTx } = await db.transaction(
      async (tx) => {
        return confirmReservation(tx, {
          reservationId: reservation.id,
          transactionIdempotencyKey: `${prefix}:audit:confirm:tx`,
          referenceType: "withdrawal",
          description: "Audit link test",
        });
      },
    );

    // The link must point exactly to the ledger entry returned by confirmReservation.
    expect(confirmed.confirmedByTransactionId).not.toBeNull();
    expect(confirmed.confirmedByTransactionId).toBe(walletTx.id);

    // The referenced transaction row must exist and carry the correct debit.
    const [txRow] = await db
      .select()
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.id, walletTx.id));
    expect(txRow).toBeDefined();
    expect(txRow!.amount).toBe(-30);
  });

  it("audit link is stable across idempotent re-confirmation", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 25,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:audit:idempotent`,
      });
    });

    const { reservation: confirmed, transaction: walletTx } = await db.transaction(
      async (tx) => {
        return confirmReservation(tx, {
          reservationId: reservation.id,
          transactionIdempotencyKey: `${prefix}:audit:idempotent:tx`,
        });
      },
    );

    // Retry with same key — must return the same data, link unchanged.
    const { reservation: confirmed2, transaction: walletTx2 } = await db.transaction(
      async (tx) => {
        return confirmReservation(tx, {
          reservationId: reservation.id,
          transactionIdempotencyKey: `${prefix}:audit:idempotent:tx`,
        });
      },
    );

    expect(confirmed2.confirmedByTransactionId).toBe(confirmed.confirmedByTransactionId);
    expect(walletTx2.id).toBe(walletTx.id);
  });
});

// ── expires_at column ─────────────────────────────────────────────────────────

describe("expires_at column", () => {
  it("defaults to NULL when not provided", async () => {
    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 15,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:expiry:null`,
      });
    });

    expect(reservation.expiresAt).toBeNull();

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("stores a future expiry timestamp when provided", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1 day

    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 15,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:expiry:set`,
        expiresAt: future,
      });
    });

    expect(reservation.expiresAt).not.toBeNull();
    // 1-second tolerance for DB timestamp rounding.
    expect(Math.abs(reservation.expiresAt!.getTime() - future.getTime())).toBeLessThan(1000);

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });

  it("a reservation with a past expires_at remains active — cleanup is external, not automatic", async () => {
    const past = new Date(Date.now() - 60_000); // 1 minute ago

    const reservation = await db.transaction(async (tx) => {
      return createReservation(tx, {
        walletAccountId: winningAccountId,
        amount: 15,
        reasonType: "withdrawal",
        idempotencyKey: `${prefix}:expiry:past`,
        expiresAt: past,
      });
    });

    // The service must NOT auto-expire — status must still be active.
    expect(reservation.status).toBe("active");
    expect(reservation.expiresAt!.getTime()).toBeLessThan(Date.now());

    await db.transaction(async (tx) => {
      await releaseReservation(tx, reservation.id);
    });
  });
});

// ── Index existence (live DB) ─────────────────────────────────────────────────

describe("database index verification", () => {
  it("wallet_reservations has a composite index on (wallet_account_id, status)", async () => {
    const result = await db.execute(
      sql`SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'wallet_reservations'
            AND indexname = 'wallet_reservations_account_status_idx'`,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as { indexdef: string };
    expect(row.indexdef).toContain("wallet_account_id");
    expect(row.indexdef).toContain("status");
  });

  it("wallet_transactions has a composite index on (wallet_account_id, created_at)", async () => {
    const result = await db.execute(
      sql`SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'wallet_transactions'
            AND indexname = 'wallet_transactions_account_created_idx'`,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as { indexdef: string };
    expect(row.indexdef).toContain("wallet_account_id");
    expect(row.indexdef).toContain("created_at");
  });

  it("wallet_reservations has a unique index on idempotency_key", async () => {
    const result = await db.execute(
      sql`SELECT indexname FROM pg_indexes
          WHERE tablename = 'wallet_reservations'
            AND indexname = 'wallet_reservations_idempotency_key_unique'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it("wallet_transactions has a unique index on idempotency_key", async () => {
    const result = await db.execute(
      sql`SELECT indexname FROM pg_indexes
          WHERE tablename = 'wallet_transactions'
            AND indexname = 'wallet_transactions_idempotency_key_unique'`,
    );
    expect(result.rows).toHaveLength(1);
  });
});
