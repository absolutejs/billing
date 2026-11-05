import { expect, test } from "bun:test";
import { grossUpProcessingFee } from "../src/creditPurchase";
test("gross-up includes the fee on the entire charge without collecting an extra rounding cent", () => {
  const rate = {
    fixedMinor: 30,
    rateBasisPoints: 290,
    rounding: "nearest" as const,
  };
  expect(
    [1000, 2500, 5000, 10000].map(
      (net) => grossUpProcessingFee(net, rate).grossMinor,
    ),
  ).toEqual([1061, 2606, 5180, 10330]);
  for (const net of [1, 99, 1000, 2500, 5000, 10000, 999999]) {
    const quote = grossUpProcessingFee(net, rate);
    expect(quote.grossMinor - quote.feeMinor).toBe(net);
    const lower = quote.grossMinor - 1;
    expect(lower - Math.round(lower * 0.029) - 30).toBeLessThan(net);
  }
});
test("fee quotes reject invalid values and overflow; support explicit upward rounding", () => {
  expect(() =>
    grossUpProcessingFee(0, {
      fixedMinor: 0,
      rateBasisPoints: 0,
      rounding: "nearest",
    }),
  ).toThrow();
  expect(() =>
    grossUpProcessingFee(100, {
      fixedMinor: 30,
      rateBasisPoints: 10000,
      rounding: "nearest",
    }),
  ).toThrow();
  expect(() =>
    grossUpProcessingFee(Number.MAX_SAFE_INTEGER, {
      fixedMinor: 30,
      rateBasisPoints: 290,
      rounding: "nearest",
    }),
  ).toThrow("safe integer");
  expect(
    grossUpProcessingFee(100, {
      fixedMinor: 0,
      rateBasisPoints: 0,
      rounding: "up",
    }),
  ).toEqual({ netMinor: 100, grossMinor: 100, feeMinor: 0 });
  const result = grossUpProcessingFee(100, {
    fixedMinor: 1,
    rateBasisPoints: 3333,
    rounding: "up",
  });
  expect(result.grossMinor - result.feeMinor).toBe(100);
});
