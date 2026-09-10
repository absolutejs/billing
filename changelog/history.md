# @absolutejs/billing changelog

## 0.1.0 — 2026-05-31

Initial release. Closes G13 from the second-pass PaaS audit — the
substrate now has a pure cost-model layer between
`@absolutejs/metering` and any invoicing backend.

### Added

- **`createPlan({ name, basePriceMicros?, pricedDimensions,
currency?, rounding?, minimumChargeMicros?, metadata? })`** —
  declarative pricing config. Validates tiered dimensions at
  construction: non-empty, final tier must be `upTo: Infinity`,
  bounds must be monotonically non-decreasing.
- **`computeInvoice({ plan, period, tenant, usage, currency? })`**
  — pure function. Returns `{ tenant, plan, currency, period,
lineItems, totalMicros, totalUnits, metadata? }`.
- **Three pricing shapes** per dimension: flat `perUnitMicros`,
  graduated `tiers`, or custom `price(quantity) => micros`.
- **`freeTier`** per dimension subtracted before pricing.
- **`unit`** divisor so `bytesEgress` priced as MB ↔ `unit:
1024*1024`.
- **Rounding modes**: `'truncate'` (default — sub-cent → $0.00 to
  match operator intuition) and `'round-half-up'`.
- **`minimumChargeMicros`** floor with an explicit
  `'minimum-charge-adjustment'` line item that captures the gap
  (transparent, not magical).
- **`formatMicros(amount, currency, { minorUnits? })`** — pure
  string formatter, honors zero-minor-unit currencies (JPY etc.).
- **All money in integer micros** (1/1,000,000 of a unit) — same
  denomination Stripe uses internally. Float drift structurally
  impossible.

### Design notes

- Pure functions throughout — no IO, no SDK peers, no side effects.
  The control plane can preview invoices, re-price past periods
  under a proposed plan, and dry-run plan changes without touching
  any external system.
- Invoice push (Stripe, QuickBooks, mailed PDF) lives OUTSIDE this
  package in `@absolutejs/billing-adapters/*`.
- Substrate is intentionally policy-free: it doesn't pick the plan
  for a tenant, doesn't fetch usage, doesn't store invoices. Those
  are control-plane concerns.

### Tests

34 covering: tier validation; flat per-unit; zero / missing /
negative / NaN usage; free tier (below / above / at boundary);
unit divisor + truncation + round-half-up; tiered (single band /
multi-band / unbounded final); tiered + free tier composition;
custom price fn; chargedQuantity passed to custom fn; base fee
emission + suppression-when-zero; minimum-charge top-up + no-op
when above floor; currency defaults + override; metadata
flow-through; realistic full-Usage shape; label override;
formatMicros (whole / sub-cent / negative / zero-minor-unit).

### License

BSL-1.1 with named carveout against hosted SaaS-billing platforms
(Metronome, Orb, Lago, Stripe Billing, m3ter, Chargebee). Change
date: 2030-05-31 (Apache 2.0).
