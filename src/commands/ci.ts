import { AxiError } from "axi-sdk-js";
import { bool, intFlag, parseArgs, str, TARGET_FLAGS, WINDOW_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  oneLine,
  project,
  rebuildCommand,
  redactionNote,
  selectFields,
  shellQuote,
  targetSuffix,
  truncate,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";
import type { Seam } from "../seam.js";
import { formatWindow, isoUtc, resolveWindow, windowFlags, type Window } from "../time.js";
import { flattenAttributes } from "./logs.js";

type Kind = "pipelines" | "tests";
interface CIEvent {
  id?: string;
  attributes?: { attributes?: Record<string, unknown>; tags?: string[]; ci_level?: string; test_level?: string };
}
interface Meta {
  status?: string;
  warnings?: unknown[];
  page?: { after?: string };
}
interface EventsResponse {
  data?: CIEvent[];
  meta?: Meta;
}
interface Bucket {
  by?: Record<string, unknown>;
  computes?: Record<string, unknown>;
}
interface AggregateResponse {
  data?: { buckets?: Bucket[] };
  meta?: Meta;
}

function attribute(event: CIEvent, path: string): unknown {
  let value: unknown = event.attributes?.attributes;
  for (const [index, part] of path.split(".").entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const remaining = path.split(".").slice(index).join(".");
    if (remaining in value) return Reflect.get(value, remaining);
    value = Reflect.get(value, part);
  }
  return value;
}
function text(event: CIEvent, path: string): string | null {
  const value = attribute(event, path);
  return typeof value === "string" ? value : null;
}
function duration(event: CIEvent): number | null {
  const value = attribute(event, "duration");
  return typeof value === "number" ? value / 1e9 : null;
}
const PIPELINE_FIELDS: FieldSet<CIEvent> = {
  all: {
    id: (e) => e.id,
    name: (e) => oneLine(text(e, "ci.pipeline.name")),
    status: (e) => text(e, "ci.status"),
    duration_s: duration,
    branch: (e) => text(e, "git.branch"),
    provider: (e) => text(e, "ci.provider.name"),
    time: (e) => text(e, "start"),
    url: (e) => text(e, "ci.pipeline.url"),
  },
  defaults: ["id", "name", "status", "duration_s", "branch", "provider"],
};
interface CountedTest {
  event: CIEvent;
  failures: number;
}
const TEST_FIELDS: FieldSet<CountedTest> = {
  all: {
    id: (t) => t.event.id,
    name: (t) => oneLine(text(t.event, "test.name")),
    status: (t) => text(t.event, "test.status"),
    flaky: (t) => attribute(t.event, "test.is_flaky") === true || attribute(t.event, "test.is_flaky") === "true",
    failures: (t) => t.failures,
    suite: (t) => text(t.event, "test.suite"),
    service: (t) => text(t.event, "test.service"),
    duration_s: (t) => duration(t.event),
    branch: (t) => text(t.event, "git.branch"),
  },
  defaults: ["id", "name", "status", "flaky", "failures"],
};
const COMMON = {
  ...WINDOW_FLAGS,
  ...TARGET_FLAGS,
  "--query": { kind: "string", value: "<query>", description: "Additional Datadog CI query (default: *)" },
} satisfies CommandSpec["flags"];
function listSpec(kind: Kind): CommandSpec {
  const fields = kind === "pipelines" ? PIPELINE_FIELDS.all : TEST_FIELDS.all;
  return {
    name: `ci ${kind}`,
    flags: {
      ...COMMON,
      "--limit": {
        kind: "string",
        value: "<n>",
        description: `Max events (default 20, max ${kind === "tests" ? 20 : 200})`,
      },
      "--cursor": { kind: "string", value: "<cursor>", description: "Continue the same query and absolute window" },
      "--fields": { kind: "list", value: "<fields>", description: `Extra columns: ${Object.keys(fields).join(", ")}` },
    },
  };
}
const VIEW: CommandSpec = {
  name: "ci view",
  positionals: ["<id>"],
  flags: {
    ...COMMON,
    "--kind": { kind: "string", value: "<pipelines|tests>", description: "Event family (default: pipelines)" },
    "--full": { kind: "boolean", description: "All attributes, without truncation" },
  },
};
export const CI_HELP = renderHelp({
  command: "ci",
  description: "Read CI Visibility pipeline runs and failing or flaky test events",
  subcommands: [
    { spec: listSpec("pipelines"), summary: "Recent pipeline runs, failures first across pages" },
    { spec: listSpec("tests"), summary: "Failing/flaky events with failure counts over the entire window" },
    { spec: VIEW, summary: "Find an event ID in the latest 1000 events of the selected family/query/window" },
  ],
  notes: [
    "Default window: last hour; output echoes absolute UTC. Failures first across pages, newest first within each status partition",
    "Tests: failures count runs with the same test name, suite and service, within the query/window; retries count separately",
    "Pipelines require ci_visibility_read; tests accept ci_visibility_read or test_optimization_read (OAuth: test_optimization_read)",
    "No get-by-ID endpoint exists: view scans up to 10 pages of 100 events, matching the exact response ID",
  ],
  examples: [
    "datadog-axi ci pipelines --from 24h",
    "datadog-axi ci tests --query '@git.branch:main'",
    "datadog-axi ci view <id> --kind tests --from 24h",
  ],
});

function filter(query: string, window: Window) {
  return { query, from: isoUtc(window.fromMs), to: isoUtc(window.toMs) };
}
function complete(meta?: Meta): void {
  if (meta?.status === "timeout" || (meta?.warnings?.length ?? 0) > 0) {
    throw new AxiError(
      "Datadog returned partial CI Visibility results; totals and empty states are not reliable",
      "UPSTREAM_ERROR",
      ["Narrow the window or query and retry"],
    );
  }
}
async function aggregate(seam: Seam, kind: Kind, query: string, window: Window, groupBy: unknown[] = []) {
  const result = await seam.call<AggregateResponse>(`ci.${kind}.aggregate`, {
    body: {
      filter: filter(query, window),
      compute: [{ aggregation: "count", type: "total" }],
      ...(groupBy.length ? { group_by: groupBy } : {}),
    },
  });
  complete(result.data?.meta);
  if (!Array.isArray(result.data?.data?.buckets) || result.data.meta?.page?.after) {
    throw new AxiError("Datadog did not return complete CI Visibility count buckets", "UPSTREAM_ERROR", [
      "Narrow the window or query and retry",
    ]);
  }
  return { buckets: result.data.data.buckets, redacted: result.redacted };
}
function count(bucket: Bucket): number {
  const value = Number(bucket.computes?.c0);
  if (!Number.isFinite(value) || value < 0)
    throw new AxiError("Invalid CI Visibility count from Datadog", "UPSTREAM_ERROR");
  return value;
}
const IDENTITY = ["test.name", "test.suite", "test.service"];
const MISSING = "__datadog_axi_missing__";
function identity(event: CIEvent): string {
  return JSON.stringify(IDENTITY.map((key) => text(event, key) ?? MISSING));
}
function exact(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}
async function testCounts(seam: Seam, events: CIEvent[], query: string, window: Window) {
  const identities = new Map(events.map((event) => [identity(event), event]));
  const clauses = [...identities.values()].map(
    (event) =>
      `(${IDENTITY.map((key) => {
        const value = text(event, key);
        return value === null ? `-@${key}:*` : `@${key}:${exact(value)}`;
      }).join(" AND ")})`,
  );
  if (!clauses.length) return { rows: [], redacted: 0 };
  // ponytail: cap pages at 20 identities; batch count queries before raising that limit.
  const result = await aggregate(
    seam,
    "tests",
    `(${query}) AND @test.status:fail AND (${clauses.join(" OR ")})`,
    window,
    IDENTITY.map((facet) => ({ facet: `@${facet}`, limit: 20, missing: MISSING })),
  );
  const counts = new Map(
    result.buckets.map((bucket) => [
      JSON.stringify(IDENTITY.map((key) => bucket.by?.[`@${key}`] ?? MISSING)),
      count(bucket),
    ]),
  );
  return {
    rows: events.map((event) => ({ event, failures: counts.get(identity(event)) ?? 0 })),
    redacted: result.redacted,
  };
}
async function priorityPage(
  seam: Seam,
  kind: Kind,
  query: string,
  window: Window,
  limit: number,
  other: boolean,
  cursor?: string,
) {
  const events: CIEvent[] = [];
  let redacted = 0;
  const failure = kind === "pipelines" ? "@ci.status:(error OR failed OR fail OR canceled)" : "@test.status:fail";
  for (const phase of other ? ["other"] : ["failed", "other"]) {
    const result = await seam.call<EventsResponse>(`ci.${kind}.search`, {
      body: {
        filter: filter(`(${query}) AND ${phase === "other" ? "-" : ""}${failure}`, window),
        sort: "-timestamp",
        page: { limit: limit - events.length, ...(cursor ? { cursor } : {}) },
      },
    });
    complete(result.data?.meta);
    if (!Array.isArray(result.data?.data))
      throw new AxiError("Datadog did not return CI Visibility events", "UPSTREAM_ERROR");
    redacted += result.redacted;
    events.push(...result.data.data);
    const after = result.data.meta?.page?.after;
    if (after) return { events, redacted, after: `${phase}:${after}` };
    if (events.length >= limit) return { events, redacted, after: phase === "failed" ? "other:" : undefined };
    cursor = undefined;
  }
  return { events, redacted, after: undefined };
}

export async function ciCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("ci", args, ["pipelines", "tests", "view"], "pipelines");
  if (sub === "view") return view(rest, rt);
  const kind: Kind = sub === "tests" ? "tests" : "pipelines";
  const spec = listSpec(kind);
  const parsed = parseArgs(spec, rest);
  const fields =
    kind === "pipelines"
      ? selectFields(parsed, PIPELINE_FIELDS, spec.name)
      : selectFields(parsed, TEST_FIELDS, spec.name);
  const limit = intFlag(parsed, "--limit", { default: 20, max: kind === "tests" ? 20 : 200 });
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());
  const userQuery = str(parsed, "--query") ?? "*";
  const base = `${kind === "pipelines" ? "ci_level:pipeline" : "test_level:test"} AND (${userQuery})`;
  const query = kind === "tests" ? `(${base}) AND (@test.status:fail OR @test.is_flaky:true)` : base;
  const cursor = str(parsed, "--cursor");
  const parts = cursor ? /^(failed|other):(.*)$/s.exec(cursor) : null;
  if (cursor && !parts)
    throw new AxiError("Invalid CI cursor", "VALIDATION_ERROR", [
      "Use the cursor printed by ci pipelines or ci tests with the same query and absolute window",
    ]);
  const seam = await connect(rt, parsed);
  const result = await priorityPage(seam, kind, query, window, limit, parts?.[1] === "other", parts?.[2]);
  const totals = await aggregate(seam, kind, query, window);
  const total = totals.buckets.reduce((sum, bucket) => sum + count(bucket), 0);
  let redacted = result.redacted + totals.redacted;
  const header = { site: seam.target.site, window: formatWindow(window), query };
  const events = result.events;
  if (!events.length) {
    const all = await aggregate(seam, kind, "*", window);
    redacted += all.redacted;
    const noData = all.buckets.reduce((sum, bucket) => sum + count(bucket), 0) === 0;
    return withHelp(
      {
        ...header,
        total,
        [kind]: noData
          ? "No CI Visibility data for this org in the time window"
          : cursor
            ? "0 events on this page"
            : "0 matching events (CI Visibility data exists)",
        ...redactionNote(redacted),
      },
      [
        `Widen the window: ${rebuildCommand(`datadog-axi ci ${kind}`, rest, ["--from", "--to", "--cursor"])} --from 7d`,
        `Check the org/site: datadog-axi ctx${targetSuffix(seam.target)}`,
      ],
    );
  }
  const tests = kind === "tests" ? await testCounts(seam, events, base, window) : null;
  redacted += tests?.redacted ?? 0;
  const after = result.after;
  return withHelp(
    {
      ...header,
      count: `${events.length} of ${total} total events`,
      order: "failures first, newest first within each status partition",
      [kind]: tests ? project(tests.rows, TEST_FIELDS, fields) : project(events, PIPELINE_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [
      ...(after
        ? [
            `Run \`${rebuildCommand(`datadog-axi ci ${kind}`, rest, ["--from", "--to", "--cursor"])} ${windowFlags(window)} --cursor ${shellQuote(after)}\` for the next page`,
          ]
        : []),
      `Run \`datadog-axi ci view <id> --kind ${kind} --query ${shellQuote(query)} ${windowFlags(window)}${targetSuffix(seam.target)}\` for attributes`,
    ],
  );
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = parsed.positionals[0];
  const kind = str(parsed, "--kind") ?? "pipelines";
  if (kind !== "pipelines" && kind !== "tests")
    throw new AxiError("--kind must be pipelines or tests", "VALIDATION_ERROR");
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());
  const query = str(parsed, "--query") ?? "*";
  const full = bool(parsed, "--full");
  const seam = await connect(rt, parsed);
  let cursor: string | undefined;
  let redacted = 0;
  for (let page = 0; page < 10; page++) {
    const result = await seam.call<EventsResponse>(`ci.${kind}.search`, {
      body: {
        filter: filter(query, window),
        sort: "-timestamp",
        page: { limit: 100, ...(cursor ? { cursor } : {}) },
      },
    });
    complete(result.data?.meta);
    if (!Array.isArray(result.data?.data))
      throw new AxiError("Datadog did not return CI Visibility events", "UPSTREAM_ERROR");
    redacted += result.redacted;
    const event = result.data.data?.find((event) => event.id === id);
    if (event) {
      const flat = flattenAttributes(event.attributes);
      const rows = flat
        .slice(0, full ? undefined : 40)
        .map(([key, value]) => ({ key, value: truncate(value, full ? Infinity : 1000).text }));
      const cut = rows.length < flat.length || (!full && flat.some(([, value]) => value.length > 1000));
      return withHelp(
        {
          site: seam.target.site,
          window: formatWindow(window),
          kind,
          id,
          attribute_count: flat.length,
          attributes: rows,
          ...redactionNote(redacted),
        },
        cut
          ? [
              `Run \`${rebuildCommand("datadog-axi ci view", args, ["--full", "--from", "--to"])} ${windowFlags(window)} --full\` for all attributes`,
            ]
          : [],
      );
    }
    cursor = result.data.meta?.page?.after;
    if (!cursor)
      throw new AxiError(
        `CI ${kind} event ${id} was not found in ${formatWindow(window)} on ${seam.target.site}`,
        "NOT_FOUND",
        ["Use the same --kind, --query, --from and --to as the list that returned the ID"],
      );
  }
  throw new AxiError("CI view reached its 1000-event scan limit; the event may still exist", "SEARCH_LIMIT", [
    "Narrow --from/--to or add --query to locate the event without an unbounded scan",
  ]);
}
