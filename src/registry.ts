/**
 * The operation registries (S5): the only list of Datadog requests this tool
 * can make, plus the refusal list of known requests it never makes.
 *
 * Datadog hides many reads behind POST (logs, spans, events, RUM search,
 * metrics v2 queries) and many writes behind POST too, so nothing here is
 * classified by HTTP verb. Each operation is keyed by method + path template
 * + body type, and the seam refuses anything that is not registered.
 *
 * `access: "write"` operations pass the S3 gate in the seam (preview by
 * default, explicit `--org`, and the org on the local `writable` allowlist).
 * datadog-axi v1 registers none: `WRITE_OPERATIONS` is empty by design and
 * a test pins that. See ROADMAP.md for the planned write tier.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Operation {
  id: string;
  method: HttpMethod;
  /** Path template; `{name}` matches one path segment. */
  path: string;
  access: "read" | "write";
  /** Request body type for POST reads, e.g. `logs_search_request`. */
  bodyType?: string;
  /** Permission domain, used by `auth status` / `doctor` and docs. */
  domain: string;
  /** Reachable through the `api` escape hatch. */
  api: boolean;
  /** For writes: the Datadog-vocabulary flag that executes instead of previewing. */
  executeFlag?: string;
  note?: string;
}

export interface Refusal {
  /** `*` matches every method. */
  method: HttpMethod | HttpMethod[] | "*";
  /** Path template; a trailing `/**` also matches every sub-path. */
  path: string;
  reason: string;
  alternative: string;
}

const r = (
  id: string,
  method: HttpMethod,
  path: string,
  domain: string,
  extra: Partial<Operation> = {},
): Operation => ({ id, method, path, access: "read", domain, api: true, ...extra });

export const READ_OPERATIONS: Operation[] = [
  r("auth.validate", "GET", "/api/v1/validate", "auth"),
  r("auth.current_user_app_keys", "GET", "/api/v2/current_user/application_keys", "auth", {
    api: false,
    note: "doctor only: reports the scopes of the key in use by its last four characters",
  }),

  r("monitors.search", "GET", "/api/v1/monitor/search", "monitors"),
  r("monitors.list", "GET", "/api/v1/monitor", "monitors"),
  r("monitors.get", "GET", "/api/v1/monitor/{monitor_id}", "monitors"),
  r("monitors.groups_search", "GET", "/api/v1/monitor/groups/search", "monitors"),

  r("logs.search", "POST", "/api/v2/logs/events/search", "logs", { bodyType: "logs_search_request" }),
  r("logs.list", "GET", "/api/v2/logs/events", "logs"),
  r("logs.aggregate", "POST", "/api/v2/logs/analytics/aggregate", "logs", {
    bodyType: "logs_aggregate_request",
  }),
  r("logs.list_v1", "POST", "/api/v1/logs-queries/list", "logs", { bodyType: "logs_list_request" }),
  r("logs.indexes", "GET", "/api/v1/logs/config/indexes", "logs"),

  r("metrics.timeseries", "POST", "/api/v2/query/timeseries", "metrics", {
    bodyType: "timeseries_formula_query_request",
  }),
  r("metrics.scalar", "POST", "/api/v2/query/scalar", "metrics", {
    bodyType: "scalar_formula_query_request",
  }),
  r("metrics.query_v1", "GET", "/api/v1/query", "metrics"),
  r("metrics.active", "GET", "/api/v1/metrics", "metrics"),
  r("metrics.search", "GET", "/api/v1/search", "metrics"),
  r("metrics.metadata", "GET", "/api/v1/metrics/{metric_name}", "metrics"),
  r("metrics.all_tags", "GET", "/api/v2/metrics/{metric_name}/all-tags", "metrics"),
  r("metrics.volumes", "GET", "/api/v2/metrics/{metric_name}/volumes", "metrics"),
  r("metrics.tag_configs", "GET", "/api/v2/metrics", "metrics"),

  r("spans.search", "POST", "/api/v2/spans/events/search", "traces", {
    bodyType: "spans_list_request",
    note: "rate limited to 300 requests per hour",
  }),
  r("spans.list", "GET", "/api/v2/spans/events", "traces"),
  r("spans.aggregate", "POST", "/api/v2/spans/analytics/aggregate", "traces", {
    bodyType: "spans_aggregate_request",
  }),

  r("services.definitions", "GET", "/api/v2/services/definitions", "services"),
  r("services.definition", "GET", "/api/v2/services/definitions/{service_name}", "services"),

  r("dashboards.list", "GET", "/api/v1/dashboard", "dashboards"),
  r("dashboards.get", "GET", "/api/v1/dashboard/{dashboard_id}", "dashboards"),

  r("incidents.list", "GET", "/api/v2/incidents", "incidents"),
  r("incidents.search", "GET", "/api/v2/incidents/search", "incidents"),
  r("incidents.get", "GET", "/api/v2/incidents/{incident_id}", "incidents"),

  r("events.list_v1", "GET", "/api/v1/events", "events"),
  r("events.get_v1", "GET", "/api/v1/events/{event_id}", "events"),
  r("events.list", "GET", "/api/v2/events", "events"),
  r("events.search", "POST", "/api/v2/events/search", "events", { bodyType: "events_list_request" }),
  r("events.get", "GET", "/api/v2/events/{event_id}", "events"),

  r("hosts.list", "GET", "/api/v1/hosts", "hosts"),
  r("hosts.totals", "GET", "/api/v1/hosts/totals", "hosts"),

  r("slos.list", "GET", "/api/v1/slo", "slos"),
  r("slos.search", "GET", "/api/v1/slo/search", "slos"),
  r("slos.get", "GET", "/api/v1/slo/{slo_id}", "slos"),
  r("slos.history", "GET", "/api/v1/slo/{slo_id}/history", "slos"),

  r("downtimes.list", "GET", "/api/v2/downtime", "downtimes"),
  r("downtimes.get", "GET", "/api/v2/downtime/{downtime_id}", "downtimes"),

  r("synthetics.list", "GET", "/api/v1/synthetics/tests", "synthetics"),
  r("synthetics.get", "GET", "/api/v1/synthetics/tests/{public_id}", "synthetics"),
  r("synthetics.api_results", "GET", "/api/v1/synthetics/tests/{public_id}/results", "synthetics"),
  r("synthetics.browser_results", "GET", "/api/v1/synthetics/tests/browser/{public_id}/results", "synthetics"),

  r("notebooks.list", "GET", "/api/v1/notebooks", "notebooks"),
  r("notebooks.get", "GET", "/api/v1/notebooks/{notebook_id}", "notebooks"),

  r("rum.search", "POST", "/api/v2/rum/events/search", "rum", { bodyType: "rum_search_request" }),
  r("rum.list", "GET", "/api/v2/rum/events", "rum"),
];

/** Empty in v1 (D3: read-only core). The gate is in place for the roadmap's write tier. */
export const WRITE_OPERATIONS: Operation[] = [];

const WRITE_ALTERNATIVE = "datadog-axi v1 is read-only; make this change in the Datadog UI or ask a human";
const CREDENTIAL_REASON = "is a credential endpoint, which datadog-axi never exposes";

const MUTATING: HttpMethod[] = ["POST", "PUT", "PATCH", "DELETE"];

const refuse = (method: Refusal["method"], path: string, reason: string, alternative = WRITE_ALTERNATIVE): Refusal => ({
  method,
  path,
  reason,
  alternative,
});

export const REFUSALS: Refusal[] = [
  refuse("*", "/api/v1/api_key/**", CREDENTIAL_REASON, "Manage keys in the Datadog UI"),
  refuse("*", "/api/v2/api_keys/**", CREDENTIAL_REASON, "Manage keys in the Datadog UI"),
  refuse("*", "/api/v1/application_key/**", CREDENTIAL_REASON, "Manage keys in the Datadog UI"),
  refuse("*", "/api/v2/application_keys/**", CREDENTIAL_REASON, "Manage keys in the Datadog UI"),
  refuse(
    "*",
    "/api/v2/current_user/application_keys/**",
    CREDENTIAL_REASON,
    "Run `datadog-axi doctor` to see the key's scopes",
  ),
  refuse("*", "/api/v2/service_accounts/**", CREDENTIAL_REASON, "Manage service accounts in the Datadog UI"),

  refuse("POST", "/api/v1/monitor", "creates a monitor"),
  refuse("PUT", "/api/v1/monitor/{monitor_id}", "edits a monitor"),
  refuse("DELETE", "/api/v1/monitor/{monitor_id}", "deletes a monitor"),
  refuse("POST", "/api/v1/monitor/{monitor_id}/mute", "mutes a monitor (silences alerts)"),
  refuse("POST", "/api/v1/monitor/{monitor_id}/unmute", "unmutes a monitor"),
  refuse("POST", "/api/monitor/bulk_resolve", "resolves monitor groups"),
  refuse("POST", "/api/v1/monitor/validate", "has undocumented side effects, so it is not classified as a read"),
  refuse(
    "POST",
    "/api/v1/monitor/{monitor_id}/validate",
    "has undocumented side effects, so it is not classified as a read",
  ),

  refuse("POST", "/api/v1/dashboard", "creates a dashboard"),
  refuse("PUT", "/api/v1/dashboard/{dashboard_id}", "edits a dashboard"),
  refuse("DELETE", "/api/v1/dashboard/{dashboard_id}", "deletes a dashboard"),
  refuse("DELETE", "/api/v1/dashboard", "bulk-deletes dashboards"),
  refuse("PATCH", "/api/v1/dashboard", "restores deleted dashboards"),

  refuse("POST", "/api/v1/series", "submits metrics (ingest)"),
  refuse("POST", "/api/v2/series", "submits metrics (ingest)"),
  refuse("POST", "/api/v1/distribution_points", "submits metrics (ingest)"),
  refuse("PUT", "/api/v1/metrics/{metric_name}", "edits metric metadata"),
  refuse("*", "/api/v2/metrics/{metric_name}/tags", "changes a metric's tag configuration"),

  refuse("POST", "/api/v2/logs", "sends logs (ingest)"),
  refuse("POST", "/v1/input/**", "sends logs (ingest)"),
  refuse(MUTATING, "/api/v1/logs/config/**", "changes log pipelines, indexes or archives"),
  refuse(MUTATING, "/api/v2/logs/config/**", "changes log configuration"),

  refuse("POST", "/api/v1/events", "posts an event"),
  refuse("POST", "/api/v2/events", "posts an event"),

  refuse("POST", "/api/v2/incidents", "declares an incident"),
  refuse("PATCH", "/api/v2/incidents/{incident_id}", "edits an incident"),
  refuse("DELETE", "/api/v2/incidents/{incident_id}", "deletes an incident"),
  refuse("POST", "/api/v2/incidents/{incident_id}/**", "changes an incident or pages responders"),
  refuse("PATCH", "/api/v2/incidents/{incident_id}/**", "changes an incident"),
  refuse("DELETE", "/api/v2/incidents/{incident_id}/**", "changes an incident"),

  refuse("POST", "/api/v1/synthetics/tests/trigger", "runs synthetic tests"),
  refuse("POST", "/api/v1/synthetics/tests/trigger/ci", "runs synthetic tests"),
  refuse("POST", "/api/v1/synthetics/tests/delete", "deletes synthetic tests"),
  refuse("PUT", "/api/v1/synthetics/tests/{public_id}/status", "pauses or starts a synthetic test"),

  refuse("POST", "/api/v2/downtime", "schedules a downtime (silences alerts)"),
  refuse("PATCH", "/api/v2/downtime/{downtime_id}", "edits a downtime"),
  refuse("DELETE", "/api/v2/downtime/{downtime_id}", "cancels a downtime"),
  refuse("*", "/api/v1/downtime/**", "changes downtimes (deprecated v1 API)"),

  refuse("POST", "/api/v1/slo", "creates an SLO"),
  refuse("PUT", "/api/v1/slo/{slo_id}", "edits an SLO"),
  refuse("DELETE", "/api/v1/slo/{slo_id}", "deletes an SLO"),
  refuse("POST", "/api/v1/slo/bulk_delete", "deletes SLOs"),

  refuse("POST", "/api/v1/notebooks", "creates a notebook"),
  refuse("PUT", "/api/v1/notebooks/{notebook_id}", "edits a notebook"),
  refuse("DELETE", "/api/v1/notebooks/{notebook_id}", "deletes a notebook"),

  refuse("POST", "/api/v1/host/{host_name}/mute", "mutes a host"),
  refuse("POST", "/api/v1/host/{host_name}/unmute", "unmutes a host"),
];

function compileTemplate(template: string): RegExp {
  const prefix = template.endsWith("/**");
  const base = prefix ? template.slice(0, -3) : template;
  const pattern = base
    .split("/")
    .map((segment) => (/^\{[a-z_]+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}${prefix ? "(?:/.*)?" : ""}$`);
}

function methodMatches(method: Refusal["method"], upper: string): boolean {
  return method === "*" || (Array.isArray(method) ? method.includes(upper as HttpMethod) : method === upper);
}

function placeholders(template: string): number {
  return (template.match(/\{[a-z_]+\}/g) ?? []).length;
}

export type Match =
  { kind: "allowed"; operation: Operation } | { kind: "refused"; refusal: Refusal } | { kind: "unregistered" };

export interface Registry {
  operations: ReadonlyMap<string, Operation>;
  refusals: readonly Refusal[];
  get(id: string): Operation | undefined;
  /** Classify a raw method + path, as the `api` command does. Refusals win. */
  match(method: string, path: string): Match;
}

export function createRegistry(
  operations: Operation[] = [...READ_OPERATIONS, ...WRITE_OPERATIONS],
  refusals: Refusal[] = REFUSALS,
): Registry {
  const byId = new Map<string, Operation>();
  for (const op of operations) {
    if (byId.has(op.id)) {
      throw new Error(`Duplicate operation id: ${op.id}`);
    }
    byId.set(op.id, op);
  }

  // Literal templates win over parameterized ones (`/monitor/search` before `/monitor/{id}`).
  const compiledOps = operations
    .map((op) => ({ op, re: compileTemplate(op.path) }))
    .sort((a, b) => placeholders(a.op.path) - placeholders(b.op.path));
  const compiledRefusals = refusals.map((refusal) => ({ refusal, re: compileTemplate(refusal.path) }));

  return {
    operations: byId,
    refusals,
    get: (id) => byId.get(id),
    match(method, path) {
      const upper = method.toUpperCase();
      const refused = compiledRefusals.find(({ refusal, re }) => methodMatches(refusal.method, upper) && re.test(path));
      if (refused) {
        return { kind: "refused", refusal: refused.refusal };
      }
      const allowed = compiledOps.find(({ op, re }) => op.method === upper && re.test(path));
      if (allowed) {
        return { kind: "allowed", operation: allowed.op };
      }
      return { kind: "unregistered" };
    },
  };
}

/** Fill a path template; each value is URI-encoded as one segment. */
export function fillPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing path parameter ${name} for ${template}`);
    }
    return encodeURIComponent(value);
  });
}

/** Inverse of `fillPath`: read the template's parameters out of a concrete path. */
export function extractParams(template: string, path: string): Record<string, string> {
  const names: string[] = [];
  const pattern = template
    .split("/")
    .map((segment) => {
      const m = /^\{([a-z_]+)\}$/.exec(segment);
      if (m) {
        names.push(m[1] as string);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const match = new RegExp(`^${pattern}$`).exec(path);
  const params: Record<string, string> = {};
  names.forEach((name, i) => {
    params[name] = decodeURIComponent(match?.[i + 1] ?? "");
  });
  return params;
}
