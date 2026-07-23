import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import { computeInvoice, readProviderBalances } from "./index";
import type { Plan, ProviderBalanceConfig } from "./index";

const MS_PER_DAY = 86_400_000;
const DEFAULT_PREVIEW_DAYS = 30;
const MAX_PREVIEW_DAYS = 366;

/* Billing has no factory config: it is a pure cost-model library. The app
 * declares a Plan with createPlan and prices usage with computeInvoice.
 * TRuntime is the v1 composite-runtime convention: the app's plan plus the
 * (optional) provider-balances credential config the host wired from env. */
type BillingRuntime = {
  plan: Plan;
  balances?: ProviderBalanceConfig;
};

const tool = toolFactory<BillingRuntime>();

export const manifest = defineManifest<Record<never, never>, BillingRuntime>()({
  contract: 2,
  identity: {
    accent: "#f59e0b",
    category: "commerce",
    description:
      "Pure cost-model substrate: `createPlan` declares a priced product (base fee, per-dimension unit prices, graduated tiers, free-tier allowances, minimum charge) and `computeInvoice` turns a usage snapshot into invoice line items — all money math in integer micros, so float drift is structurally impossible. `readProviderBalances` reads what the vendors YOU pay (Anthropic, OpenAI, Twilio, Deepgram, ElevenLabs, Apollo) say you have left or have spent, so a dashboard can reconcile your own metering against vendor truth.",
    docsUrl: "https://github.com/absolutejs/billing",
    name: "@absolutejs/billing",
    tagline: "Price your product and turn usage into invoices.",
  },
  requires: {
    env: [
      {
        description:
          "Anthropic Admin API key — only needed for provider-balance reporting (spend, not balance: Anthropic exposes cost only)",
        docsUrl: "https://console.anthropic.com/settings/admin-keys",
        example: "sk-ant-admin-xxxxxxxxx",
        key: "ANTHROPIC_ADMIN_KEY",
        optional: true,
        secret: true,
      },
      {
        description:
          "OpenAI organization Admin key — only needed for provider-balance reporting (spend, not balance: OpenAI exposes cost only)",
        docsUrl: "https://platform.openai.com/settings/organization/admin-keys",
        example: "sk-admin-xxxxxxxxx",
        key: "OPENAI_ADMIN_KEY",
        optional: true,
        secret: true,
      },
    ],
  },
  settings: Type.Object({}),
  tools: {
    explain_plan: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "authenticated",
        effects: ["read"],
        requiredScopes: ["billing:read"],
      },
      description:
        "Describe the app's pricing plan: base fee, per-dimension unit prices or tier tables, free-tier allowances, rounding, and minimum charge. Amounts are integer micros (1,000,000 micros = 1 currency unit). Custom function-priced dimensions are reported as 'custom'.",
      handler: (_input, { plan }) => {
        const dimensions = Object.entries(plan.pricedDimensions).map(
          ([key, dim]) => ({
            freeTier: dim.freeTier,
            key,
            label: dim.label ?? key,
            pricing:
              dim.perUnitMicros !== undefined
                ? { perUnitMicros: dim.perUnitMicros }
                : dim.tiers !== undefined
                  ? { tiers: dim.tiers }
                  : "custom",
            unit: dim.unit ?? 1,
          }),
        );

        return JSON.stringify({
          basePriceMicros: plan.basePriceMicros ?? 0,
          currency: plan.currency ?? "usd",
          dimensions,
          minimumChargeMicros: plan.minimumChargeMicros ?? 0,
          name: plan.name,
          rounding: plan.rounding ?? "truncate",
        });
      },
      input: Type.Object({}),
    }),
    preview_invoice: tool.runtime({
      annotations: { idempotentHint: true, readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "owner",
        effects: ["read"],
        requiredScopes: ["billing:preview"],
        resource: {
          idField: "tenant",
          tenantIdField: "tenant",
          type: "billing-preview",
        },
      },
      description:
        "Dry-run an invoice: price a usage snapshot through the app's plan and return the line items and total in integer micros. Pure math — nothing is charged or stored. Usage keys must match the plan's priced dimensions.",
      handler: ({ periodDays, tenant, usage }, { plan }) => {
        const end = Date.now();
        const invoice = computeInvoice({
          period: {
            end,
            start: end - (periodDays ?? DEFAULT_PREVIEW_DAYS) * MS_PER_DAY,
          },
          plan,
          tenant: tenant ?? "preview",
          usage,
        });

        return JSON.stringify(invoice);
      },
      input: Type.Object({
        periodDays: Type.Optional(
          Type.Integer({
            description:
              "Length of the invoice period ending now, in days (default 30).",
            maximum: MAX_PREVIEW_DAYS,
            minimum: 1,
          }),
        ),
        tenant: Type.Optional(
          Type.String({
            description: "Tenant id to stamp on the preview invoice.",
          }),
        ),
        usage: Type.Record(Type.String(), Type.Number({ minimum: 0 }), {
          description:
            'Metered quantities keyed by dimension name, e.g. {"requests": 120000}.',
        }),
      }),
    }),
    provider_balances: tool.runtime({
      annotations: { idempotentHint: true, openWorldHint: true },
      authorization: {
        approval: "policy",
        audience: "admin",
        destinations: ["configured-billing-provider"],
        effects: ["read", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["billing:providers:read"],
        reversible: false,
      },
      description:
        "Read each configured upstream vendor's OWN reported balance, quota, or spend (Anthropic/OpenAI report spend; Twilio/Deepgram report balance; ElevenLabs/Apollo report quota). Free reporting endpoints — no per-call charge. Reports only the providers the host wired credentials for.",
      handler: async (_input, { balances }) =>
        balances === undefined
          ? "no provider credentials are wired — wire a ProviderBalanceConfig (see the provider-balances recipe)"
          : JSON.stringify(await readProviderBalances(balances)),
      input: Type.Object({}),
    }),
  },
  wiring: [
    {
      description:
        "Dimension keys must match the keys of the usage snapshot you price with computeInvoice.",
      id: "default",
      server: {
        code: [
          "const plan = createPlan({",
          "\tname: 'pro',",
          "\tpricedDimensions: {",
          "\t\t// TODO: your priced dimensions, e.g.",
          "\t\trequests: { freeTier: 10_000, perUnitMicros: 200 }",
          "\t}",
          "});",
        ].join("\n"),
        imports: [{ from: "@absolutejs/billing", names: ["createPlan"] }],
        placement: "module-scope",
      },
      title: "Declare your pricing plan",
    },
    {
      description:
        "Optional: read upstream vendors' own balance/quota/spend. Include only the providers you pay; each needs its credential in env.",
      id: "provider-balances",
      server: {
        code: [
          "const providerBalanceConfig = {",
          "\tanthropic: { adminKey: ${env.ANTHROPIC_ADMIN_KEY} ?? '' },",
          "\topenai: { adminKey: ${env.OPENAI_ADMIN_KEY} ?? '' }",
          "};",
        ].join("\n"),
        imports: [],
        placement: "module-scope",
      },
      title: "Wire vendor-balance credentials",
    },
  ],
});
