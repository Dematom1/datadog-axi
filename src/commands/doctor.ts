import { AxiError } from "axi-sdk-js";
import { parseArgs, TARGET_FLAGS, type CommandSpec } from "../args.js";
import { deniedScopes, guideCommand } from "../guide.js";
import { renderHelp } from "../help.js";
import { PROBE_TIMEOUT_MS, probeDomains, validateKeys } from "../probe.js";
import { withHelp } from "../render.js";
import { connect, type Runtime } from "../runtime.js";
import type { Seam } from "../seam.js";
import { regionOf } from "../sites.js";
import { WRITES_STATUS } from "./ctx.js";

const SPEC: CommandSpec = { name: "doctor", flags: { ...TARGET_FLAGS } };

export const DOCTOR_HELP = renderHelp({
  command: "doctor",
  description:
    "Check key validity, site reachability, readable domains, rate-limit headroom and whether the key could write",
  subcommands: [{ spec: SPEC, summary: "Read-only diagnostics; about a dozen one-item reads" }],
  examples: ["datadog-axi doctor", "datadog-axi doctor --org prod"],
});

const READ_SCOPE = /(^|_)read(_|$)|_query$|^logs_live_tail$/;
const WRITE_SCOPE = /(^|_)(write|manage|modify|delete|create|share|generate|downtime)(_|$)/;

interface AppKey {
  attributes?: { last4?: string; name?: string; scopes?: string[] | null };
}

/**
 * Whether the credential could write, without writing: the current user's
 * application keys are listed (names, last four characters and scopes only;
 * never key values) and matched by the last four characters of the key in use.
 */
export async function writeCapability(seam: Seam): Promise<string> {
  const auth = seam.target.auth;
  if (auth.kind === "bearer") {
    return seam.target.scopes !== undefined
      ? classifyScopes(seam.target.scopes, "the token")
      : "unknown - bearer tokens carry their own scopes; check them where the token was issued";
  }
  try {
    const { data } = await seam.call<{ data?: AppKey[] }>("auth.current_user_app_keys", {
      query: { "page[size]": 100 },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const last4 = auth.appKey.slice(-4);
    const key = (data.data ?? []).find((k) => k.attributes?.last4 === last4);
    if (!key) {
      return "unknown - the application key is not one of this user's keys (it may belong to a service account)";
    }
    return classifyScopes(key.attributes?.scopes ?? [], "the application key");
  } catch (error) {
    const code = error instanceof AxiError ? error.code : "UNKNOWN";
    return `unknown - could not list the user's application keys (${code})`;
  }
}

function classifyScopes(scopes: readonly string[], what: string): string {
  if (scopes.length === 0) {
    return `likely yes - ${what} is unscoped, so it has every permission of its user`;
  }
  const writes = scopes.filter((s) => WRITE_SCOPE.test(s));
  if (writes.length > 0) {
    return `yes - write scopes: ${writes.join(", ")}`;
  }
  const unknown = scopes.filter((s) => !READ_SCOPE.test(s));
  return unknown.length > 0
    ? `unknown - unrecognized scopes: ${unknown.join(", ")}`
    : `no - every scope is read-only (${scopes.join(", ")})`;
}

export async function doctorCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const parsed = parseArgs(SPEC, args);
  const seam = await connect(rt, parsed);
  const [keys, domains, couldWrite] = await Promise.all([
    validateKeys(seam),
    probeDomains(seam, rt.now()),
    writeCapability(seam),
  ]);

  const limits = domains
    .filter((d) => d.rateLimit && d.rateLimit.limit !== undefined)
    .map((d) => ({
      domain: d.domain,
      limit_name: d.rateLimit?.name ?? null,
      remaining: d.rateLimit?.remaining ?? null,
      limit: d.rateLimit?.limit ?? null,
      reset_seconds: d.rateLimit?.resetSeconds ?? null,
    }));
  const denied = domains.filter((d) => d.readable === "no").map((d) => d.domain);
  const errored = domains.filter((d) => d.readable === "error").map((d) => `${d.domain} (${d.detail})`);

  return withHelp(
    {
      target: {
        org: seam.target.org,
        site: `${seam.target.site} (${regionOf(seam.target.site)})`,
        credentials: seam.target.credentials,
        writes: WRITES_STATUS,
      },
      keys,
      could_write: couldWrite,
      domains: domains.map(({ domain, readable, detail }) => ({ domain, readable, detail })),
      rate_limits: limits.length > 0 ? limits : "no rate-limit headers returned",
    },
    [
      ...(keys.site_reachable === "no"
        ? ["Check network access to the site; a wrong site also looks like no data"]
        : []),
      ...(denied.length > 0
        ? [
            `Denied: ${denied.join(", ")}; the key's scopes or user role do not cover them`,
            `Scopes that would allow them: ${deniedScopes(denied)}`,
            `Run \`${guideCommand(seam.target.site)}\` for where to edit the key's scopes`,
          ]
        : []),
      ...(errored.length > 0 ? [`Errored probes: ${errored.join(", ")}; re-run doctor to see if they persist`] : []),
    ],
  );
}
