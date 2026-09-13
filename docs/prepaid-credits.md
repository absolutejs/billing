# Prepaid service credits

Use `@absolutejs/billing/prepaid` for service-credit balances and `@absolutejs/billing/prepaid-postgres` for durable storage. These units are not currency and are not the assistant provider's model tokens. Host commerce permission, authentication, approval, and payment verification remain separate requirements.

`createCreditAccountLedger(store)` exposes `initialize`, `balance`, `receipt`, and `execute`. PostgreSQL stores initial state, current state, immutable operation receipts, and reservation state. Every command locks its account and commits its receipt and balance together. Operation IDs are scoped to the account; reuse with different normalized input fails. Identical retries return the historical receipt, so use `balance` for the current view.

## Accounting rules

- Purchased and promotional balances persist across renewals and subscription cancellation. Period IDs are canonical ISO UTC start timestamps and cannot move backwards. A same-period upgrade grants only the increase; downgrades take effect at the next period.
- Spending uses period credits, then promotional credits, then purchased credits. Reservations remove their allocation from availability immediately. Settlement charges at most the reservation and restores unused funds in reverse order. Unused expired-period credits are not restored into a later period.
- Reversals remove credits from their originating bucket and record any shortfall as debt. Future grants or available funds cover that debt exactly once. A reservation release also pays outstanding reversal debt before restoring spendable funds.
- `debit` is for already-metered usage. `allowDebt: true` is an explicit legacy/postpaid option; do not use it to authorize prepaid execution. Authorize prepaid work with reservations before an external effect.
- All amounts must be nonnegative safe integers. The database adapter supports PostgreSQL-compatible drivers through a parameterized SQL port and real transactions. Never implement its transaction method as independent pooled queries.

## Durable work with a maximum customer charge

Apply `creditAccountPostgresSchemaSql()` followed by `creditWorkPostgresSchemaSql()`. `createPostgresCreditWork(client)` offers:

1. `begin(accountId, workId, requestDigest, budget)` reserves the budget and atomically claims execution. Run the effect only when `fresh` is true. A retry of running work must report pending; a finished retry returns its stored result. Bind the digest to the exact tool and arguments and bind account identity outside model input.
2. `record(accountId, workId, eventId, credits, eventDigest)` records measured usage once. Commit the application's usage row in the same outer transaction. It returns the customer charge; any provider usage beyond the agreed budget is tracked as `absorbed` rather than customer debt. Hosts should also bound provider calls, concurrency, time, and output, and stop starting additional work when the budget is exhausted.
3. After all metering writes complete, `finish(accountId, workId, result, failed)` settles measured charges and releases unused credit. A failed task still charges its measured usage. Persisted result retrieval must check the authenticated account.

A process crash or unknown effect outcome deliberately leaves work running and its reservation held. Do not automatically replay it or release the hold merely because time passed. Reconcile the effect and metering before finishing it. This is an at-most-once execution claim with an explicit uncertain state, not a guarantee that an external provider executes exactly once.

## Migrating a mixed legacy balance

`migrateLegacyCreditAccount` preserves `max(0, periodAllowance + bonusCredits - consumed)` without inventing historical purchase provenance. It first allocates known current-period consumption against period allowance, carries only the residual bonus balance, and records any deficit. Legacy carryover is classified as promotional because the old mixed column cannot prove which credits were purchased. Keep the original row and its payment/usage history as immutable migration evidence. Future verified purchases go to the purchased bucket.

Dry-run all accounts, compare current availability before and after, and separately review ambiguous historical purchase allocation before changing customer balances or claiming a reconstructed purchase balance. Run under a writer drain or account-level locks; block legacy writers after cutover. Never roll back by re-enabling the old balance formula, which would restore spent permanent credits. An operational rollback should disable new paid work while keeping the new ledger and recovery reads available.

## PostgreSQL driver JSON encoding

Version 0.9.1 binds serialized JSON through `::text::jsonb`. Direct postgres.js infers JSON parameters and otherwise JSON-encodes strings a second time; adapters such as Drizzle override that serializer, which can hide the defect in adapter-only tests. This applies to account state, immutable operation receipts, reservations, work records and checkout quotes.

For a real-driver regression, set `BILLING_TEST_DATABASE_URL` to a test database and run `bun test tests/postgresJson.test.ts`. It creates and removes a unique schema containing only synthetic records. The ordinary suite skips this test when the database is absent. Existing double-encoded rows need a separately reviewed repair; updating the package does not rewrite financial records. Preserve originals and verify semantic value equality before committing any repair.

## Deferred worker handoff

`createPostgresCreditWork` supports `handoff`, `resumeDeferred` and
`finishDeferred`. Bind an account-owned work reservation to the exact durable
`effectId` and immutable `authorizationId`. Call `begin`, `handoff` and the outbox
insert using one application transaction (a transaction-bound SQL client).
Approval must bind the reviewed input and explicit maximum credits before enqueue.
These methods reuse the existing JSON work state; no new DDL is required.

A worker must hold its execution claim and validate account, effect and action
identity before `resumeDeferred`. Restore the saved budget and charged amount in
its metering context. Reattachment grants no provider authorization, lease or
retry permission. Drain every usage write before finishing. Settle only a durable
`succeeded` or definite terminal `failed` outcome. `unknown`, metering uncertainty,
and nonterminal retries retain the reservation. Recovery of a completed effect
may retry settlement, never execution. `finish` refuses transferred work;
`finishDeferred` validates its binding even for repeated terminal calls.

Charges remain capped at the approved budget; overruns are absorbed. Unused
credits are released only on definite settlement. An unknown external outcome
requires the application's audited reconciliation process before settlement or
any replacement action. No automatic expiry release is safe for an uncertain send.

### Minimum-budget admission

Pass a trusted async fifth argument to `begin` returning `{ minimumCredits,
policy }`. It runs under the account lock only for a new work ID, before any
reservation. Rejecting or unavailable pricing rolls back without a claim. Exact
replays still validate the original input and budget, but never call admission.
Keep admission local and quick; do not call a provider while holding this lock.

The policy is persisted in `work.admission`. Workers can use
`canAffordCreditStep(budget, charged, minimumCredits)` after draining usage and
before marking a new provider step in flight. Use a conservative current estimate
and the persisted floor; stop with saved partial results when it no longer fits.
An estimate is not an authorization, guaranteed price, or provider-spend ceiling.
The explicit charge cap and absorbed overrun accounting still apply.
