import { AxiError } from "axi-sdk-js";
import { describe, expect, it, vi } from "vitest";
import { updateCommand } from "../src/cli.js";
import { formatError } from "../src/output.js";
import { VERSION } from "../src/version.js";
import type { UpdateProbe } from "../src/update-manager.js";
import type { UpdateCommandDependencies } from "../src/cli.js";

function fakeFs(files: Record<string, string>, writable = true): UpdateProbe {
  return {
    exists: (path) => path in files,
    read: (path) => files[path],
    writable: () => writable,
    realpath: (path) => path,
  };
}
const entry = "/tmp/npm/lib/node_modules/datadog-axi/bin/cli.js";
const files = () => ({
  "/tmp/npm/lib/node_modules/datadog-axi/package.json": '{"name":"datadog-axi","version":"0.1.0"}',
});
const packageDbExec = async () => ({ code: 1, stdout: "" });
const deps = (overrides: Partial<UpdateCommandDependencies> = {}) => ({
  entry,
  env: { npm_config_prefix: "/tmp/npm" },
  fs: fakeFs(files()),
  exec: packageDbExec,
  fetchLatest: async () => "1.0.0",
  ...overrides,
});

describe("update command", () => {
  it("validates arguments", async () => {
    await expect(updateCommand(["--force"], deps())).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    } satisfies Partial<AxiError>);
  });

  it("reports manager and real path in --check without executing an installer", async () => {
    const execute = vi.fn();
    const result = await updateCommand(["--check"], deps({ execute }));
    expect(result).toMatchObject({
      update: {
        package: "datadog-axi",
        manager: "npm",
        path: entry,
        current: VERSION,
        latest: "1.0.0",
        available: true,
      },
      help: ["Run npm install -g datadog-axi@latest to upgrade"],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the already-latest result without executing", async () => {
    const execute = vi.fn();
    expect(await updateCommand([], deps({ fetchLatest: async () => VERSION, execute }))).toMatchObject({
      update: { action: "current", available: false },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports Nix as manual and never invokes an installer", async () => {
    const execute = vi.fn();
    const result = await updateCommand(["--check"], deps({ entry: "/nix/store/hash/cli.js", env: {}, execute }));
    expect(result).toMatchObject({
      update: { manager: "nix", path: "/nix/store/hash/cli.js" },
      help: [expect.stringContaining("Nix config/flake and rebuild")],
    });
    expect(execute).not.toHaveBeenCalled();
    const error = await updateCommand([], deps({ entry: "/nix/store/hash/cli.js", env: {}, execute })).catch(
      (error) => error,
    );
    expect(error).toMatchObject({ code: "MANUAL_UPDATE_REQUIRED", action: "manual", manager: "nix" });
    expect(formatError(error)).toMatchObject({ exitCode: 2 });
  });

  it("makes every unsupported update explicit in update and --check output", async () => {
    const project = "/tmp/project";
    const checkout = "/tmp/checkout";
    const rows = [
      { entry: "/nix/store/hash/cli.js", env: {}, manager: "nix" },
      {
        entry: "/tmp/.npm/_npx/hash/node_modules/datadog-axi/bin/cli.js",
        env: {},
        manager: "npx",
      },
      {
        entry: `${project}/node_modules/datadog-axi/bin/cli.js`,
        env: {},
        manager: "project-local",
        fs: fakeFs({ [`${project}/package.json`]: '{"name":"project"}' }),
      },
      {
        entry: `${checkout}/node_modules/datadog-axi/bin/cli.js`,
        env: {},
        manager: "linked",
        fs: fakeFs({
          [`${checkout}/node_modules/datadog-axi/package.json`]: '{"name":"datadog-axi"}',
          [`${checkout}/.git`]: "",
        }),
      },
      {
        entry: "/tmp/npm/lib/node_modules/datadog-axi/bin/cli.js",
        env: { npm_config_prefix: "/tmp/npm" },
        manager: "read-only",
        fs: fakeFs(files(), false),
      },
      {
        entry: "/usr/lib/node_modules/datadog-axi/bin/cli.js",
        env: {},
        manager: "dpkg",
        fs: fakeFs({ "/var/lib/dpkg/status": "" }),
        exec: async () => ({ code: 0, stdout: "datadog-axi: /usr/lib/node_modules/datadog-axi/bin/cli.js\n" }),
      },
      {
        entry: "/home/test/.local/share/mise/installs/npm-10/lib/node_modules/datadog-axi/bin/cli.js",
        env: { HOME: "/home/test" },
        manager: "mise",
      },
      { entry: "/custom/tool/cli.js", env: {}, manager: "unknown" },
    ];

    for (const row of rows) {
      const execute = vi.fn();
      const options = { ...row, execute, fetchLatest: async () => "0.1.8" };
      const check = await updateCommand(["--check"], deps(options));
      expect(check).toMatchObject({
        update: {
          result: "not updated",
          action: "manual",
          manager: row.manager,
          path: row.entry,
          instruction: expect.any(String),
          note: expect.stringContaining("Nothing was updated."),
        },
      });
      const checkText = JSON.stringify(check).toLowerCase();
      expect(checkText).not.toMatch(/successfully|already on the latest|upgraded/);

      const error = await updateCommand([], deps(options)).catch((error) => error);
      expect(error).toMatchObject({
        code: "MANUAL_UPDATE_REQUIRED",
        result: "not updated",
        action: "manual",
        manager: row.manager,
        path: row.entry,
        instruction: expect.any(String),
      });
      const rendered = formatError(error);
      expect(rendered.exitCode).toBe(2);
      expect(rendered.output).toContain("result: not updated");
      expect(rendered.output).toContain("Nothing was updated.");
      expect(rendered.output).toContain(`manager: ${row.manager}`);
      expect(rendered.output).toContain(`path: ${row.entry}`);
      expect(rendered.output).toContain((error as AxiError & { instruction: string }).instruction);
      expect(rendered.output.toLowerCase()).not.toMatch(/successfully|already on the latest|upgraded/);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("reports the resolved real path", async () => {
    const resolved = "/private/tmp/npm/lib/node_modules/datadog-axi/dist/bin/cli.js";
    const fs = {
      ...fakeFs({
        ["/private/tmp/npm/lib/node_modules/datadog-axi/package.json"]: '{"name":"datadog-axi","version":"0.1.0"}',
      }),
      realpath: (path: string) => (path === "/tmp/npm/bin/cli.js" ? resolved : path),
    };
    const result = await updateCommand(
      ["--check"],
      deps({ entry: "/tmp/npm/bin/cli.js", fs, env: { npm_config_prefix: "/private/tmp/npm" } }),
    );
    expect(result).toMatchObject({ update: { manager: "npm", path: resolved } });
  });

  it("runs only the planned installer and verifies the installed version", async () => {
    const state = files();
    const execute = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe("npm");
      expect(args).toEqual(["install", "-g", "datadog-axi@latest"]);
      state["/tmp/npm/lib/node_modules/datadog-axi/package.json"] = '{"name":"datadog-axi","version":"1.0.0"}';
    });
    const result = await updateCommand([], deps({ fs: fakeFs(state), execute }));
    expect(result).toMatchObject({ update: { action: "upgraded", manager: "npm", current: "1.0.0" } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("post-checks the version reached through a retargeted pnpm global link", async () => {
    const entry = "/tmp/pnpm/bin/datadog-axi";
    let target = "/tmp/pnpm/store/v11/links/@/datadog-axi/0.0.1/old/node_modules/datadog-axi/dist/bin/cli.js";
    const packages: Record<string, string> = {
      "/tmp/pnpm/store/v11/links/@/datadog-axi/0.0.1/old/node_modules/datadog-axi/package.json":
        '{"name":"datadog-axi","version":"0.0.1"}',
      "/tmp/pnpm/store/v11/links/@/datadog-axi/0.1.0/new/node_modules/datadog-axi/package.json":
        '{"name":"datadog-axi","version":"1.0.0"}',
    };
    const fs: UpdateProbe = {
      exists: (path) => path in packages,
      read: (path) => packages[path],
      writable: () => true,
      realpath: (path) => (path === entry ? target : path),
    };
    const result = await updateCommand(
      [],
      deps({
        entry,
        env: { PNPM_HOME: "/tmp/pnpm" },
        fs,
        execute: async () => {
          target = "/tmp/pnpm/store/v11/links/@/datadog-axi/0.1.0/new/node_modules/datadog-axi/dist/bin/cli.js";
        },
      }),
    );
    expect(result).toMatchObject({ update: { manager: "pnpm", action: "upgraded", current: "1.0.0" } });
  });

  it("maps installer failures to UPDATE_ERROR", async () => {
    await expect(
      updateCommand(
        [],
        deps({
          execute: async () => {
            throw new Error("installer failed");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "UPDATE_ERROR" } satisfies Partial<AxiError>);
  });

  it("fails when a successful installer leaves the installed copy stale", async () => {
    await expect(updateCommand([], deps({ execute: async () => {} }))).rejects.toMatchObject({
      code: "UPDATE_ERROR",
      message: expect.stringContaining("still 0.1.0"),
    } satisfies Partial<AxiError>);
  });
});
