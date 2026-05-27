import type { ContentRef, ParsedSession, Step, ModelChange, TokenUsage } from "./transcript-parser.js";

// ─── Types ───────────────────────────────────────────────────────────

export type StepRow = {
  step: number;
  turn: number;
  toolCallId: string;
  inferenceId: string;
  tool: string;
  status: string;
  durationMs: number | null;
  inputSummary: string;
  outputSummary: string;
  contentRefs: {
    input?: ContentRef;
    output: ContentRef[];
    thinking?: ContentRef;
  };
  exitCode: number | null;
  isError: boolean;
  costThisTurn: number;
  tokensThisTurn: number;
  tokenSummary: TokenUsage;
  isSharedInferenceUsage: boolean;
  subagentSessionId?: string;
};

export type StepListResult = {
  sessionKey: string;
  totalSteps: number;
  stepsReturned: number;
  offset: number;
  hasMore: boolean;
  modelChanges: ModelChange[];
  steps: StepRow[];
};

export type StepListOptions = {
  filter?: string;
  toolFilter?: string;
  offset?: number;
  limit?: number;
  around?: number;
  summaryInputChars?: number;
  summaryOutputChars?: number;
};

// ─── Builder ─────────────────────────────────────────────────────────

export function buildStepList(
  sessionKey: string,
  parsed: ParsedSession,
  opts: StepListOptions = {},
): StepListResult {
  const inputMax = opts.summaryInputChars ?? 120;
  const outputMax = opts.summaryOutputChars ?? 200;

  // Apply filters
  let filtered = parsed.steps;

  if (opts.filter === "errors") {
    filtered = filtered.filter((s) => s.isError);
  } else if (opts.filter === "slow") {
    filtered = filtered.filter((s) => (s.durationMs ?? 0) > 5000);
  } else if (opts.filter === "expensive") {
    filtered = filtered.filter((s) => s.costThisTurn > 0.1 || s.tokenSummary.totalReportedTokens > 100_000);
  }

  if (opts.toolFilter) {
    filtered = filtered.filter((s) => s.tool === opts.toolFilter);
  }

  const totalSteps = filtered.length;

  // Apply pagination
  let offset = opts.offset ?? 0;
  let limit = opts.limit ?? 50;

  if (opts.around !== undefined) {
    const center = opts.around;
    const idx = filtered.findIndex((s) => s.step === center);
    if (idx >= 0) {
      offset = Math.max(0, idx - 5);
      limit = 11;
    }
  }

  const page = filtered.slice(offset, offset + limit);

  const rows: StepRow[] = page.map((step) => ({
    step: step.step,
    turn: step.turn,
    toolCallId: step.toolCallId,
    inferenceId: step.inferenceId,
    tool: step.tool,
    status: step.isError ? "error" : "ok",
    durationMs: step.durationMs,
    inputSummary: summarizeInput(step, inputMax),
    outputSummary: summarizeOutput(step, outputMax),
    contentRefs: {
      input: step.argumentRef,
      output: step.resultRefs,
      thinking: step.parentThinkingRef,
    },
    exitCode: step.exitCode,
    isError: step.isError,
    costThisTurn: step.costThisTurn,
    tokensThisTurn: step.tokensThisTurn,
    tokenSummary: step.tokenSummary,
    isSharedInferenceUsage: step.isSharedInferenceUsage,
    subagentSessionId: step.subagentSessionId,
  }));

  return {
    sessionKey,
    totalSteps,
    stepsReturned: rows.length,
    offset,
    hasMore: offset + limit < totalSteps,
    modelChanges: parsed.modelChanges,
    steps: rows,
  };
}

// ─── Summarizers ─────────────────────────────────────────────────────

function summarizeInput(step: Step, maxChars: number): string {
  const args = step.arguments;
  if (!args || typeof args !== "object") return "(no input)";

  // For common tools, pick the most informative field
  if (step.tool === "exec" && args.command) {
    return truncate(`command: '${args.command}'`, maxChars);
  }
  if ((step.tool === "read" || step.tool === "write") && args.file_path) {
    return truncate(`file_path: '${args.file_path}'`, maxChars);
  }
  if (step.tool === "read" && args.file) {
    return truncate(`file: '${args.file}'`, maxChars);
  }
  if (step.tool === "edit" && args.file) {
    return truncate(`file: '${args.file}'`, maxChars);
  }
  if (step.tool === "edit" && args.file_path) {
    return truncate(`file: '${args.file_path}'`, maxChars);
  }
  if (step.tool === "message" && args.action) {
    const target = args.channelId ?? args.to ?? "";
    return truncate(`${args.action} ${target ? `channel:${target}` : ""}`, maxChars);
  }
  if (step.tool === "sessions_spawn") {
    return truncate(`task: '${args.task ?? ""}'`, maxChars);
  }
  if (step.tool === "sessions_history") {
    return truncate(`sessionKey: '${args.sessionKey ?? args.sessionId ?? ""}'`, maxChars);
  }
  if (step.tool === "web_search" && args.query) {
    return truncate(`query: '${args.query}'`, maxChars);
  }

  // Fallback: JSON.stringify with truncation
  const json = JSON.stringify(args);
  return truncate(json, maxChars);
}

function summarizeOutput(step: Step, maxChars: number): string {
  const text = step.resultContent.map((b) => b.text).join("").trim();

  if (!text && step.exitCode === 0) return "(no output)";
  if (!text) return step.isError ? "(error, no output)" : "(no output)";

  // Prioritize error lines
  if (step.isError) {
    const errorLine = text
      .split("\n")
      .find((l) => /error|exception|traceback|failed|denied/i.test(l));
    if (errorLine) {
      return truncate(`ERROR: ${errorLine.trim()}`, maxChars);
    }
  }

  // For read results, show first line + length
  if (step.tool === "read") {
    const firstLine = text.split("\n")[0] ?? "";
    return truncate(`${firstLine} (${text.length} chars)`, maxChars);
  }

  return truncate(text.split("\n")[0] ?? text, maxChars);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

// ─── Text Formatting ─────────────────────────────────────────────────

export function formatStepListText(result: StepListResult): string {
  const lines: string[] = [];
  lines.push(`=== Execution Chain: ${result.sessionKey} (${result.totalSteps} steps) ===\n`);

  // Header
  lines.push(
    ` #   Tool                Status  Dur(ms)   Cost          Tokens  Input                                          Output`,
  );
  lines.push("-".repeat(130));

  let prevTurnCost: number | null = null;

  for (const s of result.steps) {
    const dur = s.durationMs !== null ? String(s.durationMs) : "-";
    const tokenStr = s.isSharedInferenceUsage ? `${s.tokensThisTurn.toLocaleString()}*` : s.tokensThisTurn.toLocaleString();
    const costStr = s.costThisTurn === prevTurnCost && s.isSharedInferenceUsage ? "(same)" : `$${s.costThisTurn.toFixed(3)}`;
    prevTurnCost = s.costThisTurn;

    const status = s.isError ? "ERROR" : "ok";
    const input = s.inputSummary.slice(0, 45).padEnd(45);
    const output = s.outputSummary.slice(0, 45);

    lines.push(
      `${String(s.step).padStart(3)}  ${s.tool.padEnd(18)} ${status.padEnd(7)} ${dur.padStart(7)}   ${costStr.padEnd(9)} ${tokenStr.padStart(10)} tok  ${input} ${output}`,
    );
  }

  // Model changes
  if (result.modelChanges.length > 0) {
    lines.push("");
    for (const mc of result.modelChanges) {
      lines.push(`[Model changed before step ${mc.beforeStep}: ${mc.from} → ${mc.to}]`);
    }
  }

  if (result.hasMore) {
    lines.push(`\n(${result.totalSteps - result.stepsReturned - result.offset} more steps. Use offset: ${result.offset + result.stepsReturned} to continue.)`);
  }

  return lines.join("\n");
}

export function buildStepListHints(result: StepListResult): string[] {
  const hints: string[] = [];

  const errorSteps = result.steps.filter((s) => s.isError);
  if (errorSteps.length > 0) {
    for (const e of errorSteps.slice(0, 3)) {
      hints.push(
        `Step ${e.step} failed (${e.tool}${e.exitCode !== null ? `, exitCode=${e.exitCode}` : ""}). Use chain_detail({sessionKey: "${result.sessionKey}", step: ${e.step}}) to see full input/output.`,
      );
    }
  }

  for (const mc of result.modelChanges) {
    hints.push(
      `Model changed at step ${mc.beforeStep}: ${mc.from} → ${mc.to}. This may indicate a fallback after rate limiting.`,
    );
  }

  const expensiveSteps = result.steps
    .filter((s) => s.costThisTurn > 0.1 || s.tokensThisTurn > 100_000)
    .sort((a, b) => (b.costThisTurn || b.tokensThisTurn) - (a.costThisTurn || a.tokensThisTurn));
  if (expensiveSteps.length > 0) {
    const top = expensiveSteps[0];
    hints.push(
      `Step ${top.step} (${top.tool}) used ${top.tokensThisTurn.toLocaleString()} reported tokens${top.isSharedInferenceUsage ? " shared with sibling tool calls" : ""}. Use chain_detail to investigate.`,
    );
  }

  if (hints.length === 0) {
    hints.push("All steps completed successfully. No anomalies detected.");
  }

  return hints;
}
