import { expect, spyOn, test } from "bun:test";
import { readProviderBalances } from "../src/balances";
const quotas = {
  '["api/v1/people", "search"]': { day: { limit: 50000, consumed: 0 } },
  '["api/v1/people", "match"]': { minute: { limit: 1000, consumed: 0 } },
};
const credits = (remaining: number) => ({
  credit_usage_stats: {
    lead_credit: {
      limit: 2960,
      consumed: 2960 - remaining,
      left_over: remaining,
    },
    ai_credit: { left_over: 250000 },
    broadcast_credit: { left_over: 50000 },
  },
  current_credit_cycle: { end_date: "2026-11-15T21:23:13.000+00:00" },
});
const read = async (
  funds: unknown,
  quota: unknown = quotas,
  creditStatus = 200,
  quotaStatus = 200,
) => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        const isCredit = String(input).includes("/credit_usage_stats");
        return new Response(JSON.stringify(isCredit ? funds : quota), {
          status: isCredit ? creditStatus : quotaStatus,
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    return (await readProviderBalances({ apollo: { apiKey: "fixture" } }))[0];
  } finally {
    mock.mockRestore();
  }
};
test("zero paid credits override plentiful request capacity and unrelated credit pools", async () => {
  const tile = await read(credits(0));
  expect(tile).toMatchObject({
    status: "error",
    remaining: 0,
    limit: 2960,
    used: 2960,
    unit: "lead credits",
    resetDate: "2026-11-15T21:23:13.000Z",
  });
  expect(tile?.detail).toBe("0 lead credits remaining — enrichment blocked");
  expect(tile?.note).toContain("2,960 of 2,960");
  expect(tile?.note).toContain("1000 / 1000 enrichment requests");
});
test("a refreshed funded balance clears the blocked state", async () => {
  expect((await read(credits(0)))?.status).toBe("error");
  expect(await read(credits(500))).toMatchObject({
    status: "ok",
    remaining: 500,
    used: 2460,
    detail: "500 lead credits remaining",
  });
});
test("missing or denied paid balance never looks funded because rate limits are available", async () => {
  for (const [body, status] of [
    [{}, 200],
    [{ error: "private" }, 403],
  ] as const) {
    const tile = await read(body, quotas, status);
    expect(tile).toMatchObject({
      status: "error",
      remaining: null,
      detail: "Paid lead-credit balance unavailable",
    });
    expect(tile?.note).not.toContain("private");
  }
});
test("quota reporting failure cannot hide a known zero credit balance", async () => {
  const tile = await read(credits(0), {}, 200, 403);
  expect(tile).toMatchObject({ status: "error", remaining: 0 });
  expect(tile?.note).toContain("allowance unavailable");
});
test("missing balances are not inferred from other Apollo credit pools", async () => {
  expect(
    await read({ credit_usage_stats: { ai_credit: { left_over: 250000 } } }),
  ).toMatchObject({ remaining: null, status: "error" });
});
