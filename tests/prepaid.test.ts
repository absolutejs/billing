import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  availableCredits,
  createCreditAccountLedger,
  migrateLegacyCreditAccount,
  type CreditAccount,
} from "../src/prepaid";
import {
  createPostgresCreditAccountStore,
  creditAccountPostgresSchemaSql,
  type CreditSqlClient,
} from "../src/prepaidPostgres";
const db = new PGlite();
const client: CreditSqlClient = {
  query: (query, parameters) => db.query(query, [...parameters]),
  transaction: (run) =>
    db.transaction((tx) =>
      run({ query: (query, parameters) => tx.query(query, [...parameters]) }),
    ),
};
const store = createPostgresCreditAccountStore(client);
const ledger = createCreditAccountLedger(store);
const period = "2026-09-01T00:00:00.000Z";
const next = "2026-10-01T00:00:00.000Z";
const seed = (purchased = 100): CreditAccount => ({
  periodId: period,
  periodEnd: null,
  periodAllowance: 0,
  periodRemaining: 0,
  purchasedRemaining: purchased,
  promotionalRemaining: 0,
  debt: 0,
  consumed: 0,
  reserved: 0,
});
beforeAll(async () => {
  await db.exec(creditAccountPostgresSchemaSql());
});
afterAll(async () => {
  await db.close();
});
test("spent purchased credits never return at renewal or cancellation", async () => {
  await ledger.initialize("renew", seed(1000));
  await ledger.execute("renew", "spend", { kind: "debit", credits: 400 });
  await ledger.execute("renew", "renewal", {
    kind: "period",
    periodEnd: null,
    periodId: next,
    allowance: 100,
  });
  expect(availableCredits((await ledger.balance("renew"))!)).toBe(700);
  await ledger.execute("renew", "cancelled", {
    kind: "period",
    periodEnd: null,
    periodId: "2026-11-01T00:00:00.000Z",
    allowance: 0,
  });
  expect((await ledger.balance("renew"))!.purchasedRemaining).toBe(600);
});
test("concurrent last-credit reservations serialize; retries charge once", async () => {
  await ledger.initialize("race", seed());
  const results = await Promise.allSettled(
    ["a", "b"].map((id) =>
      ledger.execute("race", id, {
        kind: "reserve",
        reservationId: id,
        credits: 80,
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const winner = results[0]?.status === "fulfilled" ? "a" : "b";
  const command = {
    kind: "settle",
    reservationId: winner,
    credits: 60,
  } as const;
  const receipts = await Promise.all([
    ledger.execute("race", "settled", command),
    ledger.execute("race", "settled", command),
  ]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect((await ledger.balance("race"))!.purchasedRemaining).toBe(40);
  expect((await ledger.balance("race"))!.reserved).toBe(0);
  await expect(
    ledger.execute("race", "settled", { ...command, credits: 61 }),
  ).rejects.toThrow("different input");
  await expect(ledger.execute("race", "other-settle", command)).rejects.toThrow(
    "not active",
  );
});
test("old-period release does not mint a new allowance, but restores permanent funds", async () => {
  await ledger.initialize("roll", {
    ...seed(50),
    periodAllowance: 50,
    periodRemaining: 50,
  });
  await ledger.execute("roll", "hold", {
    kind: "reserve",
    reservationId: "work",
    credits: 80,
  });
  await ledger.execute("roll", "next", {
    kind: "period",
    periodEnd: null,
    periodId: next,
    allowance: 50,
  });
  await ledger.execute("roll", "cancel", {
    kind: "release",
    reservationId: "work",
  });
  expect(await ledger.balance("roll")).toMatchObject({
    periodRemaining: 50,
    purchasedRemaining: 50,
    reserved: 0,
  });
});
test("over-budget settlement rolls back; a later exact settlement succeeds", async () => {
  await ledger.initialize("over", seed());
  await ledger.execute("over", "hold", {
    kind: "reserve",
    reservationId: "work",
    credits: 50,
  });
  await expect(
    ledger.execute("over", "charge", {
      kind: "settle",
      reservationId: "work",
      credits: 51,
    }),
  ).rejects.toThrow("exceeds");
  expect(await ledger.balance("over")).toMatchObject({
    purchasedRemaining: 50,
    reserved: 50,
  });
  await ledger.execute("over", "charge", {
    kind: "settle",
    reservationId: "work",
    credits: 50,
  });
});
test("refund liability is collected once, including against released reservations", async () => {
  await ledger.initialize("refund", seed());
  await ledger.execute("refund", "hold", {
    kind: "reserve",
    reservationId: "work",
    credits: 100,
  });
  await ledger.execute("refund", "reversal", {
    kind: "reverse",
    bucket: "purchased",
    credits: 100,
  });
  await ledger.execute("refund", "release", {
    kind: "release",
    reservationId: "work",
  });
  expect(await ledger.balance("refund")).toMatchObject({
    purchasedRemaining: 0,
    debt: 0,
  });
  await ledger.execute("refund", "period", {
    kind: "period",
    periodEnd: null,
    periodId: next,
    allowance: 100,
  });
  expect(availableCredits((await ledger.balance("refund"))!)).toBe(100);
});
test("migration preserves each observed balance without fabricating purchase provenance", () => {
  for (const allowance of [0, 20, 100])
    for (const consumed of [0, 10, 30, 200])
      for (const bonus of [-100, -10, 0, 50, 200]) {
        const result = migrateLegacyCreditAccount({
          periodId: period,
          periodEnd: null,
          periodAllowance: allowance,
          consumed,
          bonusCredits: bonus,
        });
        expect(availableCredits(result)).toBe(
          Math.max(0, allowance + bonus - consumed),
        );
        expect(result.purchasedRemaining).toBe(0);
      }
});
test("account IDs isolate receipts and reservations; stale periods and unsafe numbers fail", async () => {
  await ledger.initialize("one", seed());
  await ledger.initialize("two", seed());
  await ledger.execute("one", "hold", {
    kind: "reserve",
    reservationId: "work",
    credits: 100,
  });
  await expect(
    ledger.execute("two", "release", {
      kind: "release",
      reservationId: "work",
    }),
  ).rejects.toThrow("not active");
  await expect(
    ledger.execute("two", "invalid", {
      kind: "grant",
      bucket: "purchased",
      credits: NaN,
    }),
  ).rejects.toThrow("safe integers");
  await ledger.execute("two", "next", {
    kind: "period",
    periodEnd: null,
    periodId: next,
    allowance: 50,
  });
  await expect(
    ledger.execute("two", "old", {
      kind: "period",
      periodEnd: null,
      periodId: period,
      allowance: 500,
    }),
  ).rejects.toThrow("backwards");
});
test("initialize cannot overwrite an account and partial settlements spend expiring funds first", async () => {
  await ledger.initialize("order", {
    ...seed(),
    promotionalRemaining: 20,
    periodAllowance: 30,
    periodRemaining: 30,
  });
  await ledger.initialize("order", seed(999));
  await ledger.execute("order", "reserve", {
    kind: "reserve",
    reservationId: "work",
    credits: 100,
  });
  await ledger.execute("order", "settle", {
    kind: "settle",
    reservationId: "work",
    credits: 40,
  });
  expect(await ledger.balance("order")).toMatchObject({
    periodRemaining: 0,
    promotionalRemaining: 10,
    purchasedRemaining: 100,
    consumed: 40,
  });
});

test("durable work claims return saved results and cap user charges while recording overruns", async () => {
  const { createPostgresCreditWork, creditWorkPostgresSchemaSql } =
    await import("../src/creditWork");
  await db.exec(creditWorkPostgresSchemaSql());
  const work = createPostgresCreditWork(client);
  await ledger.initialize("work", seed());
  const claims = await Promise.all([
    work.begin("work", "request", "digest", 80),
    work.begin("work", "request", "digest", 80),
  ]);
  expect(claims.filter((claim) => claim.fresh)).toHaveLength(1);
  expect(
    await work.record("work", "request", "event", 100, "event-digest"),
  ).toEqual({ charged: 80, fresh: true });
  expect(
    await work.record("work", "request", "event", 100, "event-digest"),
  ).toEqual({ charged: 80, fresh: false });
  const result = await work.finish("work", "request", "completed result");
  expect(result).toMatchObject({
    charged: 80,
    absorbed: 20,
    status: "completed",
    result: "completed result",
  });
  expect((await work.begin("work", "request", "digest", 80)).work).toEqual(
    result,
  );
  expect(await ledger.balance("work")).toMatchObject({
    purchasedRemaining: 20,
    reserved: 0,
    debt: 0,
  });
  await expect(
    work.begin("work", "request", "different-digest", 80),
  ).rejects.toThrow("different input");
  await expect(
    work.record("work", "request", "late", 1, "event-digest"),
  ).rejects.toThrow("finished");
});
test("failed work charges measured usage and releases only unused credits", async () => {
  const { createPostgresCreditWork, creditWorkPostgresSchemaSql } =
    await import("../src/creditWork");
  await db.exec(creditWorkPostgresSchemaSql());
  const work = createPostgresCreditWork(client);
  await ledger.initialize("failed-work", seed());
  await work.begin("failed-work", "request", "digest", 80);
  await work.record("failed-work", "request", "event", 20, "event-digest");
  await work.finish("failed-work", "request", "Work failed", true);
  expect(
    (await work.begin("failed-work", "request", "digest", 80)).work.status,
  ).toBe("failed");
  expect(await ledger.balance("failed-work")).toMatchObject({
    purchasedRemaining: 80,
    reserved: 0,
    consumed: 20,
  });
});

test("a funded non-subscriber gets MCP access without portal access", async () => {
  const { creditEntitlements } = await import("../src/prepaid");
  expect(
    creditEntitlements({
      subscribed: false,
      prepaidEnabled: true,
      account: seed(50),
    }),
  ).toEqual({ portal: false, mcp: "prepaid" });
  expect(
    creditEntitlements({
      subscribed: false,
      prepaidEnabled: false,
      account: seed(50),
    }),
  ).toEqual({ portal: false, mcp: "free" });
  expect(
    creditEntitlements({
      subscribed: false,
      prepaidEnabled: true,
      account: { ...seed(0), periodAllowance: 100, periodRemaining: 100 },
    }).mcp,
  ).toBe("free");
  expect(
    creditEntitlements({
      subscribed: true,
      prepaidEnabled: true,
      account: seed(0),
    }),
  ).toEqual({ portal: true, mcp: "member" });
});

test("deferred reservation survives handoff, restart and unknown outcome with immutable ownership", async () => {
  const { createPostgresCreditWork, creditWorkPostgresSchemaSql } =
    await import("../src/creditWork");
  await db.exec(creditWorkPostgresSchemaSql());
  await ledger.initialize("deferred", seed());
  const binding = { effectId: "effect", authorizationId: "approved-version" };
  await expect(
    client.transaction(async (sql) => {
      const work = createPostgresCreditWork({
        ...sql,
        transaction: (run) => run(sql),
      });
      await work.begin("deferred", "job", "review", 40);
      await work.handoff("deferred", "job", binding);
      throw Error("outbox insert failed");
    }),
  ).rejects.toThrow("outbox");
  expect((await ledger.balance("deferred"))?.reserved).toBe(0);
  const work = createPostgresCreditWork(client);
  expect(await work.get("deferred", "job")).toBeNull();
  await client.transaction(async (sql) => {
    const tx = createPostgresCreditWork({
      ...sql,
      transaction: (run) => run(sql),
    });
    await tx.begin("deferred", "job", "review", 40);
    await tx.handoff("deferred", "job", binding);
  });
  await expect(
    work.finish("deferred", "job", "wrong immediate finish"),
  ).rejects.toThrow("bound worker");
  await expect(
    work.handoff("deferred", "job", { ...binding, authorizationId: "other" }),
  ).rejects.toThrow("mismatch");
  await expect(
    work.resumeDeferred("other-account", "job", binding),
  ).rejects.toThrow("does not exist");
  await expect(
    work.resumeDeferred("deferred", "job", { ...binding, effectId: "other" }),
  ).rejects.toThrow("mismatch");
  await work.record("deferred", "job", "event", 10, "usage");
  const restarted = createPostgresCreditWork(client);
  expect(
    await restarted.resumeDeferred("deferred", "job", binding),
  ).toMatchObject({ budget: 40, charged: 10, status: "running" });
  await restarted.finishDeferred(
    "deferred",
    "job",
    binding,
    "unknown",
    "uncertain",
  );
  expect((await ledger.balance("deferred"))?.reserved).toBe(40);
  await work.record("deferred", "job", "event", 10, "usage");
  await work.record("deferred", "job", "second", 50, "more");
  expect(
    await restarted.finishDeferred(
      "deferred",
      "job",
      binding,
      "succeeded",
      "saved result",
    ),
  ).toMatchObject({ charged: 40, absorbed: 20, status: "completed" });
  await restarted.finishDeferred(
    "deferred",
    "job",
    binding,
    "succeeded",
    "duplicate",
  );
  expect(await ledger.balance("deferred")).toMatchObject({
    reserved: 0,
    purchasedRemaining: 60,
    debt: 0,
    consumed: 40,
  });
  expect(
    (await restarted.resumeDeferred("deferred", "job", binding)).result,
  ).toBe("saved result");
  await expect(
    restarted.finishDeferred(
      "deferred",
      "job",
      { ...binding, authorizationId: "other" },
      "succeeded",
      "bad",
    ),
  ).rejects.toThrow("mismatch");
});
