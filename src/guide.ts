import { pupLoginCommand } from "./pup.js";
import { appBaseUrl, DEFAULT_SITE, normalizeSite, regionOf } from "./sites.js";

/**
 * The credential setup guide: which scopes datadog-axi needs and two ways
 * for a human to get a credential with them on the org's own site. Route A,
 * the default, is a browser login with Pup, Datadog's CLI; datadog-axi then
 * reads pup's token itself (`pup.ts`). Route B, the fallback, is an API key
 * and a scoped application key stored with `auth login`. Printing the guide
 * is fully offline: no keychain, no network, no pup.
 *
 * Scopes are the permission each endpoint's Datadog API reference names
 * ("This endpoint requires the `X` permission"); application keys can be
 * scoped to any permission.
 */

export interface DomainScopes {
  domain: string;
  scopes: string[];
  /** Set when the only scope that works is not read-only. */
  caveat?: string;
}

export const DOMAIN_SCOPES: readonly DomainScopes[] = [
  { domain: "monitors", scopes: ["monitors_read"] },
  { domain: "logs", scopes: ["logs_read_data", "logs_read_index_data"] },
  { domain: "metrics", scopes: ["metrics_read", "timeseries_query"] },
  { domain: "traces", scopes: ["apm_read"] },
  { domain: "services", scopes: ["apm_service_catalog_read"] },
  { domain: "dashboards", scopes: ["dashboards_read"] },
  { domain: "incidents", scopes: ["incident_read"] },
  { domain: "events", scopes: ["events_read"] },
  { domain: "hosts", scopes: ["hosts_read"] },
  { domain: "slos", scopes: ["slos_read"] },
  { domain: "synthetics", scopes: ["synthetics_read"] },
  { domain: "notebooks", scopes: ["notebooks_read"] },
  {
    domain: "downtimes",
    scopes: ["monitors_downtime"],
    caveat: "optional, not read-only: Datadog's downtime list needs Manage Downtimes, which can also mute monitors",
  },
];

/** `logs_read_data logs_read_index_data (logs), ...` for the denied domains, in table order. */
export function deniedScopes(denied: readonly string[]): string {
  return DOMAIN_SCOPES.filter((d) => denied.includes(d.domain))
    .map((d) => `${d.scopes.join(" ")} (${d.domain})`)
    .join(", ");
}

/**
 * The site a guide is for: `--site`, then `DD_SITE` (which matters even with
 * no keys set), then US1. `explicit` is false only for the US1 fallback.
 */
export function guideSite(flag: string | undefined, env: NodeJS.ProcessEnv): { site: string; explicit: boolean } {
  const input = flag ?? (env.DD_SITE !== undefined && env.DD_SITE.trim().length > 0 ? env.DD_SITE : undefined);
  return input !== undefined ? { site: normalizeSite(input), explicit: true } : { site: DEFAULT_SITE, explicit: false };
}

export const US1_FALLBACK_HINT = `The links are for ${DEFAULT_SITE} (US1); if the org is on another site, run \`datadog-axi auth guide --site <site>\``;

export function apiKeysUrl(site: string): string {
  return `${appBaseUrl(site)}/organization-settings/api-keys`;
}

export function applicationKeysUrl(site: string): string {
  return `${appBaseUrl(site)}/organization-settings/application-keys`;
}

export function accessTokensUrl(site: string): string {
  return `${appBaseUrl(site)}/personal-settings/access-tokens`;
}

export const PUP_DOCS_URL = "https://docs.datadoghq.com/cli/";

export function guideCommand(site: string, org?: string): string {
  return `datadog-axi auth guide --site ${site}${org !== undefined ? ` --org ${org}` : ""}`;
}

export interface SetupGuide {
  /** Site, links and scopes, encoded as TOON data. */
  data: Record<string, unknown>;
  /** Numbered steps, printed as unquoted `help` lines so the login command stays pasteable. */
  steps: string[];
}

/** Every read-only scope datadog-axi uses, in table order. */
export const READ_SCOPES: readonly string[] = DOMAIN_SCOPES.filter((d) => d.caveat === undefined).flatMap(
  (d) => d.scopes,
);

export function setupGuide(site: string, org = "<name>"): SetupGuide {
  const readOnly = READ_SCOPES;
  return {
    data: {
      site: `${site} (${regionOf(site)})`,
      links: {
        api_keys: apiKeysUrl(site),
        application_keys: applicationKeysUrl(site),
        personal_access_tokens: accessTokensUrl(site),
        pup_cli: PUP_DOCS_URL,
      },
      read_scopes: readOnly.join(" "),
      scopes: DOMAIN_SCOPES.map(({ domain, scopes, caveat }) => ({
        domain,
        scopes: scopes.join(" "),
        note: caveat ?? "read-only",
      })),
    },
    steps: [
      "Route A (recommended) - Pup, Datadog's CLI: one browser login and no long-lived key",
      "A1. Install Pup: brew tap datadog-labs/pack && brew install datadog-labs/pack/pup (or npm install -g @datadog/pup)",
      `A2. Log in once in the browser with only read_scopes: ${pupLoginCommand(site, readOnly)}`,
      `A3. Nothing to copy: with no other credential set, datadog-axi runs \`pup auth token\` itself and keeps the token in memory only${
        site === DEFAULT_SITE ? "" : `. Export DD_SITE=${site} so pup and datadog-axi pick this login`
      }; for a named pup session (pup auth login --org <name>), export DD_ORG=<name>`,
      "A4. Run `datadog-axi auth status` and `datadog-axi doctor`. Pup's token lasts about an hour and pup refreshes it for 30 days; after that, run A2 again (`pup auth refresh` forces a refresh)",
      "Route B (fallback) - an API key and application key in the OS keychain; they do not expire",
      `B1. Open ${apiKeysUrl(site)} and copy an existing API key, or create one with New Key`,
      `B2. Open ${applicationKeysUrl(site)}, create a key with New Key and limit its scopes to read_scopes above`,
      `B3. Store both in the OS keychain; keys go on stdin, never in arguments: printf '%s\\n%s\\n' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org ${org} --site ${site} --api-key-stdin`,
      `B4. Wait a few seconds for the new key to propagate, then run \`datadog-axi auth status --org ${org}\` to see which domains it can read`,
      `B5. Run \`datadog-axi doctor --org ${org}\` to check rate-limit headroom and whether the key could write`,
      `Instead of B1-B3: create a Personal Access Token (one scoped credential with an expiry) at ${accessTokensUrl(site)} with read_scopes, then set DD_ACCESS_TOKEN and DD_SITE=${site}`,
    ],
  };
}
