import { AxiError } from "axi-sdk-js";
import { bool, intFlag, list, parseArgs, str, TARGET_FLAGS, WINDOW_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  DETAIL_TEXT_LIMIT,
  iso,
  oneLine,
  orgSuffix,
  project,
  rebuildCommand,
  redactionNote,
  selectFields,
  shellQuote,
  tagsText,
  truncate,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";
import { formatWindow, isoUtc, resolveWindow, windowFlags, type Window } from "../time.js";

interface LogEvent {
  id?: string;
  attributes?: {
    timestamp?: string;
    status?: string;
    service?: string;
    host?: string;
    message?: string;
    tags?: string[];
    attributes?: Record<string, unknown>;
  };
}

export const DEFAULT_LOG_LIMIT = 20;
export const MAX_LOG_LIMIT = 200;
const INGESTION_LAG = "recent logs can take a minute or more to become searchable";

export const LOG_FIELDS: FieldSet<LogEvent> = {
  all: {
    time: (l) => iso(l.attributes?.timestamp),
    service: (l) => l.attributes?.service,
    status: (l) => l.attributes?.status,
    message: (l) => oneLine(l.attributes?.message),
    host: (l) => l.attributes?.host,
    id: (l) => l.id,
    tags: (l) => tagsText(l.attributes?.tags),
  },
  defaults: ["time", "service", "status", "message"],
};

const INDEX_FLAG = {
  "--index": {
    kind: "list" as const,
    value: "<index>",
    description: "Log index to search (default: all indexes)",
  },
};

const SEARCH: CommandSpec = {
  name: "logs search",
  positionals: ["<query>"],
  flags: {
    ...WINDOW_FLAGS,
    ...INDEX_FLAG,
    "--limit": {
      kind: "string",
      value: "<n>",
      description: `Max events (default ${DEFAULT_LOG_LIMIT}, max ${MAX_LOG_LIMIT})`,
    },
    "--sort": { kind: "string", value: "<order>", description: "-timestamp (newest first, default) or timestamp" },
    "--cursor": { kind: "string", value: "<cursor>", description: "Continue from a previous page's cursor" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(LOG_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const AGGREGATE: CommandSpec = {
  name: "logs aggregate",
  positionals: ["<query>"],
  flags: {
    "--by": {
      kind: "string",
      value: "<facet>",
      description: "Group by a facet: status, service, host or @attribute (default: total only)",
    },
    "--limit": { kind: "string", value: "<n>", description: "Max groups (default 10, max 100)" },
    ...WINDOW_FLAGS,
    ...INDEX_FLAG,
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = {
  name: "logs view",
  positionals: ["<id>"],
  flags: {
    "--full": { kind: "boolean", description: "Untruncated message and every attribute" },
    ...WINDOW_FLAGS,
    ...TARGET_FLAGS,
  },
};

export const LOGS_HELP = renderHelp({
  command: "logs",
  description: "Search log events, count them by facet, and view one event",
  subcommands: [
    { spec: SEARCH, summary: "Search events; the Datadog log query is passed through unchanged" },
    { spec: AGGREGATE, summary: "Count matching events, optionally grouped by a facet" },
    { spec: VIEW, summary: "One event with its attributes; pass the window the event falls in" },
  ],
  notes: [
    "The window defaults to the last hour and is echoed as absolute UTC",
    "Start with `logs aggregate --by service` to see where errors come from before reading events",
  ],
  examples: [
    'datadog-axi logs search "service:checkout status:error" --from 15m',
    'datadog-axi logs aggregate "status:error" --by service --from 1h',
    "datadog-axi logs view <id> --from 2026-10-28T11:00:00Z --to 2026-10-28T12:00:00Z",
  ],
});

export async function logsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("logs", args, ["search", "aggregate", "view"]);
  if (sub === "aggregate") {
    return aggregate(rest, rt);
  }
  return sub === "view" ? view(rest, rt) : search(rest, rt);
}

function filter(query: string, window: Window, indexes: string[]): Record<string, unknown> {
  return {
    query,
    from: isoUtc(window.fromMs),
    to: isoUtc(window.toMs),
    indexes: indexes.length > 0 ? indexes : ["*"],
  };
}

function scope(site: string, window: Window, query: string, indexes: string[]): Record<string, string> {
  return {
    site,
    window: formatWindow(window),
    query: query === "" ? "*" : query,
    indexes: indexes.length > 0 ? indexes.join(",") : "* (all)",
  };
}

async function search(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SEARCH, args);
  const query = parsed.positionals[0] as string;
  const fields = selectFields(parsed, LOG_FIELDS, SEARCH.name);
  const limit = intFlag(parsed, "--limit", { default: DEFAULT_LOG_LIMIT, max: MAX_LOG_LIMIT });
  const sort = str(parsed, "--sort") ?? "-timestamp";
  if (sort !== "timestamp" && sort !== "-timestamp") {
    throw new AxiError(`--sort must be timestamp or -timestamp`, "VALIDATION_ERROR", [
      "Pass `--sort -timestamp` for newest first",
    ]);
  }
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());
  const indexes = list(parsed, "--index");
  const cursor = str(parsed, "--cursor");

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: LogEvent[]; meta?: { page?: { after?: string } } }>(
    "logs.search",
    {
      body: {
        filter: filter(query, window, indexes),
        page: { limit, ...(cursor ? { cursor } : {}) },
        sort,
      },
    },
  );

  const events = data.data ?? [];
  const after = data.meta?.page?.after;
  const org = orgSuffix(seam.target);
  const header = scope(seam.target.site, window, query, indexes);

  if (events.length === 0) {
    return withHelp({ logs: "0 matched", ...header, note: INGESTION_LAG, ...redactionNote(redacted) }, [
      `Widen the window: ${rebuildCommand("datadog-axi logs search", args, ["--from", "--to", "--cursor"])} --from 24h`,
      `Loosen the query, e.g. drop a facet: datadog-axi logs search "*" ${windowFlags(window)}${org}`,
    ]);
  }

  const hints: string[] = [];
  if (after) {
    hints.push(
      `Run \`${rebuildCommand("datadog-axi logs search", args, ["--from", "--to", "--cursor"])} ${windowFlags(window)} --cursor ${after}\` for the next ${limit}`,
    );
  }
  hints.push(
    `Run \`datadog-axi logs aggregate ${shellQuote(query)} --by service ${windowFlags(window)}${org}\` to count matches by service`,
  );
  hints.push(
    fields.includes("id")
      ? `Run \`datadog-axi logs view <id> ${windowFlags(window)}${org}\` for one event's attributes`
      : "Add `--fields id` to get event ids for `logs view <id>`",
  );

  return withHelp(
    {
      ...header,
      count: after ? `${events.length} shown (more available)` : `${events.length} (all matches)`,
      logs: project(events, LOG_FIELDS, fields),
      ...redactionNote(redacted),
    },
    hints,
  );
}

interface AggregateResponse {
  data?: { buckets?: Array<{ by?: Record<string, unknown>; computes?: Record<string, unknown> }> };
}

async function aggregate(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(AGGREGATE, args);
  const query = parsed.positionals[0] as string;
  const by = str(parsed, "--by");
  const limit = intFlag(parsed, "--limit", { default: 10, max: 100 });
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());
  const indexes = list(parsed, "--index");

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<AggregateResponse>("logs.aggregate", {
    body: {
      filter: filter(query, window, indexes),
      compute: [{ aggregation: "count", type: "total" }],
      ...(by
        ? { group_by: [{ facet: by, limit, sort: { aggregation: "count", order: "desc", type: "measure" } }] }
        : {}),
    },
  });

  const header = scope(seam.target.site, window, query, indexes);
  const buckets = data.data?.buckets ?? [];
  const count = (b: { computes?: Record<string, unknown> }) => Number(b.computes?.c0 ?? 0);
  const org = orgSuffix(seam.target);

  if (!by) {
    const total = buckets.reduce((sum, b) => sum + count(b), 0);
    return withHelp(
      { ...header, total, ...(total === 0 ? { note: INGESTION_LAG } : {}), ...redactionNote(redacted) },
      total === 0
        ? [`Widen the window: add \`--from 24h\``, 'Loosen the query, e.g. `"*"`']
        : [
            `Run \`datadog-axi logs aggregate ${shellQuote(query)} --by service ${windowFlags(window)}${org}\` to break it down`,
          ],
    );
  }

  const groups = buckets
    .map((b) => ({ [by]: stringify(b.by?.[by]), count: count(b) }))
    .sort((a, b) => (b.count as number) - (a.count as number));
  const total = groups.reduce((sum, g) => sum + (g.count as number), 0);

  if (groups.length === 0) {
    return withHelp({ ...header, by, groups: "0 matched", note: INGESTION_LAG, ...redactionNote(redacted) }, [
      `Widen the window: add \`--from 24h\``,
      `Check the facet name; reserved facets are status, service and host, attributes start with @`,
    ]);
  }

  return withHelp({ ...header, by, total_in_groups: total, groups, ...redactionNote(redacted) }, [
    `Run \`datadog-axi logs search ${shellQuote(`${query} ${by}:<value>`)} ${windowFlags(window)}${org}\` to read events from one group`,
  ]);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "(none)";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

const ATTRIBUTE_ROWS = 40;

/** Nested log attributes as dotted keys (`http.status_code`) with string values. */
export function flattenAttributes(value: unknown, prefix = ""): Array<[string, string]> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix) {
      return [[prefix, "{}"]];
    }
    return entries.flatMap(([key, child]) => flattenAttributes(child, prefix ? `${prefix}.${key}` : key));
  }
  if (!prefix) {
    return [];
  }
  return [[prefix, typeof value === "string" ? value : JSON.stringify(value)]];
}

interface LogsListV1Response {
  logs?: Array<{
    id?: string;
    content?: {
      timestamp?: string;
      host?: string;
      service?: string;
      message?: string;
      tags?: string[];
      attributes?: Record<string, unknown>;
    };
  }>;
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = parsed.positionals[0] as string;
  const full = bool(parsed, "--full");
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());

  const seam = await connect(rt, parsed);
  // Datadog has no get-by-id for logs; the v1 list API starts a page at a log id.
  const { data, redacted } = await seam.call<LogsListV1Response>("logs.list_v1", {
    body: {
      query: "*",
      time: { from: isoUtc(window.fromMs), to: isoUtc(window.toMs) },
      startAt: id,
      limit: 1,
      sort: "desc",
    },
  });

  const log = (data.logs ?? [])[0];
  if (!log || log.id !== id) {
    throw new AxiError(`Log ${id} was not found in ${formatWindow(window)} on site ${seam.target.site}`, "NOT_FOUND", [
      "Pass the window the event falls in, e.g. the `--from`/`--to` of the search that returned it",
      `Run \`datadog-axi logs view ${id} --from 7d${orgSuffix(seam.target)}\` to look further back`,
    ]);
  }

  const content = log.content ?? {};
  const message = truncate(content.message ?? "", full ? Number.POSITIVE_INFINITY : DETAIL_TEXT_LIMIT);
  const attributes = content.attributes ?? {};
  const flat = flattenAttributes(attributes);
  const attributeLimit = full ? flat.length : ATTRIBUTE_ROWS;
  const valueLimit = full ? Number.POSITIVE_INFINITY : 300;
  let valueCut = false;
  const rows = flat.slice(0, attributeLimit).map(([key, value]) => {
    const t = truncate(value, valueLimit);
    valueCut ||= t.truncated;
    return { key, value: t.text };
  });
  const cut = message.truncated || valueCut || flat.length > attributeLimit;

  return withHelp(
    {
      site: seam.target.site,
      log: {
        id: log.id,
        time: iso(content.timestamp),
        service: content.service ?? null,
        host: content.host ?? null,
        status: typeof attributes.status === "string" ? attributes.status : null,
        tags: tagsText(content.tags, full ? 1000 : 20),
        message: message.text,
      },
      attribute_count: flat.length > attributeLimit ? `${attributeLimit} of ${flat.length}` : flat.length,
      ...(rows.length > 0 ? { attributes: rows } : {}),
      ...redactionNote(redacted),
    },
    cut
      ? [`Run \`datadog-axi logs view ${id} ${windowFlags(window)}${orgSuffix(seam.target)} --full\` for everything`]
      : [],
  );
}
