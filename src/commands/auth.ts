import { AxiError } from "axi-sdk-js";
import { bool, parseArgs, str, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { findOrg, loadConfig, saveConfig, validateOrgName } from "../config.js";
import { deniedScopes, guideCommand, guideSite, setupGuide, US1_FALLBACK_HINT } from "../guide.js";
import { renderHelp } from "../help.js";
import { probeDomains, validateKeys } from "../probe.js";
import { orgSuffix, withHelp } from "../render.js";
import { connect, readConfig, splitSubcommand, type Runtime } from "../runtime.js";
import { normalizeSite, regionOf } from "../sites.js";
import { describeTarget } from "../target.js";

/**
 * Local credential management (S7, D4, D-c2). Secrets arrive only on stdin
 * (never argv), a terminal on stdin is refused, nothing ever echoes a key,
 * and datadog-axi has no interactive or browser login of its own. `auth guide`
 * points a human to pup's browser login first and stored keys as the fallback.
 */

const GUIDE: CommandSpec = {
  name: "auth guide",
  flags: {
    "--site": { kind: "string", value: "<site>", description: "The org's Datadog site (default: DD_SITE, then US1)" },
    "--org": { kind: "string", value: "<name>", description: "Name to store the org under in the login step" },
  },
};

const LOGIN: CommandSpec = {
  name: "auth login",
  flags: {
    "--org": { kind: "string", value: "<name>", description: "Name for this org (required)" },
    "--site": { kind: "string", value: "<site>", description: "The org's Datadog site, pinned to it (required)" },
    "--api-key-stdin": {
      kind: "boolean",
      description: "Read the API key (line 1) and application key (line 2) from stdin (required)",
    },
  },
};

const STATUS: CommandSpec = { name: "auth status", flags: { ...TARGET_FLAGS } };
const LIST: CommandSpec = { name: "auth list", flags: {} };
const LOGOUT: CommandSpec = {
  name: "auth logout",
  flags: { "--org": { kind: "string", value: "<name>", description: "Stored org to remove (required)" } },
};

export const AUTH_HELP = renderHelp({
  command: "auth",
  description: "Set up, store, inspect and remove Datadog credentials (OS keychain, one entry per org)",
  subcommands: [
    {
      spec: GUIDE,
      summary:
        "Credential setup guide for the org's site: pup login first, keys as the fallback (links, scopes, checks); offline",
    },
    { spec: LOGIN, summary: "Store an org's keys in the OS keychain and make it the current org; local only" },
    { spec: STATUS, summary: "Check the keys and report which Datadog domains they can read" },
    { spec: LIST, summary: "Stored orgs with their pinned sites; local only" },
    { spec: LOGOUT, summary: "Remove a stored org and its keychain entry; local only" },
  ],
  notes: [
    "Environment credentials win when no --org is given: DD_ACCESS_TOKEN, or DD_API_KEY + DD_APP_KEY (or DD_APPLICATION_KEY), with DD_SITE",
    "With nothing else configured, pup's browser login is used when pup is on PATH (DATADOG_AXI_PUP=off disables it)",
    "Keys are never accepted as flags; login reads them from stdin and refuses a terminal",
  ],
  examples: [
    "datadog-axi auth guide --site datadoghq.eu --org prod",
    'printf \'%s\\n%s\\n\' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org prod --site datadoghq.eu --api-key-stdin',
    "datadog-axi auth status --org prod",
    "datadog-axi auth list",
  ],
});

export async function authCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { sub, rest } = splitSubcommand("auth", args, ["guide", "login", "status", "list", "logout"]);
  switch (sub) {
    case "guide":
      return guide(rest, rt);
    case "login":
      return login(rest, rt);
    case "status":
      return status(rest, rt);
    case "list":
      return list(rest, rt);
    default:
      return logout(rest, rt);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function guide(args: string[], rt: Runtime): Record<string, unknown> {
  const parsed = parseArgs(GUIDE, args);
  const orgName = str(parsed, "--org");
  const org = orgName !== undefined ? validateOrgName(orgName) : undefined;
  const { site, explicit } = guideSite(str(parsed, "--site"), rt.env);
  const { data, steps } = setupGuide(site, org);
  return withHelp({ guide: data }, [
    "A human follows these steps; an agent never handles key values",
    ...steps,
    ...(explicit ? [] : [US1_FALLBACK_HINT]),
  ]);
}

const KEY_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

async function login(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LOGIN, args);
  const orgName = str(parsed, "--org");
  const siteInput = str(parsed, "--site");
  if (!orgName || !siteInput || !bool(parsed, "--api-key-stdin")) {
    throw new AxiError("auth login needs --org, --site and --api-key-stdin", "VALIDATION_ERROR", [
      'printf \'%s\\n%s\\n\' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org <name> --site <site> --api-key-stdin',
    ]);
  }
  const org = validateOrgName(orgName);
  const site = normalizeSite(siteInput);

  const stdin = await rt.readStdin();
  if (stdin.isTTY) {
    throw new AxiError("Refusing to read keys from a terminal", "VALIDATION_ERROR", [
      'Pipe the keys instead: printf \'%s\\n%s\\n\' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login ...',
    ]);
  }
  const lines = stdin.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 2) {
    throw new AxiError(
      `Expected exactly 2 non-empty lines on stdin (API key, then application key), got ${lines.length}`,
      "VALIDATION_ERROR",
      [
        'printf \'%s\\n%s\\n\' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org <name> --site <site> --api-key-stdin',
      ],
    );
  }
  const [apiKey, appKey] = lines as [string, string];
  if (!KEY_SHAPE.test(apiKey) || !KEY_SHAPE.test(appKey)) {
    throw new AxiError("A key on stdin does not look like a Datadog key", "VALIDATION_ERROR", [
      "Line 1 is the API key and line 2 the application key, each 16-128 letters, digits, _ or -",
    ]);
  }

  // Read and validate the config before touching the keychain, so a bad config
  // never leaves a stored secret without an org record (or overwrites working keys).
  const config = loadConfig(rt.configPath);
  const replaced = findOrg(config, org) !== undefined;

  // The current entry is read first: rolling back a failed config save needs it.
  let previous;
  try {
    previous = await rt.keychain.get(org);
  } catch (error) {
    throw new AxiError(`Could not read the OS keychain: ${errorText(error)}`, "KEYCHAIN_UNAVAILABLE", [
      `Unlock the keychain, then re-run \`datadog-axi auth login --org ${org} --site ${site} --api-key-stdin\``,
    ]);
  }
  try {
    await rt.keychain.set(org, { apiKey, appKey });
  } catch (error) {
    throw new AxiError(`Could not write to the OS keychain: ${errorText(error)}`, "KEYCHAIN_UNAVAILABLE", [
      `Unlock the keychain, then re-run \`datadog-axi auth login --org ${org} --site ${site} --api-key-stdin\``,
      "Or use DD_API_KEY and DD_APP_KEY in the environment instead",
    ]);
  }
  config.orgs[org] = { site };
  config.current = org;
  try {
    saveConfig(rt.configPath, config);
  } catch (error) {
    // Undo the keychain write so keys and config never disagree.
    let rolledBack = true;
    try {
      await (previous ? rt.keychain.set(org, previous) : rt.keychain.delete(org));
    } catch {
      rolledBack = false;
    }
    throw new AxiError(
      `Could not save the config file: ${errorText(error)}${
        rolledBack ? "" : `; the keychain entry for org "${org}" could not be restored and may not match the config`
      }`,
      "CONFIG_INVALID",
      [
        `Check that ${rt.configPath} and its directory are writable, then re-run \`datadog-axi auth login --org ${org} --site ${site} --api-key-stdin\``,
      ],
    );
  }

  return withHelp(
    { auth: { org, site: `${site} (${regionOf(site)})`, stored: "OS keychain", current: true, replaced } },
    [`Run \`datadog-axi auth status --org ${org}\` to check the keys and see which domains they can read`],
  );
}

async function status(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(STATUS, args);
  const seam = await connect(rt, parsed);
  const [keys, domains] = await Promise.all([validateKeys(seam), probeDomains(seam, rt.now())]);
  const readable = domains.filter((d) => d.readable === "yes").map((d) => d.domain);
  const denied = domains.filter((d) => d.readable === "no").map((d) => d.domain);
  return withHelp(
    {
      target: { org: seam.target.org, site: seam.target.site, credentials: seam.target.credentials },
      keys,
      readable: readable.length > 0 ? readable.join(", ") : "none",
      ...(denied.length > 0 ? { denied: denied.join(", ") } : {}),
      domains: domains.map(({ domain, readable: r, detail }) => ({ domain, readable: r, detail })),
    },
    denied.length > 0
      ? [
          `Denied domains need these scopes on the key, and a user role that grants them: ${deniedScopes(denied)}`,
          `Run \`${guideCommand(seam.target.site)}\` for where to edit the key's scopes`,
        ]
      : [`Run \`datadog-axi doctor${orgSuffix(seam.target)}\` for rate-limit headroom and whether the key could write`],
  );
}

async function list(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  parseArgs(LIST, args);
  const config = readConfig(rt);
  const active = describeTarget({}, rt.env, config);
  const orgs = Object.entries(config.orgs).map(([name, entry]) => ({
    org: name,
    site: entry.site,
    current: config.current === name,
  }));
  const env = active.source === "env" ? active.credentials : "none";
  const pup = active.source === "pup" ? { pup: active.credentials } : {};
  if (orgs.length === 0) {
    return withHelp({ orgs: "0 stored", environment: env, ...pup, active: active.org }, [
      "Run `datadog-axi auth guide --site <site>` for both setup routes (pup login or keys)",
      'A human stores an org with: printf \'%s\\n%s\\n\' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org <name> --site <site> --api-key-stdin',
    ]);
  }
  return withHelp({ orgs, environment: env, ...pup, active: active.org }, [
    "Select a stored org per command with `--org <name>`",
    ...(active.source === "env" ? ["Environment credentials are active because no `--org` was given"] : []),
    ...(active.source === "pup" ? ["pup's login is active because no other credential is configured"] : []),
  ]);
}

async function logout(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(LOGOUT, args);
  const orgName = str(parsed, "--org");
  if (!orgName) {
    throw new AxiError("auth logout needs --org <name>", "VALIDATION_ERROR", [
      "Run `datadog-axi auth list` to see stored orgs",
    ]);
  }
  const config = loadConfig(rt.configPath);
  const known = findOrg(config, orgName) !== undefined;
  let deleted = false;
  try {
    deleted = await rt.keychain.delete(orgName);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AxiError(`Could not remove the keychain entry: ${reason}`, "KEYCHAIN_UNAVAILABLE", [
      "Unlock the keychain and retry",
    ]);
  }
  if (!known && !deleted) {
    return { auth: `org ${orgName} is not stored (no-op)` };
  }
  delete config.orgs[orgName];
  if (config.current === orgName) {
    delete config.current;
  }
  config.writable = config.writable.filter((w) => w !== orgName);
  saveConfig(rt.configPath, config);
  return { auth: { org: orgName, removed: true, keychain_entry_deleted: deleted } };
}
