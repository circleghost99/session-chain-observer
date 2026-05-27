import fs from "fs";
import path from "path";
import os from "os";

import { makeContentRef, readContentRef } from "./content-ref.js";
import { readJsonl } from "./jsonl.js";
import {
  emptyTokenUsage,
  normalizeTokenUsage,
  type ContentReadOptions,
  type ContentReadResult,
  type ContentRef,
  type InferenceEvent,
  type ListSessionOptions,
  type ParsedSession,
  type ParseOptions,
  type ProviderOptions,
  type SessionMeta,
  type SessionProvider,
  type Step,
  type TokenUsage,
} from "./model.js";

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function agentsDir(): string {
  return path.join(os.homedir(), ".openclaw", "agents");
}

function extractSkills(snapshot: any): string[] {
  if (!snapshot) return [];
  const skills = snapshot.resolvedSkills ?? snapshot.skills ?? [];
  return skills.map((s: any) => s.name).filter(Boolean);
}

function metaFromRecord(key: string, val: any): SessionMeta {
  return {
    provider: "openclaw",
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
    cwd: val.cwd,
  };
}

export const openClawProvider: SessionProvider = {
  id: "openclaw",

  async resolveSession(keyOrId: string, _opts: ProviderOptions = {}): Promise<SessionMeta | null> {
    const dir = agentsDir();
    if (!fs.existsSync(dir)) return null;

    const agentDirs = fs.readdirSync(dir).filter((d) => {
      const p = path.join(dir, d, "sessions", "sessions.json");
      return fs.existsSync(p);
    });

    for (const agent of agentDirs) {
      const sessionsPath = path.join(dir, agent, "sessions", "sessions.json");
      try {
        const data = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
        for (const [key, val] of Object.entries(data) as [string, any][]) {
          if (key === keyOrId || val.sessionId === keyOrId) {
            return metaFromRecord(key, val);
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  },

  async listSessions(agentId: string | undefined, opts: ListSessionOptions = {}): Promise<SessionMeta[]> {
    if (!agentId) return [];
    const sessionsPath = path.join(agentsDir(), agentId, "sessions", "sessions.json");
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

        const meta = metaFromRecord(key, val);
        if (!meta.sessionFile || !fs.existsSync(meta.sessionFile)) continue;
        sessions.push(meta);
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return sessions.slice(0, limit);
    } catch {
      return [];
    }
  },

  async parseSession(meta: SessionMeta, _opts: ParseOptions = {}): Promise<ParsedSession> {
    return parseOpenClawTranscript(meta);
  },

  async readContent(refId: string, opts: ContentReadOptions = {}): Promise<ContentReadResult> {
    return readContentRef(refId, opts);
  },
};

type PendingCall = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentRef?: ContentRef;
  turn: number;
  thinking: string | null;
  thinkingRef?: ContentRef;
  inferenceId: string;
  costThisTurn: number;
  tokensThisTurn: number;
  tokenSummary: TokenUsage;
  timestamp: number;
};

async function parseOpenClawTranscript(meta: SessionMeta): Promise<ParsedSession> {
  let sessionId = meta.sessionId || "";
  let cwd = meta.cwd ?? "";
  let startedAt = meta.startedAt ? new Date(meta.startedAt).toISOString() : "";
  let endedAt = meta.endedAt ? new Date(meta.endedAt).toISOString() : "";
  let currentModel = meta.model ?? "unknown";
  let userMessageCount = 0;
  const modelChanges = [];
  const thinkingByTurn = new Map<number, string>();
  const pendingCalls = new Map<string, PendingCall>();
  const steps: Step[] = [];
  const inferenceEvents: InferenceEvent[] = [];
  const contentRefs: ContentRef[] = [];
  let turnIndex = 0;
  let stepIndex = 0;
  let prevModel = "unknown";

  for await (const { obj, lineNo } of readJsonl(meta.sessionFile)) {
    const type = obj.type;

    if (type === "session") {
      sessionId = obj.id ?? sessionId;
      cwd = obj.cwd ?? cwd;
      startedAt = obj.timestamp ?? startedAt;
      continue;
    }

    if (type === "model_change") {
      const newModel = obj.modelId ?? obj.model ?? "unknown";
      if (prevModel !== "unknown" && prevModel !== newModel) {
        modelChanges.push({ beforeStep: stepIndex + 1, from: prevModel, to: newModel });
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
    if (obj.timestamp) endedAt = obj.timestamp;

    if (role === "user") {
      userMessageCount++;
      continue;
    }

    if (role === "assistant") {
      turnIndex++;
      const thinking = extractThinking(content);
      let thinkingRef: ContentRef | undefined;
      if (thinking) {
        thinkingByTurn.set(turnIndex, thinking);
        const idx = Array.isArray(content) ? content.findIndex((b: any) => b?.type === "thinking") : -1;
        if (idx >= 0) {
          thinkingRef = makeContentRef(meta.sessionFile, lineNo, `/message/content/${idx}/text`, thinking);
          contentRefs.push(thinkingRef);
        }
      }

      const usage = msg.usage ?? {};
      const costThisTurn = usage.cost?.total ?? 0;
      const tokenSummary = normalizeTokenUsage({
        inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0,
        outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0,
        totalReportedTokens: usage.totalTokens ?? usage.total_tokens ?? 0,
      });
      const tokensThisTurn = tokenSummary.totalReportedTokens;
      const inferenceId = `${sessionId || meta.sessionKey}:turn:${turnIndex}`;
      const linkedToolCallIds: string[] = [];

      if (Array.isArray(content)) {
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          if (block?.type !== "toolCall") continue;
          const argumentRef = makeContentRef(meta.sessionFile, lineNo, `/message/content/${idx}/arguments`, block.arguments ?? {});
          contentRefs.push(argumentRef);
          linkedToolCallIds.push(block.id);
          pendingCalls.set(block.id, {
            toolCallId: block.id,
            name: block.name,
            arguments: block.arguments ?? {},
            argumentRef,
            turn: turnIndex,
            thinking,
            thinkingRef,
            inferenceId,
            costThisTurn,
            tokensThisTurn,
            tokenSummary,
            timestamp,
          });
        }
      }

      inferenceEvents.push({
        inferenceId,
        sessionId: sessionId || meta.sessionId,
        assistantEventId: obj.id ?? obj.uuid ?? inferenceId,
        turn: turnIndex,
        model: msg.model ?? currentModel,
        tokenUsage: tokenSummary,
        costUsd: costThisTurn,
        linkedToolCallIds,
        isSubagent: false,
      });
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
      const resultContent = [];
      const resultRefs = [];
      if (Array.isArray(msg.content)) {
        for (let idx = 0; idx < msg.content.length; idx++) {
          const block = msg.content[idx];
          if (typeof block === "object" && block?.type === "text") {
            const text = String(block.text ?? "");
            const ref = makeContentRef(meta.sessionFile, lineNo, `/message/content/${idx}/text`, text);
            contentRefs.push(ref);
            resultRefs.push(ref);
            resultContent.push({ type: "text", text, ref });
          }
        }
      }

      const linkedCount = inferenceEvents.find((i) => i.inferenceId === pending.inferenceId)?.linkedToolCallIds.length ?? 1;
      steps.push({
        step: stepIndex,
        turn: pending.turn,
        toolCallId,
        tool: msg.toolName ?? pending.name,
        arguments: pending.arguments,
        argumentRef: pending.argumentRef,
        resultContent,
        resultDetails: details,
        resultRefs,
        isError,
        exitCode,
        durationMs,
        parentThinking: pending.thinking,
        parentThinkingRef: pending.thinkingRef,
        inferenceId: pending.inferenceId,
        costThisTurn: pending.costThisTurn,
        tokensThisTurn: pending.tokensThisTurn,
        tokenSummary: pending.tokenSummary,
        isSharedInferenceUsage: linkedCount > 1,
        timestamp: pending.timestamp,
      });
    }
  }

  if (!startedAt && steps[0]?.timestamp) startedAt = new Date(Number(steps[0].timestamp)).toISOString();
  if (!endedAt && steps.length > 0) endedAt = String(steps[steps.length - 1].timestamp);
  return {
    provider: "openclaw",
    sessionId: sessionId || meta.sessionId,
    sessionKey: meta.sessionKey,
    sessionFile: meta.sessionFile,
    cwd,
    startedAt,
    endedAt,
    steps,
    modelChanges,
    userMessageCount,
    currentModel,
    thinkingByTurn,
    inferenceEvents,
    contentRefs,
    subagents: [],
  };
}

function extractThinking(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b: any) => typeof b === "object" && b?.type === "thinking" && b?.text)
    .map((b: any) => String(b.text));
  return parts.length > 0 ? parts.join("\n") : null;
}
