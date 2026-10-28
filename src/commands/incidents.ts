import { AxiError } from "axi-sdk-js";
import { bool, intFlag, list, parseArgs, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import {
  DETAIL_TEXT_LIMIT,
  iso,
  orgSuffix,
  project,
  redactionNote,
  selectFields,
  truncate,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";

interface IncidentAttributes {
  title?: string;
  public_id?: number;
  state?: string;
  severity?: string;
  created?: string;
  modified?: string;
  detected?: string;
  resolved?: string | null;
  customer_impacted?: boolean;
  customer_impact_scope?: string | null;
  fields?: Record<string, { value?: unknown } | undefined>;
}

interface Incident {
  id?: string;
  attributes?: IncidentAttributes;
}

/** Newer API versions put state/severity at the top level, older ones under `fields`. */
export function incidentField(a: IncidentAttributes | undefined, name: "state" | "severity"): string | null {
  const direct = a?.[name];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const nested = a?.fields?.[name]?.value;
  return typeof nested === "string" ? nested : null;
}

const INCIDENT_FIELDS: FieldSet<Incident> = {
  all: {
    id: (i) => i.id,
    public_id: (i) => i.attributes?.public_id,
    title: (i) => i.attributes?.title,
    severity: (i) => incidentField(i.attributes, "severity"),
    state: (i) => incidentField(i.attributes, "state"),
    created: (i) => iso(i.attributes?.created),
    customer_impacted: (i) => i.attributes?.customer_impacted ?? null,
  },
  defaults: ["id", "title", "severity", "state"],
};

const STATES = ["active", "stable", "resolved"];

const LIST: CommandSpec = {
  name: "incidents list",
  flags: {
    "--status": {
      kind: "list",
      value: "<state>",
      description: "Incident state: active, stable, resolved (default: active,stable)",
    },
    "--limit": { kind: "string", value: "<n>", description: "Max incidents (default 50, max 100)" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(INCIDENT_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = {
  name: "incidents view",
  positionals: ["<id>"],
  flags: {
    "--full": { kind: "boolean", description: "Untruncated summary and fields" },
    ...TARGET_FLAGS,
  },
};

export const INCIDENTS_HELP = renderHelp({
  command: "incidents",
  description: "List incidents (open by default) and view one",
  subcommands: [
    { spec: LIST, summary: "Incidents by state, newest first, with the total" },
    { spec: VIEW, summary: "One incident: severity, state, impact, timeline fields and summary" },
  ],
  examples: [
    "datadog-axi incidents list",
    "datadog-axi incidents list --status resolved --limit 10",
    "datadog-axi incidents view <id>",
  ],
});

export async function incidentsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("incidents", args, ["list", "view"], "list");
  return sub === "view" ? view(rest, rt) : listIncidents(rest, rt);
}

export function incidentStateQuery(states: string[]): string {
  for (const s of states) {
    if (!STATES.includes(s)) {
      throw new AxiError(`Unknown incident state: ${s}`, "VALIDATION_ERROR", [`Valid states: ${STATES.join(", ")}`]);
    }
  }
  return states.length === 1 ? `state:${states[0]}` : `state:(${states.join(" OR ")})`;
}

interface IncidentSearchResponse {
  data?: { attributes?: { incidents?: Array<{ data?: Incident }>; total?: number } };
}

async function listIncidents(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const fields = selectFields(parsed, INCIDENT_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 50, max: 100 });
  const states = list(parsed, "--status").map((s) => s.toLowerCase());
  const effective = states.length > 0 ? states : ["active", "stable"];
  const query = incidentStateQuery(effective);

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<IncidentSearchResponse>("incidents.search", {
    query: { query, sort: "-created", "page[size]": limit },
  });
  const incidents = (data.data?.attributes?.incidents ?? []).map((i) => i.data ?? {});
  const total = data.data?.attributes?.total ?? incidents.length;
  const org = orgSuffix(seam.target);

  if (incidents.length === 0) {
    return withHelp(
      { site: seam.target.site, incidents: `0 ${effective.join(" or ")}` },
      effective.includes("resolved")
        ? ["Run `datadog-axi ctx` to check this is the expected org and site"]
        : [`Run \`datadog-axi incidents list --status resolved --limit 10${org}\` for recent resolved incidents`],
    );
  }

  return withHelp(
    {
      site: seam.target.site,
      status: effective.join(","),
      count: `${incidents.length} of ${total} total`,
      incidents: project(incidents, INCIDENT_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [`Run \`datadog-axi incidents view <id>${org}\` for impact and summary`],
  );
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = parsed.positionals[0] as string;
  const full = bool(parsed, "--full");
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: Incident }>("incidents.get", { params: { incident_id: id } });
  const a = data.data?.attributes ?? {};

  const limit = full ? Number.POSITIVE_INFINITY : DETAIL_TEXT_LIMIT;
  let truncated = false;
  const extraFields: Record<string, string> = {};
  for (const [name, field] of Object.entries(a.fields ?? {})) {
    if (name === "state" || name === "severity") {
      continue;
    }
    const value = field?.value;
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    const t = truncate(typeof value === "string" ? value : JSON.stringify(value), limit);
    truncated ||= t.truncated;
    extraFields[name] = t.text;
  }

  return withHelp(
    {
      site: seam.target.site,
      incident: {
        id: data.data?.id ?? id,
        public_id: a.public_id ?? null,
        title: a.title ?? null,
        severity: incidentField(a, "severity"),
        state: incidentField(a, "state"),
        customer_impacted: a.customer_impacted ?? null,
        customer_impact_scope: a.customer_impact_scope ?? null,
        detected: iso(a.detected),
        created: iso(a.created),
        resolved: iso(a.resolved),
        modified: iso(a.modified),
      },
      fields: extraFields,
      ...redactionNote(redacted),
    },
    truncated
      ? [`Run \`datadog-axi incidents view ${id}${orgSuffix(seam.target)} --full\` for untruncated fields`]
      : [],
  );
}
