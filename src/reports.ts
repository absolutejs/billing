/** Public customer reports. No payment tokens, vault references, or provider costs. */
export type BillingStatus = {
  portalAccess: boolean;
  subscription: {
    status: string;
    renewsAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  credits: {
    remaining: number;
    reserved: number;
    purchased: number;
    promotional: number;
    debt: number;
  };
  automaticRefill: false;
};
export type BillingReceipt = {
  id: string;
  issuedAt: string;
  currency: string;
  amountCents: number;
  refundedAmountCents: number;
  source: "credit_purchase" | "initial" | "plan_change" | "renewal";
  status: "paid" | "partially_refunded" | "refunded";
};
export type ReceiptCursor = { at: string; id: string };
export type ReceiptPageRequest = {
  limit: number;
  cursor: ReceiptCursor | null;
};
export type ReceiptPage = {
  receipts: BillingReceipt[];
  nextCursor: string | null;
};
export type UsageRange = { from: string; to: string };
export type CustomerUsageReport = {
  from: string;
  to: string;
  creditsConsumed: number;
  events: number;
  byDay: { day: string; credits: number; events: number }[];
  byFeature: { feature: string; credits: number; events: number }[];
};
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (input: unknown, keys: readonly string[]) => {
  if (!record(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error("Invalid report input");
  return input;
};
const integer = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid report amount");
  return value;
};
const iso = (value: string) => {
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Invalid report timestamp");
  return value;
};
const day = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) !== value
  )
    throw new Error("Expected a UTC calendar date");
  return value;
};
export const parseUsageRange = (
  input: unknown,
  now = new Date(),
): UsageRange => {
  const args = only(input, ["from", "to"]);
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
      DAY_MS,
  );
  const to = day(args.to ?? tomorrow.toISOString().slice(0, 10));
  const from = day(
    args.from ??
      new Date(Date.parse(to) - 30 * DAY_MS).toISOString().slice(0, 10),
  );
  const duration = Date.parse(to) - Date.parse(from);
  if (
    duration <= 0 ||
    duration > 90 * DAY_MS ||
    Date.parse(to) > tomorrow.getTime()
  )
    throw new Error(
      "Choose a range of 1–90 UTC days, ending no later than tomorrow",
    );
  return { from, to };
};
/** Cursor is a position, never authorization. Consumers must filter by account. */
export const encodeReceiptCursor = (cursor: ReceiptCursor) => {
  if (!UUID.test(cursor.id)) throw new Error("Invalid receipt cursor");
  return Buffer.from(
    JSON.stringify({ at: iso(cursor.at), id: cursor.id }),
  ).toString("base64url");
};
export const parseReceiptPage = (input: unknown): ReceiptPageRequest => {
  const args = only(input, ["limit", "cursor"]);
  const limit = args.limit ?? 20;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Receipt limit must be 1–50");
  if (args.cursor === undefined || args.cursor === null)
    return { limit, cursor: null };
  if (
    typeof args.cursor !== "string" ||
    args.cursor.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(args.cursor)
  )
    throw new Error("Invalid receipt cursor");
  const decoded: unknown = JSON.parse(
    Buffer.from(args.cursor, "base64url").toString("utf8"),
  );
  if (
    !record(decoded) ||
    typeof decoded.at !== "string" ||
    typeof decoded.id !== "string" ||
    !UUID.test(decoded.id)
  )
    throw new Error("Invalid receipt cursor");
  return { limit, cursor: { at: iso(decoded.at), id: decoded.id } };
};
export const projectBillingStatus = (value: BillingStatus): BillingStatus => ({
  portalAccess: value.portalAccess === true,
  subscription: value.subscription
    ? {
        status: String(value.subscription.status).slice(0, 64),
        renewsAt:
          value.subscription.renewsAt === null
            ? null
            : iso(value.subscription.renewsAt),
        cancelAtPeriodEnd: value.subscription.cancelAtPeriodEnd === true,
      }
    : null,
  credits: {
    remaining: integer(value.credits.remaining),
    reserved: integer(value.credits.reserved),
    purchased: integer(value.credits.purchased),
    promotional: integer(value.credits.promotional),
    debt: integer(value.credits.debt),
  },
  automaticRefill: false,
});
export const projectReceiptPage = (
  value: ReceiptPage,
  limit: number,
): ReceiptPage => {
  if (value.receipts.length > limit)
    throw new Error("Receipt page exceeds its limit");
  if (value.nextCursor !== null) parseReceiptPage({ cursor: value.nextCursor });
  return {
    receipts: value.receipts.map((row) => {
      if (
        !UUID.test(row.id) ||
        !/^[A-Z]{3}$/.test(row.currency) ||
        !["credit_purchase", "initial", "plan_change", "renewal"].includes(
          row.source,
        ) ||
        !["paid", "partially_refunded", "refunded"].includes(row.status) ||
        row.refundedAmountCents > row.amountCents
      )
        throw new Error("Invalid receipt");
      return {
        id: row.id,
        issuedAt: iso(row.issuedAt),
        currency: row.currency,
        amountCents: integer(row.amountCents),
        refundedAmountCents: integer(row.refundedAmountCents),
        source: row.source,
        status: row.status,
      };
    }),
    nextCursor: value.nextCursor,
  };
};
export const projectUsageReport = (
  value: CustomerUsageReport,
  range: UsageRange,
): CustomerUsageReport => {
  if (
    value.from !== range.from ||
    value.to !== range.to ||
    value.byDay.length > 90 ||
    value.byFeature.length > 21
  )
    throw new Error("Invalid usage report bounds");
  const byDay = value.byDay.map((row) => ({
    day: day(row.day),
    credits: integer(row.credits),
    events: integer(row.events),
  }));
  const byFeature = value.byFeature.map((row) => ({
    feature: row.feature.slice(0, 128),
    credits: integer(row.credits),
    events: integer(row.events),
  }));
  const credits = integer(value.creditsConsumed),
    events = integer(value.events);
  for (const rows of [byDay, byFeature])
    if (
      rows.reduce((sum, row) => sum + row.credits, 0) !== credits ||
      rows.reduce((sum, row) => sum + row.events, 0) !== events
    )
      throw new Error("Usage breakdown does not reconcile");
  if (
    new Set(byDay.map((row) => row.day)).size !== byDay.length ||
    byDay.some((row) => row.day < range.from || row.day >= range.to)
  )
    throw new Error("Invalid usage days");
  return {
    from: range.from,
    to: range.to,
    creditsConsumed: credits,
    events,
    byDay,
    byFeature,
  };
};
