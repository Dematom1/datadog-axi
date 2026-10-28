import { AxiError } from "axi-sdk-js";
import { bool, intFlag, parseArgs, str, TARGET_FLAGS, WINDOW_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  iso,
  oneLine,
  orgSuffix,
  project,
  rebuildCommand,
  redactionNote,
  selectFields,
  shellQuote,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";
import { formatWindow, isoUtc, resolveWindow, windowFlags, type Window } from "../time.js";

interface SpanAttributes {
  service?: string;
  resource_name?: string;
  start_timestamp?: string;
  end_timestamp?: string;
  trace_id?: string;
  span_id?: string;
  parent_id?: string;
  env?: string;
  host?: string;
  type?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

interface Span {
  id?: string;
  attributes?: SpanAttributes;
}

interface SpansResponse {
  data?: Span[];
  meta?: { page?: { after?: string } };
}

const RATE_NOTE = "span search is limited to 300 requests per hour per org";

export function durationMs(a: SpanAttributes | undefined): number | null {
  const start = a?.start_timestamp ? Date.parse(a.start_timestamp) : NaN;
  const end = a?.end_timestamp ? Date.parse(a.end_timestamp) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

/** Best effort: Datadog marks errors in several places depending on the tracer. */
export function isError(a: SpanAttributes | undefined): boolean {
  if (!a) {
    return false;
  }
  const status = a.attributes?.status ?? a.custom?.status;
  if (status === "error") {
    return true;
  }
  if ((a.tags ?? []).includes("status:error")) {
    return true;
  }
  const error = a.custom?.error ?? a.attributes?.error;
  if (error === 1 || error === true || error === "1" || error === "true") {
    return true;
  }
  return error !== null && typeof error === "object" && Object.keys(error).length > 0;
}

export const SPAN_FIELDS: FieldSet<Span> = {
  all: {
    time: (s) => iso(s.attributes?.start_timestamp),
    service: (s) => s.attributes?.service,
    resource: (s) => oneLine(s.attributes?.resource_name, 120),
    duration_ms: (s) => durationMs(s.attributes),
    error: (s) => isError(s.attributes),
    trace_id: (s) => s.attributes?.trace_id,
    span_id: (s) => s.attributes?.span_id,
    env: (s) => s.attributes?.env,
    host: (s) => s.attributes?.host,
    type: (s) => s.attributes?.type,
  },
  defaults: ["service", "resource", "duration_ms", "error"],
};

const SEARCH: CommandSpec = {
  name: "traces search",
  positionals: ["<query>"],
  flags: {
    ...WINDOW_FLAGS,
    "--limit": { kind: "string", value: "<n>", description: "Max spans (default 20, max 200)" },
    "--sort": { kind: "string", value: "<order>", description: "-timestamp (newest first, default) or timestamp" },
    "--cursor": { kind: "string", value: "<cursor>", description: "Continue from a previous page's cursor" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(SPAN_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = {
  name: "traces view",
  positionals: ["<trace_id>"],
  flags: {
    "--full": { kind: "boolean", description: "Every span instead of the first 50" },
    ...WINDOW_FLAGS,
    ...TARGET_FLAGS,
  },
};

export const TRACES_HELP = renderHelp({
  command: "traces",
  description: "Search APM spans and view one trace as a summarized span tree",
  subcommands: [
    { spec: SEARCH, summary: "Search spans; the Datadog span query is passed through unchanged" },
    { spec: VIEW, summary: "Span tree for one trace: service, resource, duration, error" },
  ],
  notes: [RATE_NOTE, "Prefer one well-scoped search over many small ones"],
  examples: [
    'datadog-axi traces search "service:checkout status:error" --from 30m',
    'datadog-axi traces search "@duration:>2s env:prod" --fields trace_id',
    "datadog-axi traces view 1234567890123456789 --from 2h",
  ],
});

export async function tracesCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("traces", args, ["search", "view"]);
  return sub === "view" ? view(rest, rt) : search(rest, rt);
}

function spanSearchBody(query: string, window: Window, limit: number, sort: string, cursor?: string) {
  return {
    data: {
      type: "search_request",
      attributes: {
        filter: { query, from: isoUtc(window.fromMs), to: isoUtc(window.toMs) },
        page: { limit, ...(cursor ? { cursor } : {}) },
        sort,
      },
    },
  };
}

async function search(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SEARCH, args);
  const query = parsed.positionals[0] as string;
  const fields = selectFields(parsed, SPAN_FIELDS, SEARCH.name);
  const limit = intFlag(parsed, "--limit", { default: 20, max: 200 });
  const sort = str(parsed, "--sort") ?? "-timestamp";
  if (sort !== "timestamp" && sort !== "-timestamp") {
    throw new AxiError(`--sort must be timestamp or -timestamp`, "VALIDATION_ERROR", [
      "Pass `--sort -timestamp` for newest first",
    ]);
  }
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());
  const cursor = str(parsed, "--cursor");

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<SpansResponse>("spans.search", {
    body: spanSearchBody(query, window, limit, sort, cursor),
  });

  const spans = data.data ?? [];
  const after = data.meta?.page?.after;
  const org = orgSuffix(seam.target);
  const header = { site: seam.target.site, window: formatWindow(window), query };

  if (spans.length === 0) {
    return withHelp(
      {
        spans: "0 matched",
        ...header,
        note: `recent spans can take a minute to become searchable; ${RATE_NOTE}`,
        ...redactionNote(redacted),
      },
      [
        `Widen the window: ${rebuildCommand("datadog-axi traces search", args, ["--from", "--to", "--cursor"])} --from 24h`,
        "Loosen the query: check the service name and env (`service:<name> env:<env>`)",
      ],
    );
  }

  const hints: string[] = [];
  if (after) {
    hints.push(
      `Run \`${rebuildCommand("datadog-axi traces search", args, ["--from", "--to", "--cursor"])} ${windowFlags(window)} --cursor ${after}\` for the next ${limit}`,
    );
  }
  hints.push(
    fields.includes("trace_id")
      ? `Run \`datadog-axi traces view <trace_id> ${windowFlags(window)}${org}\` for the span tree`
      : "Add `--fields trace_id` to get ids for `traces view <trace_id>`",
  );

  return withHelp(
    {
      ...header,
      count: after ? `${spans.length} shown (more available)` : `${spans.length} (all matches)`,
      spans: project(spans, SPAN_FIELDS, fields),
      ...redactionNote(redacted),
    },
    hints,
  );
}

interface TreeRow {
  [key: string]: string | number | boolean | null;
  depth: number;
  service: string | null;
  resource: string;
  duration_ms: number | null;
  error: boolean;
}

export function spanTree(spans: Span[]): TreeRow[] {
  const ids = new Set(spans.map((s) => s.attributes?.span_id).filter(Boolean));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    const parent = span.attributes?.parent_id;
    if (!parent || parent === "0" || !ids.has(parent)) {
      roots.push(span);
    } else {
      children.set(parent, [...(children.get(parent) ?? []), span]);
    }
  }
  const byStart = (a: Span, b: Span) =>
    (Date.parse(a.attributes?.start_timestamp ?? "") || 0) - (Date.parse(b.attributes?.start_timestamp ?? "") || 0);

  const rows: TreeRow[] = [];
  const walk = (span: Span, depth: number) => {
    rows.push({
      depth,
      service: span.attributes?.service ?? null,
      resource: oneLine(span.attributes?.resource_name, 120),
      duration_ms: durationMs(span.attributes),
      error: isError(span.attributes),
    });
    for (const child of (children.get(span.attributes?.span_id ?? "") ?? []).sort(byStart)) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots.sort(byStart)) {
    walk(root, 0);
  }
  return rows;
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const traceId = parsed.positionals[0] as string;
  if (!/^[0-9a-fA-F]+$/.test(traceId)) {
    throw new AxiError(`Trace id must be decimal or hex digits: ${traceId}`, "VALIDATION_ERROR", [
      'Run `datadog-axi traces search "<query>" --fields trace_id` to find trace ids',
    ]);
  }
  const full = bool(parsed, "--full");
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<SpansResponse>("spans.search", {
    body: spanSearchBody(`trace_id:${traceId}`, window, 1000, "timestamp"),
  });
  const spans = data.data ?? [];
  if (spans.length === 0) {
    throw new AxiError(
      `Trace ${traceId} has no spans in ${formatWindow(window)} on site ${seam.target.site}`,
      "NOT_FOUND",
      [
        "Pass the window the trace falls in, e.g. the `--from`/`--to` of the search that returned it",
        `Run \`datadog-axi traces view ${traceId} --from 24h${orgSuffix(seam.target)}\` to look further back`,
      ],
    );
  }

  const rows = spanTree(spans);
  const limit = full ? rows.length : 50;
  const services = [...new Set(spans.map((s) => s.attributes?.service).filter((s): s is string => Boolean(s)))];
  const starts = spans.map((s) => Date.parse(s.attributes?.start_timestamp ?? "")).filter((n) => !Number.isNaN(n));
  const ends = spans.map((s) => Date.parse(s.attributes?.end_timestamp ?? "")).filter((n) => !Number.isNaN(n));

  const output: Record<string, unknown> = {
    site: seam.target.site,
    trace: {
      trace_id: traceId,
      spans: spans.length,
      errors: rows.filter((r) => r.error).length,
      services: services.join(", "),
      duration_ms: starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : null,
      start: starts.length ? iso(Math.min(...starts)) : null,
    },
    tree: rows.slice(0, limit),
    ...redactionNote(redacted),
  };

  const hints: string[] = [];
  if (rows.length > limit) {
    output.shown = `${limit} of ${rows.length} spans`;
    hints.push(
      `Run \`datadog-axi traces view ${traceId} ${windowFlags(window)}${orgSuffix(seam.target)} --full\` for every span`,
    );
  }
  if (spans.length === 1000) {
    hints.push("The trace has 1000+ spans; only the first 1000 were fetched");
  }
  const firstError = spans.find((s) => isError(s.attributes))?.attributes?.service;
  if (firstError) {
    hints.push(
      `Run \`datadog-axi logs search ${shellQuote(`service:${firstError} status:error`)} ${windowFlags(window)}${orgSuffix(seam.target)}\` for the erroring service's logs`,
    );
  }
  return withHelp(output, hints);
}
