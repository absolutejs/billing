import { expect, test } from "bun:test";
import {
  parseUsageRange,
  parseReceiptPage,
  encodeReceiptCursor,
  projectReceiptPage,
  projectUsageReport,
  projectBillingStatus,
} from "../src/reports";
test("report inputs reject tenant overrides, unbounded ranges and invalid cursors", () => {
  const now = new Date("2026-09-11T12:00:00.000Z");
  expect(parseUsageRange({}, now)).toEqual({
    from: "2026-08-13",
    to: "2026-09-12",
  });
  for (const value of [
    { accountId: "other" },
    { from: "2026-01-01", to: "2026-09-01" },
    { from: "2026-02-30", to: "2026-03-02" },
    { to: "2027-01-01" },
    { from: "2026-09-10", to: "2026-09-10" },
  ])
    expect(() => parseUsageRange(value, now)).toThrow();
  const cursor = {
    at: "2026-09-10T01:02:03.000Z",
    id: "00000000-0000-0000-0000-000000000001",
  };
  expect(
    parseReceiptPage({ limit: 1, cursor: encodeReceiptCursor(cursor) }),
  ).toEqual({ limit: 1, cursor });
  for (const value of [
    { limit: 51 },
    { limit: 0 },
    { limit: 1.5 },
    { cursor: "x" },
    { accountId: "other" },
  ])
    expect(() => parseReceiptPage(value)).toThrow();
});
test("public projections discard provider secrets and require exact usage reconciliation", () => {
  const row = {
    id: "00000000-0000-0000-0000-000000000001",
    issuedAt: "2026-09-10T00:00:00.000Z",
    currency: "USD",
    amountCents: 1000,
    refundedAmountCents: 100,
    source: "credit_purchase" as const,
    status: "partially_refunded" as const,
    customerVaultId: "secret",
  };
  expect(
    JSON.stringify(
      projectReceiptPage({ receipts: [row], nextCursor: null }, 1),
    ),
  ).not.toContain("secret");
  expect(() =>
    projectReceiptPage(
      { receipts: [{ ...row, refundedAmountCents: 1001 }], nextCursor: null },
      1,
    ),
  ).toThrow();
  const range = { from: "2026-09-10", to: "2026-09-11" };
  const usage = {
    ...range,
    creditsConsumed: 10,
    events: 2,
    byDay: [{ day: "2026-09-10", credits: 10, events: 2 }],
    byFeature: [{ feature: "draft", credits: 10, events: 2 }],
    costUsd: 99,
  };
  expect(JSON.stringify(projectUsageReport(usage, range))).not.toContain(
    "costUsd",
  );
  expect(() =>
    projectUsageReport({ ...usage, creditsConsumed: 11 }, range),
  ).toThrow();
  expect(() =>
    projectUsageReport(
      { ...usage, byDay: [{ day: "2026-09-11", credits: 10, events: 2 }] },
      range,
    ),
  ).toThrow();
  expect(() =>
    projectBillingStatus({
      portalAccess: false,
      subscription: null,
      credits: {
        remaining: -1,
        reserved: 0,
        purchased: 0,
        promotional: 0,
        debt: 0,
      },
      automaticRefill: false,
    }),
  ).toThrow();
});
