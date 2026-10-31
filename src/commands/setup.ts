import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  if (args[0] !== "hooks" && args[0] !== "status" && args[0] !== "uninstall") {
    throw new AxiError(args[0] ? `Unknown setup action: ${args[0]}` : "`setup` needs an action", "VALIDATION_ERROR", [
      "Run `datadog-axi setup hooks`",
    ]);
  }
  const parsed = parseArgs(HOOKS, args.slice(1));
  const settingsPath = bool(parsed, "--project")
    ? join(process.cwd(), ".claude", "settings.json")
    : join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude"), "settings.json");
  if (args[0] === "status")
    return { hooks: { claude_session_end: hasClaudeSessionEndHook(settingsPath) ? "installed" : "not installed" } };
  if (args[0] === "uninstall")
    return { hooks: { claude_session_end: removeClaudeSessionEndHook(settingsPath) ? "removed" : "not installed" } };
  const errors: string[] = [];
  installSessionStartHooks({
    marker: "datadog-axi",
    execPath: resolveCtxEntrypoint(),
    binaryNames: ["datadog-axi-ctx"],
    distEntrypoints: ["dist/bin/datadog-axi-ctx.js"],
    scope: bool(parsed, "--project") ? "project" : "user",
    onError: (message) => errors.push(message),
  });
  installClaudeSessionEndHook(settingsPath);
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
function readClaudeSettings(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  } catch {
    return {};
  }
}

function claudeHookGroups(path: string): {
  settings: Record<string, unknown>;
  hooks: Record<string, unknown>;
  groups: Array<Record<string, unknown>>;
} {
  const settings = readClaudeSettings(path);
  const hooks = settings.hooks && typeof settings.hooks === "object" ? (settings.hooks as Record<string, unknown>) : {};
  return {
    settings,
    hooks,
    groups: Array.isArray(hooks.SessionEnd) ? (hooks.SessionEnd as Array<Record<string, unknown>>) : [],
  };
}

function hasClaudeSessionEndHook(path: string): boolean {
  return claudeHookGroups(path).groups.some(
    (group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((hook: { command?: string }) => hook.command?.endsWith(" context end")),
  );
}

function removeClaudeSessionEndHook(path: string): boolean {
  const { settings, hooks, groups } = claudeHookGroups(path);
  const next = groups
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks)
        ? group.hooks.filter((hook: { command?: string }) => !hook.command?.endsWith(" context end"))
        : [],
    }))
    .filter((group) => (group.hooks as unknown[]).length > 0);
  if (next.length === groups.length) return false;
  if (next.length) hooks.SessionEnd = next;
  else delete hooks.SessionEnd;
  if (!Object.keys(hooks).length) delete settings.hooks;
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function installClaudeSessionEndHook(path: string): void {
  let settings: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      settings = Object.fromEntries(Object.entries(value));
  } catch {
    /* New settings file. */
  }
  const hooks = settings.hooks && typeof settings.hooks === "object" ? (settings.hooks as Record<string, unknown>) : {};
  const groups = Array.isArray(hooks.SessionEnd) ? (hooks.SessionEnd as Array<Record<string, unknown>>) : [];
  const command = `${resolveCtxEntrypoint()} context end`;
  if (
    !groups.some(
      (group) =>
        Array.isArray(group.hooks) && group.hooks.some((hook: { command?: string }) => hook.command === command),
    )
  ) {
    groups.push({ matcher: "", hooks: [{ type: "command", command, timeout: 30 }] });
  }
  hooks.SessionEnd = groups;
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function resolveCtxEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, "..", "..", "bin", "datadog-axi-ctx.js");
  return existsSync(compiled) ? compiled : join(here, "..", "..", "bin", "datadog-axi-ctx.ts");
}
