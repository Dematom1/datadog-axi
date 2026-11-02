import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AxiError,
  computeSessionStartHookRemoval,
  computeSessionStartHookUpdate,
  installSessionStartHooks,
  sessionStartHookStatus,
} from "axi-sdk-js";
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
  if (args[0] === "status") {
    const status = observedSessionStartStatus(settingsPath, bool(parsed, "--project"));
    return {
      hooks: {
        claude_session_end: hasClaudeSessionEndHook(settingsPath) ? "installed" : "not installed",
        session_start: status,
      },
    };
  }
  if (args[0] === "uninstall") {
    let removed: boolean;
    try {
      removed = removeClaudeSessionEndHook(settingsPath);
    } catch (error) {
      throw setupFailure("removal", settingsPath, error);
    }
    const remains = hasClaudeSessionEndHook(settingsPath);
    return { hooks: { claude_session_end: remains ? "still installed" : removed ? "removed" : "not installed" } };
  }
  const errors: string[] = [];
  try {
    readClaudeSettings(settingsPath);
  } catch (error) {
    throw setupFailure("reading", settingsPath, error);
  }
  installSessionStartHooks({
    marker: "datadog-axi",
    execPath: resolveCtxEntrypoint(),
    binaryNames: ["datadog-axi-ctx"],
    distEntrypoints: ["dist/bin/datadog-axi-ctx.js"],
    scope: bool(parsed, "--project") ? "project" : "user",
    onError: (message) => errors.push(message),
  });
  try {
    if (!installClaudeSessionEndHook(settingsPath))
      errors.push(`Could not safely update Claude settings at ${settingsPath}`);
  } catch (error) {
    errors.push(setupFailure("installation", settingsPath, error).message);
  }
  if (errors.length === 0 && !bool(parsed, "--project")) syncClaudeSessionStart(settingsPath, errors);
  if (errors.length > 0) {
    throw new AxiError(`Hook installation reported problems: ${errors.join("; ")}`, "SETUP_FAILED", [
      "Fix the paths above, then re-run `datadog-axi setup hooks`",
    ]);
  }
  const status = observedSessionStartStatus(settingsPath, bool(parsed, "--project"));
  const sessionEnd = hasClaudeSessionEndHook(settingsPath);
  return {
    hooks: {
      status: { claude_session_end: sessionEnd, session_start: status },
      scope: bool(parsed, "--project") ? "project" : "user",
      integrations: "Claude Code, Codex, OpenCode",
      command: "datadog-axi-ctx (local config only; no keychain, no network)",
    },
    help: ["Restart your agent session to receive datadog-axi context"],
  };
}

function readClaudeSettings(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Claude settings must contain a JSON object");
    const settings = Object.fromEntries(Object.entries(value));
    if ("hooks" in settings && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)))
      throw new Error("Claude hooks must contain an object");
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    for (const event of ["SessionEnd", "SessionStart"]) {
      if (!hooks || !(event in hooks)) continue;
      const groups = hooks[event];
      if (!Array.isArray(groups)) throw new Error(`Claude ${event} hooks must contain an array`);
      for (const group of groups) {
        if (!group || typeof group !== "object" || Array.isArray(group))
          throw new Error(`Claude ${event} hook groups must contain objects`);
        const entries = (group as Record<string, unknown>).hooks;
        if (
          Array.isArray(entries) &&
          entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))
        )
          throw new Error(`Claude ${event} hook entries must contain objects`);
      }
    }
    if (
      hooks &&
      "session_start" in hooks &&
      Array.isArray(hooks.session_start) &&
      hooks.session_start.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))
    )
      throw new Error("Claude session_start entries must contain objects");
    return settings;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw setupFailure("reading", path, error);
  }
}

function setupFailure(action: string, path: string, error: unknown): AxiError {
  const detail = error instanceof Error ? error.message : String(error);
  return new AxiError(`Could not complete hook ${action} at ${path}: ${detail}`, "SETUP_FAILED", [
    "Check the settings path and permissions, then retry setup",
  ]);
}

function observedSessionStartStatus(path: string, project: boolean) {
  const status = sessionStartHookStatus({ marker: "datadog-axi", scope: project ? "project" : "user" });
  for (const target of [status.codex.path, status.codex.userFeaturePath, status.opencode.path]) {
    try {
      const content = readFileSync(target, "utf8");
      if (target === status.codex.path) {
        const value: unknown = JSON.parse(content);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Codex hooks must be an object");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw setupFailure("reading", target, error);
    }
  }
  const settings = readClaudeSettings(path);
  return {
    ...status,
    claude: { installed: hasClaudeSessionStartHook(settings), path },
  };
}

function hasClaudeSessionStartHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const events = hooks as Record<string, unknown>;
  for (const groups of [events.SessionStart, events.session_start]) {
    if (!Array.isArray(groups)) continue;
    if (
      groups.some((group) => {
        if (!group || typeof group !== "object" || Array.isArray(group)) return false;
        const entries = (group as Record<string, unknown>).hooks;
        return (
          Array.isArray(entries) &&
          entries.some(
            (entry) =>
              !!entry &&
              typeof entry === "object" &&
              typeof (entry as Record<string, unknown>).command === "string" &&
              ((entry as Record<string, unknown>).command as string).includes("datadog-axi"),
          )
        );
      })
    )
      return true;
  }
  return (
    Array.isArray(events.session_start) &&
    events.session_start.some(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).command === "string" &&
        ((entry as Record<string, unknown>).command as string).includes("datadog-axi"),
    )
  );
}

function syncClaudeSessionStart(path: string, errors: string[]): void {
  const defaultPath = join(process.env.HOME || homedir(), ".claude", "settings.json");
  if (path === defaultPath) return;
  try {
    const source = readClaudeSettings(defaultPath);
    const target = readClaudeSettings(path);
    const sourceHooks = source.hooks as Record<string, unknown> | undefined;
    const groups = Array.isArray(sourceHooks?.SessionStart) ? sourceHooks.SessionStart : [];
    const command = groups
      .flatMap((group) => {
        if (!group || typeof group !== "object" || Array.isArray(group)) return [];
        const entries = (group as Record<string, unknown>).hooks;
        return Array.isArray(entries) ? entries : [];
      })
      .find(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).command === "string" &&
          ((entry as Record<string, unknown>).command as string).includes("datadog-axi"),
      );
    if (!command || typeof (command as Record<string, unknown>).command !== "string") return;
    const [updatedTarget] = computeSessionStartHookUpdate(target, {
      marker: "datadog-axi",
      command: (command as Record<string, unknown>).command as string,
      timeoutSeconds: 10,
    });
    const [updatedSource, changed] = computeSessionStartHookRemoval(source, "datadog-axi");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(updatedTarget, null, 2)}\n`, { mode: 0o600 });
    if (changed) writeFileSync(defaultPath, `${JSON.stringify(updatedSource, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    errors.push(setupFailure("updating selected Claude settings", path, error).message);
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

function sessionEndHookCommand(): string {
  return `'${resolveCliEntrypoint().replace(/'/g, "'\\''")}' context end`;
}

function hasClaudeSessionEndHook(path: string): boolean {
  const command = sessionEndHookCommand();
  return claudeHookGroups(path).groups.some(
    (group) => Array.isArray(group.hooks) && group.hooks.some((hook: { command?: string }) => hook.command === command),
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
