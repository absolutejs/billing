import type { CreditSqlClient } from "./prepaidPostgres";
export type ProviderReservation = {
  id: string;
  scope: string;
  period: string;
  reservedMicros: number;
  status: "reserved" | "fulfilled" | "rejected" | "unknown";
  actualMicros: number | null;
};
/** Host supplies a journaled table; every writer locks the same scope before admission. */
export const createProviderBudget = (
  client: CreditSqlClient,
  table = "provider_request_budget",
) => {
  if (!/^[a-z][a-z0-9_]*$/u.test(table))
    throw new Error("Invalid provider budget table");
  const integer = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Budget amounts must be nonnegative integer micros");
  };
  return {
    reserve: async (input: {
      id: string;
      scope: string;
      period: string;
      reserveMicros: number;
      maxMicros: number;
      maxRequests: number;
    }) => {
      [input.reserveMicros, input.maxMicros, input.maxRequests].forEach(
        integer,
      );
      if (!input.id || !input.scope || !input.period)
        throw new Error("Budget identity required");
      return client.transaction(async (sql) => {
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`provider-budget:${input.scope}:${input.period}`],
        );
        const existing = await sql.query(
          `SELECT id FROM ${table} WHERE id = $1`,
          [input.id],
        );
        // Reservations are single-use admission tokens; repeated IDs never authorize another request.
        if (existing.rows.length) return false;
        const usage = await sql.query(
          `SELECT count(*) FILTER (WHERE status <> 'rejected') AS requests, coalesce(sum(CASE WHEN status = 'rejected' THEN 0 ELSE coalesce(actual_micros, reserved_micros) END),0) AS micros FROM ${table} WHERE scope = $1 AND period = $2`,
          [input.scope, input.period],
        );
        const row = usage.rows[0];
        if (
          Number(row?.requests ?? 0) >= input.maxRequests ||
          Number(row?.micros ?? 0) + input.reserveMicros > input.maxMicros
        )
          return false;
        await sql.query(
          `INSERT INTO ${table} (id,scope,period,reserved_micros,status) VALUES ($1,$2,$3,$4,'reserved')`,
          [input.id, input.scope, input.period, input.reserveMicros],
        );
        return true;
      });
    },
    settle: async (
      id: string,
      status: "fulfilled" | "rejected" | "unknown",
      actualMicros: number | null,
    ) => {
      if (actualMicros !== null) integer(actualMicros);
      if (status === "rejected" && actualMicros !== 0)
        throw new Error("Rejected requests have zero cost");
      if (status === "unknown" && actualMicros !== null)
        throw new Error("Unknown outcomes must retain the full reservation");
      if (status === "fulfilled" && actualMicros === null)
        throw new Error("Fulfilled settlement requires known cost");
      // Unknown and interrupted attempts retain their reservation until reconciled.
      await client.query(
        `UPDATE ${table} SET status = $2, actual_micros = $3 WHERE id = $1 AND status IN ('reserved','unknown')`,
        [id, status, actualMicros],
      );
    },
  };
};
