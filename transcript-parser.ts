export type {
  ContentReadOptions,
  ContentReadResult,
  ContentRef,
  InferenceEvent,
  ListSessionOptions,
  ModelChange,
  ParseOptions,
  ParsedSession,
  ProviderId,
  SessionMeta,
  Step,
  TokenUsage,
} from "./src/model.js";

import type { ProviderId, ProviderOptions, SessionMeta } from "./src/model.js";
import { getProvider, listSessions, resolveSession as resolveWithProvider } from "./src/providers.js";

export async function resolveSession(
  keyOrId: string,
  provider: ProviderId = "openclaw",
  opts: ProviderOptions = {},
): Promise<SessionMeta | null> {
  const resolved = await resolveWithProvider(keyOrId, provider, opts);
  return resolved?.meta ?? null;
}

export async function resolveAnySession(
  keyOrId: string,
  provider?: ProviderId,
  opts: ProviderOptions = {},
): Promise<{ meta: SessionMeta; provider: ReturnType<typeof getProvider> } | null> {
  return resolveWithProvider(keyOrId, provider, opts);
}

export async function listSessionsForAgent(
  agentId: string,
  opts: { provider?: ProviderId; hoursBack?: number; limit?: number; sessionDir?: string } = {},
): Promise<SessionMeta[]> {
  return listSessions(opts.provider ?? "openclaw", agentId, opts);
}

export async function parseTranscript(
  metaOrPath: SessionMeta | string,
  provider: ProviderId = "openclaw",
  opts: ParseOptions = {},
) {
  const p = getProvider(provider);
  const meta = typeof metaOrPath === "string"
    ? {
        provider,
        sessionId: "",
        sessionKey: metaOrPath,
        sessionFile: metaOrPath,
        status: "done",
        model: "unknown",
        modelProvider: provider === "claude-code" ? "anthropic" : "unknown",
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        startedAt: 0,
        endedAt: 0,
        runtimeMs: 0,
        abortedLastRun: false,
        skillsUsed: [],
        updatedAt: 0,
      }
    : metaOrPath;
  return p.parseSession(meta, opts);
}

export async function readSessionContent(refId: string, provider: ProviderId = "openclaw", start?: number, chars?: number) {
  return getProvider(provider).readContent(refId, { start, chars });
}
