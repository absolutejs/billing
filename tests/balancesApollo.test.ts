import { expect, spyOn, test } from "bun:test";
import { readProviderBalances } from "../src/balances";

const read = async (quotas: unknown) => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => new Response(JSON.stringify(quotas), { status: 200 }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    return (await readProviderBalances({ apollo: { apiKey: "fixture" } }))[0];
  } finally {
    mock.mockRestore();
  }
};

test("Apollo shows the enrichment endpoint allowance rather than the largest unrelated quota", async () => {
  const tile = await read({
    '["api/v1/people", "search"]': { day: { limit: 50000, consumed: 0 } },
    '["api/v1/people", "match"]': { minute: { limit: 1000, consumed: 4 } },
  });
  expect(tile).toMatchObject({
    limit: 1000,
    remaining: 996,
    used: 4,
    unit: "requests/minute",
  });
  expect(tile?.detail).toContain("enrichment requests");
  expect(tile?.note).toContain("paid lead-credit balance is not reported");
  expect(tile?.detail).not.toContain("50000");
});

test("missing enrichment quota never substitutes search capacity or implies paid credits", async () => {
  const tile = await read({
    '["api/v1/people", "search"]': { day: { limit: 50000, consumed: 0 } },
  });
  expect(tile).toMatchObject({ kind: "none", limit: null, remaining: null });
  expect(tile?.detail).toContain("unavailable");
});

test("exhausted enrichment capacity cannot become negative", async () => {
  const tile = await read({
    '["api/v1/people", "match"]': { day: { limit: 100, consumed: 110 } },
  });
  expect(tile).toMatchObject({ remaining: 0, unit: "requests/day" });
});
