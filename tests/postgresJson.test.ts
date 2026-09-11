import { expect, test } from "bun:test";
import postgres from "postgres";
import {
  createCreditAccountLedger,
  migrateLegacyCreditAccount,
} from "../src/prepaid";
import {
  createPostgresCreditAccountStore,
  creditAccountPostgresSchemaSql,
  type CreditSql,
  type CreditSqlClient,
} from "../src/prepaidPostgres";
import {
  createPostgresCreditWork,
  creditWorkPostgresSchemaSql,
} from "../src/creditWork";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
(databaseUrl ? test : test.skip)(
  "real postgres.js preserves JSON objects through ledger and work writes",
  async () => {
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    const schema = `billing_json_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const query =
      (connection: typeof sql | postgres.TransactionSql) =>
      async (statement: string, values: readonly unknown[]) => {
        const parameters = values.map((value) => {
          if (
            value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          )
            return value;
          throw Error("Expected primitive SQL parameter");
        });
        return {
          rows: [
            ...(await connection.unsafe<Record<string, unknown>[]>(
              statement,
              parameters,
            )),
          ],
        };
      };
    const client: CreditSqlClient = {
      query: query(sql),
      transaction: async <T>(run: (sql: CreditSql) => Promise<T>) => {
        let result!: T;
        await sql.begin(async (tx) => {
          result = await run({ query: query(tx) });
        });
        return result;
      },
    };
    try {
      await sql
        .unsafe(
          creditAccountPostgresSchemaSql(schema) +
            creditWorkPostgresSchemaSql(schema),
        )
        .simple();
      const ledger = createCreditAccountLedger(
        createPostgresCreditAccountStore(client, schema),
      );
      await ledger.initialize(
        "test",
        migrateLegacyCreditAccount({
          bonusCredits: 3,
          consumed: 0,
          periodAllowance: 0,
          periodId: "2026-09-01T00:00:00.000Z",
          periodEnd: null,
        }),
      );
      expect((await ledger.balance("test"))?.promotionalRemaining).toBe(3);
      await ledger.execute("test", "grant", {
        kind: "grant",
        bucket: "purchased",
        credits: 2,
      });
      expect(
        (await ledger.receipt("test", "grant"))?.account.purchasedRemaining,
      ).toBe(2);
      const work = createPostgresCreditWork(client, schema);
      const claim = await work.begin("test", "work", "digest", 2);
      expect(claim.fresh).toBe(true);
      await work.finish("test", "work", "done", false);
      expect((await work.get("test", "work"))?.status).toBe("completed");
      expect((await ledger.balance("test"))?.reserved).toBe(0);
      const rows = await sql.unsafe(
        `select jsonb_typeof(state) as kind from ${schema}.accounts union all select jsonb_typeof(state) from ${schema}.work union all select jsonb_typeof(state) from ${schema}.reservations union all select jsonb_typeof(receipt) from ${schema}.operations`,
      );
      expect(rows.length).toBeGreaterThan(4);
      expect(rows.every((row) => row.kind === "object")).toBe(true);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
  30000,
);
