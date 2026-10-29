import { AxiError } from "axi-sdk-js";
import { guideSite, setupGuide, US1_FALLBACK_HINT } from "../guide.js";
import { project } from "../render.js";
import { connect, readConfig, type Runtime } from "../runtime.js";
import type { Seam } from "../seam.js";
import { ctxBlock } from "./ctx.js";
import { incidentStateQuery } from "./incidents.js";
import { MONITOR_FIELDS, sortProblemsFirst, statusCounts, type MonitorSearchResponse } from "./monitors.js";

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

export async function homeCommand(rt: Runtime): Promise<Record<string, unknown>> {
  let ctx: Record<string, unknown>;
  try {
    ctx = ctxBlock({}, rt.env, readConfig(rt), rt.configPath);
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
    seam = await connect(rt, { positionals: [], flags: {} });
  } catch (error) {
    return {
      ctx,
      live: `unavailable - ${reason(error)}`,
      help: ["Run `datadog-axi auth status` to check the credentials", "Run `datadog-axi --help` for commands"],
    };
  }

  const [all, problems, incidents] = await Promise.allSettled([
    seam.call<MonitorSearchResponse>("monitors.search", {
      query: { per_page: 1 },
      timeoutMs: HOME_TIMEOUT_MS,
    }),
    seam.call<MonitorSearchResponse>("monitors.search", {
      query: { query: '(status:alert OR status:"no data")', per_page: 5 },
      timeoutMs: HOME_TIMEOUT_MS,
    }),
    seam.call<{ data?: { attributes?: { total?: number } } }>("incidents.search", {
      query: { query: incidentStateQuery(["active", "stable"]), "page[size]": 1 },
      timeoutMs: HOME_TIMEOUT_MS,
    }),
  ]);

  const output: Record<string, unknown> = { ctx };

  if (all.status === "fulfilled") {
    const counts = statusCounts(all.value.data);
    output.monitor_counts = Object.keys(counts).length > 0 ? counts : "0 monitors";
  } else {
    output.monitor_counts = `unavailable - ${reason(all.reason)}`;
  }

  if (problems.status === "fulfilled") {
    const rows = sortProblemsFirst(problems.value.data.monitors ?? []);
    output.alerting =
      rows.length > 0 ? project(rows, MONITOR_FIELDS, MONITOR_FIELDS.defaults) : "0 monitors in alert or no data";
  } else {
    output.alerting = `unavailable - ${reason(problems.reason)}`;
  }

  if (incidents.status === "fulfilled") {
    output.incidents = `${incidents.value.data.data?.attributes?.total ?? 0} open`;
  } else {
    output.incidents = `unavailable - ${reason(incidents.reason)}`;
  }

  output.help = [
    "Run `datadog-axi monitors --status alert` for every alerting monitor",
    "Run `datadog-axi monitors view <id>` for a monitor's query and failing groups",
    'Run `datadog-axi logs aggregate "status:error" --by service` to see where errors come from',
    "Run `datadog-axi --help` for every command",
  ];
  return output;
}
