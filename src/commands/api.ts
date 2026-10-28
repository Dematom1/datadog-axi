import { readFileSync } from "node:fs";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { bool, list, parseArgs, str, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";
import { createRegistry, extractParams, READ_OPERATIONS } from "../registry.js";
import { renderHelpBlock } from "../output.js";
import { redactionNote } from "../render.js";
import { connect, type Runtime } from "../runtime.js";

/**
 * Allowlisted read-only escape hatch (S6, D-c16). A raw method + path is
 * classified by the same registries as every other command: refusals first,
 * then the read allowlist; anything else is refused. Responses get the same
 * redaction (at the seam) and output clamping as every other command.
 */

const SPEC: CommandSpec = {
  name: "api",
  positionals: ["<method-or-path>", "<path>?"],
  flags: {
    "--query": { kind: "list", value: "<key=value>", description: "Query parameter (repeatable)" },
    "--body-file": {
      kind: "string",
      value: "<path|->",
      description: "JSON request body for POST reads; `-` reads stdin",
    },
    "--full": { kind: "boolean", description: "Do not clamp the output" },
    ...TARGET_FLAGS,
  },
};

export const API_OUTPUT_LIMIT = 8000;

const ALLOWED_SUMMARY = (() => {
  const byDomain = new Map<string, string[]>();
  for (const op of READ_OPERATIONS.filter((o) => o.api)) {
    byDomain.set(op.domain, [...(byDomain.get(op.domain) ?? []), `${op.method} ${op.path}`]);
  }
  return [...byDomain.entries()].map(([domain, ops]) => `${domain}: ${ops.join(", ")}`);
})();

export const API_HELP = renderHelp({
  command: "api",
  description: "Call an allowlisted read-only Datadog API endpoint directly (GET, or POST for search-style reads)",
  subcommands: [{ spec: SPEC, summary: "Method defaults to GET; the path must be on the read allowlist" }],
  notes: [
    "Writes, credential endpoints and unregistered paths are refused with a reason",
    "Responses are redacted and clamped like every other command",
    `allowlist[${ALLOWED_SUMMARY.length}]:`,
    ...ALLOWED_SUMMARY.map((line) => `  ${line}`),
  ],
  examples: [
    "datadog-axi api /api/v1/monitor --query group_states=alert",
    "datadog-axi api POST /api/v2/spans/analytics/aggregate --body-file query.json",
  ],
});

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export async function apiCommand(args: string[], rt: Runtime): Promise<string> {
  const parsed = parseArgs(SPEC, args);
  const [first, second] = parsed.positionals as [string, string | undefined];
  const method = second !== undefined ? first.toUpperCase() : "GET";
  const rawPath = second ?? first;
  if (second !== undefined && !METHODS.has(method)) {
    throw new AxiError(`Unknown HTTP method: ${first}`, "VALIDATION_ERROR", ["Use GET or POST"]);
  }

  let url: URL;
  try {
    url = new URL(rawPath, "https://api.invalid");
  } catch {
    throw new AxiError(`Invalid path: ${rawPath}`, "VALIDATION_ERROR", ["Pass a path such as /api/v1/monitor"]);
  }
  if (!rawPath.startsWith("/") || url.origin !== "https://api.invalid" || rawPath.includes("..")) {
    throw new AxiError(`Path must be an absolute API path: ${rawPath}`, "VALIDATION_ERROR", [
      "Pass only the path, e.g. /api/v1/monitor; the host always comes from the org's site",
    ]);
  }
  const path = url.pathname;

  const registry = rt.registry ?? createRegistry();
  const match = registry.match(method, path);
  if (match.kind === "refused") {
    throw new AxiError(`${method} ${path} is refused because it ${match.refusal.reason}`, "REFUSED", [
      match.refusal.alternative,
    ]);
  }
  if (match.kind === "unregistered" || !match.operation.api) {
    throw new AxiError(`${method} ${path} is refused because it is not on the read-only allowlist`, "REFUSED", [
      "Run `datadog-axi api --help` for the allowlisted endpoints",
      method === "GET"
        ? "If this is a read datadog-axi should support, open an issue"
        : "datadog-axi v1 never sends writes",
    ]);
  }
  const op = match.operation;

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  for (const pair of list(parsed, "--query")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new AxiError(`--query must be key=value: ${pair}`, "VALIDATION_ERROR", ["Pass e.g. `--query per_page=10`"]);
    }
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  let body: unknown;
  const bodyFile = str(parsed, "--body-file");
  if (op.method === "POST") {
    if (bodyFile === undefined) {
      throw new AxiError(`${op.method} ${op.path} is a search-style read and needs a JSON body`, "VALIDATION_ERROR", [
        `Pass \`--body-file <path>\` with a ${op.bodyType ?? "JSON"} body, or \`--body-file -\` to read stdin`,
      ]);
    }
    body = await readBody(bodyFile, rt);
  } else if (bodyFile !== undefined) {
    throw new AxiError("GET requests take no body", "VALIDATION_ERROR", ["Use `--query key=value` instead"]);
  }

  const seam = await connect(rt, parsed);
  const { data, redacted } = await seam.call(op.id, { params: extractParams(op.path, path), query, body });

  const header = encode({
    request: `${method} ${path}`,
    operation: op.id,
    site: seam.target.site,
    ...redactionNote(redacted),
  });
  const rendered = encode({ response: data ?? null });
  if (bool(parsed, "--full") || rendered.length <= API_OUTPUT_LIMIT) {
    return `${header}\n${rendered}`;
  }
  return `${header}\n${rendered.slice(0, API_OUTPUT_LIMIT)}\n... (truncated, ${rendered.length} chars total)\n${renderHelpBlock(
    ["Add `--full` for the complete response, or narrow it with `--query`"],
  )}`;
}

async function readBody(source: string, rt: Runtime): Promise<unknown> {
  let text: string;
  if (source === "-") {
    const stdin = await rt.readStdin();
    if (stdin.isTTY) {
      throw new AxiError("--body-file - needs the body piped on stdin", "VALIDATION_ERROR", [
        "Pipe the JSON body, or pass a file path",
      ]);
    }
    text = stdin.text;
  } else {
    try {
      text = readFileSync(source, "utf-8");
    } catch {
      throw new AxiError(`Cannot read body file: ${source}`, "VALIDATION_ERROR", ["Check the path"]);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AxiError("Request body is not valid JSON", "VALIDATION_ERROR", ["Fix the JSON in the body file"]);
  }
}
