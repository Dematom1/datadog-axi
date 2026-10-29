import { DESCRIPTION, TOP_HELP } from "./cli.js";

/**
 * The installable agent skill, generated from the same text the CLI prints
 * (its description and top-level help) so it cannot drift. `npm run
 * check:skill` fails CI when the committed SKILL.md is stale.
 */

export const SKILL_DESCRIPTION =
  "Read Datadog through the datadog-axi CLI - monitors, logs, metrics, APM traces, incidents, dashboards, events, hosts, SLOs, downtimes, synthetics, notebooks and allowlisted read-only API calls. " +
  "Use whenever a task needs Datadog data: checking what is alerting, searching or counting logs, querying a metric, finding slow or failing traces, reviewing incidents, or reading a dashboard's queries.";

function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find the commands block in TOP_HELP");
  }
  return (match[1] as string).trimEnd();
}

function extractSummaryBlock(): string {
  const match = TOP_HELP.match(/^(summary\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find the summary block in TOP_HELP");
  }
  return (match[1] as string).trimEnd();
}

export function createSkillMarkdown(): string {
  return `---
name: datadog-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
---

# datadog-axi

${DESCRIPTION}.

You do not need datadog-axi installed globally - invoke it with \`npx -y datadog-axi <command>\`.
If datadog-axi output shows a follow-up command starting with \`datadog-axi\`, run it as \`npx -y datadog-axi ...\` instead.

## Credentials

datadog-axi reads credentials from the environment first: \`DD_API_KEY\` plus \`DD_APP_KEY\` (or \`DD_APPLICATION_KEY\`), or a \`DD_ACCESS_TOKEN\` bearer, with \`DD_SITE\` naming the Datadog site (default \`datadoghq.com\`).
Without them it uses an org stored in the OS keychain, and with nothing else configured it uses the browser login of Pup, Datadog's CLI, when \`pup\` is on PATH (a human runs \`pup auth login\` once; datadog-axi runs \`pup auth token\` itself).
A human stores an org with:

\`\`\`sh
printf '%s\\n%s\\n' "$DD_API_KEY" "$DD_APP_KEY" | npx -y datadog-axi auth login --org <name> --site <site> --api-key-stdin
\`\`\`

Never put keys in command arguments, and never ask the user to paste a key into the conversation.
If a command returns \`AUTH_REQUIRED\`, show the user its help lines (for an expired pup login, \`pup auth refresh\`), or run \`npx -y datadog-axi auth guide --site <site>\` and show the user its steps: the pup login first, keys as the fallback. The user runs the login commands themselves.
Each stored org is pinned to its site; \`WRONG_SITE\` means \`--site\` disagrees with the org's site.

## When to use

Use datadog-axi whenever a task needs Datadog data: what is alerting and why, error logs for a service, log counts by facet, a metric's recent values, slow or failing traces, open incidents, a dashboard's queries, recent deploy events, host state, SLO health, active downtimes, synthetic test results, or a notebook's content.

## Workflow

1. Run \`npx -y datadog-axi\` with no arguments: org, site, monitor counts by status, alerting monitors and open incidents.
2. Drill in command-first: \`monitors --status alert\`, \`monitors view <id>\`, \`logs aggregate "status:error" --by service\`, \`logs search "<query>"\`, \`metrics query "<expr>"\`, \`traces search "<query>"\`.
3. Time windows use \`--from\` / \`--to\`: \`15m\`, \`1h\`, \`7d\`, \`now-1h\`, RFC3339 with a zone, or epoch seconds/milliseconds. The default is the last hour, and every result echoes the absolute UTC window.
4. Queries are Datadog query strings, passed through unchanged (\`service:checkout status:error\`, \`avg:system.cpu.user{env:prod} by {host}\`).
5. Select a stored org with \`--org <name>\` after the command; flags never go before the command.
6. Every response ends with contextual next-step hints under \`help:\` - follow them.

## Commands

\`\`\`
${extractCommandsBlock()}
${extractSummaryBlock()}
\`\`\`

Run \`npx -y datadog-axi --help\` for global flags, or \`npx -y datadog-axi <command> --help\` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient. Lists show a few columns; add more with \`--fields\`. Long text is truncated with its total size; add \`--full\` when the output says so.
- datadog-axi v1 is read-only. Writes and write-like requests (mute, create, delete, post, trigger) are refused with a reason; a human makes those changes in the Datadog UI or with Datadog's official CLI.
- \`api <path>\` reaches allowlisted read-only endpoints that have no dedicated command; \`api --help\` lists them.
- Values under sensitive-looking keys (tokens, passwords, keys) are redacted, and the output says how many. This is best effort: free text such as log messages is not scanned.
- Zero results state the site, window and query. Widen the window or loosen the query before concluding there is no data, and remember a wrong site also looks like no data (\`npx -y datadog-axi ctx\`).
- Span search is limited to 300 requests per hour per org: prefer one well-scoped \`traces search\` over many.
- Nothing streams or follows; re-run a command with a newer \`--from\` to refresh.
`;
}
