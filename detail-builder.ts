import type { ParsedSession, Step } from "./transcript-parser.js";

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
  tool: string;
  arguments: Record<string, unknown>;
  result: Array<{ type: string; text: string }>;
  resultDetails: Record<string, unknown>;
  isError: boolean;
  parentThinking: string | null;
  reactionThinking: string | null;
  costContext: { thisTurn: number; cumulative: number };
  adjacentSteps: AdjacentStep[];
};

export type DetailOptions = {
  includeThinking?: boolean;
  includeAdjacentSteps?: boolean;
  maxDetailChars?: number;
};

// ─── Builder ─────────────────────────────────────────────────────────

export function buildDetail(
  sessionKey: string,
  parsed: ParsedSession,
  stepNum: number,
  opts: DetailOptions = {},
): StepDetail | null {
  const maxChars = opts.maxDetailChars ?? 8000;
  const includeThinking = opts.includeThinking !== false;
  const includeAdjacent = opts.includeAdjacentSteps !== false;

  const target = parsed.steps.find((s) => s.step === stepNum);
  if (!target) return null;

  // Truncate result content
  const result = target.resultContent.map((b) => ({
    type: b.type,
    text: b.text.length > maxChars ? b.text.slice(0, maxChars) + `\n...(truncated, ${b.text.length} total chars)` : b.text,
  }));

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
  let cumulative = 0;
  for (const s of parsed.steps) {
    if (s.step <= target.step) {
      cumulative += s.costThisTurn;
    }
  }

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
    tool: target.tool,
    arguments: target.arguments,
    result,
    resultDetails: target.resultDetails,
    isError: target.isError,
    parentThinking,
    reactionThinking,
    costContext: {
      thisTurn: target.costThisTurn,
      cumulative: Math.round(cumulative * 10000) / 10000,
    },
    adjacentSteps,
  };
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
  const argsStr = JSON.stringify(detail.arguments, null, 2);
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
  lines.push(`\nCost: $${detail.costContext.thisTurn.toFixed(4)} this turn, $${detail.costContext.cumulative.toFixed(4)} cumulative`);

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
