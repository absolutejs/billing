import { describe, expect, test } from "bun:test";
import {
  computeInvoice,
  createPlan,
  formatMicros,
  type Plan,
} from "../src/index";

// =============================================================================
// createPlan validation
// =============================================================================

describe("createPlan", () => {
  test("returns the plan when shape is valid", () => {
    const plan = createPlan({
      name: "free",
      pricedDimensions: {
        requests: { perUnitMicros: 100 },
      },
    });
    expect(plan.name).toBe("free");
  });

  test("throws when tiered dimension has no tiers", () => {
    expect(() =>
      createPlan({
        name: "broken",
        pricedDimensions: {
          requests: { tiers: [] },
        },
      }),
    ).toThrow("no tiers");
  });

  test("throws when final tier is not Infinity", () => {
    expect(() =>
      createPlan({
        name: "broken",
        pricedDimensions: {
          requests: {
            tiers: [{ perUnitMicros: 100, upTo: 1_000_000 }],
          },
        },
      }),
    ).toThrow("Infinity");
  });

  test("throws when tier bounds are non-monotonic", () => {
    expect(() =>
      createPlan({
        name: "broken",
        pricedDimensions: {
          requests: {
            tiers: [
              { perUnitMicros: 100, upTo: 1_000_000 },
              { perUnitMicros: 50, upTo: 500_000 },
              { perUnitMicros: 25, upTo: Infinity },
            ],
          },
        },
      }),
    ).toThrow("must be >=");
  });
});

// =============================================================================
// Flat per-unit pricing
// =============================================================================

describe("computeInvoice — flat per-unit", () => {
  const plan = createPlan({
    name: "simple",
    pricedDimensions: {
      requests: { perUnitMicros: 200 }, // $0.0002 per request
    },
  });

  test("quantity * perUnitMicros becomes the line item amount", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 5000 },
    });
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0]?.key).toBe("requests");
    expect(invoice.lineItems[0]?.quantity).toBe(5000);
    expect(invoice.lineItems[0]?.amountMicros).toBe(5000 * 200);
    expect(invoice.totalMicros).toBe(1_000_000);
    expect(invoice.totalUnits).toBe(1);
  });

  test("zero usage produces no line items", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 0 },
    });
    expect(invoice.lineItems).toEqual([]);
    expect(invoice.totalMicros).toBe(0);
  });

  test("missing usage key treated as zero", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: {},
    });
    expect(invoice.totalMicros).toBe(0);
  });

  test("negative usage is ignored (not charged)", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: -100 },
    });
    expect(invoice.totalMicros).toBe(0);
  });

  test("non-finite usage (NaN / Infinity) is ignored", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: NaN },
    });
    expect(invoice.totalMicros).toBe(0);
  });
});

// =============================================================================
// Free tier
// =============================================================================

describe("computeInvoice — free tier", () => {
  const plan = createPlan({
    name: "pro",
    pricedDimensions: {
      requests: { freeTier: 1000, perUnitMicros: 200 },
    },
  });

  test("quantity under free tier → no charge", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 500 },
    });
    expect(invoice.totalMicros).toBe(0);
  });

  test("quantity above free tier → only overage charged", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 5000 },
    });
    expect(invoice.lineItems[0]?.chargedQuantity).toBe(4000);
    expect(invoice.lineItems[0]?.amountMicros).toBe(4000 * 200);
    expect(invoice.lineItems[0]?.freeTier).toBe(1000);
  });

  test("quantity exactly equal to free tier → no charge", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 1000 },
    });
    expect(invoice.totalMicros).toBe(0);
  });
});

// =============================================================================
// unit divisor (e.g. price per MB when quantity is bytes)
// =============================================================================

describe("computeInvoice — unit divisor", () => {
  const plan = createPlan({
    name: "data",
    pricedDimensions: {
      bytesEgress: {
        perUnitMicros: 100, // $0.0001 per MB
        unit: 1024 * 1024, // 1 MB
      },
    },
  });

  test("charges per unit, not per metered measure", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { bytesEgress: 10 * 1024 * 1024 },
    });
    expect(invoice.totalMicros).toBe(1000); // 10 MB * 100 micros
  });

  test("truncation rounds fractional units DOWN", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { bytesEgress: 1024 * 1024 + 100 }, // ~1.0001 MB
    });
    expect(invoice.totalMicros).toBe(100); // truncates to 1 MB
  });

  test("round-half-up rounds fractional units half-up", () => {
    const rounded = createPlan({
      name: "data",
      pricedDimensions: {
        bytesEgress: {
          perUnitMicros: 100,
          unit: 1024 * 1024,
        },
      },
      rounding: "round-half-up",
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan: rounded,
      tenant: "acme",
      usage: { bytesEgress: Math.floor(1.6 * 1024 * 1024) },
    });
    expect(invoice.totalMicros).toBe(160);
  });
});

// =============================================================================
// Tiered (graduated) pricing
// =============================================================================

describe("computeInvoice — tiered", () => {
  const plan = createPlan({
    name: "enterprise",
    pricedDimensions: {
      requests: {
        tiers: [
          { perUnitMicros: 200, upTo: 1_000_000 },
          { perUnitMicros: 150, upTo: 10_000_000 },
          { perUnitMicros: 100, upTo: Infinity },
        ],
      },
    },
  });

  test("quantity entirely in first band", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 500_000 },
    });
    expect(invoice.lineItems[0]?.amountMicros).toBe(500_000 * 200);
    expect(invoice.lineItems[0]?.tierBreakdown).toHaveLength(1);
  });

  test("quantity spans multiple bands → graduated sum", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 5_000_000 },
    });
    // 1_000_000 @ 200 + 4_000_000 @ 150 = 200_000_000 + 600_000_000 = 800_000_000
    expect(invoice.lineItems[0]?.amountMicros).toBe(800_000_000);
    expect(invoice.lineItems[0]?.tierBreakdown).toHaveLength(2);
    expect(invoice.lineItems[0]?.tierBreakdown?.[0]?.unitsInTier).toBe(
      1_000_000,
    );
    expect(invoice.lineItems[0]?.tierBreakdown?.[1]?.unitsInTier).toBe(
      4_000_000,
    );
  });

  test("quantity spilling into final unbounded band", () => {
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 20_000_000 },
    });
    // 1M*200 + 9M*150 + 10M*100 = 200_000_000 + 1_350_000_000 + 1_000_000_000
    expect(invoice.lineItems[0]?.amountMicros).toBe(2_550_000_000);
    expect(invoice.lineItems[0]?.tierBreakdown).toHaveLength(3);
  });

  test("tiered + free tier composes", () => {
    const withFree = createPlan({
      name: "enterprise",
      pricedDimensions: {
        requests: {
          freeTier: 100_000,
          tiers: [
            { perUnitMicros: 200, upTo: 1_000_000 },
            { perUnitMicros: 100, upTo: Infinity },
          ],
        },
      },
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan: withFree,
      tenant: "acme",
      usage: { requests: 600_000 },
    });
    // chargedQuantity = 500_000 (after 100k free)
    // 500_000 * 200 = 100_000_000
    expect(invoice.lineItems[0]?.chargedQuantity).toBe(500_000);
    expect(invoice.lineItems[0]?.amountMicros).toBe(500_000 * 200);
  });
});

// =============================================================================
// Custom pricing function
// =============================================================================

describe("computeInvoice — custom price fn", () => {
  test("caller-supplied pricing function controls the amount", () => {
    const plan = createPlan({
      name: "surge",
      pricedDimensions: {
        cpuMs: {
          price: (q) => q * 50 + (q > 1000 ? 10_000_000 : 0),
        },
      },
    });
    const small = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { cpuMs: 500 },
    });
    const big = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { cpuMs: 2000 },
    });
    expect(small.totalMicros).toBe(25_000);
    expect(big.totalMicros).toBe(2000 * 50 + 10_000_000);
  });

  test("custom price fn receives chargedQuantity (post-freeTier)", () => {
    let lastSeen = -1;
    const plan = createPlan({
      name: "spy",
      pricedDimensions: {
        cpuMs: {
          freeTier: 100,
          price: (q) => {
            lastSeen = q;
            return q * 10;
          },
        },
      },
    });
    computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { cpuMs: 250 },
    });
    expect(lastSeen).toBe(150);
  });
});

// =============================================================================
// Base fee + minimum charge
// =============================================================================

describe("computeInvoice — base + minimum", () => {
  test("basePriceMicros emits a `base` line item", () => {
    const plan = createPlan({
      basePriceMicros: 20_000_000, // $20
      name: "pro",
      pricedDimensions: {},
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: {},
    });
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0]?.key).toBe("base");
    expect(invoice.lineItems[0]?.amountMicros).toBe(20_000_000);
  });

  test("basePriceMicros: 0 (or undefined) emits no base line", () => {
    const plan = createPlan({
      basePriceMicros: 0,
      name: "pay-go",
      pricedDimensions: { requests: { perUnitMicros: 100 } },
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 10 },
    });
    expect(invoice.lineItems.find((l) => l.key === "base")).toBeUndefined();
  });

  test("minimum charge tops up totals below the floor", () => {
    const plan = createPlan({
      minimumChargeMicros: 5_000_000, // $5 minimum
      name: "pay-go",
      pricedDimensions: { requests: { perUnitMicros: 100 } },
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 100 }, // 100 * 100 = 10_000 micros
    });
    expect(invoice.totalMicros).toBe(5_000_000);
    const top = invoice.lineItems.find(
      (l) => l.key === "minimum-charge-adjustment",
    );
    expect(top?.amountMicros).toBe(5_000_000 - 10_000);
  });

  test("minimum charge does not fire when total exceeds the floor", () => {
    const plan = createPlan({
      minimumChargeMicros: 5_000_000,
      name: "pay-go",
      pricedDimensions: { requests: { perUnitMicros: 100 } },
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 1_000_000 }, // 100_000_000 > floor
    });
    expect(
      invoice.lineItems.find((l) => l.key === "minimum-charge-adjustment"),
    ).toBeUndefined();
    expect(invoice.totalMicros).toBe(100_000_000);
  });
});

// =============================================================================
// Currency + metadata
// =============================================================================

describe("computeInvoice — currency + metadata", () => {
  test('currency defaults to plan currency, falls back to "usd"', () => {
    const plan = createPlan({
      currency: "eur",
      name: "p",
      pricedDimensions: { requests: { perUnitMicros: 100 } },
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 1 },
    });
    expect(invoice.currency).toBe("eur");
  });

  test("per-call currency override beats the plan currency", () => {
    const plan = createPlan({
      currency: "eur",
      name: "p",
      pricedDimensions: { requests: { perUnitMicros: 100 } },
    });
    const invoice = computeInvoice({
      currency: "jpy",
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 1 },
    });
    expect(invoice.currency).toBe("jpy");
  });

  test("plan metadata flows through unchanged", () => {
    const plan = createPlan({
      metadata: { "price-list": "pl_2026q2", region: "us-east" },
      name: "p",
      pricedDimensions: { requests: { perUnitMicros: 100 } },
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { requests: 1 },
    });
    expect(invoice.metadata).toEqual({
      "price-list": "pl_2026q2",
      region: "us-east",
    });
  });
});

// =============================================================================
// Realistic shape — closely mirrors @absolutejs/metering Usage
// =============================================================================

describe("computeInvoice — realistic usage shape", () => {
  const plan: Plan = createPlan({
    basePriceMicros: 20_000_000,
    currency: "usd",
    name: "pro",
    pricedDimensions: {
      bytesEgress: {
        freeTier: 100 * 1024 * 1024,
        perUnitMicros: 100,
        unit: 1024 * 1024,
      },
      cpuMs: { freeTier: 60_000 * 60 * 10, perUnitMicros: 50, unit: 1000 },
      hibernationGbSeconds: { perUnitMicros: 5 },
      requests: { freeTier: 1_000_000, perUnitMicros: 200 },
    },
  });

  test("produces a stable Invoice for a metering Usage snapshot", () => {
    const usage = {
      bytesEgress: 500 * 1024 * 1024, // 500 MB
      cpuMs: 60_000 * 60 * 15, // 15 hours
      hibernationGbSeconds: 200_000,
      requests: 2_500_000,
    };
    const invoice = computeInvoice({
      period: { end: 1_000, start: 0 },
      plan,
      tenant: "acme",
      usage,
    });
    const keys = invoice.lineItems.map((l) => l.key).sort();
    expect(keys).toEqual([
      "base",
      "bytesEgress",
      "cpuMs",
      "hibernationGbSeconds",
      "requests",
    ]);
    expect(invoice.totalMicros).toBe(
      20_000_000 + // base
        1_500_000 * 200 + // requests overage
        ((60_000 * 60 * 5) / 1000) * 50 + // cpu overage
        400 * 100 + // egress overage (400 MB)
        200_000 * 5, // hibernation
    );
  });
});

// =============================================================================
// Custom label
// =============================================================================

describe("computeInvoice — label override", () => {
  test("dim.label wins over the usage key", () => {
    const plan = createPlan({
      name: "p",
      pricedDimensions: {
        cpuMs: { label: "Compute time (vCPU-seconds)", perUnitMicros: 50 },
      },
    });
    const invoice = computeInvoice({
      period: { end: 200, start: 100 },
      plan,
      tenant: "acme",
      usage: { cpuMs: 100 },
    });
    expect(invoice.lineItems[0]?.label).toBe("Compute time (vCPU-seconds)");
  });
});

// =============================================================================
// formatMicros
// =============================================================================

describe("formatMicros", () => {
  test("formats whole-dollar amounts", () => {
    expect(formatMicros(20_000_000, "usd")).toBe("20.00 USD");
  });

  test("rounds sub-cent amounts to 2 minor units", () => {
    expect(formatMicros(1, "usd")).toBe("0.00 USD");
    expect(formatMicros(5_000, "usd")).toBe("0.01 USD");
  });

  test("negative amounts get a leading minus", () => {
    expect(formatMicros(-1_500_000, "usd")).toBe("-1.50 USD");
  });

  test("honors minorUnits override (e.g. JPY has 0 minor digits)", () => {
    expect(formatMicros(1_000_000_000, "jpy", { minorUnits: 0 })).toBe(
      "1000 JPY",
    );
  });
});
