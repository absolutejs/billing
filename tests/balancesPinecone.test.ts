import { describe, expect, test } from "bun:test";
import { readProviderBalances } from "../src/balances";

const snapshot = {
  capturedAt: "2026-07-31T00:00:00.000Z",
  monthlyTokenLimit: 5_000_000,
  resetDate: "2026-08-01T00:00:00.000Z",
  tokensUsed: 4_700_000,
};

describe("pinecone embedding quota tile", () => {
  test("reports usage against the plan cap", async () => {
    const [tile] = await readProviderBalances({ pinecone: snapshot });
    expect(tile).toMatchObject({
      kind: "quota",
      limit: 5_000_000,
      provider: "pinecone",
      remaining: 300_000,
      status: "ok",
      unit: "tokens",
      used: 4_700_000,
    });
    expect(tile?.detail).toBe("4.7M / 5.0M tokens this month");
  });

  test("says so plainly when the allowance is spent", async () => {
    const [tile] = await readProviderBalances({
      pinecone: { ...snapshot, exhausted: true, tokensUsed: 5_000_000 },
    });
    expect(tile?.detail).toContain("embeddings currently refused");
    expect(tile?.remaining).toBe(0);
  });

  test("never reports negative remaining when the cap is overshot", async () => {
    const [tile] = await readProviderBalances({
      pinecone: { ...snapshot, tokensUsed: 6_000_000 },
    });
    expect(tile?.remaining).toBe(0);
  });

  test("is unconfigured, not absent, when the host reports nothing", async () => {
    const [tile] = await readProviderBalances({ pinecone: null });
    expect(tile?.provider).toBe("pinecone");
    expect(tile?.status).toBe("unconfigured");
  });

  test("stays out of the list when not configured at all", async () => {
    const tiles = await readProviderBalances({});
    expect(tiles).toHaveLength(0);
  });
});

test("uncapped paid usage retains application budget without fabricating provider headroom", async () => {
  const [tile] = await readProviderBalances({
    pinecone: {
      ...snapshot,
      monthlyTokenLimit: null,
      monthlyBudgetTokens: 9000000,
      tier: "Standard",
    },
  });
  expect(tile).toMatchObject({
    limit: null,
    remaining: null,
    used: 4700000,
    tier: "Standard",
    status: "ok",
  });
  expect(tile?.detail).toContain("no monthly token cap");
  expect(tile?.note).toContain("Application budget: 9.0M");
  expect(JSON.parse(JSON.stringify(tile)).limit).toBeNull();
});
test("refused embeddings do not imply monthly exhaustion even on a paid plan", async () => {
  const [tile] = await readProviderBalances({
    pinecone: { ...snapshot, monthlyTokenLimit: null, exhausted: true },
  });
  expect(tile?.status).toBe("error");
  expect(tile?.detail).toContain("embeddings currently refused");
  expect(tile?.detail).not.toContain("quota spent");
});
