import fs from "fs";
import path from "path";
import os from "os";

import { makeContentRef, readContentRef, valueToText } from "./content-ref.js";
import { readJsonl, statFile } from "./jsonl.js";
import {
  normalizeTokenUsage,
  type ContentReadOptions,
  type ContentReadResult,
  type ContentRef,
  type InferenceEvent,
  type ListSessionOptions,
  type ParsedSession,
  type ParseOptions,
  type ProviderOptions,
  type SessionIndexEntry,
  type SessionMeta,
  type SessionProvider,
  type Step,
  type SubagentLink,
  type TokenUsage,
} from "./model.js";

const indexCache = new Map<string, { builtAt: number; entries: SessionIndexEntry[] }>();

function claudeProjectsDir(sessionDir?: string): string {
  if (sessionDir) return expandHome(sessionDir);
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? expandHome(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export const claudeCodeProvider: SessionProvider = {
  id: "claude-code",

  async resolveSession(keyOrId: string, opts: ProviderOptions = {}): Promise<SessionMeta | null> {
    const sessions = await listClaudeSessions(opts);
    const normalized = keyOrId.replace(/^claude-code:/, "");
    const found = sessions.find((s) =>
      s.sessionKey === keyOrId ||
      s.sessionKey.endsWith(normalized) ||
      s.sessionId === normalized ||
      s.sessionFile === keyOrId
    );
    return found ? metaFromIndex(found) : null;
  },

  async listSessions(_agentId: string | undefined, opts: ListSessionOptions = {}): Promise<SessionMeta[]> {
    const hoursBack = opts.hoursBack ?? 24;
    const limit = opts.limit ?? 5;
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    const entries = await listClaudeSessions(opts);
    return entries
      .filter((entry) => entry.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(metaFromIndex);
  },

  async parseSession(meta: SessionMeta, opts: ParseOptions = {}): Promise<ParsedSession> {
    return parseClaudeSession(meta, opts);
  },

  async readContent(refId: string, opts: ContentReadOptions = {}): Promise<ContentReadResult> {
    return readContentRef(refId, opts);
  },
};

async function listClaudeSessions(opts: ProviderOptions = {}): Promise<SessionIndexEntry[]> {
  const root = claudeProjectsDir(opts.sessionDir);
  if (!fs.existsSync(root)) return [];

  const cached = indexCache.get(root);
  if (cached && Date.now() - cached.builtAt < 5000) return cached.entries;

  const entries: SessionIndexEntry[] = [];
  for (const projectDir of safeReadDir(root)) {
    const projectPath = path.join(root, projectDir);
    if (!safeIsDirectory(projectPath)) continue;
    for (const fileName of safeReadDir(projectPath)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const sessionFile = path.join(projectPath, fileName);
      const sessionId = fileName.slice(0, -".jsonl".length);
      const stat = statFile(sessionFile);
      entries.push({
        provider: "claude-code",
        sessionId,
        sessionKey: `claude-code:${projectDir}:${sessionId}`,
        sessionFile,
        sizeBytes: stat.sizeBytes,
        mtimeMs: stat.mtimeMs,
        updatedAt: stat.mtimeMs,
      });
    }
  }

  indexCache.set(root, { builtAt: Date.now(), entries });
  return entries;
}

function metaFromIndex(entry: SessionIndexEntry): SessionMeta {
  return {
    provider: "claude-code",
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
    sessionFile: entry.sessionFile,
    status: "done",
    model: "unknown",
    modelProvider: "anthropic",
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    startedAt: 0,
    endedAt: entry.updatedAt,
    runtimeMs: 0,
    abortedLastRun: false,
    skillsUsed: [],
    updatedAt: entry.updatedAt,
    cwd: entry.cwd,
  };
}

async function parseClaudeSession(meta: SessionMeta, opts: ParseOptions = {}): Promise<ParsedSession> {
  const parsed = await parseClaudeJsonl(meta, { isSubagent: false });
  if (opts.includeSubagents === false) return finalizeParsed(parsed, meta);

  const links = readSubagentLinks(meta.sessionFile);
  parsed.subagents.push(...links);
  for (const link of links) {
    if (!fs.existsSync(link.sessionFile)) continue;
    const subMeta: SessionMeta = {
      ...meta,
      sessionKey: `${meta.sessionKey}:subagent:${path.basename(link.sessionFile, ".jsonl")}`,
      sessionFile: link.sessionFile,
      status: "done",
      updatedAt: fs.statSync(link.sessionFile).mtimeMs,
    };
    const subParsed = await parseClaudeJsonl(subMeta, { isSubagent: true, parentToolUseId: link.toolUseId });
    link.sessionId = subParsed.sessionId;
    link.orphan = !parsed.steps.some((s) => s.toolCallId === link.toolUseId);
    appendSubagent(parsed, subParsed, link);
  }

  return finalizeParsed(parsed, meta);
}

async function parseClaudeJsonl(
  meta: SessionMeta,
  opts: { isSubagent: boolean; parentToolUseId?: string },
): Promise<ParsedSession> {
  let sessionId = meta.sessionId;
  let cwd = meta.cwd ?? "";
  let startedAt = "";
  let endedAt = "";
  let currentModel = meta.model ?? "unknown";
  let userMessageCount = 0;
  const thinkingByTurn = new Map<number, string>();
  const pendingCalls = new Map<string, PendingCall>();
  const steps: Step[] = [];
  const inferenceEvents: InferenceEvent[] = [];
  const contentRefs: ContentRef[] = [];
  let turnIndex = 0;
  let stepIndex = 0;

  for await (const { obj, lineNo } of readJsonl(meta.sessionFile)) {
    sessionId = obj.sessionId ?? sessionId;
    cwd = obj.cwd ?? cwd;
    if (obj.timestamp) {
      if (!startedAt) startedAt = obj.timestamp;
      endedAt = obj.timestamp;
    }

    if (obj.type === "assistant") {
      turnIndex++;
      const msg = obj.message ?? {};
      currentModel = msg.model ?? currentModel;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const thinkingInfo = extractClaudeThinking(content, meta.sessionFile, lineNo);
      if (thinkingInfo.text) {
        thinkingByTurn.set(turnIndex, thinkingInfo.text);
        if (thinkingInfo.ref) contentRefs.push(thinkingInfo.ref);
      }

      const tokenSummary = claudeTokenUsage(msg.usage);
      const costThisTurn = 0;
      const tokensThisTurn = tokenSummary.totalReportedTokens;
      const inferenceId = `${sessionId || meta.sessionKey}:turn:${turnIndex}:${opts.isSubagent ? "sub" : "main"}`;
      const linkedToolCallIds: string[] = [];

      for (let idx = 0; idx < content.length; idx++) {
        const block = content[idx];
        if (block?.type !== "tool_use") continue;
        const input = block.input ?? {};
        const argumentRef = makeContentRef(meta.sessionFile, lineNo, `/message/content/${idx}/input`, input);
        contentRefs.push(argumentRef);
        linkedToolCallIds.push(block.id);
        pendingCalls.set(block.id, {
          toolCallId: block.id,
          name: block.name ?? "unknown",
          arguments: input,
          argumentRef,
          turn: turnIndex,
          thinking: thinkingInfo.text,
          thinkingRef: thinkingInfo.ref,
          inferenceId,
          costThisTurn,
          tokensThisTurn,
          tokenSummary,
          timestamp: obj.timestamp ?? "",
          isSubagentStep: opts.isSubagent,
        });
      }

      inferenceEvents.push({
        inferenceId,
        sessionId,
        assistantEventId: obj.uuid ?? msg.id ?? inferenceId,
        turn: turnIndex,
        model: currentModel,
        tokenUsage: tokenSummary,
        costUsd: costThisTurn,
        linkedToolCallIds,
        isSubagent: opts.isSubagent,
      });
      continue;
    }

    if (obj.type === "user") {
      const msg = obj.message ?? {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolResults = content
        .map((block: any, idx: number) => ({ block, idx }))
        .filter(({ block }) => block?.type === "tool_result");

      if (toolResults.length === 0) {
        if (msg.role === "user" || typeof msg.content === "string") userMessageCount++;
        continue;
      }

      for (const { block, idx } of toolResults) {
        const toolCallId = block.tool_use_id ?? "";
        const pending = pendingCalls.get(toolCallId);
        if (!pending) continue;
        pendingCalls.delete(toolCallId);
        stepIndex++;

        const details = obj.toolUseResult ?? {};
        const exitCode = extractExitCode(details);
        const durationMs = typeof details.durationMs === "number" ? details.durationMs : null;
        const isError = block.is_error === true || details.isError === true || (exitCode !== null && exitCode !== 0);
        const resultText = valueToText(block.content);
        const ref = makeContentRef(meta.sessionFile, lineNo, `/message/content/${idx}/content`, block.content);
        contentRefs.push(ref);
        const linkedCount = inferenceEvents.find((i) => i.inferenceId === pending.inferenceId)?.linkedToolCallIds.length ?? 1;

        steps.push({
          step: stepIndex,
          turn: pending.turn,
          toolCallId,
          tool: pending.name,
          arguments: pending.arguments,
          argumentRef: pending.argumentRef,
          resultContent: [{ type: "text", text: resultText, ref }],
          resultDetails: details,
          resultRefs: [ref],
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
          isSubagentStep: opts.isSubagent,
        });
      }
      continue;
    }
  }

  return {
    provider: "claude-code",
    sessionId,
    sessionKey: meta.sessionKey,
    sessionFile: meta.sessionFile,
    cwd,
    startedAt,
    endedAt,
    steps,
    modelChanges: [],
    userMessageCount,
    currentModel,
    thinkingByTurn,
    inferenceEvents,
    contentRefs,
    subagents: [],
  };
}

type PendingCall = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentRef: ContentRef;
  turn: number;
  thinking: string | null;
  thinkingRef?: ContentRef;
  inferenceId: string;
  costThisTurn: number;
  tokensThisTurn: number;
  tokenSummary: TokenUsage;
  timestamp: string;
  isSubagentStep: boolean;
};

function appendSubagent(parent: ParsedSession, child: ParsedSession, link: SubagentLink): void {
  const stepOffset = parent.steps.length;
  for (const step of child.steps) {
    parent.steps.push({
      ...step,
      step: step.step + stepOffset,
      subagentSessionId: child.sessionId,
      subagentPath: child.sessionFile,
      isSubagentStep: true,
    });
  }
  parent.inferenceEvents.push(...child.inferenceEvents);
  parent.contentRefs.push(...child.contentRefs);
  for (const [turn, thinking] of child.thinkingByTurn.entries()) {
    parent.thinkingByTurn.set(parent.thinkingByTurn.size + turn, thinking);
  }
}

function finalizeParsed(parsed: ParsedSession, meta: SessionMeta): ParsedSession {
  if (!parsed.startedAt && meta.startedAt) parsed.startedAt = new Date(meta.startedAt).toISOString();
  if (!parsed.endedAt && meta.endedAt) parsed.endedAt = new Date(meta.endedAt).toISOString();
  if (!parsed.currentModel || parsed.currentModel === "unknown") {
    const known = parsed.inferenceEvents.find((i) => i.model && i.model !== "unknown");
    if (known) parsed.currentModel = known.model;
  }
  return parsed;
}

function readSubagentLinks(mainSessionFile: string): SubagentLink[] {
  const sessionId = path.basename(mainSessionFile, ".jsonl");
  const baseDir = path.join(path.dirname(mainSessionFile), sessionId, "subagents");
  if (!fs.existsSync(baseDir)) return [];

  const links: SubagentLink[] = [];
  for (const metaName of safeReadDir(baseDir)) {
    if (!metaName.endsWith(".meta.json")) continue;
    const metaPath = path.join(baseDir, metaName);
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const jsonlPath = path.join(baseDir, metaName.slice(0, -".meta.json".length) + ".jsonl");
      links.push({
        toolUseId: raw.toolUseId ?? "",
        agentType: raw.agentType ?? "unknown",
        description: raw.description ?? "",
        sessionFile: jsonlPath,
        orphan: false,
      });
    } catch {
      continue;
    }
  }
  return links;
}

function extractClaudeThinking(content: any[], sourcePath: string, lineNo: number): { text: string | null; ref?: ContentRef } {
  const idx = content.findIndex((block) => block?.type === "thinking" && (block.text || block.thinking));
  if (idx < 0) return { text: null };
  const block = content[idx];
  const text = String(block.text ?? block.thinking ?? "");
  return {
    text,
    ref: makeContentRef(sourcePath, lineNo, `/message/content/${idx}/${block.text ? "text" : "thinking"}`, text),
  };
}

function claudeTokenUsage(usage: any): TokenUsage {
  if (!usage) return normalizeTokenUsage({}, "missing");
  return normalizeTokenUsage({
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  });
}

function extractExitCode(details: any): number | null {
  if (typeof details.exitCode === "number") return details.exitCode;
  if (typeof details.code === "number") return details.code;
  return null;
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
