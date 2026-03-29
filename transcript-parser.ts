import fs from "fs";
import path from "path";
import os from "os";

// ─── Types ───────────────────────────────────────────────────────────

export type Step = {
  step: number;
  turn: number;
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  resultContent: Array<{ type: string; text: string }>;
  resultDetails: Record<string, unknown>;
  isError: boolean;
  exitCode: number | null;
  durationMs: number | null;
  parentThinking: string | null;
  costThisTurn: number;
  tokensThisTurn: number;
  timestamp: number;
};

export type ModelChange = {
  beforeStep: number;
  from: string;
  to: string;
};

export type ParsedSession = {
  sessionId: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  steps: Step[];
  modelChanges: ModelChange[];
  userMessageCount: number;
  currentModel: string;
  /** Thinking text by turn index (turn -> thinking text) */
  thinkingByTurn: Map<number, string>;
};

export type SessionMeta = {
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  status: string;
  model: string;
  modelProvider: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  startedAt: number;
  endedAt: number;
  runtimeMs: number;
  abortedLastRun: boolean;
  skillsUsed: string[];
  updatedAt: number;
};

// ─── Helpers ─────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => typeof b === "object" && b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join("\n");
}

function extractThinking(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b: any) => typeof b === "object" && b?.type === "thinking" && b?.text)
    .map((b: any) => String(b.text));
  return parts.length > 0 ? parts.join("\n") : null;
}

// ─── Session Resolution ──────────────────────────────────────────────

/**
 * Resolve a sessionKey or sessionId to a SessionMeta by reading sessions.json.
 * Searches all agents if needed.
 */
export function resolveSession(keyOrId: string): SessionMeta | null {
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
  if (!fs.existsSync(agentsDir)) return null;

  const agentDirs = fs.readdirSync(agentsDir).filter((d) => {
    const p = path.join(agentsDir, d, "sessions", "sessions.json");
    return fs.existsSync(p);
  });

  for (const agent of agentDirs) {
    const sessionsPath = path.join(agentsDir, agent, "sessions", "sessions.json");
    try {
      const data = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      for (const [key, val] of Object.entries(data) as [string, any][]) {
        if (key === keyOrId || val.sessionId === keyOrId) {
          return {
            sessionId: val.sessionId,
            sessionKey: key,
            sessionFile: expandHome(val.sessionFile ?? ""),
            status: val.status ?? (val.abortedLastRun ? "aborted" : "done"),
            model: val.model ?? val.modelOverride ?? "unknown",
            modelProvider: val.modelProvider ?? val.providerOverride ?? "unknown",
            totalTokens: val.totalTokens ?? 0,
            inputTokens: val.inputTokens ?? 0,
            outputTokens: val.outputTokens ?? 0,
            estimatedCostUsd: val.estimatedCostUsd ?? 0,
            startedAt: val.startedAt ?? 0,
            endedAt: val.endedAt ?? 0,
            runtimeMs: val.runtimeMs ?? 0,
            abortedLastRun: val.abortedLastRun ?? false,
            skillsUsed: extractSkills(val.skillsSnapshot),
            updatedAt: val.updatedAt ?? 0,
          };
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractSkills(snapshot: any): string[] {
  if (!snapshot) return [];
  const skills = snapshot.resolvedSkills ?? snapshot.skills ?? [];
  return skills.map((s: any) => s.name).filter(Boolean);
}

/**
 * List sessions for a given agent, sorted by updatedAt desc.
 */
export function listSessionsForAgent(
  agentId: string,
  opts: { hoursBack?: number; limit?: number } = {},
): SessionMeta[] {
  const sessionsPath = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
  if (!fs.existsSync(sessionsPath)) return [];

  const hoursBack = opts.hoursBack ?? 24;
  const limit = opts.limit ?? 5;
  const cutoff = Date.now() - hoursBack * 3600 * 1000;

  try {
    const data = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const sessions: SessionMeta[] = [];

    for (const [key, val] of Object.entries(data) as [string, any][]) {
      const updatedAt = val.updatedAt ?? 0;
      if (updatedAt < cutoff) continue;

      const sessionFile = expandHome(val.sessionFile ?? "");
      if (!sessionFile || !fs.existsSync(sessionFile)) continue;

      sessions.push({
        sessionId: val.sessionId,
        sessionKey: key,
        sessionFile,
        status: val.status ?? (val.abortedLastRun ? "aborted" : "done"),
        model: val.model ?? val.modelOverride ?? "unknown",
        modelProvider: val.modelProvider ?? val.providerOverride ?? "unknown",
        totalTokens: val.totalTokens ?? 0,
        inputTokens: val.inputTokens ?? 0,
        outputTokens: val.outputTokens ?? 0,
        estimatedCostUsd: val.estimatedCostUsd ?? 0,
        startedAt: val.startedAt ?? 0,
        endedAt: val.endedAt ?? 0,
        runtimeMs: val.runtimeMs ?? 0,
        abortedLastRun: val.abortedLastRun ?? false,
        skillsUsed: extractSkills(val.skillsSnapshot),
        updatedAt,
      });
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions.slice(0, limit);
  } catch {
    return [];
  }
}

// ─── Transcript Parsing ──────────────────────────────────────────────

/**
 * Parse a session transcript .jsonl file into a structured ParsedSession.
 */
export function parseTranscript(filePath: string): ParsedSession {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  let sessionId = "";
  let cwd = "";
  let startedAt = "";
  let endedAt = "";
  let currentModel = "unknown";
  let userMessageCount = 0;

  const modelChanges: ModelChange[] = [];
  const thinkingByTurn = new Map<number, string>();

  // First pass: collect tool calls and associate them with turns
  type PendingCall = {
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    turn: number;
    thinking: string | null;
    costThisTurn: number;
    tokensThisTurn: number;
    timestamp: number;
  };

  const pendingCalls = new Map<string, PendingCall>();
  const steps: Step[] = [];
  let turnIndex = 0;
  let stepIndex = 0;
  let prevModel = "unknown";

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type;

    if (type === "session") {
      sessionId = obj.id ?? "";
      cwd = obj.cwd ?? "";
      startedAt = obj.timestamp ?? "";
      continue;
    }

    if (type === "model_change") {
      const newModel = obj.modelId ?? obj.model ?? "unknown";
      if (prevModel !== "unknown" && prevModel !== newModel) {
        modelChanges.push({
          beforeStep: stepIndex + 1,
          from: prevModel,
          to: newModel,
        });
      }
      prevModel = newModel;
      currentModel = newModel;
      continue;
    }

    if (type !== "message") continue;

    const msg = obj.message;
    if (!msg) continue;
    const role = msg.role;
    const content = msg.content;
    const timestamp = msg.timestamp ?? 0;

    // Track endedAt from the last message timestamp
    const ts = obj.timestamp ?? "";
    if (ts) endedAt = ts;

    if (role === "user") {
      userMessageCount++;
      continue;
    }

    if (role === "assistant") {
      turnIndex++;
      const thinking = extractThinking(content);
      if (thinking) {
        thinkingByTurn.set(turnIndex, thinking);
      }

      const usage = msg.usage ?? {};
      const costThisTurn = usage.cost?.total ?? 0;
      const tokensThisTurn = usage.totalTokens ?? 0;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "toolCall") {
            pendingCalls.set(block.id, {
              toolCallId: block.id,
              name: block.name,
              arguments: block.arguments ?? {},
              turn: turnIndex,
              thinking,
              costThisTurn,
              tokensThisTurn,
              timestamp,
            });
          }
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = msg.toolCallId ?? "";
      const pending = pendingCalls.get(toolCallId);
      if (!pending) continue;

      pendingCalls.delete(toolCallId);
      stepIndex++;

      const details = msg.details ?? {};
      const exitCode = typeof details.exitCode === "number" ? details.exitCode : null;
      const durationMs = typeof details.durationMs === "number" ? details.durationMs : null;
      const isError = msg.isError === true || (exitCode !== null && exitCode !== 0);

      const resultContent: Array<{ type: string; text: string }> = [];
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (typeof b === "object" && b?.type === "text") {
            resultContent.push({ type: "text", text: String(b.text ?? "") });
          }
        }
      }

      steps.push({
        step: stepIndex,
        turn: pending.turn,
        toolCallId,
        tool: msg.toolName ?? pending.name,
        arguments: pending.arguments,
        resultContent,
        resultDetails: details,
        isError,
        exitCode,
        durationMs,
        parentThinking: pending.thinking,
        costThisTurn: pending.costThisTurn,
        tokensThisTurn: pending.tokensThisTurn,
        timestamp: pending.timestamp,
      });
    }
  }

  return {
    sessionId,
    cwd,
    startedAt,
    endedAt,
    steps,
    modelChanges,
    userMessageCount,
    currentModel,
    thinkingByTurn,
  };
}
