import { readSessionContent } from "./transcript-parser.js";
import type { ContentRef, ParsedSession, Step, TokenUsage } from "./transcript-parser.js";

// ─── Types ───────────────────────────────────────────────────────────

export type AdjacentStep = {
  step: number;
  tool: string;
  status: string;
  inputSummary: string;
};

export type StepDetail = {
  sessionKey: string;
  step: number;
  toolCallId: string;
  inferenceId: string;
  tool: string;
  arguments: Record<string, unknown> | null;
  argumentRef?: ContentRef;
  result: Array<{ type: string; text: string }>;
  resultRefs: ContentRef[];
  resultDetails: Record<string, unknown>;
  isError: boolean;
  parentThinking: string | null;
  reactionThinking: string | null;
  tokenSummary: TokenUsage;
  isSharedInferenceUsage: boolean;
  costContext: { thisTurn: number; cumulative: number };
  adjacentSteps: AdjacentStep[];
  subagentSessionId?: string;
};

export type DetailOptions = {
  includeThinking?: boolean;
  includeInput?: boolean;
  includeOutput?: boolean;
  includeAdjacentSteps?: boolean;
  maxDetailChars?: number;
};

// ─── Builder ─────────────────────────────────────────────────────────

export async function buildDetail(
  sessionKey: string,
  parsed: ParsedSession,
  stepNum: number,
  opts: DetailOptions = {},
): Promise<StepDetail | null> {
  const maxChars = opts.maxDetailChars ?? 8000;
  const includeThinking = opts.includeThinking === true;
  const includeInput = opts.includeInput !== false;
  const includeOutput = opts.includeOutput !== false;
  const includeAdjacent = opts.includeAdjacentSteps !== false;

  const target = parsed.steps.find((s) => s.step === stepNum);
  if (!target) return null;

  const result = includeOutput ? await readResultBlocks(parsed, target, maxChars) : [];

  // Get thinking context
  let parentThinking: string | null = null;
  let reactionThinking: string | null = null;

  if (includeThinking) {
    parentThinking = target.parentThinking;

    // Reaction = thinking from the next assistant turn
    const nextTurn = target.turn + 1;
    reactionThinking = parsed.thinkingByTurn.get(nextTurn) ?? null;

    if (parentThinking && !parentThinking.trim()) parentThinking = null;
    if (reactionThinking && !reactionThinking.trim()) reactionThinking = null;

    // Truncate long thinking
    if (parentThinking && parentThinking.length > 2000) {
      parentThinking = parentThinking.slice(0, 2000) + "...(truncated)";
    }
    if (reactionThinking && reactionThinking.length > 2000) {
      reactionThinking = reactionThinking.slice(0, 2000) + "...(truncated)";
    }
  }

  // Cumulative cost up to this step
  const cumulative = cumulativeCost(parsed, target.step);

  // Adjacent steps
  const adjacentSteps: AdjacentStep[] = [];
  if (includeAdjacent) {
    for (const s of parsed.steps) {
      if (s.step >= target.step - 2 && s.step <= target.step + 2 && s.step !== target.step) {
        adjacentSteps.push({
          step: s.step,
          tool: s.tool,
          status: s.isError ? "error" : "ok",
          inputSummary: summarizeInputShort(s),
        });
      }
    }
  }

  return {
    sessionKey,
    step: target.step,
    toolCallId: target.toolCallId,
    inferenceId: target.inferenceId,
    tool: target.tool,
    arguments: includeInput ? target.arguments : null,
    argumentRef: target.argumentRef,
    result,
    resultRefs: target.resultRefs,
    resultDetails: target.resultDetails,
    isError: target.isError,
    parentThinking,
    reactionThinking,
    tokenSummary: target.tokenSummary,
    isSharedInferenceUsage: target.isSharedInferenceUsage,
    costContext: {
      thisTurn: target.costThisTurn,
      cumulative: Math.round(cumulative * 10000) / 10000,
    },
    adjacentSteps,
    subagentSessionId: target.subagentSessionId,
  };
}

async function readResultBlocks(parsed: ParsedSession, step: Step, maxChars: number): Promise<Array<{ type: string; text: string }>> {
  const blocks = [];
  for (const block of step.resultContent) {
    const ref = block.ref;
    let text = block.text;
    if (ref) {
      try {
        const content = await readSessionContent(ref.refId, parsed.provider, 0, maxChars);
        text = content.text + (content.hasMore ? `\n...(truncated, ${content.charCount} total chars)` : "");
      } catch {
        text = block.text;
      }
    }
    if (text.length > maxChars) text = text.slice(0, maxChars) + `\n...(truncated, ${text.length} total chars)`;
    blocks.push({ type: block.type, text });
  }
  return blocks;
}

function cumulativeCost(parsed: ParsedSession, throughStep: number): number {
  const seen = new Set<string>();
  let total = 0;
  for (const step of parsed.steps) {
    if (step.step > throughStep) continue;
    if (seen.has(step.inferenceId)) continue;
    seen.add(step.inferenceId);
    const event = parsed.inferenceEvents.find((i) => i.inferenceId === step.inferenceId);
    total += event?.costUsd ?? step.costThisTurn;
  }
  return total;
}

function summarizeInputShort(step: Step): string {
  const args = step.arguments;
  if (step.tool === "exec" && args.command) return String(args.command).slice(0, 60);
  if (step.tool === "read" && (args.file_path || args.file)) return String(args.file_path ?? args.file).slice(0, 60);
  if (step.tool === "edit" && (args.file_path || args.file)) return String(args.file_path ?? args.file).slice(0, 60);
  if (step.tool === "write" && args.file_path) return String(args.file_path).slice(0, 60);
  if (step.tool === "message") return `${args.action ?? "send"} ${args.channelId ?? ""}`.slice(0, 60);
  return JSON.stringify(args).slice(0, 60);
}

// ─── Text Formatting ─────────────────────────────────────────────────

export function formatDetailText(detail: StepDetail): string {
  const lines: string[] = [];
  const statusLabel = detail.isError ? "ERROR" : "OK";
  lines.push(`=== Step ${detail.step} Detail: ${detail.tool} (${statusLabel}) ===`);

  // Thinking before
  if (detail.parentThinking) {
    lines.push("\nAgent thinking (before):");
    for (const line of detail.parentThinking.split("\n").slice(0, 10)) {
      lines.push(`> ${line}`);
    }
  }

  // Input
  lines.push("\nInput:");
  const argsStr = detail.arguments === null ? "(input omitted)" : JSON.stringify(detail.arguments, null, 2);
  const argsLines = argsStr.split("\n");
  for (const line of argsLines.slice(0, 20)) {
    lines.push(`  ${line}`);
  }
  if (argsLines.length > 20) {
    lines.push(`  ...(${argsLines.length} lines total)`);
  }

  // Output
  const exitInfo: string[] = [];
  if (detail.resultDetails.exitCode !== undefined) exitInfo.push(`exitCode=${detail.resultDetails.exitCode}`);
  if (detail.resultDetails.durationMs !== undefined) exitInfo.push(`${detail.resultDetails.durationMs}ms`);
  const exitStr = exitInfo.length > 0 ? ` (${exitInfo.join(", ")})` : "";
  lines.push(`\nOutput${exitStr}:`);

  for (const block of detail.result) {
    const outputLines = block.text.split("\n");
    for (const line of outputLines.slice(0, 30)) {
      lines.push(`  ${line}`);
    }
    if (outputLines.length > 30) {
      lines.push(`  ...(${outputLines.length} lines total)`);
    }
  }

  // Thinking after
  if (detail.reactionThinking) {
    lines.push("\nAgent thinking (after):");
    for (const line of detail.reactionThinking.split("\n").slice(0, 10)) {
      lines.push(`> ${line}`);
    }
  }

  // Cost context
  lines.push(
    `\nTokens: ${detail.tokenSummary.totalReportedTokens.toLocaleString()} reported${detail.isSharedInferenceUsage ? " (shared inference usage)" : ""}`,
  );
  lines.push(`Cost: $${detail.costContext.thisTurn.toFixed(4)} this turn, $${detail.costContext.cumulative.toFixed(4)} cumulative`);

  // Adjacent steps
  if (detail.adjacentSteps.length > 0) {
    lines.push("\nAdjacent steps:");
    for (const a of detail.adjacentSteps) {
      lines.push(`  ${a.step} ${a.tool} ${a.status.padEnd(5)} — ${a.inputSummary}`);
    }
  }

  return lines.join("\n");
}

export function buildDetailHints(detail: StepDetail): string[] {
  const hints: string[] = [];

  if (detail.isError) {
    // Check if the next adjacent step is the same tool and succeeded (self-correction)
    const nextOk = detail.adjacentSteps.find(
      (a) => a.step > detail.step && a.tool === detail.tool && a.status === "ok",
    );
    if (nextOk) {
      hints.push(
        `Agent self-corrected in step ${nextOk.step}. Consider adding skill guidance to prevent this trial-and-error.`,
      );
    } else {
      hints.push("Agent did not recover from this error in subsequent steps. This may be a blocking issue.");
    }
  }

  if (detail.costContext.thisTurn > 0.1) {
    hints.push(
      `This turn cost $${detail.costContext.thisTurn.toFixed(3)} — unusually high. Check if the model or input size was appropriate.`,
    );
  }

  if (!detail.parentThinking && !detail.reactionThinking) {
    hints.push("No thinking content available for this step (provider may not expose it).");
  }

  if (hints.length === 0) {
    hints.push("Step completed normally. No anomalies detected.");
  }

  return hints;
}
