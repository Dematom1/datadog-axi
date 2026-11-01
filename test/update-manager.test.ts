import { describe, expect, it } from "vitest";
import { classify, type UpdateProbe } from "../src/update-manager.js";

function probe(files: Record<string, string> = {}, writable = true): UpdateProbe {
  return {
    exists: (path) => path in files,
    read: (path) => files[path],
    writable: () => writable,
    realpath: () => undefined,
  };
}

describe("update manager classification", () => {
  it.each([
    ["Nix", "/nix/store/hash-datadog-axi/bin/datadog-axi", "nix", "Update your Nix config and rebuild"],
    [
      "Homebrew Apple Silicon",
      "/opt/homebrew/Cellar/datadog-axi/1/bin/datadog-axi",
      "homebrew",
      "brew upgrade datadog-axi",
    ],
    ["Homebrew Intel", "/usr/local/Cellar/datadog-axi/1/bin/datadog-axi", "homebrew", "brew upgrade datadog-axi"],
    [
      "apt",
      "/var/lib/dpkg/info/datadog-axi/bin/cli.js",
      "system-package",
      "Update datadog-axi with your system package manager",
    ],
    [
      "dnf",
      "/var/lib/rpm/datadog-axi/bin/cli.js",
      "system-package",
      "Update datadog-axi with your system package manager",
    ],
    [
      "pacman",
      "/var/lib/pacman/local/datadog-axi/bin/cli.js",
      "system-package",
      "Update datadog-axi with your system package manager",
    ],
    [
      "npx",
      "/home/u/.npm/_npx/hash/node_modules/datadog-axi/bin/datadog-axi",
      "ephemeral",
      "Nothing to update; the next run fetches the latest version. Pin the package to keep this version.",
    ],
    [
      "pnpm dlx",
      "/home/u/.cache/pnpm/dlx/hash/node_modules/datadog-axi/bin/datadog-axi",
      "ephemeral",
      "Nothing to update; the next run fetches the latest version. Pin the package to keep this version.",
    ],
    [
      "bunx",
      "/home/u/.bun/install/cache/hash/node_modules/datadog-axi/bin/datadog-axi",
      "ephemeral",
      "Nothing to update; the next run fetches the latest version. Pin the package to keep this version.",
    ],
    [
      "project local",
      "/work/app/node_modules/datadog-axi/bin/datadog-axi",
      "project-local",
      "Update datadog-axi in package.json",
    ],
  ] as const)("classifies %s", (_label, path, manager, instruction) => {
    const result = classify(path, {}, probe(path.startsWith("/work/app/") ? { "/work/app/package.json": "{}" } : {}));
    expect(result.manager).toBe(manager);
    expect(result.instruction).toBe(instruction);
    expect(result.command).toBeUndefined();
  });

  it.each([
    ["Volta", "/home/u/.volta/tools/image/packages/datadog-axi/bin/cli.js", "volta"],
    ["mise", "/home/u/.local/share/mise/installs/node/22/lib/node_modules/datadog-axi/bin/cli.js", "mise"],
    ["asdf", "/home/u/.asdf/installs/nodejs/22/lib/node_modules/datadog-axi/bin/cli.js", "asdf"],
    ["nvm", "/home/u/.nvm/versions/node/22/lib/node_modules/datadog-axi/bin/cli.js", "nvm"],
    ["fnm", "/home/u/.local/share/fnm/node-versions/22/installation/lib/node_modules/datadog-axi/bin/cli.js", "fnm"],
  ] as const)("supports %s managed global install", (_label, path, manager) => {
    const result = classify(path, { HOME: "/home/u" });
    expect(result.manager).toBe(manager);
    expect(result.command).toEqual(
      manager === "volta" ? ["volta", "install", "datadog-axi"] : ["npm", "install", "-g", "datadog-axi@latest"],
    );
  });

  it.each([
    ["npm", "/tmp/npm/lib/node_modules/datadog-axi/bin/cli.js", { npm_config_prefix: "/tmp/npm" }, "npm"],
    ["default npm root", "/usr/local/lib/node_modules/datadog-axi/bin/cli.js", {}, "npm"],
    ["npm node_modules root", "/usr/local/node_modules/datadog-axi/bin/cli.js", {}, "npm"],
    ["home npm-global root", "/home/u/.npm-global/lib/node_modules/datadog-axi/bin/cli.js", { HOME: "/home/u" }, "npm"],
    ["pnpm", "/home/u/Library/pnpm/global/3/node_modules/datadog-axi/bin/cli.js", { HOME: "/home/u" }, "pnpm"],
    ["yarn", "/home/u/.config/yarn/global/node_modules/datadog-axi/bin/cli.js", { HOME: "/home/u" }, "yarn"],
    ["bun", "/home/u/.bun/install/global/node_modules/datadog-axi/bin/cli.js", { HOME: "/home/u" }, "bun"],
  ] as const)("uses the %s global installer", (_label, path, env, manager) => {
    expect(classify(path, env).manager).toBe(manager);
  });

  it("recognizes npm link/source checkout and never runs an installer", () => {
    const result = classify(
      "/work/datadog-axi/bin/cli.js",
      {},
      probe({ "/work/datadog-axi/package.json": '{"name":"datadog-axi"}', "/work/datadog-axi/.git": "" }),
    );
    expect(result).toEqual({ manager: "source", instruction: "Run git pull and rebuild in the source checkout" });
  });

  it("refuses read-only and unknown/container installs", () => {
    expect(
      classify(
        "/opt/app/package/bin/cli.js",
        {},
        probe({ "/opt/app/package/package.json": '{"name":"datadog-axi"}' }, false),
      ).manager,
    ).toBe("read-only");
    expect(
      classify(
        "/container/app/node_modules/datadog-axi/bin/cli.js",
        {},
        probe({ "/container/app/node_modules/datadog-axi/package.json": '{"name":"datadog-axi"}' }, false),
      ).manager,
    ).toBe("read-only");
    const unknownGlobal = classify("/custom/yarn/node_modules/datadog-axi/bin/cli.js", {});
    expect(unknownGlobal.manager).toBe("unknown");
    expect(unknownGlobal.command).toBeUndefined();
    expect(classify("/container/app/bin/datadog-axi", {}).manager).toBe("unknown");
  });
});
