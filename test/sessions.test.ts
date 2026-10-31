import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configPath } from "../src/config.js";
import { lastSession, recordSessionEnd, releaseLock } from "../src/sessions.js";
import { setupCommand } from "../src/commands/setup.js";

const historyPath = (env: NodeJS.ProcessEnv) => configPath(env).replace("config.json", "sessions.json");
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin/datadog-axi.js");

function runContextEnd(cwd: string, home: string, transcript: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "context", "end"], {
      cwd,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin?.end(JSON.stringify({ transcript_path: transcript }));
  });
}

describe("session memory", () => {
  it("stores command names and counts without transcript arguments or secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "datadog-axi-session-"));
    const env = { HOME: home };
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "tool_use",
          input: { command: "datadog-axi monitors --site datadoghq.eu --api-key TOP_SECRET" },
        }),
        JSON.stringify({ type: "tool_use", input: { command: "datadog-axi monitors view 123 --query PRIVATE_QUERY" } }),
        JSON.stringify({
          type: "tool_use",
          input: { command: "datadog-axi monitors --query 'error:datadog-axi logs'" },
        }),
        JSON.stringify({ type: "tool_use", input: { command: "datadog-axi monitors --query '--site evil.example'" } }),
      ].join("\n"),
    );
    await recordSessionEnd({ transcript_path: transcript }, env, "/work/project");
    const file = readFileSync(historyPath(env), "utf8");
    expect(lastSession(env, "/work/project")).toMatchObject({ commands: { monitors: 4 }, site: "datadoghq.eu" });
    expect(lastSession(env, "/work/project")?.commands.logs).toBeUndefined();
    expect(file).not.toContain("TOP_SECRET");
    expect(file).not.toContain("PRIVATE_QUERY");
    expect(statSync(historyPath(env)).mode & 0o777).toBe(0o600);
  });

  it("preserves records from concurrent SessionEnd processes", async () => {
    const home = mkdtempSync(join(tmpdir(), "datadog-axi-session-"));
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "tool_use", input: { command: "datadog-axi monitors" } }));
    const run = (cwd: string) =>
      runContextEnd(cwd, home, transcript).then((code) => {
        if (code !== 0) throw new Error(`context end exited ${code}`);
      });
    const first = join(home, "first");
    const second = join(home, "second");
    mkdirSync(first);
    mkdirSync(second);
    await Promise.all([run(first), run(second)]);
    expect(lastSession({ HOME: home }, first)?.commands.monitors).toBe(1);
    expect(lastSession({ HOME: home }, second)?.commands.monitors).toBe(1);
  });

  it("does not reclaim an old lock held by a live process", async () => {
    const home = mkdtempSync(join(tmpdir(), "datadog-axi-session-"));
    const transcript = join(home, "transcript.jsonl");
    const path = historyPath({ HOME: home });
    mkdirSync(join(home, ".config", "datadog-axi"), { recursive: true });
    writeFileSync(transcript, JSON.stringify({ type: "tool_use", input: { command: "datadog-axi monitors" } }));
    const lock = `${path}.lock`;
    const token = `${process.pid}:live-owner`;
    writeFileSync(lock, token);
    const stale = new Date(Date.now() - 31_000);
    utimesSync(lock, stale, stale);
    const cwd = join(home, "project");
    mkdirSync(cwd);
    expect(await runContextEnd(cwd, home, transcript)).toBe(0);
    expect(readFileSync(lock, "utf8")).toBe(token);
    expect(existsSync(path)).toBe(false);
  });

  it("reclaims an old lock held by a dead process", async () => {
    const home = mkdtempSync(join(tmpdir(), "datadog-axi-session-"));
    const transcript = join(home, "transcript.jsonl");
    const env = { HOME: home };
    const path = historyPath(env);
    mkdirSync(join(home, ".config", "datadog-axi"), { recursive: true });
    writeFileSync(transcript, JSON.stringify({ type: "tool_use", input: { command: "datadog-axi monitors" } }));
    const lock = `${path}.lock`;
    writeFileSync(lock, "2147483647:dead-owner");
    const stale = new Date(Date.now() - 31_000);
    utimesSync(lock, stale, stale);
    await recordSessionEnd({ transcript_path: transcript }, env, "/work/project");
    expect(lastSession(env, "/work/project")?.commands.monitors).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("does not remove a successor lock on release", () => {
    const home = mkdtempSync(join(tmpdir(), "datadog-axi-session-"));
    const lock = join(home, "sessions.json.lock");
    writeFileSync(lock, "successor:owner");
    releaseLock(lock, "original:owner");
    expect(readFileSync(lock, "utf8")).toBe("successor:owner");
  });

  it("preserves unrecognized SessionEnd groups on uninstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "datadog-axi-setup-"));
    const path = join(home, ".claude", "settings.json");
    mkdirSync(dirname(path), { recursive: true });
    const hookPath = join(dirname(fileURLToPath(import.meta.url)), "../bin/datadog-axi.ts");
    const command = `'${hookPath.replace(/'/g, "'\\''")}' context end`;
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              matcher: "",
              hooks: [
                { type: "command", command },
                { type: "command", command: "other-tool context end" },
              ],
            },
            { matcher: "other", hooks: "preserve-this-group" },
          ],
        },
      }),
    );
    const oldHome = process.env.HOME;
    const oldClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    try {
      await setupCommand(["uninstall"]);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = oldClaudeConfig;
    }
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "other-tool context end" }] },
          { matcher: "other", hooks: "preserve-this-group" },
        ],
      },
    });
  });

  it("treats corrupt session history as absent", () => {
    const home = mkdtempSync(join(tmpdir(), "datadog-axi-session-"));
    const env = { HOME: home };
    const path = historyPath(env);
    mkdirSync(join(home, ".config", "datadog-axi"), { recursive: true });
    writeFileSync(path, "broken");
    expect(lastSession(env, "/work/project")).toBeUndefined();
  });
});
