import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configPath } from "../src/config.js";
import { lastSession, recordSessionEnd } from "../src/sessions.js";

const historyPath = (env: NodeJS.ProcessEnv) => configPath(env).replace("config.json", "sessions.json");

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
        JSON.stringify({ type: "tool_use", input: { command: "datadog-axi monitors --query 'error:datadog-axi logs'" } }),
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
    const cli = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin/datadog-axi.js");
    const run = (cwd: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, "context", "end"], {
          cwd,
          env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
          stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
        child.stdin?.end(JSON.stringify({ transcript_path: transcript }));
      });
    const first = join(home, "first");
    const second = join(home, "second");
    mkdirSync(first);
    mkdirSync(second);
    await Promise.all([run(first), run(second)]);
    expect(lastSession({ HOME: home }, first)?.commands.monitors).toBe(1);
    expect(lastSession({ HOME: home }, second)?.commands.monitors).toBe(1);
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
