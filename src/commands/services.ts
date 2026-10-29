import { intFlag, parseArgs, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import { orgSuffix, project, redactionNote, selectFields, withHelp, type FieldSet } from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";

interface ServiceSchema {
  "dd-service"?: string;
  team?: string;
  tier?: string;
  lifecycle?: string;
  description?: string;
  application?: string;
  languages?: string[];
  contacts?: Array<{ type?: string; contact?: string; name?: string }>;
  links?: Array<{ name?: string; type?: string; url?: string }>;
  repos?: Array<{ name?: string; url?: string }>;
  "schema-version"?: string;
}

interface ServiceDefinition {
  id?: string;
  attributes?: { schema?: ServiceSchema; meta?: { "last-modified-time"?: string; "ingestion-source"?: string } };
}

const SERVICE_FIELDS: FieldSet<ServiceDefinition> = {
  all: {
    service: (s) => s.attributes?.schema?.["dd-service"],
    team: (s) => s.attributes?.schema?.team,
    tier: (s) => s.attributes?.schema?.tier,
    lifecycle: (s) => s.attributes?.schema?.lifecycle,
    application: (s) => s.attributes?.schema?.application,
    languages: (s) => (s.attributes?.schema?.languages ?? []).join(" "),
  },
  defaults: ["service", "team", "tier", "lifecycle"],
};

const LIST: CommandSpec = {
  name: "services list",
  flags: {
    "--limit": { kind: "string", value: "<n>", description: "Services per page (default 100, max 100)" },
    "--page": { kind: "string", value: "<n>", description: "Page number, starting at 0" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(SERVICE_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = { name: "services view", positionals: ["<name>"], flags: { ...TARGET_FLAGS } };

export const SERVICES_HELP = renderHelp({
  command: "services",
  description: "Service ownership and links from the service catalog (service definitions)",
  subcommands: [
    { spec: LIST, summary: "Services with team, tier and lifecycle" },
    { spec: VIEW, summary: "One service: owner, contacts, links and repos" },
  ],
  examples: ["datadog-axi services list", "datadog-axi services view checkout"],
});

export async function servicesCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("services", args, ["list", "view"], "list");
  return sub === "view" ? view(rest, rt) : list(rest, rt);
}

async function list(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const fields = selectFields(parsed, SERVICE_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 100 });
  const page = intFlag(parsed, "--page", { default: 0, min: 0, max: 100_000 });
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: ServiceDefinition[] }>("services.definitions", {
    query: { "page[size]": limit, "page[number]": page },
  });
  const services = data.data ?? [];
  const org = orgSuffix(seam.target);
  if (services.length === 0) {
    return withHelp(
      { site: seam.target.site, services: page > 0 ? `0 on page ${page}` : "0 defined in the service catalog" },
      page > 0
        ? [`Run \`datadog-axi services list${org}\` for the first page`]
        : [
            "Services appear here once a service definition is registered in the catalog",
            'Run `datadog-axi traces search "*" --fields service` to see services that send traces',
          ],
    );
  }
  return withHelp(
    {
      site: seam.target.site,
      count: `${services.length} on page ${page}`,
      services: project(services, SERVICE_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [
      `Run \`datadog-axi services view <name>${org}\` for contacts and links`,
      ...(services.length === limit ? [`Run \`datadog-axi services list --page ${page + 1}${org}\` for more`] : []),
    ],
  );
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const name = parsed.positionals[0] as string;
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ data?: ServiceDefinition }>("services.definition", {
    params: { service_name: name },
  });
  const schema = data.data?.attributes?.schema ?? {};
  return {
    site: seam.target.site,
    service: {
      name: schema["dd-service"] ?? name,
      team: schema.team ?? null,
      tier: schema.tier ?? null,
      lifecycle: schema.lifecycle ?? null,
      application: schema.application ?? null,
      description: schema.description ?? null,
      languages: (schema.languages ?? []).join(" "),
    },
    contacts: (schema.contacts ?? []).map((c) => ({
      type: c.type ?? null,
      contact: c.contact ?? null,
      name: c.name ?? null,
    })),
    links: (schema.links ?? []).map((l) => ({ name: l.name ?? null, type: l.type ?? null, url: l.url ?? null })),
    repos: (schema.repos ?? []).map((r) => ({ name: r.name ?? null, url: r.url ?? null })),
    ...redactionNote(redacted),
  };
}
