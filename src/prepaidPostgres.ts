import {
  validateCreditAccount,
  type CreditAccount,
  type CreditAccountStore,
  type CreditReceipt,
  type CreditReservation,
} from "./prepaid";
export type CreditSql = {
  query: (
    query: string,
    parameters: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};
export type CreditSqlClient = CreditSql & {
  transaction: <T>(run: (sql: CreditSql) => Promise<T>) => Promise<T>;
};
const namespace = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error("Invalid credit schema name");
  return value;
};
export const creditAccountPostgresSchemaSql = (schema = "billing_credits") => {
  const n = namespace(schema);
  return `CREATE SCHEMA IF NOT EXISTS ${n};
CREATE TABLE IF NOT EXISTS ${n}.accounts (
  account_id text PRIMARY KEY, state jsonb NOT NULL, initial_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${n}.operations (
  account_id text NOT NULL REFERENCES ${n}.accounts(account_id), operation_id text NOT NULL,
  receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (account_id, operation_id)
);
CREATE TABLE IF NOT EXISTS ${n}.reservations (
  account_id text NOT NULL REFERENCES ${n}.accounts(account_id), reservation_id text NOT NULL,
  state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (account_id, reservation_id)
);`;
};
export const createPostgresCreditAccountStore = (
  client: CreditSqlClient,
  schema = "billing_credits",
): CreditAccountStore => {
  const n = namespace(schema);
  const read = async (sql: CreditSql, accountId: string, lock = false) => {
    const { rows } = await sql.query(
      `SELECT state FROM ${n}.accounts WHERE account_id = $1${lock ? " FOR UPDATE" : ""}`,
      [accountId],
    );
    if (!rows[0]) return null;
    const state = rows[0].state as CreditAccount;
    validateCreditAccount(state);
    return state;
  };
  return {
    initialize: async (accountId, seed) => {
      validateCreditAccount(seed);
      await client.query(
        `INSERT INTO ${n}.accounts (account_id, state, initial_state) VALUES ($1, $2::jsonb, $2::jsonb) ON CONFLICT DO NOTHING`,
        [accountId, JSON.stringify(seed)],
      );
    },
    read: (accountId) => read(client, accountId),
    transaction: (accountId, run) =>
      client.transaction(async (sql) => {
        const account = await read(sql, accountId, true);
        if (!account) throw new Error("Credit account is not initialized");
        return run({
          account,
          receipt: async (operationId) => {
            const { rows } = await sql.query(
              `SELECT receipt FROM ${n}.operations WHERE account_id = $1 AND operation_id = $2`,
              [accountId, operationId],
            );
            return (rows[0]?.receipt as CreditReceipt | undefined) ?? null;
          },
          reservation: async (id) => {
            const { rows } = await sql.query(
              `SELECT state FROM ${n}.reservations WHERE account_id = $1 AND reservation_id = $2`,
              [accountId, id],
            );
            return (rows[0]?.state as CreditReservation | undefined) ?? null;
          },
          save: async (operationId, receipt) => {
            await sql.query(
              `UPDATE ${n}.accounts SET state = $2::jsonb, updated_at = now() WHERE account_id = $1`,
              [accountId, JSON.stringify(receipt.account)],
            );
            if (receipt.reservation)
              await sql.query(
                `INSERT INTO ${n}.reservations (account_id, reservation_id, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (account_id, reservation_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
                [
                  accountId,
                  receipt.reservation.id,
                  JSON.stringify(receipt.reservation),
                ],
              );
            await sql.query(
              `INSERT INTO ${n}.operations (account_id, operation_id, receipt) VALUES ($1, $2, $3::jsonb)`,
              [accountId, operationId, JSON.stringify(receipt)],
            );
          },
        });
      }),
  };
};
