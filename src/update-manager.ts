import { realpathSync, existsSync, accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type UpdateManager =
  | "nix"
  | "homebrew"
  | "system-package"
  | "ephemeral"
  | "project-local"
  | "volta"
  | "mise"
  | "asdf"
  | "nvm"
  | "fnm"
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "source"
  | "read-only"
  | "unknown";

export type UpdateClassification = {
  manager: UpdateManager;
  instruction: string;
  command?: string[];
};

export type UpdateProbe = {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  writable(path: string): boolean;
  realpath(path: string): string | undefined;
};

const defaultProbe: UpdateProbe = {
  exists: existsSync,
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writable(path) {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  },
};

const inside = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
const normalized = (path?: string) => path?.replaceAll("\\", "/").replace(/\/$/, "");

export function classify(
  realPath: string,
  env: NodeJS.ProcessEnv = {},
  probe: UpdateProbe = defaultProbe,
): UpdateClassification {
  const path = normalized(realPath) ?? realPath;
  const refuse = (manager: UpdateManager, instruction: string): UpdateClassification => ({ manager, instruction });
  if (path.includes("/nix/store/")) return refuse("nix", "Update your Nix config and rebuild");
  if (
    ["/opt/homebrew/Cellar", "/usr/local/Cellar", normalized(env.HOMEBREW_CELLAR)]
      .filter((x): x is string => Boolean(x))
      .some((root) => inside(path, root))
  ) {
    const root = [normalized(env.HOMEBREW_CELLAR), "/opt/homebrew/Cellar", "/usr/local/Cellar"].find(
      (x) => x && inside(path, x),
    );
    const formula = root ? path.slice(root.length + 1).split("/")[0] : "datadog-axi";
    return refuse("homebrew", `brew upgrade ${formula}`);
  }
  if (
    /\/(?:dpkg|apt|dnf|yum|rpm|pacman|snap)\//.test(path) ||
    /^\/(?:usr\/share|usr\/lib)\/.*(?:node_modules|datadog-axi)/.test(path)
  )
    return refuse("system-package", "Update datadog-axi with your system package manager");
  let packageDir = dirname(path);
  while (packageDir !== dirname(packageDir)) {
    const pkg = probe.read(join(packageDir, "package.json"));
    if (pkg) {
      try {
        if ((JSON.parse(pkg) as { name?: unknown }).name === "datadog-axi" && !probe.writable(packageDir))
          return refuse(
            "read-only",
            "This installation is read-only; update it through its container or deployment configuration",
          );
      } catch {
        /* Ignore unrelated or malformed package metadata. */
      }
    }
    packageDir = dirname(packageDir);
  }
  if (
    ["/_npx/", "/_dlx/", "/pnpm/dlx/", "/bun/install/cache/", "/.bun/install/cache/"].some((marker) =>
      path.includes(marker),
    ) ||
    /\/dlx-[^/]+\//.test(path)
  ) {
    return refuse(
      "ephemeral",
      "Nothing to update; the next run fetches the latest version. Pin the package to keep this version.",
    );
  }
  if (/\/node_modules\/\.bin\//.test(path)) return refuse("project-local", "Update datadog-axi in package.json");

  const home = normalized(env.HOME ?? env.USERPROFILE);
  const managerRoots: [UpdateManager, string[]][] = [
    ["volta", [home && `${home}/.volta/tools/image/packages`].filter((x): x is string => Boolean(x))],
    [
      "mise",
      [
        home && `${home}/.local/share/mise/installs/node`,
        normalized(env.MISE_DATA_DIR) && `${normalized(env.MISE_DATA_DIR)}/installs/node`,
      ].filter((x): x is string => Boolean(x)),
    ],
    [
      "asdf",
      [
        home && `${home}/.asdf/installs/nodejs`,
        normalized(env.ASDF_DATA_DIR) && `${normalized(env.ASDF_DATA_DIR)}/installs/nodejs`,
      ].filter((x): x is string => Boolean(x)),
    ],
    [
      "nvm",
      [normalized(env.NVM_DIR) ?? (home && `${home}/.nvm`)]
        .filter((x): x is string => Boolean(x))
        .map((x) => `${x}/versions/node`),
    ],
    [
      "fnm",
      [
        normalized(env.FNM_DIR) && `${normalized(env.FNM_DIR)}/node-versions`,
        home && `${home}/.local/share/fnm/node-versions`,
      ].filter((x): x is string => Boolean(x)),
    ],
  ];
  for (const [manager, roots] of managerRoots)
    if (roots.some((root) => inside(path, root))) {
      const command =
        manager === "volta"
          ? ["volta", "install", "datadog-axi"]
          : manager === "mise"
            ? ["mise", "use", "-g", "npm:datadog-axi@latest"]
            : ["npm", "install", "-g", "datadog-axi@latest"];
      return { manager, instruction: command.join(" "), command };
    }

  const configuredPrefix = normalized(env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX);
  const prefix = configuredPrefix ? (normalized(probe.realpath(configuredPrefix)) ?? configuredPrefix) : undefined;
  if (prefix && (inside(path, `${prefix}/lib/node_modules`) || inside(path, `${prefix}/node_modules`)))
    return {
      manager: "npm",
      instruction: "npm install -g datadog-axi@latest",
      command: ["npm", "install", "-g", "datadog-axi@latest"],
    };
  const globalRoots: [UpdateManager, string][] = [
    ...[
      home && `${home}/Library/pnpm/global`,
      home && `${home}/.local/share/pnpm/global`,
      home && `${home}/AppData/Local/pnpm/global`,
      normalized(env.LOCALAPPDATA) && `${normalized(env.LOCALAPPDATA)}/pnpm/global`,
    ]
      .filter((x): x is string => Boolean(x))
      .map((root) => ["pnpm", root] as [UpdateManager, string]),
    ["yarn", `${home ?? ""}/.config/yarn/global/node_modules`],
    ["bun", `${home ?? ""}/.bun/install/global/node_modules`],
  ];
  for (const [manager, root] of globalRoots)
    if (inside(path, root)) {
      const command =
        manager === "pnpm"
          ? ["pnpm", "add", "-g", "datadog-axi@latest"]
          : manager === "yarn"
            ? ["yarn", "global", "add", "datadog-axi@latest"]
            : ["bun", "add", "-g", "datadog-axi@latest"];
      return { manager, instruction: command.join(" "), command };
    }
  if (/\/node_modules\/datadog-axi\//.test(path)) return refuse("project-local", "Update datadog-axi in package.json");
  if (path.includes("/lib/node_modules/") || path.includes("/node_modules/"))
    return {
      manager: "npm",
      instruction: "npm install -g datadog-axi@latest",
      command: ["npm", "install", "-g", "datadog-axi@latest"],
    };

  let dir = dirname(path);
  while (dir !== dirname(dir)) {
    const pkg = probe.read(join(dir, "package.json"));
    if (pkg) {
      try {
        if ((JSON.parse(pkg) as { name?: unknown }).name === "datadog-axi") {
          if (probe.exists(join(dir, ".git")))
            return refuse("source", "Run git pull and rebuild in the source checkout");
          if (!probe.writable(dir))
            return refuse(
              "read-only",
              "This installation is read-only; update it through its container or deployment configuration",
            );
        }
      } catch {
        /* Ignore unrelated or malformed package metadata. */
      }
    }
    dir = dirname(dir);
  }
  return refuse(
    "unknown",
    `Cannot safely identify the installation manager for ${path}; update it with the tool that installed it`,
  );
}

export function realRunningPath(entry = process.argv[1] ?? "") {
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}
