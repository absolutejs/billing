import { describe, expect, test } from "bun:test";
import {
  creditBalanceFrom,
  creditGate,
  isGrantableCredits,
  isPeriodLapsed,
} from "../src/ledger";

const row = {
  bonusCredits: 500,
  consumed: 200,
  periodAllowance: 1000,
  periodEnd: new Date("2026-08-01T00:00:00.000Z"),
};

describe("balance math", () => {
  test("bonus credits add to the spendable ceiling", () => {
    const balance = creditBalanceFrom(row);
    expect(balance.allowance).toBe(1500);
    expect(balance.remaining).toBe(1300);
  });

  test("an over-spend reads as zero left, never a negative", () => {
    expect(creditBalanceFrom({ ...row, consumed: 99_999 }).remaining).toBe(0);
  });

  test("a missing period end is normalised to null", () => {
    expect(
      creditBalanceFrom({ ...row, periodEnd: undefined }).periodEnd,
    ).toBeNull();
  });
});

describe("period rollover", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");

  test("has not lapsed before the end date", () => {
    expect(isPeriodLapsed(new Date("2026-08-01T00:00:00.000Z"), now)).toBe(
      false,
    );
  });

  test("lapses at and after the end date", () => {
    expect(isPeriodLapsed(now, now)).toBe(true);
    expect(isPeriodLapsed(new Date("2026-07-30T00:00:00.000Z"), now)).toBe(
      true,
    );
  });

  test("an unbounded balance never lapses", () => {
    expect(isPeriodLapsed(null, now)).toBe(false);
    expect(isPeriodLapsed(undefined, now)).toBe(false);
  });
});

describe("enforcement gate", () => {
  const base = { allowance: 1000, remaining: 3 };

  test("off allows and reports nothing, without needing a balance", () => {
    const gate = creditGate({ ...base, mode: "off" });
    expect(gate).toMatchObject({ allowed: true, low: false, remaining: 0 });
  });

  test("warn allows but flags a balance that cannot cover the call", () => {
    const gate = creditGate({ ...base, estimatedCredits: 10, mode: "warn" });
    expect(gate.allowed).toBe(true);
    expect(gate.low).toBe(true);
  });

  test("block refuses only once the balance cannot cover it", () => {
    expect(
      creditGate({ ...base, estimatedCredits: 3, mode: "block" }).allowed,
    ).toBe(true);
    expect(
      creditGate({ ...base, estimatedCredits: 4, mode: "block" }).allowed,
    ).toBe(false);
  });

  test("defaults to an estimate of one credit", () => {
    expect(
      creditGate({ allowance: 10, mode: "block", remaining: 0 }).allowed,
    ).toBe(false);
    expect(
      creditGate({ allowance: 10, mode: "block", remaining: 1 }).allowed,
    ).toBe(true);
  });
});

describe("grants", () => {
  test("only positive finite amounts are writable", () => {
    expect(isGrantableCredits(100)).toBe(true);
    expect(isGrantableCredits(0)).toBe(false);
    expect(isGrantableCredits(-5)).toBe(false);
    expect(isGrantableCredits(Number.NaN)).toBe(false);
    expect(isGrantableCredits(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
