import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { configPath } from "./config.js";
import { renderResult } from "./output.js";

const MAX_DIRECTORIES = 100;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
type Summary = { ended: string; commands: Record<string, number>; site?: string };

function sessionsPath(env: NodeJS.ProcessEnv): string {
  return configPath(env).replace(/config\.json$/, "sessions.json");
}

function commandInvocations(line: string): { command: string; site?: string }[] {
  const commands: { value: string; quoted: boolean }[][] = [[]];
  let token = "";
  let quote = "";
  let quoted = false;
  let escaped = false;
  const pushToken = () => {
    if (token) commands[commands.length - 1].push({ value: token, quoted });
    token = "";
    quoted = false;
  };
  for (const char of line) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    }
    else if (/[;&|]/.test(char)) {
      pushToken();
      if (commands[commands.length - 1].length) commands.push([]);
    } else if (/\s/.test(char)) pushToken();
    else token += char;
  }
  pushToken();
  return commands.flatMap((parts) => {
    const executable = parts[0]?.value.split("/").at(-1);
    if (executable !== "datadog-axi") return [];
    const siteIndex = parts.findIndex((part, index) => index > 0 && !part.quoted && part.value === "--site");
    const siteArg = siteIndex < 0 ? undefined : parts[siteIndex + 1]?.value;
    const site = siteArg && /^[A-Za-z0-9.-]+$/.test(siteArg) ? siteArg : undefined;
    const inlineSite = parts.slice(1).find((part) => !part.quoted && part.value.startsWith("--site="))?.value.slice(7);
    const selectedSite = site ?? (inlineSite && /^[A-Za-z0-9.-]+$/.test(inlineSite) ? inlineSite : undefined);
    const subcommand = parts[1]?.value;
    return [{
      command: subcommand && /^[a-z][a-z-]*$/.test(subcommand) ? subcommand : "home",
      ...(selectedSite ? { site: selectedSite } : {}),
    }];
  });
}

function invocations(value: unknown): { command: string; site?: string }[] {
  if (Array.isArray(value)) return value.flatMap(invocations);
  if (value === null || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if (item.type === "tool_use") {
    const input = item.input;
    if (input && typeof input === "object" && typeof (input as Record<string, unknown>).command === "string") {
      return commandInvocations((input as Record<string, string>).command);
    }
    return [];
  }
  return ["message", "content"].flatMap((key) => invocations(item[key]));
}

export async function recordSessionEnd(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<void> {
  const transcript =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>).transcript_path : undefined;
  if (typeof transcript !== "string") return;
  try {
    if (!existsSync(transcript) || statSync(transcript).size > MAX_TRANSCRIPT_BYTES) return;
  } catch {
    return;
  }
  const counts: Record<string, number> = {};
  const sites: Record<string, number> = {};
  const lines = createInterface({ input: createReadStream(transcript, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes("datadog-axi")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      for (const invocation of invocations(parsed)) {
        counts[invocation.command] = (counts[invocation.command] ?? 0) + 1;
        if (invocation.site) sites[invocation.site] = (sites[invocation.site] ?? 0) + 1;
      }
    } catch {
      /* Ignore incomplete transcript lines. */
    }
  }
  if (Object.keys(counts).length === 0) return;
  const site = Object.entries(sites).sort((a, b) => b[1] - a[1])[0]?.[0];
  const path = sessionsPath(env);
  let directories: Record<string, Summary> = {};
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data) && "directories" in data) {
      const candidate = (data as { directories: unknown }).directories;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
        directories = candidate as Record<string, Summary>;
    }
  } catch {
    /* A missing or corrupt history is an empty history. */
  }
  delete directories[cwd];
  directories[cwd] = { ended: new Date().toISOString(), commands: counts, ...(site ? { site } : {}) };
  for (const old of Object.keys(directories).slice(0, Math.max(0, Object.keys(directories).length - MAX_DIRECTORIES)))
    delete directories[old];
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ directories }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function lastSession(env: NodeJS.ProcessEnv, cwd = process.cwd()): Summary | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionsPath(env), "utf8"));
    if (!parsed || typeof parsed !== "object" || !("directories" in parsed)) return undefined;
    const value = (parsed as { directories: Record<string, unknown> }).directories[cwd];
    if (!value || typeof value !== "object" || !("commands" in value)) return undefined;
    return value as Summary;
  } catch {
    return undefined;
  }
}

export async function contextEndCommand(): Promise<string> {
  let payload: unknown;
  try {
    payload = JSON.parse(
      await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }),
    );
  } catch {
    return "";
  }
  await recordSessionEnd(payload);
  return `${renderResult({ status: "recorded" })}\n`;
}
