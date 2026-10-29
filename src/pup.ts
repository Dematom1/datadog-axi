import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AxiError } from "axi-sdk-js";

/**
 * Pup, Datadog's CLI, as a credential source. A human logs in once with
 * `pup auth login` (browser OAuth); when no other credential is configured,
 * datadog-axi asks pup for the current access token with `pup auth token`,
 * which also honors pup's keychain or file storage and refreshes an expired
 * token, then reads the token's site and org from `pup auth status`.
 *
 * The token stays in memory: it is read from pup's stdout, never written to
 * disk, never passed in argv, never printed. Pup's own environment rules
 * apply (`DD_SITE`, `DD_ORG` for a named session), and `DATADOG_AXI_PUP`
 * points at a specific binary or, set to `off`, turns this source off.
 */

export const PUP_ENV = "DATADOG_AXI_PUP";

export const PUP_TIMEOUT_MS = 60_000;

export interface PupLogin {
  token: string;
  /** The site pup's token is for, as pup reports it (not yet normalized). */
  site: string;
  /** Pup's named session, when one is in use. */
  org?: string;
  expiresAt?: string;
  /** The token's OAuth scopes, as pup reports them. */
  scopes?: string[];
}

export interface PupRunner {
  /** Run pup with these args and environment; resolves with stdout or rejects with a `PupFailure`. */
  run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string>;
}

export class PupFailure extends Error {
  constructor(
    message: string,
    readonly kind: "failed" | "timeout" | "missing",
  ) {
    super(message);
  }
}

/** Offline: the pup binary datadog-axi would use, or undefined. Never executes anything. */
export function findPup(env: NodeJS.ProcessEnv): string | undefined {
  const override = env[PUP_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return override.toLowerCase() === "off" ? undefined : override;
  }
  const names = process.platform === "win32" ? ["pup.exe", "pup.cmd"] : ["pup"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const processPupRunner: PupRunner = {
  run(bin, args, env) {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { env, timeout: PUP_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const err = error as NodeJS.ErrnoException & { killed?: boolean };
          if (err.code === "ENOENT" || err.code === "EACCES") {
            reject(new PupFailure(`could not run ${bin}`, "missing"));
          } else if (err.killed) {
            reject(new PupFailure(`pup did not answer within ${PUP_TIMEOUT_MS / 1000}s`, "timeout"));
          } else {
            reject(new PupFailure(firstLine(stderr) || firstLine(stdout) || `pup exited with an error`, "failed"));
          }
        },
      );
    });
  },
};

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 300) ?? ""
  );
}

/** Pup's hints, shaped for the site and session in use. */
export function pupLoginCommand(site: string | undefined, scopes: readonly string[]): string {
  return `pup auth login${site ? ` --site ${site}` : ""} --scopes ${scopes.join(",")}`;
}

const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

/**
 * Ask pup for its current token, and the site and session it belongs to.
 * `site` is datadog-axi's explicit site (`--site`), passed to pup as
 * `DD_SITE` so both tools mean the same site.
 */
export async function pupLogin(
  bin: string,
  env: NodeJS.ProcessEnv,
  site: string | undefined,
  runner: PupRunner,
  loginHint: string,
): Promise<PupLogin> {
  const childEnv: NodeJS.ProcessEnv = { ...env, ...(site !== undefined ? { DD_SITE: site } : {}) };
  const sessionFlag = nonEmpty(env.DD_ORG) !== undefined ? ` --org ${nonEmpty(env.DD_ORG)}` : "";

  let stdout: string;
  try {
    stdout = await runner.run(bin, ["auth", "token"], childEnv);
  } catch (error) {
    throw pupError(error, sessionFlag, loginHint);
  }
  const token = stdout.trim();
  if (!TOKEN_SHAPE.test(token)) {
    throw new AxiError("pup auth token did not print a token", "AUTH_REQUIRED", [
      `Run \`pup auth status${sessionFlag}\` to check pup's login`,
      loginHint,
    ]);
  }

  let status: { site?: unknown; org?: unknown; expires_at?: unknown; scopes?: unknown };
  try {
    status = JSON.parse(await runner.run(bin, ["auth", "status"], childEnv)) as typeof status;
  } catch (error) {
    if (error instanceof PupFailure) {
      throw pupError(error, sessionFlag, loginHint);
    }
    throw new AxiError("Could not read pup auth status (expected JSON)", "AUTH_REQUIRED", [
      "Update pup (`brew upgrade datadog-labs/pack/pup` or `npm install -g @datadog/pup`), or set DD_ACCESS_TOKEN",
    ]);
  }
  if (typeof status.site !== "string" || status.site.length === 0) {
    throw new AxiError("pup auth status did not name a site", "AUTH_REQUIRED", [
      `Run \`pup auth status${sessionFlag}\` to check pup's login`,
    ]);
  }
  return {
    token,
    site: status.site,
    ...(typeof status.org === "string" && status.org.length > 0 ? { org: status.org } : {}),
    ...(typeof status.expires_at === "string" && status.expires_at.length > 0 ? { expiresAt: status.expires_at } : {}),
    ...(Array.isArray(status.scopes) && status.scopes.every((s) => typeof s === "string")
      ? { scopes: status.scopes as string[] }
      : {}),
  };
}

function pupError(error: unknown, sessionFlag: string, loginHint: string): AxiError {
  const reason = error instanceof Error ? error.message : String(error);
  const off = `Or use keys instead: set ${PUP_ENV}=off and run \`datadog-axi auth guide\``;
  if (error instanceof PupFailure && error.kind === "timeout") {
    return new AxiError(reason, "AUTH_REQUIRED", [
      "pup may be waiting for an OS keychain prompt; allow it, then retry",
      off,
    ]);
  }
  if (error instanceof PupFailure && error.kind === "missing") {
    return new AxiError(`pup is not runnable: ${reason}`, "AUTH_REQUIRED", [
      `Install pup, or point ${PUP_ENV} at it`,
      off,
    ]);
  }
  if (/expired/i.test(reason)) {
    return new AxiError(`pup's Datadog token has expired and was not refreshed: ${reason}`, "AUTH_REQUIRED", [
      `A human runs \`pup auth refresh${sessionFlag}\`, or logs in again if the refresh token (30 days) has expired too: ${loginHint}`,
      off,
    ]);
  }
  return new AxiError(`pup has no usable Datadog login: ${reason}`, "AUTH_REQUIRED", [
    `A human logs in once in the browser: ${loginHint}`,
    "For a named pup session (pup auth login --org <name>), set DD_ORG=<name>",
    off,
  ]);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}
