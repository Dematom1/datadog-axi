import { AxiError } from "axi-sdk-js";
import { bool, intFlag, parseArgs, str, TARGET_FLAGS, WINDOW_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import { iso, orgSuffix, redactionNote, shellQuote, withHelp } from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";
import { formatWindow, resolveWindow, toSeconds, windowFlags } from "../time.js";

const QUERY: CommandSpec = {
  name: "metrics query",
  positionals: ["<expr>"],
  flags: {
    ...WINDOW_FLAGS,
    "--interval": {
      kind: "string",
      value: "<seconds>",
      description: "Rollup interval in seconds (default: chosen by Datadog)",
    },
    "--points": { kind: "boolean", description: "Also print raw points (up to 100 per series)" },
    "--limit": { kind: "string", value: "<n>", description: "Max series (default 20, max 500)" },
    ...TARGET_FLAGS,
  },
};

const LIST: CommandSpec = {
  name: "metrics list",
  flags: {
    "--from": { kind: "string", value: "<time>", description: "Metrics actively reporting since (default: 1h ago)" },
    "--limit": { kind: "string", value: "<n>", description: "Max names (default 100, max 5000)" },
    ...TARGET_FLAGS,
  },
};

const SEARCH: CommandSpec = {
  name: "metrics search",
  positionals: ["<text>"],
  flags: {
    "--limit": { kind: "string", value: "<n>", description: "Max names (default 100, max 5000)" },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = { name: "metrics view", positionals: ["<name>"], flags: { ...TARGET_FLAGS } };

const TAGS: CommandSpec = {
  name: "metrics tags",
  positionals: ["<name>"],
  flags: {
    "--full": { kind: "boolean", description: "Every value of every tag key" },
    ...TARGET_FLAGS,
  },
};

export const METRICS_HELP = renderHelp({
  command: "metrics",
  description: "Query timeseries as per-series summaries, and browse metric names, metadata and tags",
  subcommands: [
    { spec: QUERY, summary: "Summarize each series (n, min, avg, max, last) over the window" },
    { spec: LIST, summary: "Names of metrics actively reporting" },
    { spec: SEARCH, summary: "Metric names containing text" },
    { spec: VIEW, summary: "Metadata (type, unit, description) and ingested/indexed volume" },
    { spec: TAGS, summary: "Tag keys with value counts (cardinality)" },
  ],
  examples: [
    'datadog-axi metrics query "avg:system.cpu.user{env:prod} by {host}" --from 4h',
    "datadog-axi metrics search checkout",
    "datadog-axi metrics tags trace.http.request.hits",
  ],
});

export async function metricsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("metrics", args, ["query", "list", "search", "view", "tags"]);
  switch (sub) {
    case "query":
      return query(rest, rt);
    case "list":
      return listMetrics(rest, rt);
    case "search":
      return search(rest, rt);
    case "view":
      return view(rest, rt);
    default:
      return tags(rest, rt);
  }
}

interface TimeseriesResponse {
  data?: {
    attributes?: {
      series?: Array<{ group_tags?: string[]; query_index?: number; unit?: Array<{ name?: string } | null> | null }>;
      times?: number[];
      values?: Array<Array<number | null>>;
    };
  };
  errors?: string;
}

export function summarize(values: Array<number | null>): Record<string, number | null> {
  const points = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (points.length === 0) {
    return { n: 0, min: null, avg: null, max: null, last: null };
  }
  const round = (v: number) => Number(v.toPrecision(6));
  const sum = points.reduce((a, b) => a + b, 0);
  return {
    n: points.length,
    min: round(Math.min(...points)),
    avg: round(sum / points.length),
    max: round(Math.max(...points)),
    last: round(points[points.length - 1] as number),
  };
}

async function query(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(QUERY, args);
  const expr = parsed.positionals[0] as string;
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now());
  const limit = intFlag(parsed, "--limit", { default: 20, max: 500 });
  const interval = str(parsed, "--interval");
  if (interval !== undefined && !/^\d+$/.test(interval)) {
    throw new AxiError("--interval must be whole seconds", "VALIDATION_ERROR", ["Pass e.g. `--interval 60`"]);
  }
  const points = bool(parsed, "--points");

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<TimeseriesResponse>("metrics.timeseries", {
    body: {
      data: {
        type: "timeseries_request",
        attributes: {
          from: window.fromMs,
          to: window.toMs,
          ...(interval ? { interval: Number(interval) * 1000 } : {}),
          queries: [{ data_source: "metrics", query: expr, name: "a" }],
          formulas: [{ formula: "a" }],
        },
      },
    },
  });

  const attrs = data.data?.attributes ?? {};
  const series = attrs.series ?? [];
  const times = attrs.times ?? [];
  const values = attrs.values ?? [];
  const header = { site: seam.target.site, window: formatWindow(window), query: expr };
  const org = orgSuffix(seam.target);

  if (series.length === 0) {
    return withHelp(
      {
        ...header,
        series: "0 returned",
        note: "no points in the window; recent points can lag by a minute or two",
        ...redactionNote(redacted),
      },
      [
        `Widen the window: datadog-axi metrics query ${shellQuote(expr)} --from 24h${org}`,
        `Check the metric name exists: datadog-axi metrics search ${shellQuote(metricNameOf(expr))}${org}`,
      ],
    );
  }

  const rows = series.slice(0, limit).map((s, i) => {
    const row: Record<string, unknown> = {
      group: s.group_tags && s.group_tags.length > 0 ? s.group_tags.join(",") : "*",
      ...summarize(values[i] ?? []),
      unit: s.unit?.find((u) => u && u.name)?.name ?? null,
    };
    return row;
  });

  const output: Record<string, unknown> = {
    ...header,
    count: `${rows.length} of ${series.length} series`,
    series: rows,
  };

  if (points) {
    output.points = series.slice(0, limit).map((s, i) => ({
      group: s.group_tags && s.group_tags.length > 0 ? s.group_tags.join(",") : "*",
      points: (values[i] ?? [])
        .map((v, j) => (v === null ? null : `${iso(times[j])}=${Number(v.toPrecision(6))}`))
        .filter((p): p is string => p !== null)
        .slice(-100)
        .join(" "),
    }));
  }
  Object.assign(output, redactionNote(redacted));

  const hints: string[] = [];
  if (series.length > limit) {
    hints.push(
      `Run \`datadog-axi metrics query ${shellQuote(expr)} ${windowFlags(window)} --limit ${Math.min(series.length, 500)}${org}\` for every series`,
    );
  }
  if (!points) {
    hints.push(`Add \`--points\` for raw values`);
  }
  return withHelp(output, hints);
}

function metricNameOf(expr: string): string {
  const match = /(?:^|:)([A-Za-z][\w.]*)\s*\{/.exec(expr);
  return match?.[1] ?? expr;
}

async function listMetrics(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 5000 });
  const window = resolveWindow(str(parsed, "--from"), undefined, rt.now());
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ metrics?: string[] }>("metrics.active", {
    query: { from: toSeconds(window.fromMs) },
  });
  const names = [...(data.metrics ?? [])].sort();
  return namesOutput(
    names,
    limit,
    { site: seam.target.site, reporting_since: iso(window.fromMs) ?? "" },
    redacted,
    seam.target,
  );
}

async function search(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SEARCH, args);
  const text = parsed.positionals[0] as string;
  const limit = intFlag(parsed, "--limit", { default: 100, max: 5000 });
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ results?: { metrics?: string[] } }>("metrics.search", {
    query: { q: `metrics:${text}` },
  });
  const names = [...(data.results?.metrics ?? [])].sort();
  return namesOutput(names, limit, { site: seam.target.site, search: text }, redacted, seam.target);
}

function namesOutput(
  names: string[],
  limit: number,
  header: Record<string, string>,
  redacted: number,
  target: { org: string; explicit: boolean },
): Record<string, unknown> {
  const org = orgSuffix(target);
  if (names.length === 0) {
    return withHelp({ ...header, metrics: "0 found", ...redactionNote(redacted) }, [
      "Try a shorter search text, e.g. the first part of the metric name",
      `Run \`datadog-axi metrics list --from 24h${org}\` to list everything reporting today`,
    ]);
  }
  const shown = names.slice(0, limit);
  return withHelp(
    { ...header, count: `${shown.length} of ${names.length} total`, metrics: shown, ...redactionNote(redacted) },
    [
      `Run \`datadog-axi metrics view <name>${org}\` for type, unit and volume`,
      `Run \`datadog-axi metrics query "avg:<name>{*}"${org}\` for values`,
      ...(names.length > limit ? [`Pass \`--limit ${Math.min(names.length, 5000)}\` to see all ${names.length}`] : []),
    ],
  );
}

interface MetricMetadata {
  type?: string;
  description?: string;
  short_name?: string;
  unit?: string;
  per_unit?: string;
  statsd_interval?: number;
  integration?: string;
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const name = parsed.positionals[0] as string;
  const seam = await connect(rt, parsed);
  const [meta, volume] = await Promise.allSettled([
    seam.call<MetricMetadata>("metrics.metadata", { params: { metric_name: name } }),
    seam.call<{ data?: { attributes?: { indexed_volume?: number; ingested_volume?: number } } }>("metrics.volumes", {
      params: { metric_name: name },
    }),
  ]);
  if (meta.status === "rejected") {
    throw meta.reason;
  }
  const m = meta.value.data;
  const metric: Record<string, unknown> = {
    name,
    type: m.type ?? null,
    unit: m.unit ? `${m.unit}${m.per_unit ? `/${m.per_unit}` : ""}` : null,
    description: m.description ?? null,
    integration: m.integration ?? null,
    statsd_interval: m.statsd_interval ?? null,
  };
  if (volume.status === "fulfilled") {
    const attrs = volume.value.data.data?.attributes ?? {};
    metric.ingested_volume = attrs.ingested_volume ?? null;
    metric.indexed_volume = attrs.indexed_volume ?? null;
  } else {
    metric.volume = `unavailable - ${volume.reason instanceof Error ? volume.reason.message : String(volume.reason)}`;
  }
  return { site: seam.target.site, metric, ...redactionNote(meta.value.redacted) };
}

async function tags(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(TAGS, args);
  const name = parsed.positionals[0] as string;
  const full = bool(parsed, "--full");
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: { attributes?: { tags?: string[] } } }>("metrics.all_tags", {
    params: { metric_name: name },
  });

  const byKey = new Map<string, string[]>();
  for (const tag of data.data?.attributes?.tags ?? []) {
    const i = tag.indexOf(":");
    const key = i === -1 ? tag : tag.slice(0, i);
    const value = i === -1 ? "" : tag.slice(i + 1);
    const values = byKey.get(key);
    if (values) {
      values.push(value);
    } else {
      byKey.set(key, [value]);
    }
  }
  if (byKey.size === 0) {
    return withHelp({ site: seam.target.site, metric: name, tags: "0 tag keys" }, [
      `Check the name: datadog-axi metrics search ${shellQuote(name)}${orgSuffix(seam.target)}`,
    ]);
  }
  const rows = [...byKey.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, values]) => ({
      key,
      values: values.length,
      sample: full ? values.join(" ") : values.slice(0, 5).join(" ") + (values.length > 5 ? " ..." : ""),
    }));
  return withHelp(
    { site: seam.target.site, metric: name, tag_keys: rows.length, tags: rows, ...redactionNote(redacted) },
    !full && rows.some((r) => r.values > 5) ? [`Add \`--full\` for every value`] : [],
  );
}
