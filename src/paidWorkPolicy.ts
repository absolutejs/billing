import { AsyncLocalStorage } from "node:async_hooks";

export type PaidWorkContext = {
  userSub: string;
  actorId?: string;
  approvalId?: string;
  closed?: boolean;
};
declare const authorizationBrand: unique symbol;
/** In-process execution permission; never serialize it or accept it from a client.
 * Accounting, reservations and durable approval claims remain the host's responsibility. */
export type PaidAuthorization = {
  readonly userSub: string;
  readonly [authorizationBrand]: true;
};
type WorkAdapter<W extends PaidWorkContext> = {
  currentWork: () => W | undefined;
  withWork: <T>(work: W | undefined, run: () => Promise<T>) => Promise<T>;
};

export class PaidWorkApprovalError extends Error {}

/** Create once per application, using its trusted funded-work context. */
export const createPaidWorkPolicy = <W extends PaidWorkContext>(
  adapter: WorkAdapter<W>,
) => {
  const currentCreditWork = adapter.currentWork;
  const withCreditWork = adapter.withWork;
  type DeferredRequester = { userSub: string; closed: boolean };
  const deferredRequester = new AsyncLocalStorage<
    DeferredRequester | undefined
  >();
  const background = new AsyncLocalStorage<boolean>();
  type PaidRequester = { userSub: string; readOnly: boolean; actorId?: string };
  const requester = new AsyncLocalStorage<PaidRequester | undefined>();

  /** Preserve admission context when a response iterator outlives its handler. */
  const bindPaidExecution = <T>(userSub: string, run: () => Promise<T>) => {
    requirePaidWorkOwner(userSub);
    if (!hasBoundPaidRequester())
      throw new PaidWorkApprovalError(
        "An authenticated or funded execution scope is required",
      );
    const actor = requester.getStore();
    const work = currentCreditWork();
    const automatic = isBackgroundPaidWork();
    const deferred = deferredRequester.getStore();

    return () =>
      deferredRequester.run(deferred, () =>
        background.run(automatic, () =>
          requester.run(actor, () => withCreditWork(work, run)),
        ),
      );
  };
  const hasBoundPaidRequester = () =>
    Boolean(
      currentCreditWork() ||
      deferredRequester.getStore() ||
      requester.getStore(),
    );

  const isBackgroundPaidWork = () => background.getStore() === true;
  const requireApprovedPaidWork = () => {
    const work = currentCreditWork();
    if (!work)
      throw new PaidWorkApprovalError(
        "Explicit funded approval is required for this run",
      );
    requirePaidWorkOwner(work.userSub);

    return work;
  };
  /** Only an authenticated write or already-funded explicit work can authorize a deferred run. */
  const requireExplicitPaidRequester = () => {
    const actor = requester.getStore();
    const work = currentCreditWork();
    if (isBackgroundPaidWork() || actor?.readOnly || (!work && !actor))
      throw new PaidWorkApprovalError(
        "An explicit authenticated request is required",
      );

    return requirePaidWorkOwner();
  };
  const requirePaidWorkOwner = (userSub?: string | null) => {
    const work = currentCreditWork();
    if (work?.closed) throw new PaidWorkApprovalError("Credit work is closed");
    const actor = requester.getStore();
    const deferred = deferredRequester.getStore();
    if (actor?.actorId && (!work?.approvalId || work.actorId !== actor.actorId))
      throw new PaidWorkApprovalError(
        "Review and approve this paid action in Live mode before starting. No spending is authorized by impersonation alone.",
      );
    if (deferred?.closed)
      throw new PaidWorkApprovalError("Deferred approval is closed");
    const owner =
      work?.userSub ?? deferred?.userSub ?? actor?.userSub ?? userSub;
    if (!owner?.trim())
      throw new PaidWorkApprovalError("Paid work requires an attributed payer");
    if (work && userSub && userSub !== work.userSub)
      throw new PaidWorkApprovalError(
        "Paid work payer does not match its approval",
      );
    if (actor?.readOnly)
      throw new PaidWorkApprovalError(
        "Reading a page does not authorize paid work",
      );
    if (isBackgroundPaidWork() && !work && !deferred)
      throw new PaidWorkApprovalError(
        "Automatic paid work requires explicit funded approval",
      );

    return owner;
  };
  /** Internal only: caller must atomically claim a durable authenticated approval. */
  const withDeferredPaidRequester = <T>(
    userSub: string,
    run: () => Promise<T>,
  ) => {
    const approval: DeferredRequester = { closed: false, userSub };

    return deferredRequester.run(approval, () =>
      withoutAutomaticSpend(() =>
        withPaidRequester(userSub, "POST", async () => {
          try {
            return await run();
          } finally {
            approval.closed = true;
          }
        }),
      ),
    );
  };
  /** Cron callbacks may read, cache and notify, but cannot start unapproved spend. */
  const withoutAutomaticSpend = <T>(run: () => T) => background.run(true, run);
  /** Capture the authenticated initiator, never infer one from a beneficiary profile. */
  const withPaidRequester = <T>(
    userSub: string,
    method: string,
    run: () => T,
    actorId?: string,
  ) =>
    requester.run(
      {
        actorId: actorId ?? requester.getStore()?.actorId,
        readOnly:
          requester.getStore()?.readOnly === true ||
          !["POST", "PUT", "PATCH", "DELETE"].includes(method),
        userSub,
      },
      run,
    );

  // The WeakMap rejects fabricated objects even when a caller bypasses TypeScript.
  const capabilities = new WeakMap<PaidAuthorization, () => string>();
  const authorizePaidWork = (userSub?: string | null): PaidAuthorization => {
    const owner = requirePaidWorkOwner(userSub);
    if (!hasBoundPaidRequester())
      throw new PaidWorkApprovalError(
        "An authenticated or funded execution scope is required",
      );
    const work = currentCreditWork();
    const actor = requester.getStore();
    const deferred = deferredRequester.getStore();
    const automatic = isBackgroundPaidWork();
    const authorization = Object.freeze({
      userSub: owner,
    }) as PaidAuthorization;
    capabilities.set(authorization, () => {
      if (work?.closed || deferred?.closed)
        throw new PaidWorkApprovalError("Paid authorization is closed");
      if (
        currentCreditWork() !== work ||
        requester.getStore() !== actor ||
        deferredRequester.getStore() !== deferred ||
        isBackgroundPaidWork() !== automatic
      )
        throw new PaidWorkApprovalError(
          "Paid authorization belongs to a different execution context",
        );
      return requirePaidWorkOwner(owner);
    });
    return authorization;
  };
  const requirePaidAuthorization = (
    authorization: PaidAuthorization,
  ): string => {
    const validate = capabilities.get(authorization);
    if (!validate)
      throw new PaidWorkApprovalError("A valid paid authorization is required");
    return validate();
  };
  return {
    authorizePaidWork,
    requirePaidAuthorization,
    bindPaidExecution,
    hasBoundPaidRequester,
    isBackgroundPaidWork,
    requireApprovedPaidWork,
    requireExplicitPaidRequester,
    requirePaidWorkOwner,
    withDeferredPaidRequester,
    withoutAutomaticSpend,
    withPaidRequester,
  };
};
