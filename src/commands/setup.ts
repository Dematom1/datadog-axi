import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError, installSessionStartHooks } from "axi-sdk-js";
import { bool, parseArgs, type CommandSpec } from "../args.js";
import { renderHelp } from "../help.js";

const HOOKS: CommandSpec = {
  name: "setup hooks",
  flags: {
    "--project": { kind: "boolean", description: "Install into this repository's agent config instead of the user's" },
  },
};

export const SETUP_HELP = renderHelp({
  command: "setup",
  description: "Install or repair agent SessionStart hooks (Claude Code, Codex, OpenCode)",
  subcommands: [
    {
      spec: HOOKS,
      summary:
        "The hook runs `datadog-axi-ctx`: org, site and credential source from local config only; no keychain, no network",
    },
  ],
  examples: ["datadog-axi setup hooks", "datadog-axi setup hooks --project"],
});

export async function setupCommand(args: string[]): Promise<Record<string, unknown>> {
  if (args[0] !== "hooks") {
    throw new AxiError(args[0] ? `Unknown setup action: ${args[0]}` : "`setup` needs an action", "VALIDATION_ERROR", [
      "Run `datadog-axi setup hooks`",
    ]);
  }
  const parsed = parseArgs(HOOKS, args.slice(1));
  const errors: string[] = [];
  installSessionStartHooks({
    marker: "datadog-axi",
    execPath: resolveCtxEntrypoint(),
    binaryNames: ["datadog-axi-ctx"],
    distEntrypoints: ["dist/bin/datadog-axi-ctx.js"],
    scope: bool(parsed, "--project") ? "project" : "user",
    onError: (message) => errors.push(message),
  });
  if (errors.length > 0) {
    throw new AxiError(`Hook installation reported problems: ${errors.join("; ")}`, "SETUP_FAILED", [
      "Fix the paths above, then re-run `datadog-axi setup hooks`",
    ]);
  }
  return {
    hooks: {
      status: "installed or already up to date",
      scope: bool(parsed, "--project") ? "project" : "user",
      integrations: "Claude Code, Codex, OpenCode",
      command: "datadog-axi-ctx (local config only; no keychain, no network)",
    },
    help: ["Restart your agent session to receive datadog-axi context"],
  };
}

/** The hook points at the ctx entrypoint, not this process's main bin. */
function resolveCtxEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, "..", "..", "bin", "datadog-axi-ctx.js");
  return existsSync(compiled) ? compiled : join(here, "..", "..", "bin", "datadog-axi-ctx.ts");
}
