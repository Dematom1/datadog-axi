import { encode } from "@toon-format/toon";
import { AxiError, exitCodeForError } from "axi-sdk-js";

/** Final rendering uses the official TOON encoder, including help hints. */

export function renderHelpBlock(lines: string[]): string {
  return lines.length === 0 ? "" : encode({ help: lines });
}

export function renderResult(result: Record<string, unknown> | string): string {
  if (typeof result === "string") {
    return encode({ result });
  }
  const { help, ...rest } = result;
  const blocks = Object.keys(rest).length > 0 ? [encode(rest)] : [];
  if (Array.isArray(help) && help.length > 0) {
    blocks.push(renderHelpBlock(help.map(String)));
  }
  return blocks.join("\n");
}

export function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const manual =
      error.code === "MANUAL_UPDATE_REQUIRED"
        ? (error as AxiError & {
            action: string;
            manager: string;
            path: string;
            instruction: string;
          })
        : undefined;
    return {
      output: `${renderResult({
        error: error.message,
        code: error.code,
        ...(manual && {
          action: manual.action,
          manager: manual.manager,
          path: manual.path,
          instruction: manual.instruction,
        }),
        help: error.suggestions,
      })}\n`,
      exitCode: manual ? 2 : exitCodeForError(error),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `${renderResult({ error: message, code: "UNKNOWN", help: ["This is a datadog-axi bug; please report it"] })}\n`,
    exitCode: 1,
  };
}
