import { expect, test } from "bun:test";
import type { CreditSqlClient, CreditSql } from "../src/prepaidPostgres";
import { PGlite } from "@electric-sql/pglite";
import {
  checkoutHandoffPostgresSchemaSql,
  createPostgresCheckoutHandoffs,
  checkoutHandoffUrl,
  checkoutSameOrigin,
} from "../src/checkoutHandoff";
const quote = {
  productId: "small",
  amountCents: 1000,
  credits: 1000,
  currency: "USD",
};
test("single-use, expiring, account-bound handoffs store no bearer secrets", async () => {
  const pg = new PGlite();
  await pg.exec(checkoutHandoffPostgresSchemaSql());
  let now = 1000;
  const db: CreditSqlClient = {
    query: async (text: string, values: readonly unknown[]) =>
      pg.query<Record<string, unknown>>(text, [...values]),
    transaction: async <T>(run: (tx: CreditSql) => Promise<T>): Promise<T> =>
      run(db),
  };
  const store = createPostgresCheckoutHandoffs(db, () => now);
  const link = await store.issue("alice", quote);
  expect(await store.get("bob", link.id)).toBeNull();
  expect(await store.exchange(link.code, "bob")).toBeNull();
  const exchanges = await Promise.all([
    store.exchange(link.code),
    store.exchange(link.code),
  ]);
  expect(exchanges.filter(Boolean)).toHaveLength(1);
  const session = exchanges.find(Boolean)!;
  expect(await store.authorize(session.session, session.csrf)).toMatchObject({
    accountId: "alice",
    quote,
  });
  expect(
    await store.authorize(session.session, session.csrf, "bob"),
  ).toBeNull();
  expect(await store.authorize(session.session, link.code)).toBeNull();
  expect(await store.authorize(link.code, session.csrf)).toBeNull();
  const stored = JSON.stringify(
    (await pg.query("SELECT * FROM billing_checkout.handoffs")).rows,
  );
  for (const bearer of [link.code, session.session, session.csrf])
    expect(stored).not.toContain(bearer);
  const expired = await store.issue("alice", quote);
  now += 15 * 60 * 1000;
  expect(await store.exchange(expired.code)).toBeNull();
  expect(await store.authorize(session.session, session.csrf)).toBeNull();
  await pg.close();
});
test("only trusted HTTPS landings and explicit same-origin POSTs", () => {
  const code = "a".repeat(43);
  expect(checkoutHandoffUrl("https://shop.test/buy", code)).toBe(
    `https://shop.test/buy#${code}`,
  );
  for (const url of [
    "http://shop.test/buy",
    "https://user@shop.test/buy",
    "https://shop.test/buy?next=bad",
    "https://shop.test/buy#bad",
  ])
    expect(() => checkoutHandoffUrl(url, code)).toThrow();
  expect(
    checkoutSameOrigin(
      new Request("https://shop.test/exchange", {
        method: "POST",
        headers: { origin: "https://shop.test" },
      }),
      "https://shop.test",
    ),
  ).toBe(true);
  for (const request of [
    new Request("https://shop.test/exchange"),
    new Request("https://shop.test/exchange", { method: "POST" }),
    new Request("https://shop.test/exchange", {
      method: "POST",
      headers: { origin: "https://evil.test" },
    }),
  ])
    expect(checkoutSameOrigin(request, "https://shop.test")).toBe(false);
});
