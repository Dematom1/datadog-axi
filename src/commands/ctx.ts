import { homedir } from "node:os";
import { parseArgs, str, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { configPath, loadConfig, type Config } from "../config.js";
import { renderHelp } from "../help.js";
import { renderResult } from "../output.js";
import { readConfig, type Runtime } from "../runtime.js";
import { regionOf } from "../sites.js";
import { describeTarget, type TargetInput } from "../target.js";
import { VERSION } from "../version.js";

/**
 * Offline context (S17, D-c18): org, site, credential source, write status,
 * version and config path. Reads only flags, environment variable presence
 * and the config file; never the keychain, never the network. The session
 * hook (`datadog-axi-ctx`) prints the same block.
 */

const SPEC: CommandSpec = { name: "ctx", flags: { ...TARGET_FLAGS } };

export const CTX_HELP = renderHelp({
  command: "ctx",
  description: "Show the resolved org, site and credential source without any network or keychain access",
  subcommands: [{ spec: SPEC, summary: "Offline context block (also what the session hook prints)" }],
  examples: ["datadog-axi ctx", "datadog-axi ctx --org prod"],
});

export const WRITES_STATUS = "none (read-only v1)";

export function ctxBlock(
  input: TargetInput,
  env: NodeJS.ProcessEnv,
  config: Config,
  path: string,
): Record<string, unknown> {
  const target = describeTarget(input, env, config);
  const block: Record<string, unknown> = {
    org: target.org,
    site: `${target.site} (${regionOf(target.site)})`,
    credentials: target.credentials,
    writes: WRITES_STATUS,
  };
  if (config.writable.length > 0) {
    block.writable_allowlist = config.writable.join(", ");
  }
  block.version = VERSION;
  block.config = collapseHome(path);
  return block;
}

function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export async function ctxCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SPEC, args);
  const config = readConfig(rt);
  const ctx = ctxBlock({ org: str(parsed, "--org"), site: str(parsed, "--site") }, rt.env, config, rt.configPath);
  const hints =
    ctx.credentials === "none configured"
      ? [
          "Set DD_API_KEY, DD_APP_KEY and DD_SITE, or have a human run `datadog-axi auth login --org <name> --site <site> --api-key-stdin`",
        ]
      : ["Run `datadog-axi` for live monitor and incident state", "Run `datadog-axi auth list` to see stored orgs"];
  return { ctx, help: hints };
}

/** Entry for the `datadog-axi-ctx` hook binary. Never throws, never exits non-zero. */
export function runCtxHook(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const path = configPath(env);
    const ctx = ctxBlock({}, env, loadConfig(path), path);
    return `${renderResult({
      "datadog-axi": ctx,
      help: ["Run `datadog-axi` for live monitors and incidents; `datadog-axi --help` for commands"],
    })}\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${renderResult({ "datadog-axi": { context: `unavailable - ${message}` } })}\n`;
  }
}
