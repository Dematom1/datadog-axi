import { describe, expect, it, vi } from "vitest";
import {
  detectInstallMethod,
  planUpgrade,
  writableMethod,
  type ExecProbe,
  type InstallMethod,
  type UpdateProbe,
} from "../src/update-manager.js";

const name = "demo-axi";
function probe(files: Record<string, string> = {}, writable = true): UpdateProbe {
  return {
    exists: (path) => path in files,
    read: (path) => files[path],
    writable: () => writable,
    realpath: () => undefined,
  };
}
const noOwner: ExecProbe = async () => ({ code: 1, stdout: "" });
const run = (path: string, env: NodeJS.ProcessEnv = {}, fs = probe(), exec = noOwner) =>
  detectInstallMethod(path, name, { env, fs, exec });

describe("detectInstallMethod", () => {
  it.each([
    ["Nix", "/nix/store/hash-demo/bin/cli.js", {}, "nix"],
    ["Homebrew arm", "/opt/homebrew/Cellar/demo-axi/2/bin/cli.js", {}, "homebrew"],
    ["Homebrew intel", "/usr/local/Cellar/demo-axi/2/bin/cli.js", {}, "homebrew"],
    ["npx", "/home/u/.npm/_npx/hash/node_modules/demo-axi/bin/cli.js", {}, "npx"],
    ["pnpm dlx", "/home/u/.cache/pnpm/dlx/hash/node_modules/demo-axi/bin/cli.js", {}, "npx"],
    ["bunx", "/home/u/.bun/install/cache/hash/node_modules/demo-axi/bin/cli.js", {}, "npx"],
    ["bunx temp cache", "/private/tmp/bunx-501-@/tmp/demo.tgz/node_modules/demo-axi/bin/cli.js", {}, "npx"],
    ["Volta", "/home/u/.volta/tools/image/packages/demo-axi/bin/cli.js", { HOME: "/home/u" }, "volta"],
    [
      "mise Node",
      "/home/u/.local/share/mise/installs/node/22/lib/node_modules/demo-axi/bin/cli.js",
      { HOME: "/home/u" },
      "node-version-manager",
    ],
    [
      "mise npm backend",
      "/home/u/.local/share/mise/installs/npm-demo-axi/1/node_modules/demo-axi/bin/cli.js",
      { HOME: "/home/u" },
      "mise-npm-backend",
    ],
    [
      "asdf",
      "/home/u/.asdf/installs/nodejs/22/lib/node_modules/demo-axi/bin/cli.js",
      { HOME: "/home/u" },
      "node-version-manager",
    ],
    [
      "nvm",
      "/home/u/.nvm/versions/node/v22/lib/node_modules/demo-axi/bin/cli.js",
      { HOME: "/home/u" },
      "node-version-manager",
    ],
    [
      "fnm",
      "/home/u/.local/share/fnm/node-versions/v22/installation/lib/node_modules/demo-axi/bin/cli.js",
      { HOME: "/home/u" },
      "node-version-manager",
    ],
    [
      "nodenv",
      "/home/u/.nodenv/versions/22/lib/node_modules/demo-axi/bin/cli.js",
      { HOME: "/home/u" },
      "node-version-manager",
    ],
    [
      "npm configured prefix",
      "/tmp/npm/lib/node_modules/demo-axi/bin/cli.js",
      { npm_config_prefix: "/tmp/npm" },
      "npm-global",
    ],
    ["npm default prefix", "/usr/local/lib/node_modules/demo-axi/bin/cli.js", {}, "npm-global"],
    ["npm /usr prefix", "/usr/lib/node_modules/demo-axi/bin/cli.js", {}, "npm-global"],
    [
      "pnpm global",
      "/home/u/Library/pnpm/global/5/node_modules/demo-axi/bin/cli.js",
      { HOME: "/home/u" },
      "pnpm-global",
    ],
    [
      "pnpm content-store global",
      "/tmp/pnpm/store/v11/links/@/demo-axi/0.0.1/hash/node_modules/demo-axi/bin/cli.js",
      { PNPM_HOME: "/tmp/pnpm" },
      "pnpm-global",
    ],
    ["yarn global", "/home/u/.config/yarn/global/node_modules/demo-axi/bin/cli.js", { HOME: "/home/u" }, "yarn-global"],
    ["bun global", "/home/u/.bun/install/global/node_modules/demo-axi/bin/cli.js", { HOME: "/home/u" }, "bun-global"],
  ] as const)("recognizes %s", async (_label, path, env, kind) => {
    const method = await run(path, env);
    expect(method.kind).toBe(kind);
  });

  it.each([
    ["dpkg", "/var/lib/dpkg/status", "demo-package: /usr/lib/node_modules/demo-axi/bin/cli.js\n", "demo-package"],
    ["rpm", "/var/lib/rpm/Packages", "demo-package-1.0.x86_64\n", "demo-package-1.0.x86_64"],
    ["pacman", "/var/lib/pacman/local", "demo-package\n", "demo-package"],
    [
      "apk",
      "/lib/apk/db/installed",
      "/usr/lib/node_modules/demo-axi/bin/cli.js is owned by demo-package\n",
      "demo-package",
    ],
  ] as const)(
    "uses the %s package database when it owns a /usr/lib package",
    async (manager, marker, output, owner) => {
      const method = await run(
        "/usr/lib/node_modules/demo-axi/bin/cli.js",
        {},
        probe({ [marker]: "" }),
        async ([cmd]) => ({
          code: cmd === ({ dpkg: "dpkg-query", rpm: "rpm", pacman: "pacman", apk: "apk" } as const)[manager] ? 0 : 1,
          stdout: output,
        }),
      );
      expect(method).toEqual({ kind: "system-package", manager, package: owner });
    },
  );

  it("classifies a package-database-owned /usr/lib package, but leaves unowned npm globals as npm", async () => {
    const owned = await run(
      "/usr/lib/node_modules/demo-axi/bin/cli.js",
      {},
      probe({ "/var/lib/dpkg/status": "" }),
      async ([cmd]) =>
        cmd === "dpkg-query"
          ? { code: 0, stdout: "demo-package: /usr/lib/node_modules/demo-axi/bin/cli.js\n" }
          : { code: 1, stdout: "" },
    );
    expect(owned).toEqual({ kind: "system-package", manager: "dpkg", package: "demo-package" });
    expect((await run("/usr/lib/node_modules/demo-axi/bin/cli.js")).kind).toBe("npm-global");
  });

  it("does not trust an npm root reported from the Nix store", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "/nix/store/node/lib/node_modules\\n" }));
    expect(await run("/nix/store/tool/bin/cli.js", {}, probe(), exec)).toEqual({ kind: "nix" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses npm root only outside Nix and detects package manager globals by project lockfile", async () => {
    const npm = await run("/custom/npm-root/demo-axi/bin/cli.js", {}, probe(), async () => ({
      code: 0,
      stdout: "/custom/npm-root\n",
    }));
    expect(npm).toEqual({ kind: "npm-global", prefix: "/custom/npm-root" });
    const aliasedPrefix = await detectInstallMethod("/private/tmp/npm/lib/node_modules/demo-axi/bin/cli.js", name, {
      env: { npm_config_prefix: "/tmp/npm" },
      fs: { ...probe(), realpath: (path) => (path === "/tmp/npm" ? "/private/tmp/npm" : undefined) },
    });
    expect(aliasedPrefix).toEqual({ kind: "npm-global" });
    const local = await run(
      "/work/app/node_modules/demo-axi/bin/cli.js",
      {},
      probe({ "/work/app/package.json": "{}", "/work/app/pnpm-lock.yaml": "" }),
    );
    expect(local).toEqual({ kind: "project-local", project: "/work/app", packageManager: "pnpm" });
  });

  it("detects linked source checkouts and unknown paths", async () => {
    const linked = await run(
      "/work/demo/bin/cli.js",
      {},
      probe({ "/work/demo/package.json": '{"name":"demo-axi"}', "/work/demo/.git": "" }),
    );
    expect(linked).toEqual({ kind: "linked", checkout: "/work/demo" });
    expect((await run("/container/custom/cli.js")).kind).toBe("unknown");
  });
});

describe("planUpgrade", () => {
  it.each([
    [{ kind: "npm-global", prefix: "/tmp/npm" }, "npm", ["install", "-g", "--prefix", "/tmp/npm", "demo-axi@latest"]],
    [{ kind: "pnpm-global" }, "pnpm", ["add", "-g", "demo-axi@latest"]],
    [{ kind: "yarn-global" }, "yarn", ["global", "add", "demo-axi@latest"]],
    [{ kind: "bun-global" }, "bun", ["add", "-g", "demo-axi@latest"]],
    [{ kind: "volta" }, "volta", ["install", "demo-axi@latest"]],
    [
      { kind: "node-version-manager", manager: "mise", npm: "/node/bin/npm" },
      "/node/bin/npm",
      ["install", "-g", "demo-axi@latest"],
    ],
    [{ kind: "homebrew", formula: "demo" }, "brew", ["upgrade", "demo"]],
  ] as const)("plans matching installer for %j", (method, command, argv) => {
    expect(planUpgrade(method as InstallMethod, name)).toMatchObject({ command, argv });
  });

  it.each([
    [{ kind: "nix" }, "nix"],
    [{ kind: "npx" }, "npx"],
    [{ kind: "mise-npm-backend" }, "mise"],
    [{ kind: "read-only", path: "/opt/demo" }, "read-only"],
    [{ kind: "unknown" }, "unknown"],
    [{ kind: "linked", checkout: "/src/demo" }, "linked"],
    [{ kind: "project-local", project: "/work/app", packageManager: "npm" }, "project-local"],
    [{ kind: "system-package", manager: "dpkg", package: "demo" }, "dpkg"],
  ] as const)("makes %s print-only", (method, manager) => {
    const plan = planUpgrade(method as InstallMethod, name);
    expect(plan.manager).toBe(manager);
    expect(plan.command).toBeNull();
    expect(plan.argv).toBeNull();
    expect(plan.note).toBeTruthy();
  });

  it("downgrades an unwritable runnable install", () => {
    const path = "/tmp/prefix/lib/node_modules/demo-axi/bin/cli.js";
    const fs = probe({ "/tmp/prefix/lib/node_modules/demo-axi/package.json": '{"name":"demo-axi"}' }, false);
    expect(writableMethod({ kind: "npm-global", prefix: "/tmp/prefix" }, path, name, fs)).toEqual({
      kind: "read-only",
      path: "/tmp/prefix/lib/node_modules/demo-axi",
    });
  });
});
