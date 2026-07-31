// The layer between a meter and an invoice: every metered event gets priced,
// converted to the customer's credit unit, written to an append-only ledger,
// debited against a balance, and folded into a daily rollup that a spend cap
// can read. Every app billing a metered API rebuilds this, and each one
// rediscovers the same three traps:
//
//   - Money in floats. Summing float ledger rows drifts; one real deployment
//     lost 2 cents across 25,740 rows before anyone noticed. Amounts here are
//     integer sub-units (see Plan.denomination) and are only ever added.
//   - The debit and the ledger row diverging. If the row is written but the
//     balance is not debited, a customer gets free usage; the reverse
//     over-charges. They must land together, so the store commits them as one
//     unit — this module never splits them.
//   - The rollup being treated as truth. It is a derived index, rebuildable
//     from the ledger, so a rollup failure must never fail the charge.
//
// Storage stays the host's business (Postgres, ClickHouse, anything). This
// owns the policy and the arithmetic, which is the part that is identical
// everywhere — and the part that is worth getting wrong only once.

/** One priced, metered event, ready to persist. */
export type LedgerEntry = {
  /** Charge in integer sub-units of the plan's denomination (see
   *  `Plan.denomination`) — never a float. */
  amount: number;
  /** What the customer is billed in the product's own unit. */
  credits: number;
  /** Product-level grouping ("chat", "voice"), not the vendor's. */
  feature?: string | null;
  model?: string;
  /** "llm" | "tts" | "embedding" | whatever the product meters. */
  operation: string;
  provider: string;
  /** Idempotency handle for at-least-once callers. */
  requestId?: string;
  /** Null for system/background work with nobody to bill. */
  tenant?: string | null;
};

export type LedgerCommit = {
  /** Append the row AND debit `entry.credits` from the tenant's balance in a
   *  single atomic unit. Called with tenant null for unattributed work, where
   *  there is nothing to debit. */
  commit: (entry: LedgerEntry) => Promise<void>;
  /** Fold the entry into a derived daily aggregate. Best-effort by contract:
   *  this module swallows its failures. */
  rollup?: (entry: LedgerEntry) => Promise<void>;
  /** Total sub-units charged since `since`, for the spend cap. */
  spentSince?: (since: Date) => Promise<number>;
};

export type UsageLedgerOptions = {
  /** Sub-units per credit. A peg of 1_000 with micros means 1 credit =
   *  $0.001. Required for credit conversion; omit to bill in raw amounts. */
  creditPegSubUnits?: number;
  /** Reported when a rollup fails. The charge already succeeded. */
  onRollupError?: (error: unknown, entry: LedgerEntry) => void;
  store: LedgerCommit;
};

/**
 * Credits for a charge. Ceiling, not rounding: a product that sells credits
 * must never hand out a fraction it cannot deduct, and rounding down means
 * the smallest calls are free — which is how a "cheap" endpoint becomes an
 * unmetered one.
 */
export const creditsFor = (amount: number, pegSubUnits: number) => {
  if (pegSubUnits <= 0) return 0;

  return Math.ceil(amount / pegSubUnits);
};

export type UsageLedger = {
  /** Price-agnostic: hand it an amount already in sub-units. Returns what was
   *  written, including the credits it derived. */
  record: (
    entry: Omit<LedgerEntry, "credits"> & { credits?: number },
  ) => Promise<LedgerEntry>;
  /** True once spend since `since` reaches `capSubUnits`. Fails OPEN — a
   *  broken cap must not take down paid features, and the per-provider
   *  budgets are still in front. */
  overCap: (capSubUnits: number, since: Date) => Promise<boolean>;
};

export const createUsageLedger = (options: UsageLedgerOptions): UsageLedger => {
  const { creditPegSubUnits, onRollupError, store } = options;

  return {
    overCap: async (capSubUnits, since) => {
      if (!store.spentSince) return false;
      try {
        return (await store.spentSince(since)) >= capSubUnits;
      } catch {
        return false;
      }
    },
    record: async (input) => {
      const credits =
        input.credits ??
        (creditPegSubUnits === undefined
          ? 0
          : creditsFor(input.amount, creditPegSubUnits));
      const entry: LedgerEntry = { ...input, credits };
      // The charge is the thing that must not be lost; it is awaited and its
      // failure propagates to the caller.
      await store.commit(entry);
      // The rollup is a derived index — rebuildable from the ledger — so its
      // failure is reported, never raised.
      if (store.rollup) {
        await store.rollup(entry).catch((error: unknown) => {
          onRollupError?.(error, entry);
        });
      }

      return entry;
    },
  };
};
