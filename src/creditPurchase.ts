export type CreditPurchaseCatalog = {
  minimumCents: number; maximumCents: number; stepCents: number;
  creditsPerCent: number;
  bonusWindows: readonly { minimumAmountCents: number; maximumAmountCents: number; bonusPercent: number }[];
};
export type CreditPurchasePreset = { id: string; name: string; amountCents: number };
/** Canonical integer credit pricing shared by the server and amount picker. */
export const quoteCreditAmount = (catalog: CreditPurchaseCatalog, amountCents: number) => {
  if (![catalog.minimumCents, catalog.maximumCents, catalog.stepCents, catalog.creditsPerCent].every(Number.isSafeInteger) || catalog.minimumCents < 1 || catalog.maximumCents < catalog.minimumCents || catalog.stepCents < 1 || catalog.creditsPerCent < 1)
    throw new Error("Invalid credit catalog");
  if (!Number.isSafeInteger(amountCents) || amountCents < catalog.minimumCents || amountCents > catalog.maximumCents || amountCents % catalog.stepCents !== 0) return undefined;
  const windows = catalog.bonusWindows.filter(w => amountCents >= w.minimumAmountCents && amountCents <= w.maximumAmountCents);
  const window = windows[0];
  if (windows.length !== 1 || !window || !Number.isSafeInteger(window.bonusPercent) || window.bonusPercent < 0) throw new Error("Invalid credit bonus schedule");
  const base = amountCents * catalog.creditsPerCent;
  const bonus = Math.floor(base * window.bonusPercent / 100);
  if (!Number.isSafeInteger(base * window.bonusPercent) || !Number.isSafeInteger(base + bonus)) throw new Error("Credit quote exceeds safe integer range");
  return { amountCents, credits: base + bonus, bonusPercent: window.bonusPercent };
};
