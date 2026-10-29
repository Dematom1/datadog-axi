import { AxiError } from "axi-sdk-js";
import { intFlag, list, parseArgs, str, TARGET_FLAGS, WINDOW_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  iso,
  oneLine,
  orgSuffix,
  project,
  rebuildCommand,
  redactionNote,
  selectFields,
  tagsText,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";
import { formatWindow, isoUtc, resolveWindow, toSeconds, windowFlags } from "../time.js";

const INGESTION_LAG = "recent events can take a minute or more to become searchable";

interface EventV1 {
  id?: number;
  title?: string;
  text?: string;
  date_happened?: number;
  priority?: string;
  source_type_name?: string;
  alert_type?: string;
  tags?: string[];
  host?: string;
}

interface EventV2 {
  id?: string;
  attributes?: {
    timestamp?: string;
    message?: string;
    tags?: string[];
    attributes?: {
      title?: string;
      priority?: string;
      status?: string;
      source_type_name?: string;
      evt?: { source_type_name?: string };
    };
  };
}

const LIST_FIELDS: FieldSet<EventV1> = {
  all: {
    time: (e) => iso(e.date_happened),
    title: (e) => oneLine(e.title, 150),
    source: (e) => e.source_type_name,
    alert_type: (e) => e.alert_type,
    priority: (e) => e.priority,
    id: (e) => e.id,
    host: (e) => e.host,
    tags: (e) => tagsText(e.tags),
    text: (e) => oneLine(e.text),
  },
  defaults: ["time", "title", "source", "alert_type"],
};

const SEARCH_FIELDS: FieldSet<EventV2> = {
  all: {
    time: (e) => iso(e.attributes?.timestamp),
    title: (e) => oneLine(e.attributes?.attributes?.title ?? e.attributes?.message, 150),
    source: (e) => e.attributes?.attributes?.source_type_name ?? e.attributes?.attributes?.evt?.source_type_name,
    status: (e) => e.attributes?.attributes?.status,
    priority: (e) => e.attributes?.attributes?.priority,
    id: (e) => e.id,
    tags: (e) => tagsText(e.attributes?.tags),
    message: (e) => oneLine(e.attributes?.message),
  },
  defaults: ["time", "title", "source", "status"],
};

const EVENTS_V1_PAGE = 1000;

const LIST: CommandSpec = {
  name: "events list",
  flags: {
    ...WINDOW_FLAGS,
    "--tags": { kind: "list", value: "<tag>", description: "Only events with these tags, e.g. env:prod (repeatable)" },
    "--priority": { kind: "string", value: "<priority>", description: "normal or low" },
    "--sources": {
      kind: "list",
      value: "<source>",
      description: "Only events from these sources, e.g. kubernetes (repeatable)",
    },
    "--limit": { kind: "string", value: "<n>", description: "Max events (default 50, max 1000)" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(LIST_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const SEARCH: CommandSpec = {
  name: "events search",
  positionals: ["<query>"],
  flags: {
    ...WINDOW_FLAGS,
    "--limit": { kind: "string", value: "<n>", description: "Max events (default 50, max 1000)" },
    "--cursor": { kind: "string", value: "<cursor>", description: "Continue from a previous page's cursor" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(SEARCH_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

export const EVENTS_HELP = renderHelp({
  command: "events",
  description: "List events (deploys, alerts, changes) by tag and priority, or search them with an event query",
  subcommands: [
    { spec: LIST, summary: "Events in the window, filtered by tags, priority and source" },
    { spec: SEARCH, summary: "Event search; the Datadog event query is passed through unchanged" },
  ],
  examples: [
    "datadog-axi events list --tags env:prod --from 4h",
    'datadog-axi events search "source:deploy service:checkout" --from 24h',
  ],
});

export async function eventsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("events", args, ["list", "search"], "list");
  return sub === "search" ? search(rest, rt) : listEvents(rest, rt);
}

async function listEvents(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const fields = selectFields(parsed, LIST_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 50, max: 1000 });
  const priority = str(parsed, "--priority");
  if (priority !== undefined && priority !== "normal" && priority !== "low") {
    throw new AxiError("--priority must be normal or low", "VALIDATION_ERROR", ["Pass `--priority normal`"]);
  }
  const tags = list(parsed, "--tags");
  const sources = list(parsed, "--sources");
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ events?: EventV1[] }>("events.list_v1", {
    query: {
      start: toSeconds(window.fromMs),
      end: toSeconds(window.toMs),
      priority,
      tags: tags.length > 0 ? tags.join(",") : undefined,
      sources: sources.length > 0 ? sources.join(",") : undefined,
      unaggregated: true,
    },
  });
  const events = [...(data.events ?? [])].sort((a, b) => (b.date_happened ?? 0) - (a.date_happened ?? 0));
  const header: Record<string, string> = { site: seam.target.site, window: formatWindow(window) };
  if (tags.length > 0) header.tags = tags.join(",");
  if (priority) header.priority = priority;
  if (sources.length > 0) header.sources = sources.join(",");

  if (events.length === 0) {
    return withHelp({ events: "0 matched", ...header, note: INGESTION_LAG, ...redactionNote(redacted) }, [
      `Widen the window: ${rebuildCommand("datadog-axi events list", args, ["--from", "--to"])} --from 24h`,
      tags.length > 0 || priority || sources.length > 0
        ? "Drop a filter (`--tags`, `--priority`, `--sources`)"
        : `Search with a query instead: datadog-axi events search "<query>" ${windowFlags(window)}${orgSuffix(seam.target)}`,
    ]);
  }

  const shown = events.slice(0, limit);
  // The v1 endpoint returns at most 1000 events per request, so a full page is a lower bound.
  const capped = events.length >= EVENTS_V1_PAGE;
  const hints: string[] = [];
  if (capped) {
    // The response holds the newest events; the missing ones sit between the window start and the oldest returned.
    const oldest = events[events.length - 1]?.date_happened;
    const cut =
      oldest !== undefined
        ? Math.min(window.toMs, Math.max(window.fromMs, oldest * 1000))
        : window.fromMs + (window.toMs - window.fromMs) / 2;
    hints.push(
      cut > window.fromMs + 1000
        ? `More events may exist: list the earlier part of the window with ${rebuildCommand("datadog-axi events list", args, ["--from", "--to"])} --from ${isoUtc(window.fromMs)} --to ${isoUtc(cut)}`
        : "More events may exist: narrow the filters (`--tags`, `--priority`, `--sources`)",
    );
  }
  if (events.length > limit) {
    hints.push(
      `Pass \`--limit ${Math.min(events.length, 1000)}\` to see all ${events.length}${capped ? " returned" : ""}`,
    );
  }
  return withHelp(
    {
      ...header,
      count: capped
        ? `${shown.length} of at least ${events.length} in window (Datadog returned its 1000-event maximum)`
        : `${shown.length} of ${events.length} in window`,
      events: project(shown, LIST_FIELDS, fields),
      ...redactionNote(redacted),
    },
    hints,
  );
}

async function search(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SEARCH, args);
  const query = parsed.positionals[0] as string;
  const fields = selectFields(parsed, SEARCH_FIELDS, SEARCH.name);
  const limit = intFlag(parsed, "--limit", { default: 50, max: 1000 });
  const cursor = str(parsed, "--cursor");
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: EventV2[]; meta?: { page?: { after?: string } } }>(
    "events.search",
    {
      body: {
        filter: { query, from: isoUtc(window.fromMs), to: isoUtc(window.toMs) },
        page: { limit, ...(cursor ? { cursor } : {}) },
        sort: "-timestamp",
      },
    },
  );
  const events = data.data ?? [];
  const after = data.meta?.page?.after;
  const header = { site: seam.target.site, window: formatWindow(window), query };

  if (events.length === 0) {
    return withHelp({ events: "0 matched", ...header, note: INGESTION_LAG, ...redactionNote(redacted) }, [
      `Widen the window: ${rebuildCommand("datadog-axi events search", args, ["--from", "--to", "--cursor"])} --from 24h`,
      'Loosen the query, e.g. `"*"` or a single `source:<name>` term',
    ]);
  }
  return withHelp(
    {
      ...header,
      count: after ? `${events.length} shown (more available)` : `${events.length} (all matches)`,
      events: project(events, SEARCH_FIELDS, fields),
      ...redactionNote(redacted),
    },
    after
      ? [
          `Run \`${rebuildCommand("datadog-axi events search", args, ["--from", "--to", "--cursor"])} ${windowFlags(window)} --cursor ${after}\` for the next ${limit}`,
        ]
      : [],
  );
}
