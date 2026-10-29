import { intFlag, parseArgs, str, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  iso,
  orgSuffix,
  project,
  redactionNote,
  selectFields,
  shellQuote,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";

interface Host {
  name?: string;
  host_name?: string;
  up?: boolean;
  is_muted?: boolean;
  last_reported_time?: number;
  apps?: string[];
  sources?: string[];
  aliases?: string[];
  meta?: { platform?: string; agent_version?: string };
}

const HOST_FIELDS: FieldSet<Host> = {
  all: {
    name: (h) => h.name ?? h.host_name,
    up: (h) => h.up ?? null,
    muted: (h) => h.is_muted ?? null,
    last_reported: (h) => iso(h.last_reported_time),
    apps: (h) => (h.apps ?? []).join(" "),
    sources: (h) => (h.sources ?? []).join(" "),
    platform: (h) => h.meta?.platform,
    agent_version: (h) => h.meta?.agent_version,
  },
  defaults: ["name", "up", "muted", "last_reported"],
};

const LIST: CommandSpec = {
  name: "hosts list",
  flags: {
    "--filter": {
      kind: "string",
      value: "<text>",
      description: "Datadog host filter: name, alias or tag, e.g. env:prod",
    },
    "--limit": { kind: "string", value: "<n>", description: "Max hosts (default 100, max 1000)" },
    "--start": { kind: "string", value: "<n>", description: "Offset of the first host (default 0)" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(HOST_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

export const HOSTS_HELP = renderHelp({
  command: "hosts",
  description: "List infrastructure hosts with up and muted state, down hosts first",
  subcommands: [{ spec: LIST, summary: "Hosts reporting in the last few hours, with the matching total" }],
  examples: ["datadog-axi hosts list", "datadog-axi hosts list --filter env:prod --fields apps"],
});

export async function hostsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { rest } = splitSubcommand("hosts", args, ["list"], "list");
  const parsed = parseArgs(LIST, rest);
  const fields = selectFields(parsed, HOST_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 1000 });
  const start = intFlag(parsed, "--start", { default: 0, min: 0, max: 1_000_000 });
  const filter = str(parsed, "--filter");

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ host_list?: Host[]; total_matching?: number }>("hosts.list", {
    query: { filter, count: limit, start },
  });
  const hosts = [...(data.host_list ?? [])].sort((a, b) => Number(a.up ?? true) - Number(b.up ?? true));
  const total = data.total_matching ?? hosts.length;
  const org = orgSuffix(seam.target);

  if (hosts.length === 0) {
    return withHelp(
      { site: seam.target.site, hosts: `0 matched${filter ? ` filter ${shellQuote(filter)}` : ""}` },
      filter
        ? ["Drop or loosen `--filter`", "Filters match host names, aliases and tags"]
        : ["Run `datadog-axi ctx` to check this is the expected org and site"],
    );
  }
  const down = hosts.filter((h) => h.up === false).length;
  return withHelp(
    {
      site: seam.target.site,
      ...(filter ? { filter } : {}),
      count: `${hosts.length} of ${total} total`,
      down_in_page: down,
      hosts: project(hosts, HOST_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [
      `Run \`datadog-axi metrics query "avg:system.cpu.user{host:<name>}"${org}\` for a host's CPU`,
      ...(start + hosts.length < total
        ? [
            `Run \`datadog-axi hosts list --start ${start + hosts.length}${filter ? ` --filter ${shellQuote(filter)}` : ""}${org}\` for more`,
          ]
        : []),
    ],
  );
}
