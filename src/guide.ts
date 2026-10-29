import { appBaseUrl, DEFAULT_SITE, normalizeSite, regionOf } from "./sites.js";

/**
 * The credential setup guide: where on the org's own site a human creates
 * the keys, which scopes datadog-axi needs, and how to store and check them.
 * Fully offline: no keychain, no network. Datadog has no API that creates a
 * first credential without an existing one, and its OAuth clients need
 * partner registration, so a guide is the setup path.
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

export function guideCommand(site: string, org?: string): string {
  return `datadog-axi auth guide --site ${site}${org !== undefined ? ` --org ${org}` : ""}`;
}

export interface SetupGuide {
  /** Site, links and scopes, encoded as TOON data. */
  data: Record<string, unknown>;
  /** Numbered steps, printed as unquoted `help` lines so the login command stays pasteable. */
  steps: string[];
}

export function setupGuide(site: string, org = "<name>"): SetupGuide {
  const readOnly = DOMAIN_SCOPES.filter((d) => d.caveat === undefined).flatMap((d) => d.scopes);
  return {
    data: {
      site: `${site} (${regionOf(site)})`,
      links: {
        api_keys: apiKeysUrl(site),
        application_keys: applicationKeysUrl(site),
        personal_access_tokens: accessTokensUrl(site),
      },
      read_scopes: readOnly.join(" "),
      scopes: DOMAIN_SCOPES.map(({ domain, scopes, caveat }) => ({
        domain,
        scopes: scopes.join(" "),
        note: caveat ?? "read-only",
      })),
    },
    steps: [
      `1. Open ${apiKeysUrl(site)} and copy an existing API key, or create one with New Key`,
      `2. Open ${applicationKeysUrl(site)}, create a key with New Key and limit its scopes to read_scopes above`,
      `3. Store both in the OS keychain; keys go on stdin, never in arguments: printf '%s\\n%s\\n' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org ${org} --site ${site} --api-key-stdin`,
      `4. Wait a few seconds for the new key to propagate, then run \`datadog-axi auth status --org ${org}\` to see which domains it can read`,
      `5. Run \`datadog-axi doctor --org ${org}\` to check rate-limit headroom and whether the key could write`,
      `Instead of steps 1-3: create a Personal Access Token (one scoped credential with an expiry) at ${accessTokensUrl(site)} with read_scopes, then set DD_ACCESS_TOKEN and DD_SITE=${site}`,
    ],
  };
}
