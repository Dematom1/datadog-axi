import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";

/**
 * Local tool config. It holds org names, each org's pinned site, the current
 * org, and the write-target allowlist. It never holds a secret: keys live in
 * the OS keychain, written only by `auth login --api-key-stdin`.
 *
 * `writable` is the S3 allowlist of orgs where writes are allowed at all.
 * It defaults to empty and no command adds to it: a human opts an org in by
 * editing this file (`auth logout` only drops the org it removes).
 * datadog-axi v1 registers no write operations, so the list has no effect
 * yet beyond being shown in `ctx`.
 */

export interface OrgEntry {
  site: string;
}

export interface Config {
  current?: string;
  orgs: Record<string, OrgEntry>;
  writable: string[];
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), ".config");
  return join(base, "datadog-axi", "config.json");
}

export function emptyConfig(): Config {
  return { orgs: {}, writable: [] };
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    return emptyConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new AxiError(`Config file is not valid JSON: ${path}`, "CONFIG_INVALID", [
      `Fix or remove ${path}, then run \`datadog-axi auth login --org <name> --site <site> --api-key-stdin\``,
    ]);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AxiError(`Config file must hold a JSON object: ${path}`, "CONFIG_INVALID", [`Fix or remove ${path}`]);
  }

  const raw = parsed as Record<string, unknown>;
  const config = emptyConfig();

  if (typeof raw.current === "string" && raw.current.length > 0) {
    config.current = raw.current;
  }

  if (raw.orgs !== undefined) {
    if (raw.orgs === null || typeof raw.orgs !== "object" || Array.isArray(raw.orgs)) {
      throw new AxiError(`"orgs" in ${path} must be an object`, "CONFIG_INVALID", [`Fix or remove ${path}`]);
    }
    for (const [name, entry] of Object.entries(raw.orgs as Record<string, unknown>)) {
      const site = (entry as { site?: unknown } | null)?.site;
      if (typeof site !== "string" || site.length === 0) {
        throw new AxiError(`Org "${name}" in ${path} has no site`, "CONFIG_INVALID", [
          `Re-run \`datadog-axi auth login --org ${name} --site <site> --api-key-stdin\``,
        ]);
      }
      config.orgs[name] = { site };
    }
  }

  if (raw.writable !== undefined) {
    if (!Array.isArray(raw.writable) || raw.writable.some((w) => typeof w !== "string")) {
      throw new AxiError(`"writable" in ${path} must be a list of org names`, "CONFIG_INVALID", [
        `Fix ${path}; the default is an empty list (no org allows writes)`,
      ]);
    }
    config.writable = raw.writable as string[];
  }

  return config;
}

export function saveConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body: Record<string, unknown> = {};
  if (config.current) {
    body.current = config.current;
  }
  body.orgs = config.orgs;
  body.writable = config.writable;

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function validateOrgName(name: string): string {
  if (!ORG_NAME.test(name) || name === "env") {
    throw new AxiError(`Invalid org name: ${name}`, "VALIDATION_ERROR", [
      'Use letters, digits, ".", "_" or "-" (max 63 chars); "env" is reserved for environment credentials',
    ]);
  }
  return name;
}
