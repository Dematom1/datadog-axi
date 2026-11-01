import { realpathSync, existsSync, accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type InstallMethod =
  | { kind: "npm-global"; prefix?: string }
  | { kind: "pnpm-global" }
  | { kind: "yarn-global" }
  | { kind: "bun-global" }
  | { kind: "homebrew"; formula: string | null }
  | { kind: "npx" }
  | { kind: "nix" }
  | { kind: "system-package"; manager: "dpkg" | "rpm" | "pacman" | "apk"; package: string }
  | { kind: "volta" }
  | { kind: "node-version-manager"; manager: "nvm" | "fnm" | "asdf" | "mise" | "nodenv"; npm: string }
  | { kind: "mise-npm-backend" }
  | { kind: "project-local"; project: string; packageManager: PackageManager }
  | { kind: "linked"; checkout: string }
  | { kind: "read-only"; path: string }
  | { kind: "unknown" };

export type UpdateProbe = {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  writable(path: string): boolean;
  realpath(path: string): string | undefined;
};
export type ExecProbe = (argv: string[]) => Promise<{ code: number; stdout: string }>;

export const defaultProbe: UpdateProbe = {
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
const defaultExec: ExecProbe = async ([command, ...args]) => {
  if (!command) return { code: 1, stdout: "" };
  try {
    const result = await execFileAsync(command, args, { encoding: "utf8" });
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    const result = error as { code?: number | string; stdout?: string };
    return { code: typeof result.code === "number" ? result.code : 1, stdout: result.stdout ?? "" };
  }
};
const normalize = (value?: string) => value?.replaceAll("\\", "/").replace(/\/$/, "");
const inside = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
function readPackage(fs: UpdateProbe, path: string): { name?: string; version?: string } | undefined {
  const text = fs.read(join(path, "package.json"));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as { name?: string; version?: string };
  } catch {
    return undefined;
  }
}
function packageRoot(path: string, name: string, fs: UpdateProbe): string | undefined {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir))
    if (readPackage(fs, dir)?.name === name) return dir;
  return undefined;
}
function managerForProject(project: string, fs: UpdateProbe): PackageManager {
  if (fs.exists(join(project, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.exists(join(project, "yarn.lock"))) return "yarn";
  if (fs.exists(join(project, "bun.lock")) || fs.exists(join(project, "bun.lockb"))) return "bun";
  return "npm";
}
async function packageDatabaseOwner(
  path: string,
  fs: UpdateProbe,
  exec: ExecProbe,
): Promise<Extract<InstallMethod, { kind: "system-package" }> | undefined> {
  if (!/^\/(?:usr\/lib(?:64)?|usr\/share)\//.test(path)) return undefined;
  const databases: ["dpkg" | "rpm" | "pacman" | "apk", string, string[]][] = [
    ["dpkg", "/var/lib/dpkg/status", ["dpkg-query", "-S", path]],
    ["rpm", "/var/lib/rpm/Packages", ["rpm", "-qf", path]],
    ["pacman", "/var/lib/pacman/local", ["pacman", "-Qqo", path]],
    ["apk", "/lib/apk/db/installed", ["apk", "info", "-W", path]],
  ];
  const database = databases.find(([, marker]) => fs.exists(marker));
  if (!database) return undefined;
  const [manager, , argv] = database;
  const result = await exec(argv);
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const text = result.stdout.trim();
  const owner =
    manager === "dpkg"
      ? text.split(":", 1)[0]
      : manager === "apk"
        ? text.split(" is owned by ").at(-1)
        : text.split(/[\\s:]/, 1)[0];
  return { kind: "system-package", manager, package: owner ?? text };
}

/** Classifies a real entry path without network access or installer side effects. */
export async function detectInstallMethod(
  entry: string,
  packageName: string,
  options: { env?: NodeJS.ProcessEnv; fs?: UpdateProbe; exec?: ExecProbe } = {},
): Promise<InstallMethod> {
  const env = options.env ?? process.env,
    fs = options.fs ?? defaultProbe,
    exec = options.exec ?? defaultExec;
  const canonical = (value?: string) => {
    const normalizedPath = normalize(value);
    return normalizedPath ? (normalize(fs.realpath(normalizedPath)) ?? normalizedPath) : undefined;
  };
  const path = normalize(entry) ?? entry,
    home = canonical(env.HOME ?? env.USERPROFILE);
  if (path.startsWith("/nix/store/")) return { kind: "nix" };
  if (
    ["/_npx/", "/_dlx/", "/pnpm/dlx/", "/bun/install/cache/", "/.bun/install/cache/", "/_bunx/"].some((s) =>
      path.includes(s),
    ) ||
    /\/(?:dlx|bunx)-[^/]+\//.test(path)
  )
    return { kind: "npx" };
  const brewRoots = [canonical(env.HOMEBREW_CELLAR), "/opt/homebrew/Cellar", "/usr/local/Cellar"].filter(
    (x): x is string => Boolean(x),
  );
  const brewRoot = brewRoots.find((root) => inside(path, root));
  if (brewRoot) return { kind: "homebrew", formula: path.slice(brewRoot.length + 1).split("/")[0] || null };

  const voltaRoots = [
    home && `${home}/.volta/tools/image/packages`,
    canonical(env.VOLTA_HOME) && `${canonical(env.VOLTA_HOME)}/tools/image/packages`,
  ].filter((x): x is string => Boolean(x));
  if (voltaRoots.some((root) => inside(path, root))) return { kind: "volta" };
  const versionRoots: [Extract<InstallMethod, { kind: "node-version-manager" }>["manager"], string][] = [
    ["nvm", `${canonical(env.NVM_DIR) ?? `${home ?? ""}/.nvm`}/versions/node`],
    ["fnm", `${canonical(env.FNM_DIR) ?? `${home ?? ""}/.local/share/fnm`}/node-versions`],
    ["asdf", `${canonical(env.ASDF_DATA_DIR) ?? `${home ?? ""}/.asdf`}/installs/nodejs`],
    ["mise", `${canonical(env.MISE_DATA_DIR) ?? `${home ?? ""}/.local/share/mise`}/installs/node`],
    ["nodenv", `${canonical(env.NODENV_ROOT) ?? `${home ?? ""}/.nodenv`}/versions`],
  ];
  for (const [manager, root] of versionRoots) {
    const marker = "/lib/node_modules/";
    if (inside(path, root) && path.includes(marker)) {
      const npmRoot = path.slice(0, path.indexOf(marker));
      return { kind: "node-version-manager", manager, npm: `${npmRoot}/bin/npm` };
    }
  }
  if (home && inside(path, `${home}/.local/share/mise/installs/npm-`)) return { kind: "mise-npm-backend" };
  if (
    /\/installs\/npm-[^/]+\//.test(path) &&
    (path.includes("/mise/") || inside(path, canonical(env.MISE_DATA_DIR) ?? "/__none__"))
  )
    return { kind: "mise-npm-backend" };

  const pnpmHome = canonical(env.PNPM_HOME);
  if (pnpmHome && inside(path, `${pnpmHome}/store/`) && /\/store\/v\d+\/links\//.test(path))
    return { kind: "pnpm-global" };
  const pnpmRoots = [
    home && `${home}/Library/pnpm/global`,
    home && `${home}/.local/share/pnpm/global`,
    home && `${home}/AppData/Local/pnpm/global`,
    pnpmHome && `${pnpmHome}/global`,
  ].filter((x): x is string => Boolean(x));
  if (pnpmRoots.some((root) => inside(path, root))) return { kind: "pnpm-global" };
  if (
    [
      home && `${home}/.config/yarn/global/node_modules`,
      canonical(env.LOCALAPPDATA) && `${canonical(env.LOCALAPPDATA)}/Yarn/Data/global`,
    ]
      .filter((x): x is string => Boolean(x))
      .some((root) => inside(path, root))
  )
    return { kind: "yarn-global" };
  if (
    [
      canonical(env.BUN_INSTALL) && `${canonical(env.BUN_INSTALL)}/install/global/node_modules`,
      home && `${home}/.bun/install/global/node_modules`,
    ]
      .filter((x): x is string => Boolean(x))
      .some((root) => inside(path, root))
  )
    return { kind: "bun-global" };

  const system = await packageDatabaseOwner(path, fs, exec);
  if (system) return system;
  const configured = canonical(env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX);
  const npmRoots = [configured, "/usr/local", "/usr", home && `${home}/.npm-global`].filter((x): x is string =>
    Boolean(x),
  );
  let npmRoot = npmRoots.find(
    (root) => inside(path, `${root}/lib/node_modules`) || inside(path, `${root}/node_modules`),
  );
  if (!npmRoot) {
    const result = await exec(["npm", "root", "-g"]);
    const root = normalize(result.stdout.trim());
    if (result.code === 0 && root && !root.startsWith("/nix/store/") && inside(path, root))
      npmRoot = root.replace(/\/lib\/node_modules$/, "");
  }
  if (npmRoot) {
    const derived = configured ? undefined : npmRoot;
    return { kind: "npm-global", ...(derived ? { prefix: derived } : {}) };
  }

  const packageModules = `/node_modules/${packageName}/`;
  const nodeModules = path.indexOf(packageModules);
  if (nodeModules >= 0) {
    const project = path.slice(0, nodeModules);
    if (readPackage(fs, project))
      return { kind: "project-local", project, packageManager: managerForProject(project, fs) };
  }
  const root = packageRoot(path, packageName, fs);
  if (root) {
    for (let dir = root; dir !== dirname(dir); dir = dirname(dir))
      if (fs.exists(join(dir, ".git"))) return { kind: "linked", checkout: dir };
  }
  return { kind: "unknown" };
}

export type UpgradePlan = {
  method: InstallMethod;
  manager: string;
  command: string | null;
  argv: string[] | null;
  note: string;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Produces the update action for a detected installation without executing it. */
export function planUpgrade(method: InstallMethod, packageName: string): UpgradePlan {
  const runnable = (
    manager: string,
    command: string,
    argv: string[],
    note = [command, ...argv].map((arg) => (arg.startsWith("/") ? quote(arg) : arg)).join(" "),
  ): UpgradePlan => ({ method, manager, command, argv, note });
  const manual = (manager: string, note: string): UpgradePlan => ({ method, manager, command: null, argv: null, note });
  const version = `${packageName}@latest`;
  switch (method.kind) {
    case "npm-global":
      return runnable("npm", "npm", ["install", "-g", ...(method.prefix ? ["--prefix", method.prefix] : []), version]);
    case "pnpm-global":
      return runnable("pnpm", "pnpm", ["add", "-g", version]);
    case "yarn-global":
      return runnable("yarn", "yarn", ["global", "add", version]);
    case "bun-global":
      return runnable("bun", "bun", ["add", "-g", version]);
    case "node-version-manager":
      return runnable(method.manager, method.npm, ["install", "-g", version]);
    case "volta":
      return runnable("volta", "volta", ["install", version]);
    case "homebrew":
      return method.formula
        ? runnable("homebrew", "brew", ["upgrade", method.formula])
        : manual("homebrew", "Update the Homebrew formula for this package");
    case "npx":
      return manual(
        "npx",
        "Nothing to update; the next run fetches the latest version. Pin the package to keep this version.",
      );
    case "nix":
      return manual(
        "nix",
        "Managed by Nix: update your Nix config/flake and rebuild (for example, home-manager switch or nixos-rebuild switch)",
      );
    case "system-package": {
      const cmd =
        method.manager === "dpkg"
          ? ["sudo", "apt", "install", "--only-upgrade", method.package]
          : method.manager === "rpm"
            ? ["sudo", "dnf", "upgrade", method.package]
            : method.manager === "pacman"
              ? ["sudo", "pacman", "-S", method.package]
              : ["sudo", "apk", "upgrade", method.package];
      return manual(method.manager, cmd.join(" "));
    }
    case "mise-npm-backend":
      return manual("mise", `mise upgrade npm:${packageName} (or update its pin in mise config)`);
    case "project-local":
      return manual(
        "project-local",
        `Run ${method.packageManager} install ${quote(`${packageName}@latest`)} in ${quote(method.project)}, or update package.json`,
      );
    case "linked":
      return manual(
        "linked",
        `In ${quote(method.checkout)}, run git pull and rebuild; unlink this package to use a registry install`,
      );
    case "read-only":
      return manual(
        "read-only",
        `Install at ${quote(method.path)} is not writable by this user; update it through its image/deployment, or rerun with the installing permissions`,
      );
    case "unknown":
      return manual(
        "unknown",
        `Cannot safely identify the installation manager for ${quote(packageName)}; update it with the tool that installed it`,
      );
  }
}

/** Resolves the executable path before classification. */
export function realRunningPath(entry = process.argv[1] ?? "", fs: UpdateProbe = defaultProbe): string {
  return fs.realpath(entry) ?? entry;
}

export function installedVersion(entry: string, packageName: string, fs: UpdateProbe): string | undefined {
  const root = packageRoot(entry, packageName, fs);
  return root ? readPackage(fs, root)?.version : undefined;
}

/** Downgrades runnable plans when the installed package directory is not writable. */
export function writableMethod(
  method: InstallMethod,
  entry: string,
  packageName: string,
  fs: UpdateProbe = defaultProbe,
): InstallMethod {
  const root = packageRoot(entry, packageName, fs);
  if (
    root &&
    !fs.writable(root) &&
    ["npm-global", "pnpm-global", "yarn-global", "bun-global", "node-version-manager", "volta", "homebrew"].includes(
      method.kind,
    )
  )
    return { kind: "read-only", path: root };
  return method;
}
