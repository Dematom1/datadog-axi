import { bool, intFlag, parseArgs, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import { iso, oneLine, orgSuffix, project, redactionNote, selectFields, withHelp, type FieldSet } from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";

interface Downtime {
  id?: string;
  attributes?: {
    scope?: string;
    status?: string;
    message?: string | null;
    canceled?: string | null;
    monitor_identifier?: { monitor_id?: number; monitor_tags?: string[] };
    schedule?: { start?: string; end?: string | null; recurrences?: unknown[] };
  };
}

const DOWNTIME_FIELDS: FieldSet<Downtime> = {
  all: {
    id: (d) => d.id,
    scope: (d) => d.attributes?.scope,
    monitor: (d) => {
      const m = d.attributes?.monitor_identifier;
      return m?.monitor_id !== undefined
        ? `id:${m.monitor_id}`
        : m?.monitor_tags
          ? `tags:${m.monitor_tags.join(",")}`
          : null;
    },
    status: (d) => d.attributes?.status,
    start: (d) => iso(d.attributes?.schedule?.start),
    end: (d) => iso(d.attributes?.schedule?.end ?? undefined),
    recurring: (d) => Array.isArray(d.attributes?.schedule?.recurrences),
    message: (d) => oneLine(d.attributes?.message ?? ""),
  },
  defaults: ["id", "scope", "monitor", "status"],
};

const LIST: CommandSpec = {
  name: "downtimes list",
  flags: {
    "--all": { kind: "boolean", description: "Include ended and canceled downtimes (default: current only)" },
    "--limit": { kind: "string", value: "<n>", description: "Max downtimes (default 100, max 1000)" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(DOWNTIME_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

export const DOWNTIMES_HELP = renderHelp({
  command: "downtimes",
  description: "List downtimes that silence monitors (current ones by default)",
  subcommands: [{ spec: LIST, summary: "Downtimes with scope, target monitor and status" }],
  examples: ["datadog-axi downtimes list", "datadog-axi downtimes list --all --fields start,end"],
});

export async function downtimesCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { rest } = splitSubcommand("downtimes", args, ["list"], "list");
  const parsed = parseArgs(LIST, rest);
  const fields = selectFields(parsed, DOWNTIME_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 1000 });
  const all = bool(parsed, "--all");

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{
    data?: Downtime[];
    meta?: { page?: { total_filtered_count?: number } };
  }>("downtimes.list", { query: { current_only: !all, "page[limit]": limit } });
  const downtimes = data.data ?? [];
  const total = data.meta?.page?.total_filtered_count ?? downtimes.length;

  if (downtimes.length === 0) {
    return withHelp(
      {
        site: seam.target.site,
        downtimes: all ? "0 in this org" : "0 current (no monitors are silenced by a downtime)",
      },
      all ? [] : [`Run \`datadog-axi downtimes list --all${orgSuffix(seam.target)}\` to include ended ones`],
    );
  }
  return {
    site: seam.target.site,
    scope: all ? "all" : "current",
    count: `${downtimes.length} of ${total} total`,
    downtimes: project(downtimes, DOWNTIME_FIELDS, fields),
    ...redactionNote(redacted),
  };
}
