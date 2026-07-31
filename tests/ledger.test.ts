import { describe, expect, test } from "bun:test";
import { createUsageLedger, creditsFor, type LedgerEntry } from "../src/ledger";

const PEG = 1000; // 1 credit = 1000 sub-units

const memoryStore = () => {
  const committed: LedgerEntry[] = [];
  const rolled: LedgerEntry[] = [];

  return {
    commit: (entry: LedgerEntry) => {
      committed.push(entry);

      return Promise.resolve();
    },
    committed,
    rolled,
    rollup: (entry: LedgerEntry) => {
      rolled.push(entry);

      return Promise.resolve();
    },
  };
};

const event = { amount: 2500, operation: "llm", provider: "anthropic" };

describe("credit conversion", () => {
  test("rounds up so the smallest calls are never free", () => {
    expect(creditsFor(1, PEG)).toBe(1);
    expect(creditsFor(1000, PEG)).toBe(1);
    expect(creditsFor(1001, PEG)).toBe(2);
    expect(creditsFor(0, PEG)).toBe(0);
  });

  test("a zero or negative peg yields no credits rather than Infinity", () => {
    expect(creditsFor(500, 0)).toBe(0);
    expect(creditsFor(500, -1)).toBe(0);
  });
});

describe("recording", () => {
  test("derives credits and commits the row", async () => {
    const store = memoryStore();
    const ledger = createUsageLedger({ creditPegSubUnits: PEG, store });
    const entry = await ledger.record(event);
    expect(entry.credits).toBe(3);
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]?.amount).toBe(2500);
  });

  test("an explicit credit figure wins over the peg", async () => {
    const store = memoryStore();
    const ledger = createUsageLedger({ creditPegSubUnits: PEG, store });
    const entry = await ledger.record({ ...event, credits: 99 });
    expect(entry.credits).toBe(99);
  });

  test("no peg means no credits, not a crash", async () => {
    const store = memoryStore();
    const ledger = createUsageLedger({ store });
    expect((await ledger.record(event)).credits).toBe(0);
  });

  test("unattributed system work still lands in the ledger", async () => {
    const store = memoryStore();
    const ledger = createUsageLedger({ creditPegSubUnits: PEG, store });
    await ledger.record({ ...event, tenant: null });
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]?.tenant).toBeNull();
  });

  test("integer amounts stay integers through the whole path", async () => {
    const store = memoryStore();
    const ledger = createUsageLedger({ creditPegSubUnits: PEG, store });
    for (let i = 0; i < 1000; i += 1)
      await ledger.record({ ...event, amount: 7 });
    const total = store.committed.reduce((sum, row) => sum + row.amount, 0);
    expect(total).toBe(7000);
    expect(Number.isInteger(total)).toBe(true);
  });
});

describe("failure contracts", () => {
  test("a failed commit propagates — the charge must not be lost silently", async () => {
    const ledger = createUsageLedger({
      creditPegSubUnits: PEG,
      store: {
        commit: () => Promise.reject(new Error("deadlock")),
      },
    });
    await expect(ledger.record(event)).rejects.toThrow("deadlock");
  });

  test("a failed rollup is reported but never fails the charge", async () => {
    let reported = false;
    const ledger = createUsageLedger({
      creditPegSubUnits: PEG,
      onRollupError: () => {
        reported = true;
      },
      store: {
        commit: () => Promise.resolve(),
        rollup: () => Promise.reject(new Error("rollup deadlock")),
      },
    });
    const entry = await ledger.record(event);
    expect(entry.credits).toBe(3);
    expect(reported).toBe(true);
  });
});

describe("spend cap", () => {
  test("trips once spend reaches the cap", async () => {
    const ledger = createUsageLedger({
      store: {
        commit: () => Promise.resolve(),
        spentSince: () => Promise.resolve(20_000_000),
      },
    });
    expect(await ledger.overCap(20_000_000, new Date())).toBe(true);
    expect(await ledger.overCap(30_000_000, new Date())).toBe(false);
  });

  test("fails OPEN when the store throws", async () => {
    const ledger = createUsageLedger({
      store: {
        commit: () => Promise.resolve(),
        spentSince: () => Promise.reject(new Error("db down")),
      },
    });
    expect(await ledger.overCap(1, new Date())).toBe(false);
  });

  test("no spentSince means no cap rather than a permanent block", async () => {
    const ledger = createUsageLedger({
      store: { commit: () => Promise.resolve() },
    });
    expect(await ledger.overCap(1, new Date())).toBe(false);
  });
});
