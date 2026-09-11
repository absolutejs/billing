/** Service-credit accounting. Host authorization and payment verification happen
 * before these commands. Every command and its receipt commit in one transaction. */
export type CreditAccount = {
  periodId: string;
  periodEnd: string | null;
  periodAllowance: number;
  periodRemaining: number;
  purchasedRemaining: number;
  promotionalRemaining: number;
  debt: number;
  reserved: number;
  consumed: number;
};
export type CreditAllocation = {
  period: number;
  purchased: number;
  promotional: number;
};
export type CreditReservation = {
  id: string;
  periodId: string;
  allocation: CreditAllocation;
  status: "reserved" | "settled" | "released";
  charged: number | null;
};
export type CreditCommand =
  | { kind: "grant"; bucket: "purchased" | "promotional"; credits: number }
  | { kind: "reverse"; bucket: "purchased" | "promotional"; credits: number }
  | {
      kind: "period";
      periodId: string;
      periodEnd: string | null;
      allowance: number;
    }
  | { kind: "reserve"; reservationId: string; credits: number }
  | { kind: "settle"; reservationId: string; credits: number }
  | { kind: "release"; reservationId: string }
  | { kind: "debit"; credits: number; allowDebt?: boolean; reference?: string };
export type CreditReceipt = {
  command: CreditCommand;
  account: CreditAccount;
  reservation?: CreditReservation;
};
export type CreditTransaction = {
  account: CreditAccount;
  receipt: (operationId: string) => Promise<CreditReceipt | null>;
  reservation: (id: string) => Promise<CreditReservation | null>;
  save: (operationId: string, receipt: CreditReceipt) => Promise<void>;
};
export type CreditAccountStore = {
  /** Persist seed once. Never overwrite an existing account. */
  initialize: (accountId: string, seed: CreditAccount) => Promise<void>;
  read: (accountId: string) => Promise<CreditAccount | null>;
  /** Lock one account, serialize its commands across processes, and roll back
   * account, reservation and receipt together if the callback fails. */
  transaction: <T>(
    accountId: string,
    run: (tx: CreditTransaction) => Promise<T>,
  ) => Promise<T>;
};
const integer = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Credits must be nonnegative safe integers");
  return value;
};
const periodIdentity = (value: string) => {
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Credit period ID must be an ISO UTC start timestamp");
  return value;
};
const identity = (value: string) => {
  if (!value || value.length > 256)
    throw new Error("Credit identity is invalid");
  return value;
};
export const validateCreditAccount = (account: CreditAccount) => {
  periodIdentity(account.periodId);
  if (
    account.periodEnd !== null &&
    periodIdentity(account.periodEnd) <= account.periodId
  )
    throw new Error("Credit period end must follow its start");
  for (const key of [
    "periodAllowance",
    "periodRemaining",
    "purchasedRemaining",
    "promotionalRemaining",
    "debt",
    "reserved",
    "consumed",
  ] as const)
    integer(account[key]);
  integer(
    account.periodRemaining +
      account.purchasedRemaining +
      account.promotionalRemaining,
  );
  if (account.periodRemaining > account.periodAllowance)
    throw new Error("Period balance exceeds its allowance");
};
export const availableCredits = (account: CreditAccount) =>
  Math.max(
    0,
    account.periodRemaining +
      account.purchasedRemaining +
      account.promotionalRemaining -
      account.debt,
  );

/** Preserve the currently observable legacy balance without inventing purchase
 * provenance. Historical mixed bonus grants remain promotional carryover. */
export const migrateLegacyCreditAccount = (input: {
  periodId: string;
  periodEnd?: string | null;
  periodAllowance: number;
  bonusCredits: number;
  consumed: number;
}): CreditAccount => {
  integer(input.periodAllowance);
  integer(input.consumed);
  if (!Number.isSafeInteger(input.bonusCredits))
    throw new Error("Invalid legacy bonus credits");
  const account: CreditAccount = {
    periodId: input.periodId,
    periodEnd: input.periodEnd ?? null,
    periodAllowance: input.periodAllowance,
    periodRemaining: Math.max(0, input.periodAllowance - input.consumed),
    purchasedRemaining: 0,
    promotionalRemaining: Math.max(
      0,
      input.bonusCredits - Math.max(0, input.consumed - input.periodAllowance),
    ),
    debt:
      Math.max(0, -input.bonusCredits) +
      Math.max(
        0,
        input.consumed -
          input.periodAllowance -
          Math.max(0, input.bonusCredits),
      ),
    reserved: 0,
    consumed: input.consumed,
  };
  validateCreditAccount(account);
  return account;
};
const allocationTotal = (value: CreditAllocation) =>
  value.period + value.promotional + value.purchased;
const take = (account: CreditAccount, credits: number): CreditAllocation => {
  // A reversal liability consumes existing available credits exactly once.
  let owed = account.debt;
  for (const key of [
    "periodRemaining",
    "promotionalRemaining",
    "purchasedRemaining",
  ] as const) {
    const covered = Math.min(account[key], owed);
    account[key] -= covered;
    owed -= covered;
  }
  account.debt = owed;
  const period = Math.min(account.periodRemaining, credits);
  const promotional = Math.min(account.promotionalRemaining, credits - period);
  const purchased = Math.min(
    account.purchasedRemaining,
    credits - period - promotional,
  );
  account.periodRemaining -= period;
  account.promotionalRemaining -= promotional;
  account.purchasedRemaining -= purchased;
  return { period, promotional, purchased };
};
const grant = (
  account: CreditAccount,
  key: "periodRemaining" | "purchasedRemaining" | "promotionalRemaining",
  credits: number,
) => {
  const covered = Math.min(account.debt, credits);
  account.debt -= covered;
  account[key] = integer(account[key] + credits - covered);
};
const normalize = (command: CreditCommand): CreditCommand => {
  switch (command.kind) {
    case "grant":
    case "reverse":
      if (command.bucket !== "purchased" && command.bucket !== "promotional")
        throw new Error("Invalid credit bucket");
      return {
        kind: command.kind,
        bucket: command.bucket,
        credits: integer(command.credits),
      };
    case "period":
      return {
        kind: command.kind,
        periodId: periodIdentity(command.periodId),
        periodEnd:
          command.periodEnd === null ? null : periodIdentity(command.periodEnd),
        allowance: integer(command.allowance),
      };
    case "reserve":
    case "settle":
      return {
        kind: command.kind,
        reservationId: identity(command.reservationId),
        credits: integer(command.credits),
      };
    case "release":
      return {
        kind: command.kind,
        reservationId: identity(command.reservationId),
      };
    case "debit":
      return {
        kind: command.kind,
        credits: integer(command.credits),
        allowDebt: command.allowDebt === true,
        ...(command.reference === undefined
          ? {}
          : { reference: identity(command.reference) }),
      };
    default:
      throw new Error("Invalid credit command");
  }
};
export const createCreditAccountLedger = (store: CreditAccountStore) => ({
  initialize: async (accountId: string, seed: CreditAccount) => {
    identity(accountId);
    validateCreditAccount(seed);
    await store.initialize(accountId, seed);
  },
  receipt: (accountId: string, operationId: string) =>
    store.transaction(identity(accountId), (tx) =>
      tx.receipt(identity(operationId)),
    ),
  balance: (accountId: string) => store.read(identity(accountId)),
  execute: async (
    accountId: string,
    operationId: string,
    input: CreditCommand,
  ): Promise<CreditReceipt> => {
    identity(accountId);
    identity(operationId);
    const command = normalize(input);
    return store.transaction(accountId, async (tx) => {
      const previous = await tx.receipt(operationId);
      if (previous) {
        if (
          JSON.stringify(normalize(previous.command)) !==
          JSON.stringify(command)
        )
          throw new Error("Credit operation ID reused with different input");
        return previous;
      }
      const account = { ...tx.account };
      validateCreditAccount(account);
      let reservation: CreditReservation | undefined;
      switch (command.kind) {
        case "grant":
          grant(
            account,
            command.bucket === "purchased"
              ? "purchasedRemaining"
              : "promotionalRemaining",
            command.credits,
          );
          break;
        case "reverse": {
          const key =
            command.bucket === "purchased"
              ? "purchasedRemaining"
              : "promotionalRemaining";
          const covered = Math.min(account[key], command.credits);
          account[key] -= covered;
          account.debt += command.credits - covered;
          break;
        }
        case "period":
          if (command.periodId < account.periodId)
            throw new Error("Credit period cannot move backwards");
          if (command.periodId === account.periodId) {
            // Upgrades add only the increase. Downgrades take effect next period.
            const increase = Math.max(
              0,
              command.allowance - account.periodAllowance,
            );
            if (account.periodEnd === null)
              account.periodEnd = command.periodEnd;
            account.periodAllowance += increase;
            grant(account, "periodRemaining", increase);
          } else {
            account.periodId = command.periodId;
            account.periodEnd = command.periodEnd;
            account.periodAllowance = command.allowance;
            account.periodRemaining = 0;
            account.consumed = 0;
            grant(account, "periodRemaining", command.allowance);
          }
          break;
        case "debit": {
          if (!command.allowDebt && availableCredits(account) < command.credits)
            throw new Error("Insufficient credits");
          const used = allocationTotal(take(account, command.credits));
          account.debt += command.credits - used;
          account.consumed += command.credits;
          break;
        }
        case "reserve":
          if (command.credits === 0)
            throw new Error("Reservation must be positive");
          if (await tx.reservation(command.reservationId))
            throw new Error("Credit reservation already exists");
          if (availableCredits(account) < command.credits)
            throw new Error("Insufficient credits");
          reservation = {
            id: command.reservationId,
            periodId: account.periodId,
            allocation: take(account, command.credits),
            status: "reserved",
            charged: null,
          };
          account.reserved += command.credits;
          break;
        case "settle":
        case "release": {
          const held = await tx.reservation(command.reservationId);
          if (!held || held.status !== "reserved")
            throw new Error("Credit reservation is not active");
          const total = allocationTotal(held.allocation);
          const charged = command.kind === "settle" ? command.credits : 0;
          if (charged > total)
            throw new Error("Charge exceeds reserved credits");
          let refund = total - charged;
          for (const [bucket, key] of [
            ["purchased", "purchasedRemaining"],
            ["promotional", "promotionalRemaining"],
            ["period", "periodRemaining"],
          ] as const) {
            const restored = Math.min(held.allocation[bucket], refund);
            refund -= restored;
            if (bucket !== "period" || held.periodId === account.periodId)
              grant(account, key, restored);
          }
          account.reserved -= total;
          if (held.periodId === account.periodId) account.consumed += charged;
          reservation = {
            ...held,
            status: command.kind === "settle" ? "settled" : "released",
            charged,
          };
          break;
        }
      }
      validateCreditAccount(account);
      const receipt: CreditReceipt = {
        command,
        account,
        ...(reservation ? { reservation } : {}),
      };
      await tx.save(operationId, receipt);
      return receipt;
    });
  },
});

/** Portal access and funded MCP access are independent. Period-only free
 * allowances do not silently unlock prepaid work; carryover grants may. */
export const creditEntitlements = (input: {
  subscribed: boolean;
  prepaidEnabled: boolean;
  account: CreditAccount | null;
}) => {
  const funded =
    input.prepaidEnabled &&
    input.account !== null &&
    input.account.purchasedRemaining + input.account.promotionalRemaining > 0 &&
    availableCredits(input.account) > 0;
  return {
    portal: input.subscribed,
    mcp: input.subscribed
      ? ("member" as const)
      : funded
        ? ("prepaid" as const)
        : ("free" as const),
  };
};
