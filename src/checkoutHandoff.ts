import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CreditSqlClient } from "./prepaidPostgres";

export type CheckoutQuote = {
  productId: string;
  amountCents: number;
  currency: string;
  credits: number;
};
export type CheckoutHandoff = {
  id: string;
  accountId: string;
  quote: CheckoutQuote;
  expiresAt: number;
  paymentLocked: boolean;
  replacedBy: string | null;
};
const lifetimeMs = 15 * 60 * 1000;
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const validSecret = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const validQuote = (value: CheckoutQuote) =>
  typeof value.productId === "string" &&
  value.productId.length > 0 &&
  value.productId.length <= 128 &&
  Number.isSafeInteger(value.amountCents) &&
  value.amountCents > 0 &&
  /^[A-Z]{3}$/.test(value.currency) &&
  Number.isSafeInteger(value.credits) &&
  value.credits > 0;

/** Apply explicitly during deployment. Secrets are stored only as SHA-256 hashes. */
export const checkoutHandoffPostgresSchemaSql = () => `
CREATE SCHEMA IF NOT EXISTS billing_checkout;
CREATE TABLE IF NOT EXISTS billing_checkout.handoffs (
 id text PRIMARY KEY, account_id text NOT NULL, quote jsonb NOT NULL,
 code_hash text NOT NULL UNIQUE, expires_at bigint NOT NULL,
 session_hash text UNIQUE, csrf_hash text, session_expires_at bigint
);
ALTER TABLE billing_checkout.handoffs ADD COLUMN IF NOT EXISTS payment_locked boolean NOT NULL DEFAULT false;
ALTER TABLE billing_checkout.handoffs ADD COLUMN IF NOT EXISTS replaced_by text;
CREATE INDEX IF NOT EXISTS handoffs_account ON billing_checkout.handoffs(account_id, id);
`;
const decode = (
  row: Record<string, unknown> | undefined,
): CheckoutHandoff | null => {
  if (!row) return null;
  const quote = row.quote;
  if (
    !quote ||
    typeof quote !== "object" ||
    !("productId" in quote) ||
    !("amountCents" in quote) ||
    !("currency" in quote) ||
    !("credits" in quote) ||
    typeof quote.productId !== "string" ||
    typeof quote.amountCents !== "number" ||
    typeof quote.currency !== "string" ||
    typeof quote.credits !== "number" ||
    typeof row.id !== "string" ||
    typeof row.account_id !== "string"
  )
    throw new Error("Invalid checkout record");
  const parsed = {
    productId: quote.productId,
    amountCents: quote.amountCents,
    currency: quote.currency,
    credits: quote.credits,
  };
  if (!validQuote(parsed)) throw new Error("Invalid checkout quote");
  return {
    id: row.id,
    accountId: row.account_id,
    quote: parsed,
    expiresAt: Number(row.expires_at),
    paymentLocked: row.payment_locked === true,
    replacedBy: typeof row.replaced_by === "string" ? row.replaced_by : null,
  };
};
/** This is a purchase-only capability, never a login or a saved-card authorization.
 * The application binds the authenticated account and prices the quote. */
export const createPostgresCheckoutHandoffs = (
  db: CreditSqlClient,
  now = Date.now,
) => ({
  async issue(accountId: string, quote: CheckoutQuote) {
    if (!accountId || !validQuote(quote))
      throw new Error("Invalid checkout request");
    const code = secret();
    const id = randomUUID();
    const expiresAt = now() + lifetimeMs;
    await db.query(
      `INSERT INTO billing_checkout.handoffs(id,account_id,quote,code_hash,expires_at) VALUES ($1,$2,$3::text::jsonb,$4,$5)`,
      [id, accountId, JSON.stringify(quote), hash(code), expiresAt],
    );
    return { id, code, expiresAt };
  },
  /** Invoke only on a deliberate same-origin POST, never a preview GET.
   * Atomic exchange makes concurrent redemption and link replay fail closed. */
  async exchange(code: string, browserAccountId: string | null = null) {
    if (!validSecret(code)) return null;
    const session = secret();
    const csrf = secret();
    const expiresAt = now() + lifetimeMs;
    const { rows } = await db.query(
      `UPDATE billing_checkout.handoffs SET session_hash=$2,csrf_hash=$3,session_expires_at=$4 WHERE code_hash=$1 AND session_hash IS NULL AND expires_at>$5 AND ($6::text IS NULL OR account_id=$6) RETURNING *`,
      [
        hash(code),
        hash(session),
        hash(csrf),
        expiresAt,
        now(),
        browserAccountId,
      ],
    );
    const handoff = decode(rows[0]);
    return handoff ? { handoff, session, csrf, expiresAt } : null;
  },
  /** Price changes create a new reference and retire the old capability atomically.
   * The server computes quote; the browser supplies only its selected amount. */
  async selectQuote(session: string, csrf: string, expectedId: string, quote: CheckoutQuote, browserAccountId: string | null = null) {
    if (!validSecret(session) || !validSecret(csrf) || !validQuote(quote)) return null;
    return db.transaction(async tx => {
      const { rows } = await tx.query(
        `SELECT * FROM billing_checkout.handoffs WHERE id=$1 AND session_hash=$2 AND csrf_hash=$3 AND session_expires_at>$4 AND payment_locked=false AND ($5::text IS NULL OR account_id=$5) FOR UPDATE`,
        [expectedId, hash(session), hash(csrf), now(), browserAccountId]);
      const row = rows[0];
      const old = decode(row);
      if (!row || !old) return null;
      const id = randomUUID();
      await tx.query(`UPDATE billing_checkout.handoffs SET session_hash=NULL,csrf_hash=NULL,session_expires_at=0,expires_at=0,payment_locked=true,replaced_by=$2 WHERE id=$1`, [old.id, id]);
      const created = await tx.query(
        `INSERT INTO billing_checkout.handoffs(id,account_id,quote,code_hash,expires_at,session_hash,csrf_hash,session_expires_at) VALUES ($1,$2,$3::text::jsonb,$4,$5,$6,$7,$5) RETURNING *`,
        [id, old.accountId, JSON.stringify(quote), hash(secret()), row.session_expires_at, hash(session), hash(csrf)]);
      return decode(created.rows[0]);
    });
  },
  /** Freeze the exact reference before an external payment request. Repeated
   * calls can reconcile that same payment, but can never change its quote. */
  async lockPayment(session: string, csrf: string, expectedId: string, browserAccountId: string | null = null) {
    if (!validSecret(session) || !validSecret(csrf)) return null;
    const { rows } = await db.query(
      `UPDATE billing_checkout.handoffs SET payment_locked=true WHERE id=$1 AND session_hash=$2 AND csrf_hash=$3 AND session_expires_at>$4 AND ($5::text IS NULL OR account_id=$5) RETURNING *`,
      [expectedId, hash(session), hash(csrf), now(), browserAccountId]);
    return decode(rows[0]);
  },
  /** Original assistant references follow amount changes without granting access
   * to another account. Limit traversal so corrupt/cyclic history fails closed. */
  async current(accountId: string, id: string) {
    const { rows } = await db.query(
      `WITH RECURSIVE chain AS (SELECT h.*,0 AS depth FROM billing_checkout.handoffs h WHERE h.id=$1 AND h.account_id=$2 UNION ALL SELECT h.*,c.depth+1 FROM billing_checkout.handoffs h JOIN chain c ON h.id=c.replaced_by WHERE h.account_id=$2 AND c.depth<100) SELECT * FROM chain WHERE replaced_by IS NULL LIMIT 1`, [id, accountId]);
    return decode(rows[0]);
  },
  async authorize(
    session: string,
    csrf: string,
    browserAccountId: string | null = null,
  ) {
    if (!validSecret(session) || !validSecret(csrf)) return null;
    const { rows } = await db.query(
      `SELECT * FROM billing_checkout.handoffs WHERE session_hash=$1 AND csrf_hash=$2 AND session_expires_at>$3 AND ($4::text IS NULL OR account_id=$4)`,
      [hash(session), hash(csrf), now(), browserAccountId],
    );
    return decode(rows[0]);
  },
  /** Public IDs are not capabilities: status always requires account binding. */
  async get(accountId: string, id: string) {
    const { rows } = await db.query(
      `SELECT * FROM billing_checkout.handoffs WHERE id=$1 AND account_id=$2`,
      [id, accountId],
    );
    return decode(rows[0]);
  },
});

/** Put the code in a fragment so previews, servers and referrers don't receive it.
 * The landing page must remove it before loading any third-party code. */
export const checkoutHandoffUrl = (landingUrl: string, code: string) => {
  const url = new URL(landingUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !validSecret(code)
  )
    throw new Error("Invalid checkout landing URL");
  url.hash = code;
  return url.href;
};
export const checkoutSameOrigin = (request: Request, origin: string) =>
  request.method === "POST" &&
  request.headers.get("origin") === new URL(origin).origin &&
  [null, "same-origin"].includes(request.headers.get("sec-fetch-site"));
