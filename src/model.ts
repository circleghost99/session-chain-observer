export type ProviderId = "openclaw" | "claude-code";

export type TokenSource = "reported" | "estimated" | "missing";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalReportedTokens: number;
  tokenSource: TokenSource;
};

export type ContentRef = {
  refId: string;
  sourcePath: string;
  lineNo: number;
  jsonPointer: string;
  charCount: number;
  tokenEstimate: number;
  sha256: string;
  preview: string;
  truncated: boolean;
};

export type ContentBlock = {
  type: string;
  text: string;
  ref?: ContentRef;
};

export type InferenceEvent = {
  inferenceId: string;
  sessionId: string;
  assistantEventId: string;
  turn: number;
  model: string;
  tokenUsage: TokenUsage;
  costUsd: number;
  linkedToolCallIds: string[];
  isSubagent: boolean;
};

export type Step = {
  step: number;
  turn: number;
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  argumentRef?: ContentRef;
  resultContent: ContentBlock[];
  resultDetails: Record<string, unknown>;
  resultRefs: ContentRef[];
  isError: boolean;
  exitCode: number | null;
  durationMs: number | null;
  parentThinking: string | null;
  parentThinkingRef?: ContentRef;
  inferenceId: string;
  costThisTurn: number;
  tokensThisTurn: number;
  tokenSummary: TokenUsage;
  isSharedInferenceUsage: boolean;
  timestamp: number | string;
  subagentSessionId?: string;
  subagentPath?: string;
  isSubagentStep?: boolean;
};

export type ModelChange = {
  beforeStep: number;
  from: string;
  to: string;
};

export type ParsedSession = {
  provider: ProviderId;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  steps: Step[];
  modelChanges: ModelChange[];
  userMessageCount: number;
  currentModel: string;
  thinkingByTurn: Map<number, string>;
  inferenceEvents: InferenceEvent[];
  contentRefs: ContentRef[];
  subagents: SubagentLink[];
};

export type SubagentLink = {
  toolUseId: string;
  agentType: string;
  description: string;
  sessionFile: string;
  sessionId?: string;
  orphan: boolean;
};

export type SessionMeta = {
  provider: ProviderId;
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
  cwd?: string;
};

export type SessionIndexEntry = {
  provider: ProviderId;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sizeBytes: number;
  mtimeMs: number;
  updatedAt: number;
  cwd?: string;
};

export type SessionProvider = {
  id: ProviderId;
  resolveSession(keyOrId: string, opts?: ProviderOptions): Promise<SessionMeta | null>;
  listSessions(agentId: string | undefined, opts?: ListSessionOptions): Promise<SessionMeta[]>;
  parseSession(meta: SessionMeta, opts?: ParseOptions): Promise<ParsedSession>;
  readContent(refId: string, opts?: ContentReadOptions): Promise<ContentReadResult>;
};

export type ProviderOptions = {
  sessionDir?: string;
};

export type ListSessionOptions = ProviderOptions & {
  hoursBack?: number;
  limit?: number;
};

export type ParseOptions = ProviderOptions & {
  includeSubagents?: boolean;
};

export type ContentReadOptions = {
  start?: number;
  chars?: number;
};

export type ContentReadResult = {
  refId: string;
  text: string;
  start: number;
  end: number;
  charCount: number;
  hasMore: boolean;
};

export function emptyTokenUsage(source: TokenSource = "missing"): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalReportedTokens: 0,
    tokenSource: source,
  };
}

export function normalizeTokenUsage(input: Partial<TokenUsage> = {}, source: TokenSource = "reported"): TokenUsage {
  const usage = {
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheCreationInputTokens: input.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: input.cacheReadInputTokens ?? 0,
    totalReportedTokens: input.totalReportedTokens ?? 0,
    tokenSource: input.tokenSource ?? source,
  };
  if (usage.totalReportedTokens === 0) {
    usage.totalReportedTokens =
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheCreationInputTokens +
      usage.cacheReadInputTokens;
  }
  if (usage.totalReportedTokens === 0) usage.tokenSource = "missing";
  return usage;
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const tokenSource = a.tokenSource === "reported" || b.tokenSource === "reported"
    ? "reported"
    : a.tokenSource === "estimated" || b.tokenSource === "estimated"
      ? "estimated"
      : "missing";
  return normalizeTokenUsage(
    {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
      cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
      totalReportedTokens: a.totalReportedTokens + b.totalReportedTokens,
      tokenSource,
    },
    tokenSource,
  );
}
