import { expect, test } from "bun:test";
import { quoteCreditAmount, type CreditPurchaseCatalog } from "../src/creditPurchase";
const catalog: CreditPurchaseCatalog = { minimumCents: 1000, maximumCents: 100000, stepCents: 100, creditsPerCent: 1, bonusWindows: [{ minimumAmountCents: 1000, maximumAmountCents: 4900, bonusPercent: 0 }, { minimumAmountCents: 5000, maximumAmountCents: 9900, bonusPercent: 10 }, { minimumAmountCents: 10000, maximumAmountCents: 100000, bonusPercent: 20 }] };
test("presets and slider use identical canonical integer quotes", () => {
  expect(quoteCreditAmount(catalog, 1000)?.credits).toBe(1000);
  expect(quoteCreditAmount(catalog, 5000)?.credits).toBe(5500);
  expect(quoteCreditAmount(catalog, 10000)?.credits).toBe(12000);
  expect(quoteCreditAmount(catalog, 7300)?.credits).toBe(8030);
  for (const amount of [0, 999, 1001, 100100, NaN, Infinity]) expect(quoteCreditAmount(catalog, amount)).toBeUndefined();
  expect(() => quoteCreditAmount({ ...catalog, bonusWindows: [] }, 1000)).toThrow();
});
