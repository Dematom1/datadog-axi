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

const STATUS: CommandSpec = { name: "setup status", flags: {} };
const UNINSTALL: CommandSpec = { name: "setup uninstall", flags: {} };

export const SETUP_HELP = renderHelp({
  command: "setup",
  description: "Install or repair agent SessionStart hooks (Claude Code, Codex, OpenCode)",
  subcommands: [
    {
      spec: HOOKS,
      summary:
        "The hook runs `datadog-axi-ctx`: org, site and credential source from local config only; no keychain, no network",
    },
    { spec: STATUS, summary: "Show whether the Claude Code SessionEnd hook is installed" },
    { spec: UNINSTALL, summary: "Remove the Claude Code SessionEnd hook" },
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
  if (!installClaudeSessionEndHook(settingsPath)) errors.push(`Could not safely update Claude settings at ${settingsPath}`);
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

function readClaudeSettings(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const settings = Object.fromEntries(Object.entries(value));
    if ("hooks" in settings && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)))
      return undefined;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (hooks && "SessionEnd" in hooks && !Array.isArray(hooks.SessionEnd)) return undefined;
    return settings;
  } catch {
    return existsSync(path) ? undefined : {};
  }
}

function claudeHookGroups(path: string): {
  settings: Record<string, unknown>;
  hooks: Record<string, unknown>;
  groups: Array<Record<string, unknown>>;
} {
  const settings = readClaudeSettings(path) ?? {};
  const hooks = settings.hooks && typeof settings.hooks === "object" ? (settings.hooks as Record<string, unknown>) : {};
  return {
    settings,
    hooks,
    groups: Array.isArray(hooks.SessionEnd) ? (hooks.SessionEnd as Array<Record<string, unknown>>) : [],
  };
}

function sessionEndHookCommand(): string {
  return `'${resolveCliEntrypoint().replace(/'/g, "'\\''")}' context end`;
}

function hasClaudeSessionEndHook(path: string): boolean {
  const command = sessionEndHookCommand();
  return claudeHookGroups(path).groups.some(
    (group) =>
      Array.isArray(group.hooks) && group.hooks.some((hook: { command?: string }) => hook.command === command),
  );
}

function removeClaudeSessionEndHook(path: string): boolean {
  const { settings, hooks, groups } = claudeHookGroups(path);
  let removed = false;
  const command = sessionEndHookCommand();
  const next = groups.flatMap((group) => {
    if (!Array.isArray(group.hooks)) return [group];
    const remaining = group.hooks.filter((hook: { command?: string }) => {
      const matches = hook.command === command;
      removed ||= matches;
      return !matches;
    });
    return remaining.length === 0 && remaining.length !== group.hooks.length ? [] : [{ ...group, hooks: remaining }];
  });
  if (!removed) return false;
  if (next.length) hooks.SessionEnd = next;
  else delete hooks.SessionEnd;
  if (!Object.keys(hooks).length) delete settings.hooks;
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function installClaudeSessionEndHook(path: string): boolean {
  const settings = readClaudeSettings(path);
  if (!settings) return false;
  const hooks = settings.hooks && typeof settings.hooks === "object" ? (settings.hooks as Record<string, unknown>) : {};
  const groups = Array.isArray(hooks.SessionEnd) ? (hooks.SessionEnd as Array<Record<string, unknown>>) : [];
  const command = sessionEndHookCommand();
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
  return true;
}

function resolveCliEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, "..", "..", "bin", "datadog-axi.js");
  return existsSync(compiled) ? compiled : join(here, "..", "..", "bin", "datadog-axi.ts");
}

function resolveCtxEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, "..", "..", "bin", "datadog-axi-ctx.js");
  return existsSync(compiled) ? compiled : join(here, "..", "..", "bin", "datadog-axi-ctx.ts");
}
