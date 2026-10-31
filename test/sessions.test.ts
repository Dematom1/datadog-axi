import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      ].join("\n"),
    );
    await recordSessionEnd({ transcript_path: transcript }, env, "/work/project");
    const file = readFileSync(historyPath(env), "utf8");
    expect(lastSession(env, "/work/project")).toMatchObject({ commands: { monitors: 2 }, site: "datadoghq.eu" });
    expect(file).not.toContain("TOP_SECRET");
    expect(file).not.toContain("PRIVATE_QUERY");
    expect(statSync(historyPath(env)).mode & 0o777).toBe(0o600);
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
