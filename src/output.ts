import { encode } from "@toon-format/toon";
import { AxiError, exitCodeForError } from "axi-sdk-js";

/**
 * Final rendering. Data is TOON via the official encoder; `help` hints are
 * printed as one unquoted line each (gh-axi style) so pasteable commands
 * keep their quotes intact. Errors use the same shape on stdout.
 */

export function renderHelpBlock(lines: string[]): string {
  return lines.length === 0 ? "" : encode({ help: lines });
}

export function renderResult(result: Record<string, unknown> | string): string {
  if (typeof result === "string") {
    return result;
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
    return {
      output: `${renderResult({ error: error.message, code: error.code, help: error.suggestions })}\n`,
      exitCode: exitCodeForError(error),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `${renderResult({ error: message, code: "UNKNOWN", help: ["This is a datadog-axi bug; please report it"] })}\n`,
    exitCode: 1,
  };
}
