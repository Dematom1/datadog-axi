import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { AxiError, fetchLatestVersion, isUpdateAvailable, runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import {
  defaultProbe,
  detectInstallMethod,
  installedVersion,
  planUpgrade,
  realRunningPath,
  writableMethod,
  type ExecProbe,
  type UpdateProbe,
} from "./update-manager.js";
import { API_HELP, apiCommand } from "./commands/api.js";
import { AUTH_HELP, authCommand } from "./commands/auth.js";
import { CTX_HELP, ctxCommand } from "./commands/ctx.js";
import { DASHBOARDS_HELP, dashboardsCommand } from "./commands/dashboards.js";
import { DOCTOR_HELP, doctorCommand } from "./commands/doctor.js";
import { DOWNTIMES_HELP, downtimesCommand } from "./commands/downtimes.js";
import { EVENTS_HELP, eventsCommand } from "./commands/events.js";
import { homeCommand } from "./commands/home.js";
import { HOSTS_HELP, hostsCommand } from "./commands/hosts.js";
import { INCIDENTS_HELP, incidentsCommand } from "./commands/incidents.js";
import { LOGS_HELP, logsCommand } from "./commands/logs.js";
import { METRICS_HELP, metricsCommand } from "./commands/metrics.js";
import { MONITORS_HELP, MONITORS_VIEW_HELP, monitorsCommand } from "./commands/monitors.js";
import { NOTEBOOKS_HELP, notebooksCommand } from "./commands/notebooks.js";
import { SERVICES_HELP, servicesCommand } from "./commands/services.js";
import { SETUP_HELP, setupCommand } from "./commands/setup.js";
import { SLOS_HELP, slosCommand } from "./commands/slos.js";
import { SYNTHETICS_HELP, syntheticsCommand } from "./commands/synthetics.js";
import { TRACES_HELP, tracesCommand } from "./commands/traces.js";
import { formatError, renderResult } from "./output.js";
import { defaultRuntime, type Runtime } from "./runtime.js";
import { VERSION } from "./version.js";
import { contextEndCommand } from "./sessions.js";

const execFileAsync = promisify(execFile);

export const DESCRIPTION =
  "Read-first Datadog for agents: monitors, logs, metrics, traces, incidents and more as compact TOON, straight from the Datadog API";

export const TOP_HELP = `usage: datadog-axi <command> [args] [flags]
commands[19]:
  (none)=home, monitors, logs, metrics, traces, services, dashboards, incidents, events, hosts, slos, downtimes, synthetics, notebooks, api, auth, doctor, ctx, setup
summary[19]:
  (none): Live home view - org, site, monitor counts, alerting monitors, open incidents
  monitors: Search monitors (problems first, status counts) and view one
  logs: Search log events, count them by facet, view one event
  metrics: Query timeseries as per-series summaries; browse names, metadata, tags
  traces: Search APM spans; view a trace as a span tree
  services: Service ownership and links from the service catalog
  dashboards: List dashboards; view widget titles and queries
  incidents: List open incidents; view one
  events: List events by tag and priority; search events
  hosts: List hosts with up and muted state
  slos: List SLOs; view one; current SLI vs target
  downtimes: List downtimes that silence monitors
  synthetics: List synthetic tests; view one; latest results
  notebooks: List notebooks; read one cell by cell
  api: Call an allowlisted read-only API endpoint directly
  auth: Credential setup guide (pup login or keys); store, check, list and remove credentials (OS keychain per org)
  doctor: Keys, site reachability, readable domains, rate limits, write capability
  ctx: Offline org, site and credential source (what the session hook prints)
  setup: Install agent SessionStart hooks
flags[6]:
  --org <name>: Stored org to use (default: env credentials, then the current org)
  --site <site>: Datadog site, e.g. datadoghq.eu or EU1; must match the org's pinned site
  --from <time>, --to <time>: Window: 15m, 1h, 7d, now-1h, RFC3339, epoch s/ms (default: last hour)
  --limit <n>: Max rows
  --fields <a,b>: Extra columns on list commands
  --full: Untruncated detail output
notes[4]:
  Read-only: v1 sends no writes; write-like requests are refused with a reason
  Queries are Datadog query strings, passed through unchanged
  Sensitive-looking fields are redacted (best effort, no reveal flag)
  Flags go after the command; each command rejects flags it does not know
examples[4]:
  datadog-axi
  datadog-axi monitors --status alert
  datadog-axi logs search "service:checkout status:error" --from 15m
  datadog-axi metrics query "avg:system.cpu.user{env:prod} by {host}"
`;

export const COMMAND_HELP: Record<string, string> = {
  monitors: MONITORS_HELP,
  logs: LOGS_HELP,
  metrics: METRICS_HELP,
  traces: TRACES_HELP,
  services: SERVICES_HELP,
  dashboards: DASHBOARDS_HELP,
  incidents: INCIDENTS_HELP,
  events: EVENTS_HELP,
  hosts: HOSTS_HELP,
  slos: SLOS_HELP,
  downtimes: DOWNTIMES_HELP,
  synthetics: SYNTHETICS_HELP,
  notebooks: NOTEBOOKS_HELP,
  api: API_HELP,
  auth: AUTH_HELP,
  doctor: DOCTOR_HELP,
  ctx: CTX_HELP,
  setup: SETUP_HELP,
};

type Handler = (args: string[], rt: Runtime) => Promise<Record<string, unknown> | string>;

const HANDLERS: Record<string, Handler> = {
  home: (args, rt) => homeCommand(rt, args),
  monitors: monitorsCommand,
  logs: logsCommand,
  metrics: metricsCommand,
  traces: tracesCommand,
  services: servicesCommand,
  dashboards: dashboardsCommand,
  incidents: incidentsCommand,
  events: eventsCommand,
  hosts: hostsCommand,
  slos: slosCommand,
  downtimes: downtimesCommand,
  synthetics: syntheticsCommand,
  notebooks: notebooksCommand,
  api: apiCommand,
  auth: authCommand,
  doctor: doctorCommand,
  ctx: ctxCommand,
  setup: (args) => setupCommand(args),
};

export interface MainOptions {
  argv?: string[];
  runtime?: Runtime;
  stdout?: { write: (chunk: string) => unknown };
}

export type UpdateCommandDependencies = {
  packageName?: string;
  entry?: string;
  env?: NodeJS.ProcessEnv;
  fs?: UpdateProbe;
  exec?: ExecProbe;
  fetchLatest?: (name: string) => Promise<string>;
  execute?: (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>;
};

export async function updateCommand(
  args: string[],
  dependencies: UpdateCommandDependencies = {},
): Promise<Record<string, unknown>> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw new AxiError("Use update [--check]", "VALIDATION_ERROR");
  const packageName = dependencies.packageName ?? "datadog-axi";
  const env = dependencies.env ?? process.env;
  const fs = dependencies.fs ?? defaultProbe;
  const runningEntry = dependencies.entry ?? process.argv[1] ?? "";
  const realPath = realRunningPath(runningEntry, fs);
  const detected = await detectInstallMethod(realPath, packageName, { env, fs, exec: dependencies.exec });
  const method = writableMethod(detected, realPath, packageName, fs);
  const plan = planUpgrade(method, packageName);
  const latest = await (dependencies.fetchLatest ?? fetchLatestVersion)(packageName);
  const available = isUpdateAvailable(VERSION, latest);
  const update = { package: packageName, current: VERSION, latest, available, manager: plan.manager, path: realPath };
  if (args[0] === "--check")
    return { update, ...(available ? { help: [plan.command ? `Run ${plan.note} to upgrade` : plan.note] } : {}) };
  if (!available)
    return { update: { ...update, action: "current", note: `${packageName} is already on the latest version` } };
  if (!plan.command || !plan.argv) return { update: { ...update, action: "manual", note: plan.note } };
  try {
    const commandEnv =
      method.kind === "node-version-manager" ? { ...env, PATH: `${dirname(method.npm)}:${env.PATH ?? ""}` } : env;
    if (dependencies.execute) await dependencies.execute(plan.command, plan.argv, commandEnv);
    else await execFileAsync(plan.command, plan.argv, { encoding: "utf8", env: commandEnv });
  } catch (error) {
    throw new AxiError(
      `${plan.manager} update failed: ${error instanceof Error ? error.message : String(error)}`,
      "UPDATE_ERROR",
    );
  }
  const installedPath = fs.realpath(runningEntry) ?? realPath;
  const version = installedVersion(installedPath, packageName, fs);
  if (!version || isUpdateAvailable(version, latest))
    throw new AxiError(
      `Installer reported success but ${installedPath} is still ${version ?? "unreadable"}; another copy may shadow it`,
      "UPDATE_ERROR",
    );
  return { update: { ...update, action: "upgraded", current: latest } };
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  if (argv[0] === "context" && argv[1] === "end") {
    (options.stdout ?? process.stdout).write(await contextEndCommand());
    return;
  }
  if (argv[0] === "monitors" && argv[1] === "view" && argv.includes("--help")) {
    (options.stdout ?? process.stdout).write(MONITORS_VIEW_HELP);
    return;
  }

  const commands: Record<string, AxiCliCommand<Runtime>> = {};
  for (const [name, handler] of Object.entries(HANDLERS)) {
    commands[name] = async (args, rt) => renderResult(await handler(args, rt as Runtime));
  }
  commands.update = async (args) => renderResult(await updateCommand(args));

  await runAxiCli<Runtime>({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    stdout: options.stdout,
    topLevelHelp: TOP_HELP,
    commands,
    home: async (_args, rt) => renderResult(await homeCommand(rt as Runtime)),
    getCommandHelp: (command) => COMMAND_HELP[command],
    resolveContext: () => options.runtime ?? defaultRuntime(),
    formatError,
  });
}
