import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createProviderBudget } from "../src/providerBudget";
import type { CreditSqlClient } from "../src/prepaidPostgres";
const db = new PGlite();
const client: CreditSqlClient = {
  query: (query, parameters) => db.query(query, [...parameters]),
  transaction: (run) =>
    db.transaction((tx) =>
      run({ query: (query, parameters) => tx.query(query, [...parameters]) }),
    ),
};
beforeAll(async () => {
  await db.exec(
    `CREATE TABLE provider_request_budget (id text primary key, scope text not null, period text not null, reserved_micros bigint not null, actual_micros bigint, status text not null)`,
  );
});
afterAll(() => db.close());
test("concurrent admissions and a new client share one allowance; unknown outcomes stay reserved", async () => {
  const reserve = (id: string) =>
    createProviderBudget(client).reserve({
      id,
      scope: "race",
      period: "2026-09",
      reserveMicros: 6,
      maxMicros: 10,
      maxRequests: 10,
    });
  const outcomes = await Promise.all([reserve("a"), reserve("b")]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const id = outcomes[0] ? "a" : "b";
  await createProviderBudget(client).settle(id, "unknown", null);
  expect(await reserve("c")).toBe(false);
  await createProviderBudget(client).settle(id, "rejected", 0);
  expect(await reserve("d")).toBe(true);
  expect(await reserve("d")).toBe(false);
});
test("settlement is idempotent, and fulfilled requests still consume request quota", async () => {
  const budget = createProviderBudget(client);
  const input = {
    id: "quota",
    scope: "requests",
    period: "month",
    reserveMicros: 5,
    maxMicros: 100,
    maxRequests: 1,
  };
  expect(await budget.reserve(input)).toBe(true);
  await budget.settle("quota", "fulfilled", 2);
  await budget.settle("quota", "rejected", 0);
  expect(await budget.reserve({ ...input, id: "quota2" })).toBe(false);
  expect(
    (
      await db.query(
        "SELECT actual_micros FROM provider_request_budget WHERE id='quota'",
      )
    ).rows[0],
  ).toEqual({ actual_micros: 2 });
});
