import type { SessionMeta } from "./transcript-parser.js";
import { parseTranscript, listSessionsForAgent } from "./transcript-parser.js";
import { buildSummary, type SessionSummary } from "./summary-builder.js";

// ─── Types ───────────────────────────────────────────────────────────

export type RecurringError = {
  pattern: string;
  occurrences: number;
  sessions: string[];
  suggestion: string;
};

export type ToolUsageStat = {
  calls: number;
  errorRate: number;
  avgDurationMs: number | null;
};

export type PatternResult = {
  agentId: string;
  sessionsAnalyzed: number;
  timeRange: { from: string; to: string };
  recurringErrors: RecurringError[];
  toolUsageDistribution: Record<string, ToolUsageStat>;
  costTrend: {
    totalCost: number;
    avgPerSession: number;
    mostExpensiveSession: { key: string; cost: number } | null;
  };
};

export type PatternOptions = {
  hoursBack?: number;
  limit?: number;
  focus?: string;
};

// ─── Analyzer ────────────────────────────────────────────────────────

export function analyzePatterns(agentId: string, opts: PatternOptions = {}): PatternResult {
  const hoursBack = opts.hoursBack ?? 168;
  const limit = opts.limit ?? 20;

  const sessions = listSessionsForAgent(agentId, { hoursBack, limit });
  const summaries: SessionSummary[] = [];

  for (const meta of sessions) {
    try {
      const parsed = parseTranscript(meta.sessionFile);
      summaries.push(buildSummary(meta, parsed));
    } catch {
      continue;
    }
  }

  const timeRange = {
    from: summaries.length > 0 ? summaries[summaries.length - 1].startedAt : new Date().toISOString(),
    to: summaries.length > 0 ? summaries[0].startedAt : new Date().toISOString(),
  };

  // Aggregate tool usage
  const toolStats: Record<string, { calls: number; errors: number; durations: number[] }> = {};

  for (const meta of sessions) {
    try {
      const parsed = parseTranscript(meta.sessionFile);
      for (const step of parsed.steps) {
        if (!toolStats[step.tool]) {
          toolStats[step.tool] = { calls: 0, errors: 0, durations: [] };
        }
        toolStats[step.tool].calls++;
        if (step.isError) toolStats[step.tool].errors++;
        if (step.durationMs !== null) toolStats[step.tool].durations.push(step.durationMs);
      }
    } catch {
      continue;
    }
  }

  const toolUsageDistribution: Record<string, ToolUsageStat> = {};
  for (const [tool, stat] of Object.entries(toolStats)) {
    toolUsageDistribution[tool] = {
      calls: stat.calls,
      errorRate: stat.calls > 0 ? Math.round((stat.errors / stat.calls) * 100) / 100 : 0,
      avgDurationMs:
        stat.durations.length > 0
          ? Math.round(stat.durations.reduce((a, b) => a + b, 0) / stat.durations.length)
          : null,
    };
  }

  // Find recurring errors
  const errorPatterns = new Map<string, { sessions: Set<string>; tool: string }>();

  for (const s of summaries) {
    for (const f of s.failedTools) {
      // Normalize error pattern: tool + first significant error token
      const key = normalizeErrorPattern(f.tool, f.snippet);
      if (!errorPatterns.has(key)) {
        errorPatterns.set(key, { sessions: new Set(), tool: f.tool });
      }
      errorPatterns.get(key)!.sessions.add(s.sessionId);
    }
  }

  const recurringErrors: RecurringError[] = [];
  for (const [pattern, data] of errorPatterns) {
    if (data.sessions.size >= 2) {
      recurringErrors.push({
        pattern,
        occurrences: data.sessions.size,
        sessions: [...data.sessions].map((id) => id.slice(0, 12) + "..."),
        suggestion: suggestFix(pattern),
      });
    }
  }
  recurringErrors.sort((a, b) => b.occurrences - a.occurrences);

  // Cost trend
  let totalCost = 0;
  let mostExpensive: { key: string; cost: number } | null = null;
  for (const s of summaries) {
    totalCost += s.estimatedCostUsd;
    if (!mostExpensive || s.estimatedCostUsd > mostExpensive.cost) {
      mostExpensive = { key: s.sessionKey, cost: s.estimatedCostUsd };
    }
  }

  return {
    agentId,
    sessionsAnalyzed: summaries.length,
    timeRange,
    recurringErrors,
    toolUsageDistribution,
    costTrend: {
      totalCost: Math.round(totalCost * 100) / 100,
      avgPerSession: summaries.length > 0 ? Math.round((totalCost / summaries.length) * 100) / 100 : 0,
      mostExpensiveSession: mostExpensive,
    },
  };
}

function normalizeErrorPattern(tool: string, snippet: string): string {
  // Extract the most recognizable error type
  const moduleMatch = snippet.match(/ModuleNotFoundError:\s*No module named '([^']+)'/);
  if (moduleMatch) return `${tool}: ModuleNotFoundError (${moduleMatch[1]})`;

  const permMatch = snippet.match(/Permission denied/i);
  if (permMatch) return `${tool}: Permission denied`;

  const notFoundMatch = snippet.match(/No such file or directory/i);
  if (notFoundMatch) return `${tool}: File not found`;

  const cmdMatch = snippet.match(/command not found/i);
  if (cmdMatch) return `${tool}: Command not found`;

  const channelMatch = snippet.match(/channel.*required/i);
  if (channelMatch) return `${tool}: Channel is required`;

  // Fallback: tool + first 50 chars of snippet
  return `${tool}: ${snippet.slice(0, 50)}`;
}

function suggestFix(pattern: string): string {
  if (pattern.includes("ModuleNotFoundError")) {
    return "Add venv activation or dependency check to skill prerequisites";
  }
  if (pattern.includes("Permission denied")) {
    return "Check file permissions or working directory in skill setup";
  }
  if (pattern.includes("File not found")) {
    return "Add existence check before file operations in skill workflow";
  }
  if (pattern.includes("Command not found")) {
    return "Use full path or add availability check for external commands";
  }
  if (pattern.includes("Channel is required")) {
    return "Skill should always specify channel parameter explicitly";
  }
  return "Investigate root cause and add preventive guidance to skill";
}

// ─── Text Formatting ─────────────────────────────────────────────────

export function formatPatternText(result: PatternResult): string {
  const lines: string[] = [];
  lines.push(`=== Pattern Analysis: ${result.agentId} (${result.sessionsAnalyzed} sessions, ${formatTimeRange(result.timeRange)}) ===`);

  // Recurring errors
  if (result.recurringErrors.length > 0) {
    lines.push(`\nRecurring errors (${result.recurringErrors.length} patterns):`);
    for (let i = 0; i < result.recurringErrors.length; i++) {
      const e = result.recurringErrors[i];
      lines.push(`  ${i + 1}. ${e.pattern} — ${e.occurrences} sessions`);
      lines.push(`     → ${e.suggestion}`);
    }
  } else {
    lines.push("\nNo recurring error patterns found.");
  }

  // Tool usage
  lines.push("\nTool usage:");
  const sorted = Object.entries(result.toolUsageDistribution).sort(([, a], [, b]) => b.calls - a.calls);
  for (const [tool, stat] of sorted) {
    const dur = stat.avgDurationMs !== null ? `, avg ${stat.avgDurationMs}ms` : "";
    const errRate = stat.errorRate > 0 ? `, ${Math.round(stat.errorRate * 100)}% error rate` : "";
    lines.push(`  ${tool}: ${stat.calls} calls${errRate}${dur}`);
  }

  // Cost
  lines.push(
    `\nCost: $${result.costTrend.totalCost.toFixed(2)} total, $${result.costTrend.avgPerSession.toFixed(2)} avg/session`,
  );
  if (result.costTrend.mostExpensiveSession) {
    const me = result.costTrend.mostExpensiveSession;
    lines.push(`  Most expensive: ${me.key.slice(-40)}... ($${me.cost.toFixed(2)})`);
  }

  return lines.join("\n");
}

function formatTimeRange(range: { from: string; to: string }): string {
  try {
    const from = new Date(range.from);
    const to = new Date(range.to);
    const days = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    return `${days} days`;
  } catch {
    return "?";
  }
}

export function buildPatternHints(result: PatternResult): string[] {
  const hints: string[] = [];

  if (result.recurringErrors.length > 0) {
    const count = result.recurringErrors.length;
    hints.push(
      `${count} error pattern(s) recur across multiple sessions — these are skill improvement candidates.`,
    );
    hints.push("Use chain_summary on specific sessions, then chain_detail to get full context for fixes.");
  }

  const highErrorTools = Object.entries(result.toolUsageDistribution).filter(
    ([, stat]) => stat.errorRate > 0.1 && stat.calls >= 5,
  );
  if (highErrorTools.length > 0) {
    for (const [tool, stat] of highErrorTools) {
      hints.push(
        `${tool} has ${Math.round(stat.errorRate * 100)}% error rate across ${stat.calls} calls — review skill instructions for this tool.`,
      );
    }
  }

  if (result.costTrend.avgPerSession > 2) {
    hints.push(
      `Average session cost is $${result.costTrend.avgPerSession.toFixed(2)} — consider model downgrades for routine tasks.`,
    );
  }

  if (hints.length === 0) {
    hints.push("No significant patterns or anomalies detected across analyzed sessions.");
  }

  return hints;
}
