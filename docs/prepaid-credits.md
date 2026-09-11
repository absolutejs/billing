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
