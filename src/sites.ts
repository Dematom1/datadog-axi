import { AxiError } from "axi-sdk-js";

/**
 * Datadog sites. Each site is fully independent: the same query against the
 * wrong site silently returns nothing, so a site is always explicit in output.
 * Only these hosts ever receive credentials.
 */
export const SITES: ReadonlyArray<{ site: string; region: string }> = [
  { site: "datadoghq.com", region: "US1" },
  { site: "us3.datadoghq.com", region: "US3" },
  { site: "us5.datadoghq.com", region: "US5" },
  { site: "datadoghq.eu", region: "EU1" },
  { site: "ap1.datadoghq.com", region: "AP1" },
  { site: "ap2.datadoghq.com", region: "AP2" },
  { site: "uk1.datadoghq.com", region: "UK1" },
  { site: "ddog-gov.com", region: "US1-FED" },
  { site: "us2.ddog-gov.com", region: "US2-FED" },
];

export const DEFAULT_SITE = "datadoghq.com";

const VALID_SITES_HINT = `Valid sites: ${SITES.map((s) => `${s.site} (${s.region})`).join(", ")}`;

/**
 * Normalize a user-supplied site: accepts the site host (`datadoghq.eu`), the
 * region name (`EU1`), or a pasted `https://app.datadoghq.eu` URL.
 */
export function normalizeSite(input: string): string {
  const raw = input.trim().toLowerCase();
  const byRegion = SITES.find((s) => s.region.toLowerCase() === raw);
  if (byRegion) {
    return byRegion.site;
  }

  const host = raw
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^(app|api)\./, "");
  const bySite = SITES.find((s) => s.site === host);
  if (bySite) {
    return bySite.site;
  }

  throw new AxiError(`Unknown Datadog site: ${input}`, "VALIDATION_ERROR", [VALID_SITES_HINT]);
}

export function regionOf(site: string): string {
  return SITES.find((s) => s.site === site)?.region ?? "unknown";
}

export function apiBaseUrl(site: string): string {
  return `https://api.${site}`;
}

export function appBaseUrl(site: string): string {
  return `https://app.${site}`;
}
