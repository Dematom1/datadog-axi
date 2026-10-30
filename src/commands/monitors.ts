import { AxiError } from "axi-sdk-js";
import { bool, intFlag, list, parseArgs, str, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  DETAIL_TEXT_LIMIT,
  iso,
  orgSuffix,
  targetSuffix,
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

export interface MonitorSearchItem {
  id?: number;
  name?: string;
  status?: string;
  type?: string;
  tags?: string[];
  query?: string;
  priority?: number | null;
  creator?: { handle?: string; name?: string };
  last_triggered_ts?: number | null;
  overall_state_modified?: number | null;
  classification?: string;
}

export interface MonitorSearchResponse {
  monitors: MonitorSearchItem[];
  counts?: { status?: Array<{ name?: string; count?: number }> };
  metadata?: { page?: number; page_count?: number; per_page?: number; total_count?: number };
}

export function parseMonitorSearchResponse(data: unknown): MonitorSearchResponse {
  if (!data || typeof data !== "object" || !Array.isArray((data as { monitors?: unknown }).monitors)) {
    throw new AxiError("Datadog returned an invalid monitor search response", "UPSTREAM_ERROR", [
      "Retry the command; if it persists, check https://status.datadoghq.com",
    ]);
  }
  const metadata = (data as { metadata?: { total_count?: unknown } }).metadata;
  if (
    metadata?.total_count !== undefined &&
    (typeof metadata.total_count !== "number" || !Number.isFinite(metadata.total_count) || metadata.total_count < 0)
  ) {
    throw new AxiError("Datadog returned an invalid monitor total", "UPSTREAM_ERROR");
  }
  return data as MonitorSearchResponse;
}

const STATUS_VALUES: Record<string, string> = {
  alert: "alert",
  warn: "warn",
  no_data: '"no data"',
  ok: "ok",
  ignored: "ignored",
  skipped: "skipped",
  unknown: "unknown",
};

const SEVERITY = ["alert", "warn", "no data", "unknown", "ok", "ignored", "skipped"];

export const MONITOR_FIELDS: FieldSet<MonitorSearchItem> = {
  all: {
    id: (m) => m.id,
    name: (m) => m.name,
    status: (m) => m.status,
    type: (m) => m.type,
    tags: (m) => tagsText(m.tags),
    query: (m) => m.query,
    priority: (m) => m.priority ?? null,
    creator: (m) => m.creator?.handle,
    last_triggered: (m) => iso(m.last_triggered_ts),
    state_modified: (m) => iso(m.overall_state_modified),
  },
  defaults: ["id", "name", "status", "type"],
};

export const DEFAULT_MONITOR_LIMIT = 50;

const SEARCH: CommandSpec = {
  name: "monitors search",
  positionals: ["<query>?"],
  flags: {
    "--status": {
      kind: "list",
      value: "<status>",
      description: "Filter by status: alert, warn, no_data, ok, ignored, skipped, unknown (comma separated)",
    },
    "--tag": { kind: "list", value: "<tag>", description: "Filter by monitor tag, e.g. env:prod" },
    "--name": { kind: "string", value: "<text>", description: "Filter by text in the monitor name" },
    "--limit": {
      kind: "string",
      value: "<n>",
      description: `Monitors per page (default ${DEFAULT_MONITOR_LIMIT}, max 1000)`,
    },
    "--page": { kind: "string", value: "<n>", description: "Page number, starting at 0" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(MONITOR_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = {
  name: "monitors view",
  positionals: ["<id>"],
  flags: {
    "--full": { kind: "boolean", description: "Untruncated message, every non-OK group and every tag" },
    ...TARGET_FLAGS,
  },
};

export const MONITORS_HELP = renderHelp({
  command: "monitors",
  description: "Search monitors (problems first, with status counts) and view one monitor",
  subcommands: [
    { spec: SEARCH, summary: "Default. Datadog monitor search; the query is passed through unchanged" },
    { spec: VIEW, summary: "One monitor: query, message, tags and its non-OK groups" },
  ],
  examples: [
    "datadog-axi monitors",
    "datadog-axi monitors --status alert,no_data --tag env:prod",
    'datadog-axi monitors search "type:metric checkout"',
    "datadog-axi monitors view 12345",
  ],
});

export async function monitorsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("monitors", args, ["search", "view"], "search");
  return sub === "view" ? view(rest, rt) : search(rest, rt);
}

/** A quoted term in Datadog search syntax (not shell syntax). */
function datadogQuote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

export function buildMonitorQuery(raw: string | undefined, statuses: string[], tags: string[], name?: string): string {
  const parts: string[] = [];
  if (raw) {
    parts.push(raw);
  }
  if (statuses.length > 0) {
    const terms = statuses.map((s) => {
      const value = STATUS_VALUES[s.toLowerCase()];
      if (!value) {
        throw new AxiError(`Unknown monitor status: ${s}`, "VALIDATION_ERROR", [
          `Valid statuses: ${Object.keys(STATUS_VALUES).join(", ")}`,
        ]);
      }
      return `status:${value}`;
    });
    parts.push(terms.length === 1 ? (terms[0] as string) : `(${terms.join(" OR ")})`);
  }
  for (const tag of tags) {
    parts.push(`tag:${datadogQuote(tag)}`);
  }
  if (name) {
    parts.push(datadogQuote(name));
  }
  return parts.join(" ");
}

export function sortProblemsFirst<T extends { status?: string }>(items: T[]): T[] {
  const rank = (s?: string) => {
    const i = SEVERITY.indexOf((s ?? "unknown").toLowerCase());
    return i === -1 ? SEVERITY.length : i;
  };
  return [...items].sort((a, b) => rank(a.status) - rank(b.status));
}

export function statusCounts(response: MonitorSearchResponse): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of sortProblemsFirst((response.counts?.status ?? []).map((c) => ({ ...c, status: c.name })))) {
    if (entry.name) {
      counts[entry.name] = entry.count ?? 0;
    }
  }
  return counts;
}

async function search(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SEARCH, args);
  const fields = selectFields(parsed, MONITOR_FIELDS, SEARCH.name);
  const limit = intFlag(parsed, "--limit", { default: DEFAULT_MONITOR_LIMIT, max: 1000 });
  const page = intFlag(parsed, "--page", { default: 0, min: 0, max: 100_000 });
  const query = buildMonitorQuery(
    parsed.positionals[0],
    list(parsed, "--status"),
    list(parsed, "--tag"),
    str(parsed, "--name"),
  );

  const seam = await connect(rt, parsed);
  const { data: rawData, redacted } = await seam.call<unknown>("monitors.search", {
    query: { query: query || undefined, page, per_page: limit, sort: "status,asc" },
  });

  const data = parseMonitorSearchResponse(rawData);
  const monitors = sortProblemsFirst(data.monitors);
  const total = data.metadata?.total_count;
  const org = targetSuffix(seam.target);
  const site = seam.target.site;

  if (monitors.length === 0) {
    const emptyPage = total === undefined || total > 0;
    return withHelp(
      {
        monitors: emptyPage
          ? `0 on this page (${page})${total === undefined ? "; total unknown" : ` of ${total} total`}`
          : `0 matched on site ${site}${query ? ` for query ${shellQuote(query)}` : ""}`,
        counts: statusCounts(data),
        ...redactionNote(redacted),
      },
      emptyPage
        ? [
            `Run \`${rebuildCommand("datadog-axi monitors search", args, ["--page"])} --page ${Math.max(page - 1, 0)}\` to inspect another page`,
          ]
        : query
          ? [
              "Drop a filter (`--status`, `--tag`, `--name`) to widen the search",
              `Run \`datadog-axi monitors${org}\` to list every monitor with status counts`,
            ]
          : [
              `This org has no monitors on site ${site}; if you expected some, check the site with \`datadog-axi ctx\``,
              "Run `datadog-axi auth status` to confirm the key can read monitors",
            ],
    );
  }

  const hints = [`Run \`datadog-axi monitors view <id>${org}\` for the query, message and failing groups`];
  if (total !== undefined && total > (page + 1) * limit) {
    hints.push(
      `Run \`${rebuildCommand("datadog-axi monitors search", args, ["--page"])} --page ${page + 1}\` for the next ${limit}`,
    );
  }
  if (!list(parsed, "--status").length && monitors.some((m) => (m.status ?? "").toLowerCase() === "alert")) {
    hints.push(`Run \`datadog-axi monitors --status alert${org}\` to see only alerting monitors`);
  }

  return withHelp(
    {
      site,
      ...(query ? { query } : {}),
      count:
        total === undefined ? `${monitors.length} returned; total unknown` : `${monitors.length} of ${total} total`,
      counts: statusCounts(data),
      monitors: project(monitors, MONITOR_FIELDS, fields),
      ...redactionNote(redacted),
    },
    hints,
  );
}

interface MonitorDetail {
  id?: number;
  name?: string;
  type?: string;
  overall_state?: string;
  query?: string;
  message?: string;
  tags?: string[];
  priority?: number | null;
  created?: string;
  modified?: string;
  creator?: { handle?: string };
  multi?: boolean;
  state?: { groups?: Record<string, { status?: string; last_triggered_ts?: number; last_nodata_ts?: number }> };
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = parsed.positionals[0] as string;
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`Monitor id must be numeric: ${id}`, "VALIDATION_ERROR", [
      "Run `datadog-axi monitors` to find monitor ids",
    ]);
  }
  const full = bool(parsed, "--full");
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<MonitorDetail>("monitors.get", {
    params: { monitor_id: id },
    query: { group_states: "alert,warn,no data" },
  });

  const message = truncate(data.message ?? "", full ? Number.POSITIVE_INFINITY : DETAIL_TEXT_LIMIT);
  const groups = Object.entries(data.state?.groups ?? {})
    .map(([name, g]) => ({ group: name, status: g.status ?? null, last_triggered: iso(g.last_triggered_ts) }))
    .filter((g) => (g.status ?? "").toLowerCase() !== "ok");
  const sortedGroups = sortProblemsFirst(groups.map((g) => ({ ...g, status: g.status ?? undefined }))).map((g) => ({
    group: g.group,
    status: g.status ?? null,
    last_triggered: g.last_triggered,
  }));
  const groupLimit = full ? sortedGroups.length : 20;

  const tags = data.tags ?? [];
  const monitor: Record<string, unknown> = {
    id: data.id,
    name: data.name,
    type: data.type,
    status: data.overall_state,
    query: data.query,
    priority: data.priority ?? null,
    tags: tagsText(tags, full ? tags.length : 50),
    creator: data.creator?.handle ?? null,
    created: iso(data.created),
    modified: iso(data.modified),
    message: message.text,
  };

  const output: Record<string, unknown> = { site: seam.target.site, monitor };
  if (sortedGroups.length > 0) {
    output.groups_not_ok = `${Math.min(groupLimit, sortedGroups.length)} of ${sortedGroups.length}`;
    output.groups = sortedGroups.slice(0, groupLimit);
  } else {
    output.groups_not_ok = 0;
  }
  Object.assign(output, redactionNote(redacted));

  const hints: string[] = [];
  if (message.truncated || sortedGroups.length > groupLimit || (!full && tags.length > 50)) {
    hints.push(
      `Run \`datadog-axi monitors view ${id}${orgSuffix(seam.target)} --full\` for the complete message and groups${!full && tags.length > 50 ? `; ${tags.length - 50} tags omitted` : ""}`,
    );
  }
  return withHelp(output, hints);
}
