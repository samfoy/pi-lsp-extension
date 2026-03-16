/**
 * lsp_completions — Get completion suggestions at a position.
 *
 * Returns ranked completion items with type signatures and documentation,
 * letting the LLM discover available methods, properties, and APIs.
 */

import { Type } from "@sinclair/typebox";
import type {
  CompletionItem,
  CompletionList,
  CompletionItemKind,
  MarkupContent,
} from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import { readFile } from "node:fs/promises";
import { SYNTHETIC_DOT_SETTLE_DELAY_MS } from "../shared/timing.js";

/** Map CompletionItemKind to human-readable labels */
const KIND_LABELS: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  11: "unit",
  12: "value",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "color",
  17: "file",
  18: "reference",
  19: "folder",
  20: "enum member",
  21: "constant",
  22: "struct",
  23: "event",
  24: "operator",
  25: "type param",
};

function kindLabel(kind?: CompletionItemKind): string {
  if (!kind) return "unknown";
  return KIND_LABELS[kind] ?? "unknown";
}

/** Extract a short doc summary (first 1-2 lines) from documentation */
function docSummary(doc?: string | MarkupContent): string | undefined {
  if (!doc) return undefined;
  const text = typeof doc === "string" ? doc : doc.value;
  if (!text) return undefined;
  // Strip markdown code fences and take first 2 non-empty lines
  const lines = text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const summary = lines.slice(0, 2).join(" ");
  // Cap at 120 chars
  return summary.length > 120 ? summary.slice(0, 117) + "..." : summary;
}

/** Format a single completion item as a compact line */
function formatItem(item: CompletionItem): string {
  const kind = kindLabel(item.kind);
  const label = item.label;
  const detail = item.detail ? ` ${item.detail}` : "";
  const labelDetail =
    item.labelDetails?.detail ? item.labelDetails.detail : "";
  const labelDesc =
    item.labelDetails?.description ? ` — ${item.labelDetails.description}` : "";

  let line = `${kind.padEnd(12)} ${label}${labelDetail}${detail}${labelDesc}`;
  const doc = docSummary(item.documentation);
  if (doc) {
    line += `\n${"".padEnd(13)}${doc}`;
  }
  return line;
}

type CompletionResponse = CompletionList | CompletionItem[] | null;

const CompletionParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Number({ description: "Line number (1-indexed)" }),
  character: Type.Number({ description: "Column number (1-indexed)" }),
  limit: Type.Optional(
    Type.Number({ description: "Max results to return (default: 20)" })
  ),
  trigger: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("none")], {
      description:
        'Synthetic trigger mode (default: "auto"). When "auto", if the position is at the end of an identifier (no trailing dot), a dot is temporarily inserted to trigger member completions. Use "none" to skip this.',
    })
  ),
});

interface CompletionDetails {
  count: number;
  total: number;
}

/**
 * Check if the position is at the end of an identifier (suitable for synthetic dot insertion).
 * Returns the position after the identifier where the dot should be inserted, or null.
 */
function shouldSyntheticTrigger(
  content: string,
  line: number,    // 0-indexed
  character: number // 0-indexed
): { insertLine: number; insertChar: number } | null {
  const lines = content.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const lineText = lines[line];
  if (character < 0 || character > lineText.length) return null;

  // The character at `character` (0-indexed) should NOT be a dot already
  if (lineText[character] === ".") return null;

  // The character before `character` should be an identifier char (or closing paren/bracket)
  const charBefore = character > 0 ? lineText[character - 1] : "";
  if (!charBefore) return null;

  // Accept identifier chars, closing parens/brackets (for chained calls like foo().bar)
  if (/[\w\d_\)\]\>]/.test(charBefore)) {
    return { insertLine: line, insertChar: character };
  }

  return null;
}

/**
 * Insert a dot at the given position in the content string.
 */
function insertDot(content: string, line: number, character: number): string {
  const lines = content.split("\n");
  const lineText = lines[line];
  lines[line] = lineText.slice(0, character) + "." + lineText.slice(character);
  return lines.join("\n");
}

/** Interface for coordinating document versions with FileSync */
export interface VersionTracker {
  getTrackedVersion(uri: string): number | null;
  setTrackedVersion(uri: string, version: number): void;
  /** Check if a synthetic dot operation is in progress for a URI */
  isSyntheticDotActive(uri: string): boolean;
}

/** Simple per-URI lock to prevent concurrent synthetic dot + file write version conflicts */
export const syntheticDotLocks = new Set<string>();

export function createCompletionsTool(
  manager: LspManager,
  versionTracker?: VersionTracker
): ToolDefinition<typeof CompletionParams, CompletionDetails> {
  return {
    name: "lsp_completions",
    label: "LSP Completions",
    description:
      'Get completion suggestions at a specific position in a file. Returns methods, properties, and other symbols available at that point. Useful for discovering APIs and verifying method names. Line and character are 1-indexed. When trigger is "auto" (default), a dot is temporarily inserted if the position is at the end of an identifier, enabling member completion without editing the file.',
    promptSnippet:
      'Get code completion suggestions at a file position via LSP. Use to discover available methods, properties, and APIs on objects. Supports automatic dot insertion for exploring members on identifiers.',
    parameters: CompletionParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const limit = params.limit ?? 20;
      const trigger = params.trigger ?? "auto";

      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return {
          content: [
            { type: "text", text: manager.getUnavailableReason(filePath) },
          ],
          details: { count: 0, total: 0 },
        };
      }

      // Check if server supports completions
      const caps = client.serverCapabilities;
      if (caps && !caps.completionProvider) {
        return {
          content: [
            {
              type: "text",
              text: `LSP server for this file does not support completions.`,
            },
          ],
          details: { count: 0, total: 0 },
        };
      }

      const uri = manager.getFileUri(filePath);
      const position = {
        line: params.line - 1,
        character: params.character - 1,
      };

      try {
        // Synthetic trigger: if position is at end of identifier, temporarily insert "."
        let syntheticDot = false;
        let originalContent: string | null = null;
        let revertVersion = 99991;
        let completionPosition = position;

        if (trigger === "auto") {
          // Acquire per-URI lock to prevent concurrent version mutations
          if (syntheticDotLocks.has(uri)) {
            // Another synthetic dot operation is in progress — skip synthetic trigger
          } else {
          try {
            syntheticDotLocks.add(uri);
            const absPath = manager.resolvePath(filePath);
            const fileContent = await readFile(absPath, "utf-8");
            const triggerPos = shouldSyntheticTrigger(fileContent, position.line, position.character);

            if (triggerPos) {
              originalContent = fileContent;
              const modifiedContent = insertDot(fileContent, triggerPos.insertLine, triggerPos.insertChar);

              // Coordinate version with FileSync to avoid desync
              const currentVersion = versionTracker?.getTrackedVersion(uri);
              const insertVersion = currentVersion != null ? currentVersion + 1 : 99990;
              revertVersion = currentVersion != null ? currentVersion + 2 : 99991;

              // Send the modified content to the LSP server
              client.didChange(uri, insertVersion, modifiedContent);

              // Update FileSync so it knows about the version bump
              if (versionTracker && currentVersion != null) {
                versionTracker.setTrackedVersion(uri, insertVersion);
              }

              // The completion position is right after the inserted dot
              completionPosition = {
                line: triggerPos.insertLine,
                character: triggerPos.insertChar + 1,
              };
              syntheticDot = true;

              // Brief delay to let the LSP process the change
              await new Promise((r) => setTimeout(r, SYNTHETIC_DOT_SETTLE_DELAY_MS));
            }
          } catch {
            // If reading file or inserting dot fails, fall through to normal completion
          } finally {
            syntheticDotLocks.delete(uri);
          }
          }
        }

        let response: CompletionResponse;
        try {
          response = await client.sendRequest<CompletionResponse>(
            "textDocument/completion",
            { textDocument: { uri }, position: completionPosition }
          );
        } finally {
          // Always revert synthetic dot, even on error
          if (syntheticDot && originalContent !== null) {
            try {
              client.didChange(uri, revertVersion, originalContent);
              // Update FileSync with the final version after revert
              if (versionTracker) {
                versionTracker.setTrackedVersion(uri, revertVersion);
              }
            } catch {
              // Best effort revert
            }
          }
        }

        if (!response) {
          return {
            content: [
              { type: "text", text: "No completions available at this position." },
            ],
            details: { count: 0, total: 0 },
          };
        }

        // Normalize to array
        const allItems: CompletionItem[] = Array.isArray(response)
          ? response
          : response.items;

        if (allItems.length === 0) {
          return {
            content: [
              { type: "text", text: "No completions available at this position." },
            ],
            details: { count: 0, total: 0 },
          };
        }

        const total = allItems.length;

        // Sort by sortText (LSP ranking), then take top N
        const sorted = [...allItems].sort((a, b) => {
          const sa = a.sortText ?? a.label;
          const sb = b.sortText ?? b.label;
          return sa.localeCompare(sb);
        });
        const topItems = sorted.slice(0, limit);

        // Resolve items in parallel for full details (documentation, signatures)
        const resolveSupported = caps?.completionProvider?.resolveProvider;
        let resolvedItems: CompletionItem[];

        if (resolveSupported) {
          const resolveResults = await Promise.allSettled(
            topItems.map((item) =>
              Promise.race([
                client.sendRequest<CompletionItem>(
                  "completionItem/resolve",
                  item
                ),
                // Timeout per item: 2 seconds
                new Promise<CompletionItem>((_, reject) =>
                  setTimeout(() => reject(new Error("resolve timeout")), 2000)
                ),
              ])
            )
          );

          resolvedItems = resolveResults.map((result, i) =>
            result.status === "fulfilled" ? result.value : topItems[i]
          );
        } else {
          resolvedItems = topItems;
        }

        // Format output
        const triggerNote = syntheticDot ? " (synthetic dot trigger)" : "";
        const header = `${resolvedItems.length} of ${total} completions at ${filePath}:${params.line}:${params.character}${triggerNote}\n`;
        const lines = resolvedItems.map(formatItem);
        const text = header + lines.join("\n");

        return {
          content: [{ type: "text", text }],
          details: { count: resolvedItems.length, total },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `LSP completion request failed: ${err.message}`,
            },
          ],
          details: { count: 0, total: 0 },
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_completions "));
      text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      const extras: string[] = [];
      if (args.limit) extras.push(`limit: ${args.limit}`);
      if (args.trigger === "none") extras.push("trigger: none");
      if (extras.length > 0) {
        text += theme.fg("dim", ` (${extras.join(", ")})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Loading completions..."), 0, 0);
      if (!result.details || result.details.count === 0) {
        const content = result.content[0];
        if (content?.type === "text")
          return new Text(theme.fg("dim", content.text), 0, 0);
        return new Text(theme.fg("dim", "No completions"), 0, 0);
      }
      const { count, total } = result.details;
      const summary = `${count} of ${total} completions`;
      return new Text(theme.fg("dim", summary), 0, 0);
    },
  };
}
