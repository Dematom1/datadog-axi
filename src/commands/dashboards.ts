import { AxiError } from "axi-sdk-js";
import { bool, intFlag, parseArgs, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  iso,
  oneLine,
  orgSuffix,
  project,
  redactionNote,
  selectFields,
  truncate,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";
import { appBaseUrl } from "../sites.js";

interface DashboardSummary {
  id?: string;
  title?: string;
  author_handle?: string;
  modified_at?: string;
  layout_type?: string;
  url?: string;
  is_read_only?: boolean;
}

const DASHBOARD_FIELDS: FieldSet<DashboardSummary> = {
  all: {
    id: (d) => d.id,
    title: (d) => d.title,
    author: (d) => d.author_handle,
    modified: (d) => iso(d.modified_at),
    layout: (d) => d.layout_type,
    url: (d) => d.url,
  },
  defaults: ["id", "title", "author", "modified"],
};

const LIST: CommandSpec = {
  name: "dashboards list",
  flags: {
    "--limit": { kind: "string", value: "<n>", description: "Dashboards per page (default 100, max 1000)" },
    "--start": { kind: "string", value: "<n>", description: "Offset of the first dashboard (default 0)" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(DASHBOARD_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = {
  name: "dashboards view",
  positionals: ["<id>"],
  flags: {
    "--full": { kind: "boolean", description: "The complete dashboard JSON" },
    ...TARGET_FLAGS,
  },
};

export const DASHBOARDS_HELP = renderHelp({
  command: "dashboards",
  description: "List dashboards and view one as widget titles and their queries",
  subcommands: [
    { spec: LIST, summary: "Dashboards with title, author and last change" },
    { spec: VIEW, summary: "Widget titles and queries; the full JSON with --full" },
  ],
  examples: ["datadog-axi dashboards list", "datadog-axi dashboards view abc-def-ghi"],
});

export async function dashboardsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("dashboards", args, ["list", "view"], "list");
  return sub === "view" ? view(rest, rt) : list(rest, rt);
}

async function list(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const fields = selectFields(parsed, DASHBOARD_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 1000 });
  const start = intFlag(parsed, "--start", { default: 0, min: 0, max: 1_000_000 });
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ dashboards?: DashboardSummary[]; total?: number }>("dashboards.list", {
    query: { count: limit, start },
  });
  const dashboards = data.dashboards ?? [];
  const org = orgSuffix(seam.target);
  if (dashboards.length === 0) {
    return withHelp(
      { site: seam.target.site, dashboards: start > 0 ? `0 after offset ${start}` : "0 in this org" },
      start > 0
        ? [`Run \`datadog-axi dashboards list${org}\` for the first page`]
        : ["Run `datadog-axi ctx` to check this is the expected org and site"],
    );
  }
  const total = data.total;
  return withHelp(
    {
      site: seam.target.site,
      count:
        total !== undefined ? `${dashboards.length} of ${total} total` : `${dashboards.length} from offset ${start}`,
      dashboards: project(dashboards, DASHBOARD_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [
      `Run \`datadog-axi dashboards view <id>${org}\` for its widgets and queries`,
      ...((total !== undefined ? start + dashboards.length < total : dashboards.length === limit)
        ? [`Run \`datadog-axi dashboards list --start ${start + dashboards.length}${org}\` for more`]
        : []),
    ],
  );
}

interface Widget {
  definition?: {
    type?: string;
    title?: string;
    widgets?: Widget[];
    requests?: unknown;
    query?: string;
    text?: string;
    content?: string;
  };
}

export function widgetQueries(requests: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if ((key === "q" || key === "query") && typeof value === "string") {
          out.push(value);
        } else if (key === "formula" && typeof value === "string") {
          // A formula that only names its query (`a`) adds nothing; `a / b * 100` does.
          if (!/^[a-z]\w*$/i.test(value.trim())) {
            out.push(value);
          }
        } else if (
          key === "search" &&
          value &&
          typeof value === "object" &&
          typeof (value as { query?: unknown }).query === "string"
        ) {
          out.push((value as { query: string }).query);
        } else {
          visit(value);
        }
      }
    }
  };
  visit(requests);
  return [...new Set(out)];
}

export function flattenWidgets(
  widgets: Widget[],
  group = "",
): Array<{ group: string; type: string; title: string; queries: string }> {
  const rows: Array<{ group: string; type: string; title: string; queries: string }> = [];
  for (const widget of widgets) {
    const def = widget.definition ?? {};
    if (Array.isArray(def.widgets)) {
      rows.push(...flattenWidgets(def.widgets, def.title ?? group));
      continue;
    }
    const queries = widgetQueries(def.requests ?? (def.query ? { query: def.query } : undefined));
    rows.push({
      group,
      type: def.type ?? "unknown",
      title: oneLine(def.title ?? def.text ?? def.content ?? "", 120),
      queries: oneLine(queries.join(" ; "), 300),
    });
  }
  return rows;
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = parsed.positionals[0] as string;
  if (!/^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/i.test(id)) {
    throw new AxiError(`Dashboard id looks wrong: ${id}`, "VALIDATION_ERROR", [
      "Dashboard ids look like abc-def-ghi; run `datadog-axi dashboards list` to find them",
    ]);
  }
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<Record<string, unknown> & { widgets?: Widget[] }>("dashboards.get", {
    params: { dashboard_id: id },
  });

  if (bool(parsed, "--full")) {
    return { site: seam.target.site, dashboard: JSON.stringify(data), ...redactionNote(redacted) };
  }

  const widgets = flattenWidgets(data.widgets ?? []);
  const description = truncate(String(data.description ?? ""), 500);
  return withHelp(
    {
      site: seam.target.site,
      dashboard: {
        id,
        title: data.title ?? null,
        author: data.author_handle ?? null,
        modified: iso(data.modified_at),
        layout: data.layout_type ?? null,
        description: description.text,
        url: typeof data.url === "string" ? `${appBaseUrl(seam.target.site)}${data.url}` : null,
        template_variables: Array.isArray(data.template_variables)
          ? (data.template_variables as Array<{ name?: string }>).map((t) => t.name).join(" ")
          : "",
      },
      widget_count: widgets.length,
      widgets,
      ...redactionNote(redacted),
    },
    [`Run \`datadog-axi metrics query "<query>"${orgSuffix(seam.target)}\` to evaluate a widget's metric query`],
  );
}
