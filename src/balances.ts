/**
 * Provider balances — read each upstream vendor's OWN reported balance / quota /
 * spend from their billing-or-usage API, normalized to one shape. The inverse of
 * `computeInvoice`: that prices YOUR usage into an invoice; this reads what the
 * vendors you pay say you have left (or have spent). Useful for an ops dashboard
 * that reconciles your own metering against vendor truth.
 *
 * These are free reporting endpoints — they run no model and incur no per-call
 * charge (just rate limits). Pure + dependency-free: pass credentials in, get
 * snapshots out. One provider failing never affects the others.
 *
 * Coverage by what each vendor exposes:
 *   - balance ($ left):   Twilio, Deepgram
 *   - quota (units left):  ElevenLabs (chars), Apollo (calls/day), Brave (queries)
 *   - cost ($ spent):      Anthropic, OpenAI — no balance API exists, only spend
 *
 * Brave has no API at all; the host app captures rate-limit headers off its own
 * search calls and passes the latest snapshot in (`config.brave`).
 */

const FETCH_TIMEOUT_MS = 6000;
// The LLM providers' org cost-report endpoints are slow (OpenAI's regularly
// takes ~6s); give them a generous timeout since the result is cached.
const COST_FETCH_TIMEOUT_MS = 20_000;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;
const MILLION = 1_000_000;
const THOUSAND = 1000;
const COST_WINDOW_DAYS = 30;

export type ProviderBalanceKind = "balance" | "quota" | "cost" | "none";
export type ProviderBalanceStatus = "ok" | "unconfigured" | "error";

export type ProviderBalance = {
  /** Human summary line, e.g. "$42.10 left" or "1.2M / 2M chars". */
  detail: string;
  checkedAt: string;
  kind: ProviderBalanceKind;
  label: string;
  /** The vendor's spend/limit when known; null when not exposed. */
  limit: number | null;
  /** Caveat for the tile (e.g. "no balance API — Admin key needed"). */
  note: string | null;
  provider: string;
  /** Remaining balance/quota for kind balance|quota; null otherwise. */
  remaining: number | null;
  resetDate: string | null;
  status: ProviderBalanceStatus;
  /** Vendor plan/tier where exposed (ElevenLabs "pro", Twilio "Full"); else null. */
  tier: string | null;
  unit: string;
  used: number | null;
};

/** Rate-limit snapshot the host app captures off its own Brave search responses
 *  (Brave has no usage API). The 30-day-window header is `monthly*`. */
export type BraveUsageSnapshot = {
  capturedAt: string;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  resetSeconds: number | null;
};

/**
 * Per-provider credentials. Include a provider's key to get its tile; omit it to
 * skip the provider entirely. A present-but-empty credential yields an
 * "unconfigured" tile (so a dashboard can show every provider it cares about and
 * label the ones missing a key).
 */
export type ProviderBalanceConfig = {
  anthropic?: { adminKey: string };
  apollo?: { apiKey: string };
  brave?: BraveUsageSnapshot | null;
  deepgram?: { apiKey: string };
  elevenlabs?: { apiKey: string };
  openai?: { adminKey: string };
  twilio?: { accountSid: string; authToken: string };
};

const nowIso = () => new Date().toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const numberOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const usd = (amount: number) => `$${amount.toFixed(2)}`;

const compact = (value: number) => {
  if (value >= MILLION) return `${(value / MILLION).toFixed(1)}M`;
  if (value >= THOUSAND) return `${(value / THOUSAND).toFixed(0)}K`;

  return String(value);
};

const base = (provider: string, label: string) => {
  const result: ProviderBalance = {
    checkedAt: nowIso(),
    detail: "",
    kind: "none",
    label,
    limit: null,
    note: null,
    provider,
    remaining: null,
    resetDate: null,
    status: "error",
    tier: null,
    unit: "",
    used: null,
  };

  return result;
};

const unconfigured = (provider: string, label: string, note: string) => {
  const result: ProviderBalance = {
    ...base(provider, label),
    note,
    status: "unconfigured",
  };

  return result;
};

const errored = (provider: string, label: string, message: string) => {
  const result: ProviderBalance = {
    ...base(provider, label),
    detail: "Couldn't reach provider",
    note: message,
  };

  return result;
};

const fetchJson = async (
  url: string,
  headers: Record<string, string>,
  opts: { method?: string; timeoutMs?: number } = {},
) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers,
      method: opts.method ?? "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      // Surface the vendor's own error text (truncated) so the tile is
      // actionable — e.g. Deepgram's "needs the billing:read scope".
      const body = await response.text().catch(() => "");
      const snippet = body.replace(/\s+/g, " ").trim().slice(0, 160);
      throw new Error(
        snippet
          ? `HTTP ${response.status}: ${snippet}`
          : `HTTP ${response.status}`,
      );
    }
    const json: unknown = await response.json();

    return json;
  } finally {
    clearTimeout(timer);
  }
};

// --- Twilio: real account balance + plan type -----------------------------
const twilioBalance = async (creds: {
  accountSid: string;
  authToken: string;
}) => {
  if (!creds.accountSid || !creds.authToken) {
    return unconfigured("twilio", "Twilio", "Twilio credentials unset");
  }
  try {
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString(
      "base64",
    );
    const headers: Record<string, string> = { Authorization: `Basic ${auth}` };
    const [data, account] = await Promise.all([
      fetchJson(
        `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Balance.json`,
        headers,
      ),
      fetchJson(
        `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}.json`,
        headers,
      ),
    ]);
    const balance = isRecord(data) ? numberOf(Number(data.balance)) : null;
    const currency =
      isRecord(data) && typeof data.currency === "string"
        ? data.currency
        : "USD";
    const accountType =
      isRecord(account) && typeof account.type === "string"
        ? account.type
        : null;
    if (balance === null) throw new Error("no balance field");
    const result: ProviderBalance = {
      ...base("twilio", "Twilio"),
      detail: `${currency} ${balance.toFixed(2)} left`,
      kind: "balance",
      remaining: balance,
      status: "ok",
      tier: accountType,
      unit: currency,
    };

    return result;
  } catch (error) {
    return errored("twilio", "Twilio", String(error));
  }
};

// --- Deepgram: real $ balance summed across projects ----------------------
const extractProjectIds = (projects: unknown) => {
  const list =
    isRecord(projects) && Array.isArray(projects.projects)
      ? projects.projects
      : [];

  return list
    .map((proj) =>
      isRecord(proj) && typeof proj.project_id === "string"
        ? proj.project_id
        : null,
    )
    .filter((id): id is string => id !== null);
};

const sumBalances = (balances: unknown) => {
  const rows =
    isRecord(balances) && Array.isArray(balances.balances)
      ? balances.balances
      : [];

  return rows.reduce<number>(
    (total, row) => total + (isRecord(row) ? (numberOf(row.amount) ?? 0) : 0),
    0,
  );
};

const fetchDeepgramTotal = async (headers: Record<string, string>) => {
  const projects = await fetchJson(
    "https://api.deepgram.com/v1/projects",
    headers,
  );
  let total = 0;
  for (const projectId of extractProjectIds(projects)) {
    // eslint-disable-next-line no-await-in-loop -- a couple of projects at most
    const balances = await fetchJson(
      `https://api.deepgram.com/v1/projects/${projectId}/balances`,
      headers,
    );
    total += sumBalances(balances);
  }

  return total;
};

const deepgramBalance = async (creds: { apiKey: string }) => {
  if (!creds.apiKey)
    return unconfigured("deepgram", "Deepgram", "API key unset");
  try {
    const total = await fetchDeepgramTotal({
      Authorization: `Token ${creds.apiKey}`,
    });
    const result: ProviderBalance = {
      ...base("deepgram", "Deepgram"),
      detail: `${usd(total)} left`,
      kind: "balance",
      remaining: total,
      status: "ok",
      unit: "USD",
    };

    return result;
  } catch (error) {
    return errored("deepgram", "Deepgram", String(error));
  }
};

// --- ElevenLabs: real character quota used / limit + tier -----------------
const elevenLabsBalance = async (creds: { apiKey: string }) => {
  if (!creds.apiKey)
    return unconfigured("elevenlabs", "ElevenLabs", "API key unset");
  try {
    const data = await fetchJson(
      "https://api.elevenlabs.io/v1/user/subscription",
      {
        "xi-api-key": creds.apiKey,
      },
    );
    const usedChars = isRecord(data) ? numberOf(data.character_count) : null;
    const limitChars = isRecord(data) ? numberOf(data.character_limit) : null;
    if (usedChars === null || limitChars === null) {
      throw new Error("no character fields");
    }
    const resetUnix = isRecord(data)
      ? numberOf(data.next_character_count_reset_unix)
      : null;
    const tier =
      isRecord(data) && typeof data.tier === "string" ? data.tier : null;
    const remaining = Math.max(0, limitChars - usedChars);
    const result: ProviderBalance = {
      ...base("elevenlabs", "ElevenLabs"),
      detail: `${compact(remaining)} / ${compact(limitChars)} chars left`,
      kind: "quota",
      limit: limitChars,
      remaining,
      resetDate: resetUnix
        ? new Date(resetUnix * MS_PER_SECOND).toISOString()
        : null,
      status: "ok",
      tier,
      unit: "characters",
      used: usedChars,
    };

    return result;
  } catch (error) {
    return errored("elevenlabs", "ElevenLabs", String(error));
  }
};

// --- Apollo: real per-endpoint API quota (master key required) ------------
const pickBusiestDayQuota = (data: unknown) => {
  let consumed = 0;
  let limit = 0;
  if (!isRecord(data)) return { consumed, limit };
  for (const value of Object.values(data)) {
    const day = isRecord(value) && isRecord(value.day) ? value.day : null;
    if (!day) continue;
    const dayLimit = numberOf(day.limit) ?? 0;
    if (dayLimit <= limit) continue;
    limit = dayLimit;
    consumed = numberOf(day.consumed) ?? 0;
  }

  return { consumed, limit };
};

const apolloResult = (consumed: number, limit: number) => {
  if (limit === 0) {
    const noQuota: ProviderBalance = {
      ...base("apollo", "Apollo"),
      detail: "Reached Apollo (no day quota in response)",
      note: "If usage stats 403, the key must be an Apollo master key.",
      status: "ok",
    };

    return noQuota;
  }
  const result: ProviderBalance = {
    ...base("apollo", "Apollo"),
    detail: `${Math.max(0, limit - consumed)} / ${limit} calls left today`,
    kind: "quota",
    limit,
    remaining: Math.max(0, limit - consumed),
    status: "ok",
    unit: "calls",
    used: consumed,
  };

  return result;
};

const apolloBalance = async (creds: { apiKey: string }) => {
  if (!creds.apiKey) return unconfigured("apollo", "Apollo", "API key unset");
  try {
    // POST (not GET) per Apollo's API; needs the master key.
    const data = await fetchJson(
      "https://api.apollo.io/api/v1/usage_stats/api_usage_stats",
      { "Content-Type": "application/json", "X-Api-Key": creds.apiKey },
      { method: "POST" },
    );
    const { consumed, limit } = pickBusiestDayQuota(data);

    return apolloResult(consumed, limit);
  } catch (error) {
    return errored(
      "apollo",
      "Apollo",
      `${error} — usage stats need the Apollo master key`,
    );
  }
};

// --- Brave: no API; read the snapshot the host captured off its own calls --
const braveBalance = (snap: BraveUsageSnapshot | null | undefined) => {
  if (!snap) {
    return unconfigured(
      "brave",
      "Brave Search",
      "No usage captured yet — appears after the next web search.",
    );
  }
  if (snap.monthlyLimit && snap.monthlyLimit > 0) {
    const remaining = snap.monthlyRemaining ?? 0;
    const quota: ProviderBalance = {
      ...base("brave", "Brave Search"),
      checkedAt: snap.capturedAt,
      detail: `${remaining} / ${snap.monthlyLimit} queries left this month`,
      kind: "quota",
      limit: snap.monthlyLimit,
      remaining,
      status: "ok",
      unit: "queries",
      used: snap.monthlyLimit - remaining,
    };

    return quota;
  }
  const metered: ProviderBalance = {
    ...base("brave", "Brave Search"),
    checkedAt: snap.capturedAt,
    detail: "Metered · pay-as-you-go",
    note: "No prepaid cap — billed per query; the host's spend cap is the ceiling.",
    status: "ok",
    tier: "metered",
  };

  return metered;
};

const costWindowStart = () => Date.now() - COST_WINDOW_DAYS * MS_PER_DAY;

// --- OpenAI: real spend (no balance API). Needs an sk-admin- Admin key. ----
const sumOpenAiCosts = (data: unknown) => {
  const buckets = isRecord(data) && Array.isArray(data.data) ? data.data : [];

  return buckets.reduce<number>((total, bucket) => {
    const results =
      isRecord(bucket) && Array.isArray(bucket.results) ? bucket.results : [];
    const bucketSum = results.reduce<number>((sub, row) => {
      const amount = isRecord(row) && isRecord(row.amount) ? row.amount : null;
      const value = amount ? Number(amount.value) : NaN;

      return sub + (Number.isFinite(value) ? value : 0);
    }, 0);

    return total + bucketSum;
  }, 0);
};

const openaiBalance = async (creds: { adminKey: string }) => {
  if (!creds.adminKey) {
    return unconfigured(
      "openai",
      "OpenAI",
      "No balance API. Provide an sk-admin- Admin key to show real spend.",
    );
  }
  try {
    const startTime = Math.floor(costWindowStart() / MS_PER_SECOND);
    const data = await fetchJson(
      `https://api.openai.com/v1/organization/costs?start_time=${startTime}&limit=${COST_WINDOW_DAYS + 1}`,
      { Authorization: `Bearer ${creds.adminKey}` },
      { timeoutMs: COST_FETCH_TIMEOUT_MS },
    );
    const result: ProviderBalance = {
      ...base("openai", "OpenAI"),
      detail: `${usd(sumOpenAiCosts(data))} spent (30d)`,
      kind: "cost",
      note: "No balance API — real provider-reported spend, not balance.",
      status: "ok",
    };

    return result;
  } catch (error) {
    return errored("openai", "OpenAI", String(error));
  }
};

// --- Anthropic: real spend (no balance API). Needs an sk-ant-admin key. ----
const sumAnthropicCosts = (data: unknown) => {
  const buckets = isRecord(data) && Array.isArray(data.data) ? data.data : [];

  return buckets.reduce<number>((total, bucket) => {
    const results =
      isRecord(bucket) && Array.isArray(bucket.results) ? bucket.results : [];
    const bucketSum = results.reduce<number>((sub, row) => {
      if (!isRecord(row)) return sub;
      const raw = row.amount ?? row.cost ?? row.value;
      const value = Number(isRecord(raw) ? (raw.value ?? raw.amount) : raw);

      return sub + (Number.isFinite(value) ? value : 0);
    }, 0);

    return total + bucketSum;
  }, 0);
};

const anthropicBalance = async (creds: { adminKey: string }) => {
  if (!creds.adminKey) {
    return unconfigured(
      "anthropic",
      "Anthropic",
      "No balance API. Provide an sk-ant-admin Admin key to show real spend.",
    );
  }
  try {
    const startedAt = new Date(costWindowStart()).toISOString();
    const data = await fetchJson(
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startedAt}`,
      { "anthropic-version": "2023-06-01", "x-api-key": creds.adminKey },
      { timeoutMs: COST_FETCH_TIMEOUT_MS },
    );
    const result: ProviderBalance = {
      ...base("anthropic", "Anthropic"),
      detail: `${usd(sumAnthropicCosts(data))} spent (30d)`,
      kind: "cost",
      note: "No balance API — real provider-reported spend, not balance.",
      status: "ok",
    };

    return result;
  } catch (error) {
    return errored(
      "anthropic",
      "Anthropic",
      `${error} — needs an sk-ant-admin Admin key (a regular API key won't work).`,
    );
  }
};

/**
 * Read every configured provider's real balance/quota/spend in parallel. Only
 * providers present in `config` produce a tile. Each runs independently — one
 * failing returns an "error" tile, never rejects the whole call. Stateless: the
 * caller owns any caching (these are free reporting calls, ~1/min is plenty).
 */
export const readProviderBalances = async (
  config: ProviderBalanceConfig,
): Promise<ProviderBalance[]> => {
  const jobs: Array<Promise<ProviderBalance>> = [];
  if (config.twilio) jobs.push(twilioBalance(config.twilio));
  if (config.deepgram) jobs.push(deepgramBalance(config.deepgram));
  if (config.elevenlabs) jobs.push(elevenLabsBalance(config.elevenlabs));
  if (config.apollo) jobs.push(apolloBalance(config.apollo));
  if ("brave" in config) jobs.push(Promise.resolve(braveBalance(config.brave)));
  if (config.anthropic) jobs.push(anthropicBalance(config.anthropic));
  if (config.openai) jobs.push(openaiBalance(config.openai));

  return Promise.all(jobs);
};
