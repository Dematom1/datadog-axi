import { AxiError } from "axi-sdk-js";
import type { CallInput, RateLimit, Seam } from "./seam.js";
import { isoUtc } from "./time.js";

/**
 * Minimal reads that tell `auth status` and `doctor` which Datadog domains
 * the credential can read. Each probe asks for one item. Span search is not
 * probed: it is limited to 300 requests per hour and a probe would spend one.
 */

export interface ProbeResult {
  domain: string;
  readable: "yes" | "no" | "error" | "not probed";
  detail: string;
  rateLimit?: RateLimit;
}

interface Probe {
  domain: string;
  operation: string;
  input: (nowMs: number) => CallInput;
}

const PROBES: Probe[] = [
  { domain: "monitors", operation: "monitors.search", input: () => ({ query: { per_page: 1 } }) },
  {
    domain: "logs",
    operation: "logs.search",
    input: (now) => ({
      body: { filter: { query: "*", from: isoUtc(now - 60_000), to: isoUtc(now) }, page: { limit: 1 } },
    }),
  },
  { domain: "metrics", operation: "metrics.search", input: () => ({ query: { q: "metrics:datadog.agent.running" } }) },
  {
    domain: "incidents",
    operation: "incidents.search",
    input: () => ({ query: { query: "state:active", "page[size]": 1 } }),
  },
  { domain: "dashboards", operation: "dashboards.list", input: () => ({ query: { count: 1 } }) },
  {
    domain: "events",
    operation: "events.list_v1",
    input: (now) => ({ query: { start: Math.floor(now / 1000) - 60, end: Math.floor(now / 1000) } }),
  },
  { domain: "hosts", operation: "hosts.totals", input: () => ({}) },
  { domain: "slos", operation: "slos.list", input: () => ({ query: { limit: 1 } }) },
  { domain: "downtimes", operation: "downtimes.list", input: () => ({ query: { "page[limit]": 1 } }) },
  { domain: "synthetics", operation: "synthetics.list", input: () => ({ query: { page_size: 1 } }) },
  { domain: "notebooks", operation: "notebooks.list", input: () => ({ query: { count: 1 } }) },
  { domain: "services", operation: "services.definitions", input: () => ({ query: { "page[size]": 1 } }) },
];

export const PROBE_TIMEOUT_MS = 10_000;

export async function probeDomains(seam: Seam, nowMs: number): Promise<ProbeResult[]> {
  const results = await Promise.all(
    PROBES.map(async (probe): Promise<ProbeResult> => {
      try {
        const { rateLimit } = await seam.call(probe.operation, { ...probe.input(nowMs), timeoutMs: PROBE_TIMEOUT_MS });
        return { domain: probe.domain, readable: "yes", detail: "ok", rateLimit };
      } catch (error) {
        if (error instanceof AxiError && (error.code === "FORBIDDEN" || error.code === "AUTH_REQUIRED")) {
          return { domain: probe.domain, readable: "no", detail: error.code };
        }
        const code = error instanceof AxiError ? error.code : "UNKNOWN";
        return { domain: probe.domain, readable: "error", detail: code };
      }
    }),
  );
  results.push({ domain: "traces", readable: "not probed", detail: "span search allows 300 requests/hour" });
  return results;
}

export interface KeyCheck {
  valid: "yes" | "no" | "unknown";
  site_reachable: "yes" | "no" | "unknown";
  detail: string;
}

export async function validateKeys(seam: Seam): Promise<KeyCheck> {
  if (seam.target.auth.kind === "bearer") {
    return { valid: "unknown", site_reachable: "unknown", detail: "bearer token: see the domain probes" };
  }
  try {
    const { data } = await seam.call<{ valid?: boolean }>("auth.validate", { timeoutMs: PROBE_TIMEOUT_MS });
    return data.valid === false
      ? { valid: "no", site_reachable: "yes", detail: "Datadog reports the API key as invalid" }
      : { valid: "yes", site_reachable: "yes", detail: "API key accepted" };
  } catch (error) {
    const code = error instanceof AxiError ? error.code : "UNKNOWN";
    if (code === "AUTH_REQUIRED" || code === "FORBIDDEN") {
      return {
        valid: "no",
        site_reachable: "yes",
        detail: `${code}: the API key is not valid for site ${seam.target.site}`,
      };
    }
    if (code === "SERVER_UNREACHABLE") {
      return { valid: "unknown", site_reachable: "no", detail: `could not reach api.${seam.target.site}` };
    }
    return { valid: "unknown", site_reachable: "unknown", detail: code };
  }
}
