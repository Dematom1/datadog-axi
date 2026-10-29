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
  tagsText,
  truncate,
  withHelp,
  type FieldSet,
} from "../render.js";
import { connect, splitSubcommand, type Runtime } from "../runtime.js";

interface SyntheticTest {
  public_id?: string;
  name?: string;
  type?: string;
  subtype?: string;
  status?: string;
  tags?: string[];
  locations?: string[];
  monitor_id?: number;
  message?: string;
  config?: { request?: { url?: string; method?: string; host?: string }; assertions?: unknown[] };
  options?: { tick_every?: number };
  steps?: unknown[];
}

const TEST_FIELDS: FieldSet<SyntheticTest> = {
  all: {
    public_id: (t) => t.public_id,
    name: (t) => t.name,
    type: (t) => (t.subtype ? `${t.type}/${t.subtype}` : t.type),
    status: (t) => t.status,
    monitor_id: (t) => t.monitor_id,
    locations: (t) => (t.locations ?? []).length,
    tags: (t) => tagsText(t.tags),
  },
  defaults: ["public_id", "name", "type", "status"],
};

const PUBLIC_ID = /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/i;

const LIST: CommandSpec = {
  name: "synthetics list",
  flags: {
    "--limit": { kind: "string", value: "<n>", description: "Tests per page (default 100, max 100)" },
    "--page": { kind: "string", value: "<n>", description: "Page number, starting at 0" },
    "--fields": {
      kind: "list",
      value: "<fields>",
      description: `Extra columns: ${Object.keys(TEST_FIELDS.all).join(", ")}`,
    },
    ...TARGET_FLAGS,
  },
};

const VIEW: CommandSpec = {
  name: "synthetics view",
  positionals: ["<public_id>"],
  flags: { "--full": { kind: "boolean", description: "Do not truncate the message" }, ...TARGET_FLAGS },
};

const RESULTS: CommandSpec = {
  name: "synthetics results",
  positionals: ["<public_id>"],
  flags: {
    "--limit": { kind: "string", value: "<n>", description: "Max results, newest first (default 20, max 200)" },
    ...TARGET_FLAGS,
  },
};

export const SYNTHETICS_HELP = renderHelp({
  command: "synthetics",
  description: "List synthetic tests, view one, and read its latest results (never triggers a run)",
  subcommands: [
    { spec: LIST, summary: "Tests with type and live/paused status" },
    { spec: VIEW, summary: "One test: target, frequency, locations, assertions" },
    { spec: RESULTS, summary: "Latest results: location, pass/fail, duration, failure" },
  ],
  examples: ["datadog-axi synthetics list", "datadog-axi synthetics results abc-def-ghi"],
});

export async function syntheticsCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("synthetics", args, ["list", "view", "results"], "list");
  if (sub === "view") return view(rest, rt);
  if (sub === "results") return results(rest, rt);
  return list(rest, rt);
}

function checkId(id: string): string {
  if (!PUBLIC_ID.test(id)) {
    throw new AxiError(`Synthetic test public id looks wrong: ${id}`, "VALIDATION_ERROR", [
      "Public ids look like abc-def-ghi; run `datadog-axi synthetics list` to find them",
    ]);
  }
  return id;
}

async function list(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LIST, args);
  const fields = selectFields(parsed, TEST_FIELDS, LIST.name);
  const limit = intFlag(parsed, "--limit", { default: 100, max: 100 });
  const page = intFlag(parsed, "--page", { default: 0, min: 0, max: 100_000 });
  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call<{ tests?: SyntheticTest[] }>("synthetics.list", {
    query: { page_size: limit, page_number: page },
  });
  const tests = data.tests ?? [];
  const org = orgSuffix(seam.target);
  if (tests.length === 0) {
    return withHelp(
      { site: seam.target.site, tests: page > 0 ? `0 on page ${page}` : "0 synthetic tests in this org" },
      page > 0 ? [`Run \`datadog-axi synthetics list${org}\` for the first page`] : [],
    );
  }
  return withHelp(
    {
      site: seam.target.site,
      count: `${tests.length} on page ${page}`,
      paused: tests.filter((t) => t.status === "paused").length,
      tests: project(tests, TEST_FIELDS, fields),
      ...redactionNote(redacted),
    },
    [
      `Run \`datadog-axi synthetics results <public_id>${org}\` for the latest runs`,
      ...(tests.length === limit ? [`Run \`datadog-axi synthetics list --page ${page + 1}${org}\` for more`] : []),
    ],
  );
}

async function view(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(VIEW, args);
  const id = checkId(parsed.positionals[0] as string);
  const seam = await connect(rt, parsed);
  const { data: t, redacted } = await seam.call<SyntheticTest>("synthetics.get", { params: { public_id: id } });
  const message = truncate(t.message ?? "", bool(parsed, "--full") ? Number.POSITIVE_INFINITY : 500);
  const org = orgSuffix(seam.target);
  return withHelp(
    {
      site: seam.target.site,
      test: {
        public_id: t.public_id ?? id,
        name: t.name ?? null,
        type: t.subtype ? `${t.type}/${t.subtype}` : (t.type ?? null),
        status: t.status ?? null,
        target: t.config?.request?.url ?? t.config?.request?.host ?? null,
        method: t.config?.request?.method ?? null,
        frequency_seconds: t.options?.tick_every ?? null,
        locations: (t.locations ?? []).join(" "),
        assertions: (t.config?.assertions ?? []).length,
        steps: Array.isArray(t.steps) ? t.steps.length : null,
        monitor_id: t.monitor_id ?? null,
        tags: tagsText(t.tags, 50),
        message: message.text,
      },
      ...redactionNote(redacted),
    },
    [
      `Run \`datadog-axi synthetics results ${id}${org}\` for the latest runs`,
      ...(message.truncated ? [`Run \`datadog-axi synthetics view ${id}${org} --full\` for the whole message`] : []),
    ],
  );
}

interface SyntheticResult {
  result_id?: string;
  check_time?: number;
  probe_dc?: string;
  status?: number;
  result?: {
    passed?: boolean;
    timings?: { total?: number };
    duration?: number;
    failure?: { code?: string; message?: string };
    errorMessage?: string;
  };
}

async function results(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(RESULTS, args);
  const id = checkId(parsed.positionals[0] as string);
  const limit = intFlag(parsed, "--limit", { default: 20, max: 200 });
  const seam = await connect(rt, parsed);
  const { data: test } = await seam.call<SyntheticTest>("synthetics.get", { params: { public_id: id } });
  const op = test.type === "browser" ? "synthetics.browser_results" : "synthetics.api_results";
  const { data, redacted } = await seam.call<{ results?: SyntheticResult[] }>(op, { params: { public_id: id } });

  const rows = [...(data.results ?? [])]
    .sort((a, b) => (b.check_time ?? 0) - (a.check_time ?? 0))
    .map((r) => ({
      time: iso(r.check_time),
      location: r.probe_dc ?? null,
      passed: r.result?.passed ?? (r.status === undefined ? null : r.status === 0),
      duration_ms: r.result?.timings?.total ?? r.result?.duration ?? null,
      failure: oneLine(
        r.result?.failure
          ? `${r.result.failure.code ?? ""} ${r.result.failure.message ?? ""}`
          : (r.result?.errorMessage ?? ""),
        150,
      ),
    }));

  if (rows.length === 0) {
    return {
      site: seam.target.site,
      test: test.name ?? id,
      results: "0 recent results (the test may be paused or new)",
    };
  }
  const shown = rows.slice(0, limit);
  const failed = rows.filter((r) => r.passed === false).length;
  return {
    site: seam.target.site,
    test: test.name ?? id,
    status: test.status ?? null,
    summary: `${rows.length - failed} passed, ${failed} failed of ${rows.length} recent`,
    count: `${shown.length} of ${rows.length}`,
    results: shown,
    ...redactionNote(redacted),
  };
}
