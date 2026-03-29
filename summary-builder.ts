import type { ParsedSession, SessionMeta } from "./transcript-parser.js";

// ─── Types ───────────────────────────────────────────────────────────

export type FailedTool = {
  tool: string;
  step: number;
  snippet: string;
};

export type SessionSummary = {
  sessionKey: string;
  sessionId: string;
  status: string;
  outcome: string;
  startedAt: string;
  endedAt: string;
  runtimeMs: number;
  model: string;
  totalTokens: number;
  estimatedCostUsd: number;
  totalSteps: number;
  errorSteps: number;
  toolBreakdown: Record<string, number>;
  failedTools: FailedTool[];
  skillsUsed: string[];
  userMessageCount: number;
};

// ─── Builder ─────────────────────────────────────────────────────────

export function buildSummary(meta: SessionMeta, parsed: ParsedSession): SessionSummary {
  const toolBreakdown: Record<string, number> = {};
  const failedTools: FailedTool[] = [];
  let errorSteps = 0;

  for (const step of parsed.steps) {
    toolBreakdown[step.tool] = (toolBreakdown[step.tool] ?? 0) + 1;

    if (step.isError) {
      errorSteps++;
      const snippet = buildErrorSnippet(step);
      failedTools.push({ tool: step.tool, step: step.step, snippet });
    }
  }

  const outcome = deriveOutcome(errorSteps, parsed.steps.length, meta.abortedLastRun);

  return {
    sessionKey: meta.sessionKey,
    sessionId: meta.sessionId,
    status: meta.status,
    outcome,
    startedAt: parsed.startedAt || new Date(meta.startedAt).toISOString(),
    endedAt: parsed.endedAt || new Date(meta.endedAt).toISOString(),
    runtimeMs: meta.runtimeMs,
    model: meta.model,
    totalTokens: meta.totalTokens,
    estimatedCostUsd: meta.estimatedCostUsd,
    totalSteps: parsed.steps.length,
    errorSteps,
    toolBreakdown,
    failedTools,
    skillsUsed: meta.skillsUsed,
    userMessageCount: parsed.userMessageCount,
  };
}

function deriveOutcome(errors: number, total: number, aborted: boolean): string {
  if (aborted) return "aborted";
  if (total === 0) return "completed";
  if (errors === 0) return "completed";
  if (errors === total) return "failed_tool";
  return "mixed";
}

function buildErrorSnippet(step: any): string {
  const parts: string[] = [];
  if (step.exitCode !== null && step.exitCode !== 0) {
    parts.push(`exit code ${step.exitCode}`);
  }
  const text = step.resultContent
    ?.map((b: any) => b.text)
    .join("")
    .trim();
  if (text) {
    // Prefer the error line
    const errorLine = text
      .split("\n")
      .find((l: string) => /error|exception|traceback|failed/i.test(l));
    parts.push((errorLine ?? text).slice(0, 100));
  }
  return parts.join(": ") || "unknown error";
}

// ─── Text Formatting ─────────────────────────────────────────────────

export function formatSummaryText(summaries: SessionSummary[]): string {
  return summaries.map(formatOneSummary).join("\n\n");
}

function formatOneSummary(s: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`=== Session Summary: ${s.sessionKey} ===`);
  lines.push(
    `Outcome: ${s.outcome}${s.errorSteps > 0 ? ` (${s.errorSteps} error${s.errorSteps > 1 ? "s" : ""} in ${s.totalSteps} steps)` : ` (${s.totalSteps} steps, all ok)`}`,
  );

  const dur = s.runtimeMs > 0 ? `${(s.runtimeMs / 1000).toFixed(1)}s` : "?";
  lines.push(`Duration: ${dur} | Model: ${s.model} | Cost: $${s.estimatedCostUsd.toFixed(2)}`);
  lines.push(`Tokens: ${s.totalTokens.toLocaleString()} | User messages: ${s.userMessageCount}`);

  const breakdown = Object.entries(s.toolBreakdown)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name}(${count})`)
    .join(" ");
  lines.push(`\nTool breakdown: ${breakdown}`);

  if (s.failedTools.length > 0) {
    lines.push("\nFailed steps:");
    for (const f of s.failedTools) {
      lines.push(`  - Step ${f.step}: ${f.tool} → ${f.snippet}`);
    }
  }

  if (s.skillsUsed.length > 0) {
    lines.push(`\nSkills: ${s.skillsUsed.join(", ")}`);
  }

  return lines.join("\n");
}

export function buildSummaryHints(summaries: SessionSummary[]): string[] {
  const hints: string[] = [];
  for (const s of summaries) {
    if (s.errorSteps > 0) {
      const failedSteps = s.failedTools.map((f) => `step ${f.step}`).join(", ");
      hints.push(
        `Session ${s.sessionKey.slice(-30)}... has ${s.errorSteps} failed step(s) (${failedSteps}). Use chain_steps({sessionKey: "${s.sessionKey}", filter: "errors"}) to see them in context.`,
      );
    }
    if (s.estimatedCostUsd > 1) {
      hints.push(`Cost is $${s.estimatedCostUsd.toFixed(2)} — consider checking if model choice was appropriate.`);
    }
  }
  if (hints.length === 0) {
    hints.push("All sessions completed without errors. Use chain_steps to review execution flow if needed.");
  }
  return hints;
}
