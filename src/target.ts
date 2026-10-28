import { AxiError } from "axi-sdk-js";
import type { Config } from "./config.js";
import type { Keychain } from "./keychain.js";
import { DEFAULT_SITE, normalizeSite } from "./sites.js";

/**
 * Resolves which Datadog org and site a command talks to, and with which
 * credential (S7, S8, D4, D5).
 *
 * Order:
 * 1. `--org <name>`: that stored org, its pinned site, its keychain entry.
 * 2. Environment: `DD_ACCESS_TOKEN` (bearer), else `DD_API_KEY` plus
 *    `DD_APP_KEY` / `DD_APPLICATION_KEY`; site from `--site`, else `DD_SITE`,
 *    else US1. Reported as org `env`.
 * 3. The config's current org and its keychain entry.
 *
 * A stored org pins its site: `--site` naming a different site is
 * `WRONG_SITE`, so a key is never sent to the wrong site by accident.
 */

export type Auth = { kind: "keys"; apiKey: string; appKey: string } | { kind: "bearer"; token: string };

export type CredentialSource = "env" | "keychain" | "none";

export interface TargetDescription {
  org: string;
  site: string;
  source: CredentialSource;
  /** Human description of where the credential comes from; never the secret. */
  credentials: string;
  /** True when the org was named with `--org` on this invocation. */
  explicit: boolean;
}

export interface Target extends TargetDescription {
  auth: Auth;
}

export interface TargetInput {
  org?: string;
  site?: string;
}

const LOGIN_HINT =
  'A human runs: printf \'%s\\n%s\\n\' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org <name> --site <site> --api-key-stdin';

function envAppKey(env: NodeJS.ProcessEnv): string | undefined {
  return nonEmpty(env.DD_APP_KEY) ?? nonEmpty(env.DD_APPLICATION_KEY);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

function hasEnvCredentials(env: NodeJS.ProcessEnv): boolean {
  return nonEmpty(env.DD_ACCESS_TOKEN) !== undefined || nonEmpty(env.DD_API_KEY) !== undefined;
}

/**
 * Offline description: reads only flags, environment variable presence and
 * the config file. Never the keychain, never the network. Used by `ctx`, the
 * session hook, and the first block of the home view.
 */
export function describeTarget(input: TargetInput, env: NodeJS.ProcessEnv, config: Config): TargetDescription {
  const flagSite = input.site !== undefined ? normalizeSite(input.site) : undefined;

  if (input.org !== undefined) {
    const entry = config.orgs[input.org];
    if (!entry) {
      throw new AxiError(`No stored org named "${input.org}"`, "NOT_FOUND", [
        "Run `datadog-axi auth list` to see stored orgs",
        LOGIN_HINT,
      ]);
    }
    assertPinnedSite(input.org, entry.site, flagSite);
    return {
      org: input.org,
      site: entry.site,
      source: "keychain",
      credentials: "keychain (stored by auth login)",
      explicit: true,
    };
  }

  if (hasEnvCredentials(env)) {
    const envSite = nonEmpty(env.DD_SITE);
    const site = flagSite ?? (envSite !== undefined ? normalizeSite(envSite) : DEFAULT_SITE);
    const credentials =
      nonEmpty(env.DD_ACCESS_TOKEN) !== undefined
        ? "env DD_ACCESS_TOKEN (bearer)"
        : envAppKey(env) !== undefined
          ? "env DD_API_KEY + application key"
          : "env DD_API_KEY (application key missing)";
    return { org: "env", site, source: "env", credentials, explicit: false };
  }

  if (config.current !== undefined) {
    const entry = config.orgs[config.current];
    if (entry) {
      assertPinnedSite(config.current, entry.site, flagSite);
      return {
        org: config.current,
        site: entry.site,
        source: "keychain",
        credentials: "keychain (stored by auth login)",
        explicit: false,
      };
    }
  }

  return {
    org: "none",
    site: flagSite ?? DEFAULT_SITE,
    source: "none",
    credentials: "none configured",
    explicit: false,
  };
}

/** Full resolution, including the secret. May read the keychain. */
export async function resolveTarget(
  input: TargetInput,
  env: NodeJS.ProcessEnv,
  config: Config,
  keychain: Keychain,
): Promise<Target> {
  const description = describeTarget(input, env, config);

  if (description.source === "none") {
    throw new AxiError("No Datadog credentials configured", "AUTH_REQUIRED", [
      "Set DD_API_KEY and DD_APP_KEY (and DD_SITE) in the environment, or store an org:",
      LOGIN_HINT,
    ]);
  }

  if (description.source === "env") {
    const token = nonEmpty(env.DD_ACCESS_TOKEN);
    if (token !== undefined) {
      return { ...description, auth: { kind: "bearer", token } };
    }
    const apiKey = nonEmpty(env.DD_API_KEY) as string;
    const appKey = envAppKey(env);
    if (appKey === undefined) {
      throw new AxiError("DD_API_KEY is set but no application key is; Datadog reads need both", "AUTH_REQUIRED", [
        "Set DD_APP_KEY (or DD_APPLICATION_KEY) in the environment",
      ]);
    }
    return { ...description, auth: { kind: "keys", apiKey, appKey } };
  }

  let keys;
  try {
    keys = await keychain.get(description.org);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AxiError(`Could not read the keychain entry for org "${description.org}": ${reason}`, "AUTH_REQUIRED", [
      "Unlock the OS keychain, or set DD_API_KEY and DD_APP_KEY in the environment",
    ]);
  }
  if (!keys) {
    throw new AxiError(`Org "${description.org}" has no keys in the keychain`, "AUTH_REQUIRED", [
      LOGIN_HINT.replace("<name>", description.org).replace("<site>", description.site),
    ]);
  }
  return { ...description, auth: { kind: "keys", apiKey: keys.apiKey, appKey: keys.appKey } };
}

function assertPinnedSite(org: string, pinned: string, requested: string | undefined): void {
  if (requested !== undefined && requested !== pinned) {
    throw new AxiError(`Org "${org}" is pinned to site ${pinned}, not ${requested}`, "WRONG_SITE", [
      `Drop \`--site\` to use ${pinned}`,
      `Store a separate org for ${requested}: datadog-axi auth login --org <name> --site ${requested} --api-key-stdin`,
    ]);
  }
}
