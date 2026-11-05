export type CreditPurchaseCatalog = {
  minimumCents: number;
  maximumCents: number;
  stepCents: number;
  creditsPerCent: number;
  bonusWindows: readonly {
    minimumAmountCents: number;
    maximumAmountCents: number;
    bonusPercent: number;
  }[];
};
export type CreditPurchasePreset = {
  id: string;
  name: string;
  amountCents: number;
};
/** Canonical integer credit pricing shared by the server and amount picker. */
export const quoteCreditAmount = (
  catalog: CreditPurchaseCatalog,
  amountCents: number,
) => {
  if (
    ![
      catalog.minimumCents,
      catalog.maximumCents,
      catalog.stepCents,
      catalog.creditsPerCent,
    ].every(Number.isSafeInteger) ||
    catalog.minimumCents < 1 ||
    catalog.maximumCents < catalog.minimumCents ||
    catalog.stepCents < 1 ||
    catalog.creditsPerCent < 1
  )
    throw new Error("Invalid credit catalog");
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < catalog.minimumCents ||
    amountCents > catalog.maximumCents ||
    amountCents % catalog.stepCents !== 0
  )
    return undefined;
  const windows = catalog.bonusWindows.filter(
    (w) =>
      amountCents >= w.minimumAmountCents &&
      amountCents <= w.maximumAmountCents,
  );
  const window = windows[0];
  if (
    windows.length !== 1 ||
    !window ||
    !Number.isSafeInteger(window.bonusPercent) ||
    window.bonusPercent < 0
  )
    throw new Error("Invalid credit bonus schedule");
  const base = amountCents * catalog.creditsPerCent;
  const bonus = Math.floor((base * window.bonusPercent) / 100);
  if (
    !Number.isSafeInteger(base * window.bonusPercent) ||
    !Number.isSafeInteger(base + bonus)
  )
    throw new Error("Credit quote exceeds safe integer range");
  return {
    amountCents,
    credits: base + bonus,
    bonusPercent: window.bonusPercent,
  };
};

export type ProcessingFeeRate = {
  fixedMinor: number;
  rateBasisPoints: number;
  rounding: "nearest" | "up";
};
/** Smallest integer charge that covers the requested net amount and the fee
 * on the entire charge. Rates and rounding are supplied by the host; this does
 * not claim to discover a payment method's actual provider pricing. */
export const grossUpProcessingFee = (
  netMinor: number,
  rate: ProcessingFeeRate,
) => {
  if (
    !Number.isSafeInteger(netMinor) ||
    netMinor < 1 ||
    !Number.isSafeInteger(rate.fixedMinor) ||
    rate.fixedMinor < 0 ||
    !Number.isSafeInteger(rate.rateBasisPoints) ||
    rate.rateBasisPoints < 0 ||
    rate.rateBasisPoints >= 10000 ||
    !["nearest", "up"].includes(rate.rounding)
  )
    throw new Error("Invalid processing fee quote");
  const net = BigInt(netMinor),
    fixed = BigInt(rate.fixedMinor),
    bps = BigInt(rate.rateBasisPoints),
    denominator = 10000n;
  const fee = (gross: bigint) =>
    fixed +
    (gross * bps + (rate.rounding === "up" ? 9999n : 5000n)) / denominator;
  let low = net,
    high =
      ((net + fixed) * denominator + denominator - bps - 1n) /
        (denominator - bps) +
      1n;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (middle - fee(middle) >= net) high = middle;
    else low = middle + 1n;
  }
  if (low > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Processing fee quote exceeds safe integer range");
  return { netMinor, grossMinor: Number(low), feeMinor: Number(fee(low)) };
};
