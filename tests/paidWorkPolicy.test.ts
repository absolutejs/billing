import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "bun:test";
import {
  createPaidWorkPolicy,
  type PaidAuthorization,
  type PaidWorkContext,
} from "../src/paidWorkPolicy";

const fixture = () => {
  const work = new AsyncLocalStorage<PaidWorkContext | undefined>();
  const policy = createPaidWorkPolicy({
    currentWork: () => work.getStore(),
    withWork: (value, run) => work.run(value, run),
  });
  return { ...policy, work };
};

test("ordinary member POST can spend; reads cannot be elevated by a nested write", () => {
  const policy = fixture();
  policy.withPaidRequester("member", "POST", () => {
    const permit = policy.authorizePaidWork();
    expect(policy.requirePaidAuthorization(permit)).toBe("member");
  });
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    expect(() =>
      policy.withPaidRequester("member", method, () =>
        policy.withPaidRequester("member", "POST", () =>
          policy.authorizePaidWork(),
        ),
      ),
    ).toThrow("Reading a page");
  }
});

test("capabilities are opaque, policy-specific and bound to the originating scope", () => {
  const policy = fixture();
  let permit: PaidAuthorization | undefined;
  policy.withPaidRequester("member", "POST", () => {
    permit = policy.authorizePaidWork();
    expect(() => fixture().requirePaidAuthorization(permit!)).toThrow(
      "valid paid authorization",
    );
    expect(() =>
      policy.withPaidRequester("other", "POST", () =>
        policy.requirePaidAuthorization(permit!),
      ),
    ).toThrow("different execution context");
  });
  expect(() => policy.requirePaidAuthorization(permit!)).toThrow(
    "different execution context",
  );
  // @ts-expect-error A payer ID is not an authorization capability.
  expect(() => policy.requirePaidAuthorization("member")).toThrow(
    "valid paid authorization",
  );
  // @ts-expect-error Structural objects cannot manufacture the opaque capability.
  expect(() => policy.requirePaidAuthorization({ userSub: "member" })).toThrow(
    "valid paid authorization",
  );
});

test("impersonation needs a matching funded actor approval", () => {
  const policy = fixture();
  expect(() =>
    policy.withPaidRequester(
      "member",
      "POST",
      () => policy.authorizePaidWork(),
      "admin",
    ),
  ).toThrow("Review and approve");
  policy.work.run(
    { userSub: "member", actorId: "admin", approvalId: "approval" },
    () => {
      policy.withPaidRequester(
        "member",
        "POST",
        () => {
          expect(
            policy.requirePaidAuthorization(policy.authorizePaidWork()),
          ).toBe("member");
          expect(() => policy.authorizePaidWork("other")).toThrow(
            "does not match",
          );
        },
        "admin",
      );
      expect(() =>
        policy.withPaidRequester(
          "member",
          "POST",
          () => policy.authorizePaidWork(),
          "other-admin",
        ),
      ).toThrow("Review and approve");
    },
  );
});

test("deferred streams preserve context and revoke permission when funded work closes", async () => {
  const policy = fixture();
  const work = { userSub: "member", closed: false };
  const next = policy.work.run(work, () =>
    policy.withPaidRequester("member", "POST", () => {
      const permit = policy.authorizePaidWork();
      return policy.bindPaidExecution("member", async () =>
        policy.requirePaidAuthorization(permit),
      );
    }),
  );
  expect(await next()).toBe("member");
  work.closed = true;
  expect(next()).rejects.toThrow("closed");
});

test("closed deferred and unapproved background work cannot authorize spending", async () => {
  const policy = fixture();
  expect(() =>
    policy.withoutAutomaticSpend(() => policy.authorizePaidWork("member")),
  ).toThrow("Automatic paid work");
  let later: (() => Promise<string>) | undefined;
  await policy.withDeferredPaidRequester("member", async () => {
    const permit = policy.authorizePaidWork();
    later = policy.bindPaidExecution("member", async () =>
      policy.requirePaidAuthorization(permit),
    );
    expect(await later()).toBe("member");
  });
  expect(later!()).rejects.toThrow("closed");
});

test("a payer ID alone cannot mint provider authorization", () => {
  expect(() => fixture().authorizePaidWork("member")).toThrow(
    "execution scope",
  );
});

test("binding a stream cannot manufacture requester authorization from an ID", () => {
  const policy = fixture();
  expect(() =>
    policy.bindPaidExecution("member", async () => policy.authorizePaidWork()),
  ).toThrow("execution scope");
});
