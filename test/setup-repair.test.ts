import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type Settings = { hooks: Record<string, { hooks: { command: string }[] }[]> };
const readSettings = (path: string): Settings => JSON.parse(readFileSync(path, "utf8"));

describe("setup repair", () => {
  for (const action of ["hooks", "uninstall"]) {
    it(`returns an actionable structured error when ${action} cannot parse Codex settings`, () => {
      const home = mkdtempSync(join(tmpdir(), "datadog-axi-error-"));
      try {
        mkdirSync(join(home, ".codex"));
        writeFileSync(join(home, ".codex", "hooks.json"), "{");
        const result = spawnSync(process.execPath, [join(root, "dist/bin/datadog-axi.js"), "setup", action], {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            CODEX_HOME: join(home, ".codex"),
            XDG_CONFIG_HOME: join(home, ".config"),
          },
          encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toBe("");
        expect(decode(result.stdout)).toMatchObject({
          code: "SETUP_FAILED",
          help: [expect.stringContaining(`datadog-axi setup ${action}`)],
        });
        expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toBe("{");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
  for (const project of [false, true]) {
    it(`repairs duplicates and executable paths, then removes only its own ${project ? "project" : "user"} hooks`, () => {
      const scratch = mkdtempSync(join(tmpdir(), "datadog-axi-repair-"));
      try {
        const relocated = join(scratch, "datadog-axi space ' quote \" $ `");
        cpSync(join(root, "dist"), join(relocated, "dist"), { recursive: true });
        writeFileSync(join(relocated, "package.json"), '{"type":"module"}');
        symlinkSync(join(root, "node_modules"), join(relocated, "node_modules"), "dir");
        const home = join(scratch, "home");
        const cwd = join(scratch, "project");
        mkdirSync(home);
        mkdirSync(cwd);
        const env = {
          ...process.env,
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          CODEX_HOME: join(home, ".codex"),
          XDG_CONFIG_HOME: join(home, ".config"),
          DD_API_KEY: "",
          DD_APP_KEY: "",
        };
        const base = project ? cwd : home;
        const paths = [join(base, ".claude", "settings.json"), join(base, ".codex", "hooks.json")];
        const foreign = { command: "other-tool --context" };
        const foreignSessionEnd = { command: "my-datadog-axi-audit" };
        for (const path of paths) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(
            path,
            JSON.stringify({
              hooks: {
                SessionStart: [
                  { hooks: [foreign, { command: "datadog-axi-ctx" }, { command: "/old/datadog-axi-ctx" }] },
                ],
                ...(path === paths[0]
                  ? {
                      SessionEnd: [
                        {
                          hooks: [
                            foreign,
                            foreignSessionEnd,
                            { command: "datadog-axi context end" },
                            { command: "/old/datadog-axi context end" },
                          ],
                        },
                      ],
                    }
                  : {}),
              },
            }),
          );
        }
        const cli = join(relocated, "dist", "bin", "datadog-axi.js");
        const setup = (action: string) =>
          execFileSync(process.execPath, [cli, "setup", action, ...(project ? ["--project"] : [])], {
            cwd,
            env,
            encoding: "utf8",
          });
        setup("hooks");
        setup("hooks");
        for (const path of paths) {
          for (const groups of Object.values(readSettings(path).hooks)) {
            const commands = groups.flatMap((group) => group.hooks);
            expect(commands).toContainEqual(foreign);
            if (path === paths[0]) expect(commands).toContainEqual(foreignSessionEnd);
            const managed = commands.filter((hook) => hook.command.includes("datadog-axi") && hook !== foreignSessionEnd);
            expect(managed).toHaveLength(1);
            for (const hook of managed) {
              expect(hook.command).toMatch(/^"\//);
              expect(hook.command).not.toContain("/old/");
              // Execute the persisted shell interface, not merely its parsed path.
              const result = spawnSync("/bin/sh", ["-c", hook.command], { cwd, env, input: "{}", encoding: "utf8" });
              expect(result.stderr).toBe("");
              expect(result.status).toBe(0);
            }
          }
        }
        setup("uninstall");
        for (const path of paths) {
          for (const groups of Object.values(readSettings(path).hooks)) {
            expect(groups.flatMap((group) => group.hooks)).toEqual(
              path === paths[0] ? [foreign, foreignSessionEnd] : [foreign],
            );
          }
        }
        const plugin = project
          ? join(cwd, ".opencode", "plugins", "axi-datadog-axi.js")
          : join(home, ".config", "opencode", "plugins", "axi-datadog-axi.js");
        expect(existsSync(plugin)).toBe(false);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
