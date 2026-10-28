import { AxiError } from "axi-sdk-js";
import { intFlag, list, parseArgs, str, TARGET_FLAGS, WINDOW_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  iso,
  oneLine,
  orgSuffix,
  project,
  redactionNote,
  selectFields,
  tagsText,
  truncate,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";
import { formatWindow, resolveWindow, toSeconds } from "../time.js";

interface Threshold {
  target?: number;
  timeframe?: string;
  warning?: number;
}

interface Slo {
  id?: string;
  name?: string;
  type?: string;
  description?: string | null;
  thresholds?: Threshold[];
  tags?: string[];
  monitor_ids?: number[];
  query?: { numerator?: string; denominator?: string };
  created_at?: number;
  modified_at?: number;
  creator?: { handle?: string };
}

export function primaryTarget(slo: Slo): string | null {
  const t = slo.thresholds?.[0];
  return t && t.target !== undefined ? `${t.target}% over ${t.timeframe ?? "?"}` : null;
}

const SLO_FIELDS: FieldSet<Slo> = {
  all: {
    id: (s) => s.id,
    name: (s) => s.name,
    type: (s) => s.type,
    target: (s) => primaryTarget(s),
    tags: (s) => tagsText(s.tags),
    description: (s) => oneLine(s.description ?? ""),
  },
  defaults: ["id", "name", "type", "target"],
};

const LIST: CommandSpec = {
  name: "slos list",
  positionals: ["<query>?"],
  flags: {
    "--tag": { kind: "list", value: "<tag>", description: "Only SLOs with this tag, e.g. team:payments (repeatable)" },
    "--limit": { kind: "string", value: "<n>", description: "Max SLOs (default 100, max 1000)" },
    "--offset": { kind: "string", value: "<n>", description: "Offset of the first SLO (default 0)" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(SLO_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = { name: "slos view", positionals: ["<id>"], flags: { ...TARGET_FLAGS } };

const STATUS: CommandSpec = {
  name: "slos status",
  positionals: ["<id>"],
  flags: {
    "--from": {
      kind: "string",
      value: "<time>",
      description: "Window start (default: the SLO's own timeframe, e.g. 7d)",
    },
    "--to": WINDOW_FLAGS["--to"] as (typeof WINDOW_FLAGS)[string],
    ...TARGET_FLAGS,
  },
};

export const SLOS_HELP = renderHelp({
  command: "slos",
  description: "List SLOs, view one, and check its current SLI against its target",
  subcommands: [
    { spec: LIST, summary: "SLOs by name query and tag, with their primary target" },
    { spec: VIEW, summary: "One SLO: targets, query or monitors, tags" },
    { spec: STATUS, summary: "SLI over the window vs target, and remaining error budget" },
  ],
  notes: ["`slos status` defaults to the SLO's own timeframe (7d, 30d or 90d) because an SLO is defined over it"],
  examples: [
    "datadog-axi slos list checkout",
    "datadog-axi slos status <id>",
    "datadog-axi slos status <id> --from 30d",
  ],
});

export async function slosCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("slos", args, ["list", "view", "status"], "list");
  if (sub === "view") return view(rest, rt);
  if (sub === "status") return status(rest, rt);
  return listSlos(rest, rt);
}

async function listSlos(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const fields = selectFields(parsed, SLO_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 1000 });
  const offset = intFlag(parsed, "--offset", { default: 0, min: 0, max: 1_000_000 });
  const tags = list(parsed, "--tag");
  const query = parsed.positionals[0];

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: Slo[]; metadata?: { page?: { total_count?: number } } }>(
    "slos.list",
    {
      query: { query, tags_query: tags.length > 0 ? tags.join(",") : undefined, limit, offset },
    },
  );
  const slos = data.data ?? [];
  const total = data.metadata?.page?.total_count;
  const org = orgSuffix(seam.target);

  if (slos.length === 0) {
    return withHelp(
      {
        site: seam.target.site,
        slos: `0 matched${query ? ` "${query}"` : ""}${tags.length ? ` tags ${tags.join(",")}` : ""}`,
      },
      query || tags.length
        ? ["Drop the name query or `--tag` to widen"]
        : ["Run `datadog-axi ctx` to check this is the expected org and site"],
    );
  }
  return withHelp(
    {
      site: seam.target.site,
      count: total !== undefined ? `${slos.length} of ${total} total` : `${slos.length} from offset ${offset}`,
      slos: project(slos, SLO_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [
      `Run \`datadog-axi slos status <id>${org}\` for the current SLI and error budget`,
      ...(total !== undefined && offset + slos.length < total
        ? [`Pass \`--offset ${offset + slos.length}\` for more`]
        : []),
    ],
  );
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = parsed.positionals[0] as string;
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: Slo }>("slos.get", { params: { slo_id: id } });
  const s = data.data ?? {};
  return withHelp(
    {
      site: seam.target.site,
      slo: {
        id: s.id ?? id,
        name: s.name ?? null,
        type: s.type ?? null,
        description: truncate(s.description ?? "", 1000).text,
        numerator: s.query?.numerator ?? null,
        denominator: s.query?.denominator ?? null,
        monitor_ids: (s.monitor_ids ?? []).join(" "),
        tags: tagsText(s.tags, 50),
        creator: s.creator?.handle ?? null,
        created: iso(s.created_at),
        modified: iso(s.modified_at),
      },
      thresholds: (s.thresholds ?? []).map((t) => ({
        timeframe: t.timeframe ?? null,
        target: t.target ?? null,
        warning: t.warning ?? null,
      })),
      ...redactionNote(redacted),
    },
    [`Run \`datadog-axi slos status ${s.id ?? id}${orgSuffix(seam.target)}\` for the current SLI`],
  );
}

interface SloHistory {
  data?: {
    overall?: { sli_value?: number | null; error_budget_remaining?: Record<string, number> | null; errors?: unknown };
    thresholds?: Record<string, { target?: number }>;
  };
  errors?: unknown;
}

const TIMEFRAME_DEFAULT: Record<string, string> = { "7d": "7d", "30d": "30d", "90d": "90d" };

async function status(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(STATUS, args);
  const id = parsed.positionals[0] as string;
  const seam = await connect(rt, parsed);
  const { data: sloData } = await seam.call<{ data?: Slo }>("slos.get", { params: { slo_id: id } });
  const slo = sloData.data ?? {};
  const primary = slo.thresholds?.[0];
  const defaultFrom = TIMEFRAME_DEFAULT[primary?.timeframe ?? ""] ?? "7d";
  const window = resolveWindow(str(parsed, "--from"), str(parsed, "--to"), rt.now(), defaultFrom);

  const { data, redacted } = await seam.call<SloHistory>("slos.history", {
    params: { slo_id: id },
    query: { from_ts: toSeconds(window.fromMs), to_ts: toSeconds(window.toMs) },
  });
  const sli = data.data?.overall?.sli_value;
  if (sli === null || sli === undefined) {
    throw new AxiError(`SLO ${id} has no SLI value for ${formatWindow(window)}`, "NOT_FOUND", [
      "The SLO may be newer than the window or have no data yet; try a shorter `--from`",
    ]);
  }
  const target = primary?.target ?? null;
  const budget = data.data?.overall?.error_budget_remaining;
  const budgetValue = budget && primary?.timeframe ? budget[primary.timeframe] : undefined;

  return {
    site: seam.target.site,
    slo: {
      id,
      name: slo.name ?? null,
      window: formatWindow(window),
      sli: Number(sli.toPrecision(6)),
      target,
      meets_target: target === null ? null : sli >= target,
      error_budget_remaining: budgetValue === undefined ? null : `${Number(budgetValue.toPrecision(4))}%`,
    },
    ...redactionNote(redacted),
  };
}
