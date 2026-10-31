import { AxiError } from "axi-sdk-js";
import { parseArgs, TARGET_FLAGS, str } from "../args.js";
import { guideSite, setupGuide, US1_FALLBACK_HINT } from "../guide.js";
import { project, targetSuffix } from "../render.js";
import { connect, readConfig, type Runtime } from "../runtime.js";
import type { Seam } from "../seam.js";
import { ctxBlock } from "./ctx.js";
import { incidentStateQuery } from "./incidents.js";
import { MONITOR_FIELDS, parseMonitorSearchResponse, sortProblemsFirst, statusCounts } from "./monitors.js";

/**
 * The no-argument home view (D-c1, S17). It starts with the same offline ctx
 * block the session hook prints, then adds live state: monitor counts by
 * status, up to 5 alerting or no-data monitors, and the open (active or
 * stable) incident count. Each live part degrades to `unavailable - <reason>` with exit 0
 * under a short timeout, so the home view never fails.
 */

export const HOME_TIMEOUT_MS = 8_000;

function reason(error: unknown): string {
  if (error instanceof AxiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function homeCommand(rt: Runtime, args: string[] = []): Promise<Record<string, unknown>> {
  const parsed = parseArgs({ name: "home", flags: TARGET_FLAGS }, args);
  let ctx: Record<string, unknown>;
  try {
    ctx = ctxBlock({ org: str(parsed, "--org"), site: str(parsed, "--site") }, rt.env, readConfig(rt), rt.configPath);
  } catch (error) {
    return {
      ctx: `unavailable - ${reason(error)}`,
      help: ["Run `datadog-axi ctx` for details", "Run `datadog-axi --help` for commands"],
    };
  }

  if (ctx.credentials === "none configured") {
    // Cannot throw here: ctxBlock above already rejected an unknown DD_SITE.
    const target = guideSite(undefined, rt.env);
    const { data, steps } = setupGuide(target.site);
    return {
      ctx,
      live: "unavailable - no credentials configured",
      setup: data,
      help: [
        "Show the user these setup steps; a human creates and stores the keys, an agent never handles key values",
        ...steps,
        ...(target.explicit ? [] : [US1_FALLBACK_HINT]),
        "Run `datadog-axi --help` for commands",
      ],
    };
  }

  let seam: Seam;
  try {
    seam = await connect(rt, parsed);
  } catch (error) {
    return {
      ctx,
      live: `unavailable - ${reason(error)}`,
      help: [
        ...(error instanceof AxiError ? error.suggestions : []),
        "Run `datadog-axi auth status` to check the credentials",
        "Run `datadog-axi --help` for commands",
      ],
    };
  }

  const [all, problems, incidents] = await Promise.allSettled([
    seam.call<unknown>("monitors.search", {
      query: { per_page: 1 },
      timeoutMs: HOME_TIMEOUT_MS,
    }),
    seam.call<unknown>("monitors.search", {
      query: { query: '(status:alert OR status:"no data")', per_page: 5 },
      timeoutMs: HOME_TIMEOUT_MS,
    }),
    seam.call<unknown>("incidents.search", {
      query: { query: incidentStateQuery(["active", "stable"]), "page[size]": 1 },
      timeoutMs: HOME_TIMEOUT_MS,
    }),
  ]);

  const output: Record<string, unknown> = { ctx };

  if (all.status === "fulfilled") {
    try {
      const data = parseMonitorSearchResponse(all.value.data);
      if (!Array.isArray(data.counts?.status)) {
        throw new AxiError("Datadog omitted monitor status counts", "UPSTREAM_ERROR");
      }
      const counts = statusCounts(data);
      output.monitor_counts = Object.keys(counts).length > 0 ? counts : "0 monitors";
    } catch (error) {
      output.monitor_counts = `unavailable - ${reason(error)}`;
    }
  } else {
    output.monitor_counts = `unavailable - ${reason(all.reason)}`;
  }

  if (problems.status === "fulfilled") {
    try {
      const data = parseMonitorSearchResponse(problems.value.data);
      const rows = sortProblemsFirst(data.monitors);
      output.alerting =
        rows.length > 0 ? project(rows, MONITOR_FIELDS, MONITOR_FIELDS.defaults) : "0 monitors in alert or no data";
    } catch (error) {
      output.alerting = `unavailable - ${reason(error)}`;
    }
  } else {
    output.alerting = `unavailable - ${reason(problems.reason)}`;
  }

  if (incidents.status === "fulfilled") {
    const response: unknown = incidents.value.data;
    const total =
      response && typeof response === "object" && "data" in response && response.data && typeof response.data === "object" &&
      "attributes" in response.data && response.data.attributes && typeof response.data.attributes === "object" &&
      "total" in response.data.attributes
        ? response.data.attributes.total
        : undefined;
    output.incidents = typeof total === "number" && Number.isFinite(total) ? `${total} open` : "unavailable - total unknown";
  } else {
    output.incidents = `unavailable - ${reason(incidents.reason)}`;
  }

  const target = targetSuffix(seam.target);
  output.help = [
    `Run \`datadog-axi monitors --status alert${target}\` for every alerting monitor`,
    `Run \`datadog-axi monitors view <id>${target}\` for a monitor's query and failing groups`,
    `Run \`datadog-axi logs aggregate "status:error" --by service${target}\` to see where errors come from`,
    "Run `datadog-axi --help` for every command",
  ];
  return output;
}
