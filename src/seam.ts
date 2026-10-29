import { AxiError } from "axi-sdk-js";
import { redact } from "./redact.js";
import { fillPath, matchesTemplate, type Operation, type Registry } from "./registry.js";
import { apiBaseUrl } from "./sites.js";
import type { Target } from "./target.js";
import { VERSION } from "./version.js";

/**
 * The one HTTP seam (S5). Every Datadog request goes through `Seam.call`,
 * which only accepts operation ids from the registry. No other module calls
 * `fetch` (a test enforces this).
 *
 * The seam also owns:
 * - the S3 write gate for `access: "write"` operations,
 * - bounded retries for reads on 429 / 502-504 (D8), never a loop,
 * - translating HTTP failures into the S13 error codes,
 * - redacting every response body before any command sees it (S12).
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SeamOptions {
  target: Target;
  registry: Registry;
  /** Orgs on the local write allowlist (config `writable`). */
  writable: readonly string[];
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Base URL override for tests; loopback only (see `resolveBaseUrl`). */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface CallInput {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Per-call timeout; the home view uses a short one. */
  timeoutMs?: number;
}

export interface WriteGateInput {
  /** True when the operation's execute flag was passed. */
  execute: boolean;
  /** The exact command the agent ran, to reprint with the execute flag. */
  command: string;
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
  name?: string;
}

export interface CallResult<T = unknown> {
  data: T;
  /** How many fields redaction hid in this response. */
  redacted: number;
  rateLimit: RateLimit;
}

export interface WritePreview {
  preview: true;
  target: { org: string; site: string };
  operation: string;
  request: string;
  sent: false;
  run: string;
}

const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_SECONDS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_DETAIL_LIMIT = 300;

export const API_URL_ENV = "DATADOG_AXI_API_URL";

/**
 * Production traffic always goes to `https://api.<site>`. `DATADOG_AXI_API_URL`
 * exists for fakes and recorded-fixture servers and is accepted only for a
 * loopback host, so it can never redirect real keys to another machine.
 */
export function resolveBaseUrl(site: string, env: NodeJS.ProcessEnv): string {
  const override = env[API_URL_ENV];
  if (override === undefined || override.length === 0) {
    return apiBaseUrl(site);
  }
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new AxiError(`${API_URL_ENV} is not a valid URL`, "VALIDATION_ERROR", [
      `Unset ${API_URL_ENV}; it is only for local test servers`,
    ]);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new AxiError(`${API_URL_ENV} must point at a loopback host`, "VALIDATION_ERROR", [
      `Unset ${API_URL_ENV}; real traffic always goes to https://api.<site>`,
    ]);
  }
  return override.replace(/\/+$/, "");
}

export class Seam {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: SeamOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = options.baseUrl ?? apiBaseUrl(options.target.site);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get target(): Target {
    return this.options.target;
  }

  /** Run a registered read operation. */
  async call<T = unknown>(operationId: string, input: CallInput = {}): Promise<CallResult<T>> {
    const op = this.operation(operationId);
    if (op.access !== "read") {
      throw new AxiError(`${operationId} is a write and must go through the write gate`, "REFUSED", [
        "Writes are previewed by default; see ROADMAP.md",
      ]);
    }
    return this.send<T>(op, input, true);
  }

  /**
   * Run a registered write operation through the S3 gate: the org must be
   * named explicitly and be on the local `writable` allowlist, and without
   * the operation's execute flag nothing is sent and a preview is returned.
   */
  async write<T = unknown>(
    operationId: string,
    input: CallInput,
    gate: WriteGateInput,
  ): Promise<CallResult<T> | WritePreview> {
    const op = this.operation(operationId);
    if (op.access !== "write") {
      throw new Error(`${operationId} is not a write operation`);
    }
    const { target, writable } = this.options;

    if (!target.explicit) {
      throw new AxiError(`Writes need the target org named explicitly`, "VALIDATION_ERROR", [
        `Re-run with \`--org <name>\`: ${gate.command} --org <name>`,
      ]);
    }
    if (!writable.includes(target.org)) {
      throw new AxiError(`Org "${target.org}" (${target.site}) is not on the local writable allowlist`, "REFUSED", [
        'Writes are allowed only for orgs a human lists under "writable" in the datadog-axi config file (default: none)',
        "Run `datadog-axi ctx` to see the config path and the allowlist",
      ]);
    }

    const flag = op.executeFlag;
    if (!flag) {
      throw new Error(`${operationId} has no execute flag`);
    }
    if (!gate.execute) {
      return {
        preview: true,
        target: { org: target.org, site: target.site },
        operation: op.id,
        request: `${op.method} ${fillPath(op.path, input.params)}`,
        sent: false,
        run: `${gate.command} ${flag}`,
      };
    }

    return this.send<T>(op, input, false);
  }

  private operation(id: string): Operation {
    const op = this.options.registry.get(id);
    if (!op) {
      throw new AxiError(`Operation ${id} is not on the allowlist`, "REFUSED", [
        "Only registered Datadog operations can be called",
      ]);
    }
    return op;
  }

  private buildUrl(op: Operation, input: CallInput): string {
    const url = new URL(`${this.baseUrl}${fillPath(op.path, input.params)}`);
    if (!matchesTemplate(op.path, url.pathname)) {
      throw new AxiError(`Request path ${url.pathname} is not the path of ${op.id}`, "REFUSED", [
        "Only registered Datadog operations can be called",
      ]);
    }
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `datadog-axi/${VERSION}`,
    };
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    const { auth } = this.options.target;
    if (auth.kind === "bearer") {
      headers.Authorization = `Bearer ${auth.token}`;
    } else {
      headers["DD-API-KEY"] = auth.apiKey;
      headers["DD-APPLICATION-KEY"] = auth.appKey;
    }
    return headers;
  }

  private async send<T>(op: Operation, input: CallInput, retryable: boolean): Promise<CallResult<T>> {
    const url = this.buildUrl(op, input);
    const hasBody = input.body !== undefined;
    const init: RequestInit = {
      method: op.method,
      headers: this.headers(hasBody),
      body: hasBody ? JSON.stringify(input.body) : undefined,
      // Never follow a redirect: it could carry the keys to another host.
      redirect: "error",
    };

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(input.timeoutMs ?? this.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (!timedOut && retryable && attempt < MAX_RETRIES) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        throw this.unreachable(timedOut ? "the request timed out" : "the connection failed");
      }

      const rateLimit = readRateLimit(response.headers);

      if (response.status === 429) {
        const wait = rateLimit.resetSeconds ?? 1;
        if (retryable && attempt < MAX_RETRIES && wait <= MAX_RETRY_WAIT_SECONDS) {
          await this.sleep(Math.max(wait, 1) * 1000);
          continue;
        }
        throw rateLimited(op, rateLimit);
      }

      if (retryable && [502, 503, 504].includes(response.status) && attempt < MAX_RETRIES) {
        await this.sleep(1000 * (attempt + 1));
        continue;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        // The timeout signal also covers the body read; map it like a failed connection.
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw this.unreachable(timedOut ? "the response timed out" : "the response was cut off");
      }
      if (!response.ok) {
        throw this.translate(response.status, text);
      }

      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new AxiError("Datadog returned a response that is not JSON", "UPSTREAM_ERROR", [
            "Retry the command; if it persists, check https://status.datadoghq.com",
          ]);
        }
      }
      const { value, redacted } = redact(parsed);
      return { data: value as T, redacted, rateLimit };
    }
  }

  private unreachable(reason: string): AxiError {
    const { org, site } = this.options.target;
    return new AxiError(`Could not reach Datadog site ${site}: ${reason}`, "SERVER_UNREACHABLE", [
      "Check network access, then retry",
      `Run \`datadog-axi doctor${org !== "env" ? ` --org ${org}` : ""}\` to check site reachability`,
    ]);
  }

  private translate(status: number, body: string): AxiError {
    const { org, site } = this.options.target;
    const detail = extractErrorDetail(body);
    const orgFlag = org !== "env" ? ` --org ${org}` : "";

    if (status === 400 || status === 422) {
      return new AxiError(`Datadog rejected the request${detail ? `: ${detail}` : ""}`, "VALIDATION_ERROR", [
        "Check the query syntax; datadog-axi passes Datadog query strings through unchanged",
      ]);
    }
    if (status === 401) {
      return new AxiError(`Datadog rejected the credentials for org ${org} on site ${site}`, "AUTH_REQUIRED", [
        "Keys belong to one site: if they were issued on another site, pass `--site <site>` (env credentials) or store the org with its own site",
        `Run \`datadog-axi auth status${orgFlag}\` to check the keys`,
      ]);
    }
    if (status === 403) {
      const permission = /\b([a-z]+(?:_[a-z]+)*_(?:read|write|query|read_data))\b/.exec(detail ?? "")?.[1];
      return new AxiError(
        `Datadog denied access${permission ? `: missing permission ${permission}` : ""}${detail && !permission ? ` (${detail})` : ""}`,
        "FORBIDDEN",
        [
          "The application key's scopes or the user's role do not allow this read",
          `Run \`datadog-axi auth status${orgFlag}\` to see which domains are readable`,
        ],
      );
    }
    if (status === 404) {
      return new AxiError(`Not found${detail ? `: ${detail}` : ""}`, "NOT_FOUND", [
        `Check the id and that site ${site} is the right one for this org`,
      ]);
    }
    if (status >= 500) {
      return new AxiError(
        `Datadog returned a server error (${status})`,
        status >= 502 && status <= 504 ? "SERVER_UNREACHABLE" : "UPSTREAM_ERROR",
        ["Retry shortly; check https://status.datadoghq.com"],
      );
    }
    return new AxiError(`Datadog returned HTTP ${status}${detail ? `: ${detail}` : ""}`, "UPSTREAM_ERROR", []);
  }
}

function readRateLimit(headers: Headers): RateLimit {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    resetSeconds: num("x-ratelimit-reset"),
    name: headers.get("x-ratelimit-name") ?? undefined,
  };
}

function rateLimited(op: Operation, rateLimit: RateLimit): AxiError {
  const reset = rateLimit.resetSeconds;
  return new AxiError(
    `Datadog rate limit reached for ${rateLimit.name ?? op.domain}${reset !== undefined ? `; resets in ${reset}s` : ""}`,
    "RATE_LIMITED",
    [
      reset !== undefined ? `Retry after ${reset}s` : "Retry in a minute",
      op.domain === "traces"
        ? "Span search is limited to 300 requests per hour; narrow the window instead of repeating searches"
        : "Narrow the query or window to need fewer calls",
    ],
  );
}

/** Pull Datadog's own error text out of a v1 or v2 error body; never the raw body. */
export function extractErrorDetail(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const errors = (parsed as { errors?: unknown })?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  const messages = errors
    .map((e) => {
      if (typeof e === "string") {
        return e;
      }
      if (e && typeof e === "object") {
        const { title, detail } = e as { title?: unknown; detail?: unknown };
        return [title, detail].filter((x) => typeof x === "string" && x.length > 0).join(": ");
      }
      return "";
    })
    .filter((m) => m.length > 0);
  if (messages.length === 0) {
    return undefined;
  }
  const joined = redact(messages).value.join("; ").replace(/\s+/g, " ").trim();
  return joined.length > ERROR_DETAIL_LIMIT ? `${joined.slice(0, ERROR_DETAIL_LIMIT)}...` : joined;
}
