import { AxiError } from "axi-sdk-js";
import { findOrg, type Config } from "./config.js";
import { apiKeysUrl, applicationKeysUrl, guideCommand, READ_SCOPES } from "./guide.js";
import type { Keychain } from "./keychain.js";
import { findPup, processPupRunner, pupLogin, pupLoginCommand, type PupRunner } from "./pup.js";
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
 * 4. Pup, when it is on PATH (or `DATADOG_AXI_PUP` names it): the token of
 *    pup's browser login, read through `pup auth token` (see `pup.ts`), for
 *    the site pup reports. Reported as org `pup`.
 * 5. None: site from `--site`, else `DD_SITE`, else US1, so setup guidance
 *    points at the right site.
 *
 * A stored org pins its site: `--site` naming a different site is
 * `WRONG_SITE`, so a key is never sent to the wrong site by accident.
 */

export type Auth = { kind: "keys"; apiKey: string; appKey: string } | { kind: "bearer"; token: string };

export type CredentialSource = "env" | "keychain" | "pup" | "none";

export interface TargetDescription {
  org: string;
  source: CredentialSource;
  /**
   * Empty only for source `pup` with no `--site` or `DD_SITE`: the site then
   * comes from pup's login, known once `resolveTarget` has asked pup.
   */
  site: string;
  /** Human description of where the credential comes from; never the secret. */
  credentials: string;
  /** True when the org was named with `--org` on this invocation. */
  explicit: boolean;
}

export interface Target extends TargetDescription {
  auth: Auth;
  /** The credential's scopes when its issuer reports them (pup does). */
  scopes?: string[];
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
    const entry = findOrg(config, input.org);
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
    const entry = findOrg(config, config.current);
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

  const envSite = nonEmpty(env.DD_SITE);
  const site = flagSite ?? (envSite !== undefined ? normalizeSite(envSite) : undefined);
  if (findPup(env) !== undefined) {
    const session = nonEmpty(env.DD_ORG);
    return {
      org: "pup",
      site: site ?? "",
      source: "pup",
      credentials: `pup auth token (OAuth login${session !== undefined ? `, session ${session}` : ""})`,
      explicit: false,
    };
  }

  // No credentials yet: DD_SITE still names the site, so setup links point at it.
  return {
    org: "none",
    site: site ?? DEFAULT_SITE,
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
  pupRunner: PupRunner = processPupRunner,
): Promise<Target> {
  const description = describeTarget(input, env, config);

  if (description.source === "pup") {
    return resolvePup(description, env, pupRunner);
  }

  if (description.source === "none") {
    const site = description.site;
    throw new AxiError("No Datadog credentials configured", "AUTH_REQUIRED", [
      `Run \`${guideCommand(site)}\` for both setup routes: a browser login with Datadog's Pup CLI, or keys a human creates (site ${site}; pass \`--site\` for another)`,
      `Keys: an API key at ${apiKeysUrl(site)} and a read-scoped application key at ${applicationKeysUrl(site)}`,
      "Then set DD_API_KEY and DD_APP_KEY (and DD_SITE) in the environment, or store an org:",
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
      `Run \`${guideCommand(description.site, description.org)}\` for how to create the keys`,
    ]);
  }
  return { ...description, auth: { kind: "keys", apiKey: keys.apiKey, appKey: keys.appKey } };
}

async function resolvePup(description: TargetDescription, env: NodeJS.ProcessEnv, runner: PupRunner): Promise<Target> {
  const requested = description.site !== "" ? description.site : undefined;
  const login = await pupLogin(findPup(env) as string, env, requested, runner, pupLoginCommand(requested, READ_SCOPES));
  let site: string;
  try {
    site = normalizeSite(login.site);
  } catch {
    throw new AxiError(
      `pup is logged in to ${login.site}, which is not a Datadog site datadog-axi sends credentials to`,
      "AUTH_REQUIRED",
      [`Log pup in to a Datadog site: ${pupLoginCommand("<site>", READ_SCOPES)}`, "Or set DD_API_KEY and DD_APP_KEY"],
    );
  }
  if (requested !== undefined && site !== requested) {
    throw new AxiError(`pup's login is for site ${site}, not ${requested}`, "WRONG_SITE", [
      `Log pup in to ${requested}: ${pupLoginCommand(requested, READ_SCOPES)}`,
      `Or drop \`--site\` and DD_SITE to use ${site}`,
    ]);
  }
  const details = [
    "OAuth login",
    ...(login.org !== undefined ? [`session ${login.org}`] : []),
    ...(login.expiresAt !== undefined ? [`expires ${login.expiresAt}`] : []),
  ];
  return {
    ...description,
    site,
    credentials: `pup auth token (${details.join(", ")})`,
    auth: { kind: "bearer", token: login.token },
    ...(login.scopes !== undefined ? { scopes: login.scopes } : {}),
  };
}

function assertPinnedSite(org: string, pinned: string, requested: string | undefined): void {
  if (requested !== undefined && requested !== pinned) {
    throw new AxiError(`Org "${org}" is pinned to site ${pinned}, not ${requested}`, "WRONG_SITE", [
      `Drop \`--site\` to use ${pinned}`,
      `Store a separate org for ${requested}: datadog-axi auth login --org <name> --site ${requested} --api-key-stdin`,
    ]);
  }
}
