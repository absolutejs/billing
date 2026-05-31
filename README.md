# `@absolutejs/billing`

> Cost-model substrate for the AbsoluteJS PaaS.

`@absolutejs/billing` is the pure-function layer between
`@absolutejs/metering` (which collects usage events) and an
invoicing backend (Stripe, QuickBooks, an internal billing engine).

It does two things:

1. **`createPlan(...)`** — declares a priced product: optional flat
   base fee, per-dimension unit prices, optional graduated tiers,
   optional per-dimension free allowances.
2. **`computeInvoice({ plan, period, tenant, usage })`** — pure
   function that turns a `Usage` snapshot into an `Invoice` with
   line items and a total.

All money math is done in integer **micros** (1 micro = 1/1,000,000
of a currency unit — the same denomination Stripe stores prices in
internally). Float drift is structurally impossible: a $0.0002
per-request price is `200` and rounding policy is explicit.

```ts
import { createPlan, computeInvoice, formatMicros } from '@absolutejs/billing';

const plan = createPlan({
  name: 'pro',
  currency: 'usd',
  basePriceMicros: 20_000_000, // $20/mo
  pricedDimensions: {
    requests:             { perUnitMicros: 200, freeTier: 1_000_000 },
    cpuMs:                { perUnitMicros: 50, unit: 1000, freeTier: 60_000 * 60 * 10 },
    bytesEgress:          { perUnitMicros: 100, unit: 1024 * 1024, freeTier: 100 * 1024 * 1024 },
    hibernationGbSeconds: { perUnitMicros: 5 },
  },
});

const invoice = computeInvoice({
  plan,
  tenant: 'acme',
  period: { start, end },
  usage, // a Usage from @absolutejs/metering
});

console.log(formatMicros(invoice.totalMicros, invoice.currency));
// "27.50 USD"
```

## Pricing shapes

A `PricedDimension` is one of three:

- **Flat per-unit** — `{ perUnitMicros: 200, unit: 1 }`
- **Tiered (graduated)** — `{ tiers: [{ upTo: 1_000_000, perUnitMicros: 200 }, { upTo: Infinity, perUnitMicros: 100 }] }`
- **Custom** — `{ price: (chargedQuantity) => micros }` (escape hatch for surge / caps / non-monotonic pricing)

Optional knobs:

- **`freeTier`** — units subtracted before pricing
- **`unit`** — divisor so `bytesEgress` priced as MB ↔ `unit:
  1024*1024`
- **`label`** — invoice line-item display name

Plan-level knobs:

- **`basePriceMicros`** — flat fee per period
- **`minimumChargeMicros`** — floor; an adjustment line item fills
  any gap
- **`rounding`** — `'truncate'` (default; sub-cent → $0.00) or
  `'round-half-up'`
- **`currency`** — display label; not converted
- **`metadata`** — arbitrary keys that flow through to the invoice

## Why pure?

The control plane needs to:

- **Preview** an upcoming invoice before the period closes
- **Re-price** a past period under a new plan ("what would this
  customer have paid on the proposed enterprise tier?")
- **Dry-run** plan changes before publishing them

A pure cost-model function makes all three trivial — no Stripe SDK,
no side effects, no IO. The Stripe push (or QuickBooks export, or
mailed-PDF generator) lives outside this package, in
`@absolutejs/billing-adapters/*`.

## License

BSL-1.1 with named carveout against hosted SaaS billing platforms
(Metronome, Orb, Lago, Stripe Billing, m3ter, Chargebee). See
`LICENSE`. Change date: **2030-05-31** → Apache 2.0.
