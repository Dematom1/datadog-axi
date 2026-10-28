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
import { widgetQueries } from "./dashboards.js";

interface Notebook {
  id?: number;
  attributes?: {
    name?: string;
    author?: { handle?: string };
    created?: string;
    modified?: string;
    status?: string;
    cells?: Array<{
      id?: string;
      attributes?: { definition?: { type?: string; text?: string; title?: string; requests?: unknown } };
    }>;
  };
}

const NOTEBOOK_FIELDS: FieldSet<Notebook> = {
  all: {
    id: (n) => n.id,
    name: (n) => n.attributes?.name,
    author: (n) => n.attributes?.author?.handle,
    modified: (n) => iso(n.attributes?.modified),
    status: (n) => n.attributes?.status,
  },
  defaults: ["id", "name", "author", "modified"],
};

const LIST: CommandSpec = {
  name: "notebooks list",
  positionals: ["<query>?"],
  flags: {
    "--limit": { kind: "string", value: "<n>", description: "Max notebooks (default 100, max 1000)" },
    "--start": { kind: "string", value: "<n>", description: "Offset of the first notebook (default 0)" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(NOTEBOOK_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = {
  name: "notebooks view",
  positionals: ["<id>"],
  flags: {
    "--full": { kind: "boolean", description: "Untruncated cell text" },
    ...TARGET_FLAGS,
  },
};

export const NOTEBOOKS_HELP = renderHelp({
  command: "notebooks",
  description: "List notebooks (postmortems, investigations) and read one cell by cell",
  subcommands: [
    { spec: LIST, summary: "Notebooks matching a text query, newest first" },
    { spec: VIEW, summary: "Cells: markdown text and the queries behind graph cells" },
  ],
  examples: ["datadog-axi notebooks list postmortem", "datadog-axi notebooks view 12345"],
});

export async function notebooksCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("notebooks", args, ["list", "view"], "list");
  return sub === "view" ? view(rest, rt) : list(rest, rt);
}

async function list(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const fields = selectFields(parsed, NOTEBOOK_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 1000 });
  const start = intFlag(parsed, "--start", { default: 0, min: 0, max: 1_000_000 });
  const query = parsed.positionals[0];
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: Notebook[]; meta?: { page?: { total_count?: number } } }>(
    "notebooks.list",
    {
      query: { query, count: limit, start },
    },
  );
  const notebooks = data.data ?? [];
  const total = data.meta?.page?.total_count;
  const org = orgSuffix(seam.target);
  if (notebooks.length === 0) {
    return withHelp(
      { site: seam.target.site, notebooks: `0 matched${query ? ` "${query}"` : ""}` },
      query ? ["Try a shorter text query, or none"] : [],
    );
  }
  return withHelp(
    {
      site: seam.target.site,
      count: total !== undefined ? `${notebooks.length} of ${total} total` : `${notebooks.length} from offset ${start}`,
      notebooks: project(notebooks, NOTEBOOK_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [
      `Run \`datadog-axi notebooks view <id>${org}\` to read one`,
      ...(total !== undefined && start + notebooks.length < total
        ? [`Pass \`--start ${start + notebooks.length}\` for more`]
        : []),
    ],
  );
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = parsed.positionals[0] as string;
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`Notebook id must be numeric: ${id}`, "VALIDATION_ERROR", [
      "Run `datadog-axi notebooks list` to find ids",
    ]);
  }
  const full = bool(parsed, "--full");
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: Notebook }>("notebooks.get", { params: { notebook_id: id } });
  const a = data.data?.attributes ?? {};
  let truncated = false;
  const cells = (a.cells ?? []).map((cell) => {
    const def = cell.attributes?.definition ?? {};
    const raw =
      def.type === "markdown"
        ? (def.text ?? "")
        : [def.title ?? "", widgetQueries(def.requests).join(" ; ")].filter(Boolean).join(": ");
    const t = full ? { text: raw, truncated: false } : truncate(oneLine(raw, Number.POSITIVE_INFINITY), 300);
    truncated ||= t.truncated;
    return { type: def.type ?? "unknown", content: t.text };
  });
  return withHelp(
    {
      site: seam.target.site,
      notebook: {
        id: data.data?.id ?? Number(id),
        name: a.name ?? null,
        author: a.author?.handle ?? null,
        status: a.status ?? null,
        created: iso(a.created),
        modified: iso(a.modified),
      },
      cell_count: cells.length,
      cells,
      ...redactionNote(redacted),
    },
    truncated ? [`Run \`datadog-axi notebooks view ${id}${orgSuffix(seam.target)} --full\` for untruncated cells`] : [],
  );
}
