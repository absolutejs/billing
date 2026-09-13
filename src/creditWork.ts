import { createCreditAccountLedger } from "./prepaid";
import {
  createPostgresCreditAccountStore,
  type CreditSql,
  type CreditSqlClient,
} from "./prepaidPostgres";
export type DeferredCreditBinding = {
  effectId: string;
  authorizationId: string;
};
/** Trusted server-side admission policy, evaluated only for a new claim.
 * This is an estimate-based floor, not a provider-cost guarantee or authorization. */
export type CreditWorkAdmission = { minimumCredits: number; policy: string };
export const canAffordCreditStep = (budget: number, charged: number, minimumCredits: number) => {
  if (![budget, charged, minimumCredits].every(Number.isSafeInteger) || budget < 1 || charged < 0 || charged > budget || minimumCredits < 1)
    throw new Error("Invalid credit step budget");
  return budget - charged >= minimumCredits;
};
export type CreditWork = {
  admission?: CreditWorkAdmission;
  deferred?: DeferredCreditBinding;
  checkpoint?: { revision: number; value: string };
  request: string;
  budget: number;
  charged: number;
  absorbed: number;
  status: "running" | "completed" | "failed";
  result: string | null;
};
const namespace = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error("Invalid credit schema name");
  return value;
};
const id = (value: string) => {
  if (!value || value.length > 128) throw new Error("Invalid credit work ID");
};
const integer = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid credit work amount");
};
export const creditWorkPostgresSchemaSql = (schema = "billing_credits") => {
  const n = namespace(schema);
  return `CREATE TABLE IF NOT EXISTS ${n}.work (
    account_id text NOT NULL REFERENCES ${n}.accounts(account_id), work_id text NOT NULL,
    state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(account_id, work_id)
  );
  CREATE TABLE IF NOT EXISTS ${n}.work_usage (
    account_id text NOT NULL, work_id text NOT NULL, event_id text NOT NULL,
    credits bigint NOT NULL CHECK (credits >= 0), charged bigint NOT NULL CHECK (charged >= 0 AND charged <= credits), reference text NOT NULL,
    PRIMARY KEY(account_id, work_id, event_id), FOREIGN KEY(account_id, work_id) REFERENCES ${n}.work(account_id, work_id)
  );`;
};
/** Durable execution claim + capped customer charge. A crash leaves work running
 * and its credits held: never automatically rerun an uncertain external effect.
 * Provider cost over the agreed budget is recorded as absorbed, not customer debt. */
export const createPostgresCreditWork = (
  client: CreditSqlClient,
  schema = "billing_credits",
) => {
  const n = namespace(schema);
  const read = async (sql: CreditSql, accountId: string, workId: string) => {
    const { rows } = await sql.query(
      `SELECT state FROM ${n}.work WHERE account_id = $1 AND work_id = $2 FOR UPDATE`,
      [accountId, workId],
    );
    return rows[0]?.state as CreditWork | undefined;
  };
  const save = (
    sql: CreditSql,
    accountId: string,
    workId: string,
    state: CreditWork,
  ) =>
    sql.query(
      `UPDATE ${n}.work SET state = $3::text::jsonb, updated_at = now() WHERE account_id = $1 AND work_id = $2`,
      [accountId, workId, JSON.stringify(state)],
    );
  const ledger = (sql: CreditSql) =>
    createCreditAccountLedger(
      createPostgresCreditAccountStore(
        { ...sql, transaction: (run) => run(sql) },
        schema,
      ),
    );
  const bindingMatches = (work: CreditWork, binding: DeferredCreditBinding) => {
    id(binding.effectId);
    id(binding.authorizationId);
    if (
      work.deferred?.effectId !== binding.effectId ||
      work.deferred.authorizationId !== binding.authorizationId
    )
      throw new Error("Deferred credit authorization mismatch");
  };
  const finish = (
    accountId: string,
    workId: string,
    result: string,
    failed: boolean,
    binding?: DeferredCreditBinding,
  ) => {
    id(accountId);
    id(workId);
    return client.transaction(async (sql) => {
      await sql.query(
        `SELECT account_id FROM ${n}.accounts WHERE account_id = $1 FOR UPDATE`,
        [accountId],
      );
      const work = await read(sql, accountId, workId);
      if (!work) throw new Error("Credit work does not exist");
      if (binding) bindingMatches(work, binding);
      else if (work.deferred)
        throw new Error("Deferred work requires its bound worker outcome");
      if (work.status !== "running") return work;
      await ledger(sql).execute(accountId, `work-settle:${workId}`, {
        kind: "settle",
        reservationId: `work:${workId}`,
        credits: work.charged,
      });
      work.status = failed ? "failed" : "completed";
      work.result = result;
      await save(sql, accountId, workId, work);
      return work;
    });
  };
  return {
    /** Bound durable progress only: the caller must already own the effect lease.
     * CAS prevents stale workers from overwriting a newer checkpoint. */
    checkpointDeferred: (
      accountId: string,
      workId: string,
      binding: DeferredCreditBinding,
      expectedRevision: number,
      value: string,
    ) => {
      id(accountId);
      id(workId);
      integer(expectedRevision);
      if (expectedRevision === Number.MAX_SAFE_INTEGER || typeof value !== "string" || value.length > 1_000_000)
        throw new Error("Invalid credit work checkpoint");
      return client.transaction(async (sql) => {
        const work = await read(sql, accountId, workId);
        if (!work) throw new Error("Credit work does not exist");
        bindingMatches(work, binding);
        if (work.status !== "running") throw new Error("Credit work already finished");
        if ((work.checkpoint?.revision ?? 0) !== expectedRevision)
          throw new Error("Credit work checkpoint revision mismatch");
        work.checkpoint = { revision: expectedRevision + 1, value };
        await save(sql, accountId, workId, work);
        return work.checkpoint;
      });
    },
    /** Call inside the same transaction as begin, authorization binding and outbox
     * enqueue. This transfers a reservation, never starts work or grants a lease. */
    handoff: (
      accountId: string,
      workId: string,
      binding: DeferredCreditBinding,
    ) => {
      id(accountId);
      id(workId);
      id(binding.effectId);
      id(binding.authorizationId);
      return client.transaction(async (sql) => {
        const work = await read(sql, accountId, workId);
        if (!work) throw new Error("Credit work does not exist");
        if (work.deferred) {
          bindingMatches(work, binding);
          return work;
        }
        if (work.status !== "running")
          throw new Error("Credit work already finished");
        work.deferred = {
          effectId: binding.effectId,
          authorizationId: binding.authorizationId,
        };
        await save(sql, accountId, workId, work);
        return work;
      });
    },
    /** Trusted worker reattaches accounting after its durable execution claim.
     * This is NOT execution authorization or permission to retry a provider. */
    resumeDeferred: (
      accountId: string,
      workId: string,
      binding: DeferredCreditBinding,
    ) => {
      id(accountId);
      id(workId);
      return client.transaction(async (sql) => {
        const work = await read(sql, accountId, workId);
        if (!work) throw new Error("Credit work does not exist");
        bindingMatches(work, binding);
        return work;
      });
    },
    /** Settle only a durable terminal result after all usage writes are drained.
     * Unknown outcomes keep credits reserved and require operator reconciliation. */
    finishDeferred: async (
      accountId: string,
      workId: string,
      binding: DeferredCreditBinding,
      outcome: "succeeded" | "failed" | "unknown",
      result: string,
    ) => {
      if (
        outcome !== "succeeded" &&
        outcome !== "failed" &&
        outcome !== "unknown"
      )
        throw new Error("Invalid deferred outcome");
      if (outcome !== "unknown")
        return finish(accountId, workId, result, outcome === "failed", binding);
      id(accountId);
      id(workId);
      return client.transaction(async (sql) => {
        const work = await read(sql, accountId, workId);
        if (!work) throw new Error("Credit work does not exist");
        bindingMatches(work, binding);
        return work;
      });
    },
    get: (accountId: string, workId: string) => {
      id(accountId);
      id(workId);
      return client.transaction(
        async (sql) => (await read(sql, accountId, workId)) ?? null,
      );
    },
    begin: (
      accountId: string,
      workId: string,
      request: string,
      budget: number,
      admit?: () => Promise<CreditWorkAdmission>,
    ) => {
      id(accountId);
      id(workId);
      integer(budget);
      if (!budget || !request || request.length > 256)
        throw new Error("Invalid credit work request");
      return client.transaction(async (sql) => {
        // One account lock serializes competing claims, including absent work rows.
        await sql.query(
          `SELECT account_id FROM ${n}.accounts WHERE account_id = $1 FOR UPDATE`,
          [accountId],
        );
        const existing = await read(sql, accountId, workId);
        if (existing) {
          if (existing.request !== request || existing.budget !== budget)
            throw new Error("Credit work ID reused with different input");
          return { fresh: false, work: existing };
        }
        const admission = admit ? await admit() : undefined;
        if (admission) {
          if (typeof admission.policy !== "string" || !admission.policy || admission.policy.length > 256)
            throw new Error("Invalid credit admission policy");
          if (!canAffordCreditStep(budget, 0, admission.minimumCredits))
            throw new Error(`This work requires at least ${admission.minimumCredits} service credits. No credits reserved; request a new estimate and user-approved budget.`);
        }
        await ledger(sql).execute(accountId, `work-reserve:${workId}`, {
          kind: "reserve",
          reservationId: `work:${workId}`,
          credits: budget,
        });
        const work: CreditWork = {
          ...(admission ? { admission: { minimumCredits: admission.minimumCredits, policy: admission.policy } } : {}),
          request,
          budget,
          charged: 0,
          absorbed: 0,
          status: "running",
          result: null,
        };
        await sql.query(
          `INSERT INTO ${n}.work (account_id, work_id, state) VALUES ($1, $2, $3::text::jsonb)`,
          [accountId, workId, JSON.stringify(work)],
        );
        return { fresh: true, work };
      });
    },
    record: (
      accountId: string,
      workId: string,
      eventId: string,
      credits: number,
      reference: string,
    ) => {
      id(accountId);
      id(workId);
      id(eventId);
      integer(credits);
      id(reference);
      return client.transaction(async (sql) => {
        const work = await read(sql, accountId, workId);
        if (!work) throw new Error("Credit work does not exist");
        const { rows } = await sql.query(
          `SELECT credits, charged, reference FROM ${n}.work_usage WHERE account_id = $1 AND work_id = $2 AND event_id = $3`,
          [accountId, workId, eventId],
        );
        const previous = rows[0];
        if (previous) {
          if (
            Number(previous.credits) !== credits ||
            previous.reference !== reference
          )
            throw new Error("Credit work event reused with different input");
          return { charged: Number(previous.charged), fresh: false };
        }
        if (work.status !== "running")
          throw new Error("Credit work already finished");
        const charged = Math.min(credits, work.budget - work.charged);
        work.charged += charged;
        work.absorbed += credits - charged;
        integer(work.charged);
        integer(work.absorbed);
        await sql.query(
          `INSERT INTO ${n}.work_usage (account_id, work_id, event_id, credits, charged, reference) VALUES ($1, $2, $3, $4, $5, $6)`,
          [accountId, workId, eventId, credits, charged, reference],
        );
        await save(sql, accountId, workId, work);
        return { charged, fresh: true };
      });
    },
    finish: (
      accountId: string,
      workId: string,
      result: string,
      failed = false,
    ) => finish(accountId, workId, result, failed),
  };
};
