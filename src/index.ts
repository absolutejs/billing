/**
 * @absolutejs/billing — cost-model substrate for the AbsoluteJS PaaS.
 *
 * Two pieces:
 *
 *   - `createPlan(...)` — declarative pricing config: optional flat
 *     base fee + per-dimension unit prices, with optional graduated
 *     tiers and free-tier allowances per dimension.
 *
 *   - `computeInvoice({ plan, period, tenant, usage, currency? })`
 *     — pure function that turns a `@absolutejs/metering`-shaped
 *     `Usage` snapshot (or any record of metered numbers) into an
 *     `Invoice` of line items + total. All money math is done in
 *     integer **micros** (1 micro = 1/1,000,000 of a currency unit
 *     — the same denomination Stripe uses internally) so float
 *     drift is structurally impossible.
 *
 * Invoice sinks (push to Stripe, post to QuickBooks, mail a PDF)
 * live OUTSIDE this package, in `@absolutejs/billing-adapters/*`.
 * Keeping the substrate pure means the control plane can preview
 * invoices, run dry-run "would-charge" projections, and replay an
 * old usage snapshot through a new plan without touching any
 * vendor SDK.
 */

// =============================================================================
// Money primitives
// =============================================================================

/** Integer micros — 1,000,000 micros = 1 unit of the currency. */
export type Micros = number;

/**
 * Round a fractional micros value to an integer. The substrate uses
 * **truncation** (banker's-style would surprise callers expecting
 * "$0.0009 → $0.00" not "$0.0009 → $0.001"). Plans override per-plan.
 */
export type Rounding = "truncate" | "round-half-up";

const roundMicros = (value: number, rounding: Rounding): Micros => {
  if (rounding === "truncate") return Math.trunc(value);
  return Math.round(value);
};

// =============================================================================
// Pricing config
// =============================================================================

/**
 * One step in a graduated-tier price table. `upTo` is the inclusive
 * upper bound (in metered units, NOT micros) for this band.
 * `perUnitMicros` is what the customer pays per single metered unit
 * within this band. The last entry must have `upTo: Infinity` to
 * cover any overflow.
 */
export type PricingTier = {
  upTo: number;
  perUnitMicros: number;
};

/**
 * Per-dimension pricing. Three shapes:
 *
 *   - Flat per-unit: `{ perUnitMicros: 200, unit: 1024 * 1024 }`
 *     charges 200 micros ($0.0002) per MB of usage.
 *
 *   - Tiered: `{ tiers: [...], unit: 1 }` charges per the first
 *     matching `PricingTier` band.
 *
 *   - Custom: `{ price: (quantity) => micros, unit: 1 }` — escape
 *     hatch for surge / caps / non-monotonic pricing. The substrate
 *     stays pure; you ship whatever function you want.
 *
 * `freeTier` is subtracted from the metered quantity BEFORE pricing
 * — the conventional "first N units free" rule.
 *
 * `unit` is the metered-unit denominator: 1 means "price per single
 * metered unit", 1024*1024 means "price per MB when quantity is in
 * bytes." Default 1.
 *
 * `label` overrides the line-item display name.
 */
export type PricedDimension = {
  label?: string;
  freeTier?: number;
  unit?: number;
} & (
  | { perUnitMicros: number; tiers?: never; price?: never }
  | { tiers: PricingTier[]; perUnitMicros?: never; price?: never }
  | {
      price: (chargedQuantity: number) => Micros;
      perUnitMicros?: never;
      tiers?: never;
    }
);

export type Plan = {
  /** Human label for the invoice (`'pro'`, `'enterprise'`, etc.). */
  name: string;
  /** Optional flat base fee charged once per invoice period. */
  basePriceMicros?: Micros;
  /**
   * Dimensions priced from usage. Keys must match keys on the
   * `usage` record passed to `computeInvoice`. Anything not listed
   * is ignored.
   */
  pricedDimensions: Record<string, PricedDimension>;
  /** Default currency for invoices generated from this plan. */
  currency?: string;
  /** Rounding strategy applied per line item. Default `'truncate'`. */
  rounding?: Rounding;
  /**
   * Minimum charge (in micros) — if the computed total is below
   * this floor, the invoice total is raised to the floor and a
   * single `'minimum-charge-adjustment'` line item captures the
   * difference. Defaults to 0 (no floor).
   */
  minimumChargeMicros?: Micros;
  /** Arbitrary plan-level metadata that flows through to invoices. */
  metadata?: Record<string, string>;
};

export const createPlan = (plan: Plan): Plan => {
  for (const [key, dim] of Object.entries(plan.pricedDimensions)) {
    if (dim.tiers !== undefined) {
      if (dim.tiers.length === 0) {
        throw new Error(`billing: dimension '${key}' has no tiers`);
      }
      const last = dim.tiers[dim.tiers.length - 1];
      if (last !== undefined && Number.isFinite(last.upTo)) {
        throw new Error(
          `billing: dimension '${key}' final tier must have upTo: Infinity`,
        );
      }
      let prev = 0;
      for (let i = 0; i < dim.tiers.length; i += 1) {
        const tier = dim.tiers[i]!;
        if (tier.upTo < prev) {
          throw new Error(
            `billing: dimension '${key}' tier #${i} upTo (${tier.upTo}) must be >= previous (${prev})`,
          );
        }
        prev = tier.upTo;
      }
    }
  }
  return plan;
};

// =============================================================================
// Invoice shape
// =============================================================================

export type LineItem = {
  /**
   * Stable key for the line item. For priced dimensions it's the
   * usage-record key (`'requests'`, `'cpuMs'`, etc.). For the base
   * fee it's `'base'`. For minimum-charge top-up it's
   * `'minimum-charge-adjustment'`.
   */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Metered units BEFORE applying free tier. 0 for the base fee. */
  quantity: number;
  /** Metered units AFTER applying free tier (what's actually charged). */
  chargedQuantity: number;
  /** Free-tier units subtracted from `quantity`. */
  freeTier?: number;
  /** Charge for this line in integer micros. */
  amountMicros: Micros;
  /**
   * Tier-by-tier breakdown when graduated pricing was used. Each
   * entry: `{ tierIndex, unitsInTier, perUnitMicros, amountMicros }`.
   */
  tierBreakdown?: Array<{
    tierIndex: number;
    unitsInTier: number;
    perUnitMicros: number;
    amountMicros: Micros;
  }>;
};

export type InvoicePeriod = {
  /** Inclusive period start (`Date.now()` ms). */
  start: number;
  /** Exclusive period end. */
  end: number;
};

export type Invoice = {
  tenant: string;
  plan: string;
  currency: string;
  period: InvoicePeriod;
  lineItems: LineItem[];
  /** Sum of all `lineItems[].amountMicros`. */
  totalMicros: Micros;
  /** Convenience: `totalMicros / 1_000_000` as a number. */
  totalUnits: number;
  /** Plan-level metadata copied through unchanged. */
  metadata?: Record<string, string>;
};

// =============================================================================
// Pricing math
// =============================================================================

type ComputeDimensionInput = {
  quantity: number;
  dim: PricedDimension;
  rounding: Rounding;
};

type ComputeDimensionResult = {
  amountMicros: Micros;
  chargedQuantity: number;
  tierBreakdown?: LineItem["tierBreakdown"];
};

const computeDimension = ({
  quantity,
  dim,
  rounding,
}: ComputeDimensionInput): ComputeDimensionResult => {
  const free = dim.freeTier ?? 0;
  const charged = Math.max(0, quantity - free);
  const unit = dim.unit ?? 1;
  const chargedUnits = unit === 1 ? charged : charged / unit;

  if (dim.perUnitMicros !== undefined) {
    const amountMicros = roundMicros(
      chargedUnits * dim.perUnitMicros,
      rounding,
    );
    return { amountMicros, chargedQuantity: charged };
  }

  if (dim.price !== undefined) {
    const amountMicros = roundMicros(dim.price(charged), rounding);
    return { amountMicros, chargedQuantity: charged };
  }

  // Tiered pricing — walk tiers, allocate chargedUnits into bands.
  const tierBreakdown: NonNullable<LineItem["tierBreakdown"]> = [];
  let remaining = chargedUnits;
  let bandFloor = 0;
  let totalMicros = 0;
  for (let i = 0; i < dim.tiers!.length && remaining > 0; i += 1) {
    const tier = dim.tiers![i]!;
    const bandWidth = tier.upTo - bandFloor;
    const unitsInTier = Math.min(remaining, bandWidth);
    if (unitsInTier > 0) {
      const tierMicros = roundMicros(
        unitsInTier * tier.perUnitMicros,
        rounding,
      );
      tierBreakdown.push({
        amountMicros: tierMicros,
        perUnitMicros: tier.perUnitMicros,
        tierIndex: i,
        unitsInTier,
      });
      totalMicros += tierMicros;
    }
    remaining -= unitsInTier;
    bandFloor = tier.upTo;
  }
  return {
    amountMicros: totalMicros,
    chargedQuantity: charged,
    tierBreakdown,
  };
};

// =============================================================================
// computeInvoice — pure
// =============================================================================

export type ComputeInvoiceInput = {
  plan: Plan;
  tenant: string;
  period: InvoicePeriod;
  /** Metered numbers keyed by the same names as `plan.pricedDimensions`. */
  usage: Record<string, number>;
  /** Override the plan's currency (e.g. for tenant-local invoicing). */
  currency?: string;
};

export const computeInvoice = ({
  plan,
  tenant,
  period,
  usage,
  currency,
}: ComputeInvoiceInput): Invoice => {
  const rounding = plan.rounding ?? "truncate";
  const lineItems: LineItem[] = [];

  if (plan.basePriceMicros !== undefined && plan.basePriceMicros > 0) {
    lineItems.push({
      amountMicros: plan.basePriceMicros,
      chargedQuantity: 1,
      key: "base",
      label: `${plan.name} base fee`,
      quantity: 1,
    });
  }

  for (const [key, dim] of Object.entries(plan.pricedDimensions)) {
    const quantity = usage[key] ?? 0;
    if (!Number.isFinite(quantity) || quantity < 0) continue;
    const result = computeDimension({ dim, quantity, rounding });
    if (result.amountMicros === 0 && result.chargedQuantity === 0) continue;
    const item: LineItem = {
      amountMicros: result.amountMicros,
      chargedQuantity: result.chargedQuantity,
      key,
      label: dim.label ?? key,
      quantity,
    };
    if (dim.freeTier !== undefined) item.freeTier = dim.freeTier;
    if (result.tierBreakdown !== undefined && result.tierBreakdown.length > 0) {
      item.tierBreakdown = result.tierBreakdown;
    }
    lineItems.push(item);
  }

  let totalMicros = lineItems.reduce((sum, item) => sum + item.amountMicros, 0);

  const floor = plan.minimumChargeMicros ?? 0;
  if (floor > 0 && totalMicros < floor) {
    const gap = floor - totalMicros;
    lineItems.push({
      amountMicros: gap,
      chargedQuantity: 1,
      key: "minimum-charge-adjustment",
      label: "Minimum charge adjustment",
      quantity: 1,
    });
    totalMicros = floor;
  }

  const invoice: Invoice = {
    currency: currency ?? plan.currency ?? "usd",
    lineItems,
    period,
    plan: plan.name,
    tenant,
    totalMicros,
    totalUnits: totalMicros / 1_000_000,
  };
  if (plan.metadata !== undefined) invoice.metadata = plan.metadata;
  return invoice;
};

// =============================================================================
// Display helpers
// =============================================================================

/**
 * Format an integer micros amount as a human currency string. Pure
 * — no Intl side effects. For locales / advanced formatting, pipe
 * through `Intl.NumberFormat` yourself.
 */
export const formatMicros = (
  amount: Micros,
  currency: string,
  { minorUnits = 2 }: { minorUnits?: number } = {},
): string => {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const wholeMicrosPerMinor = 10 ** (6 - minorUnits);
  const minorTotal = Math.round(abs / wholeMicrosPerMinor);
  const divisor = 10 ** minorUnits;
  const whole = Math.trunc(minorTotal / divisor);
  const upper = currency.toUpperCase();
  if (minorUnits === 0) return `${sign}${whole} ${upper}`;
  const fraction = minorTotal % divisor;
  const fractionStr = fraction.toString().padStart(minorUnits, "0");
  return `${sign}${whole}.${fractionStr} ${upper}`;
};

// Provider balances — read upstream vendors' real balance/quota/spend (the
// inverse of computeInvoice). See ./balances.
export {
  readProviderBalances,
  type ProviderBalance,
  type ProviderBalanceConfig,
  type ProviderBalanceKind,
  type ProviderBalanceStatus,
  type BraveUsageSnapshot,
} from "./balances";
