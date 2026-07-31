import { describe, expect, test } from "bun:test";
import {
  computeInvoice,
  createPlan,
  formatMicros,
  NANO_DENOMINATION,
} from "../src/index";

const period = { end: 2, start: 1 };

// $0.16 per million tokens — a real embedding rate. In micros a small call
// truncates to zero; in nanos it bills correctly.
const embedNanosPerToken = 160;

describe("denomination", () => {
  test("micros truncate a token-priced call to nothing", () => {
    const plan = createPlan({
      name: "micros",
      pricedDimensions: { tokens: { perUnitMicros: 0.16 } },
    });
    const invoice = computeInvoice({
      period,
      plan,
      tenant: "t",
      usage: { tokens: 5 },
    });
    expect(invoice.totalMicros).toBe(0);
  });

  test("nanos bill the same call correctly", () => {
    const plan = createPlan({
      denomination: NANO_DENOMINATION,
      name: "nanos",
      pricedDimensions: { tokens: { perUnitMicros: embedNanosPerToken } },
    });
    const invoice = computeInvoice({
      period,
      plan,
      tenant: "t",
      usage: { tokens: 5 },
    });
    expect(invoice.totalMicros).toBe(800);
    expect(invoice.denomination).toBe(NANO_DENOMINATION);
    expect(invoice.totalUnits).toBeCloseTo(0.0000008, 10);
  });

  test("defaults to micros so existing plans are unchanged", () => {
    const plan = createPlan({
      name: "legacy",
      pricedDimensions: { requests: { perUnitMicros: 2_000_000 } },
    });
    const invoice = computeInvoice({
      period,
      plan,
      tenant: "t",
      usage: { requests: 3 },
    });
    expect(invoice.denomination).toBe(1_000_000);
    expect(invoice.totalUnits).toBe(6);
  });

  test("formats amounts in the plan's denomination", () => {
    expect(formatMicros(1_500_000, "usd")).toBe("1.50 USD");
    expect(
      formatMicros(1_500_000_000, "usd", { denomination: NANO_DENOMINATION }),
    ).toBe("1.50 USD");
  });

  test("integer sub-units do not drift when summed", () => {
    const plan = createPlan({
      denomination: NANO_DENOMINATION,
      name: "nanos",
      pricedDimensions: { tokens: { perUnitMicros: embedNanosPerToken } },
    });
    const one = computeInvoice({
      period,
      plan,
      tenant: "t",
      usage: { tokens: 7 },
    }).totalMicros;
    const many = Array.from({ length: 100_000 }).reduce<number>(
      (sum) => sum + one,
      0,
    );
    expect(many).toBe(one * 100_000);
  });
});
