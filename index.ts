import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  readSessionContent,
  resolveAnySession,
  type ProviderId,
  listSessionsForAgent,
  parseTranscript,
} from "./transcript-parser.js";
import { buildSummary, formatSummaryText, buildSummaryHints } from "./summary-builder.js";
import {
  buildStepList,
  formatStepListText,
  buildStepListHints,
} from "./step-builder.js";
import { buildDetail, formatDetailText, buildDetailHints } from "./detail-builder.js";
import {
  analyzePatterns,
  formatPatternText,
  buildPatternHints,
} from "./pattern-analyzer.js";

function stringEnum<T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}

type PluginConfig = {
  maxStepsPerPage?: number;
  maxDetailChars?: number;
  summaryInputChars?: number;
  summaryOutputChars?: number;
  claudeSessionDir?: string;
  debug?: boolean;
};

function providerParam(params: any): ProviderId | undefined {
  if (params.provider === "claude-code") return "claude-code";
  if (params.provider === "openclaw") return "openclaw";
  return undefined;
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const debug = cfg.debug ?? false;

  if (debug) {
    api.logger.info?.("[session-chain-observer] Plugin initialized (debug mode).");
  }

  // ─── Tool 1: chain_summary (Layer 0) ───────────────────────────────

  api.registerTool(
    () => ({
      name: "chain_summary",
      label: "Chain Summary",
      description:
        "Get a lightweight execution summary for one or more sessions. Returns success/failure status, tool call counts, error counts, cost, and which steps failed. Always start here when investigating a session.",
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({
            description: "Session key or session ID to analyze. Mutually exclusive with agentId.",
          }),
        ),
        agentId: Type.Optional(
          Type.String({
            description:
              "Agent ID to scan recent sessions for. Returns summaries for the last N sessions. Mutually exclusive with sessionKey.",
          }),
        ),
        provider: Type.Optional(
          stringEnum(["openclaw", "claude-code"] as const),
        ),
        sessionDir: Type.Optional(
          Type.String({
            description: "Optional provider-specific session directory. For Claude Code, this points at the projects directory or a custom CLAUDE_CONFIG_DIR/projects equivalent.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "When using agentId, max sessions to return. Default: 5.",
          }),
        ),
        hoursBack: Type.Optional(
          Type.Number({
            description: "When using agentId, only include sessions from the last N hours. Default: 24.",
          }),
        ),
        statusFilter: Type.Optional(
          stringEnum(["all", "errors_only"] as const),
        ),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const provider = providerParam(params);
          const sessionDir = String(params.sessionDir ?? cfg.claudeSessionDir ?? "").trim() || undefined;
          const sessionKey = String(params.sessionKey ?? "").trim();
          const agentId = String(params.agentId ?? "").trim();

          if (!sessionKey && !agentId) {
            return {
              content: [{ type: "text", text: "Error: Provide either sessionKey or agentId." }],
              details: { error: "missing_params" },
            };
          }

          const metas =
            sessionKey
              ? (() => {
                  return [];
                })()
              : await listSessionsForAgent(agentId, {
                  provider: provider ?? "openclaw",
                  hoursBack: params.hoursBack,
                  limit: params.limit,
                  sessionDir,
                });

          if (sessionKey) {
            const resolved = await resolveAnySession(sessionKey, provider, { sessionDir });
            if (resolved) metas.push(resolved.meta);
          }

          if (metas.length === 0) {
            return {
              content: [{ type: "text", text: `No sessions found for ${sessionKey || agentId}.` }],
              details: { sessions: [], hints: ["Check the agent ID or session key."] },
            };
          }

          const summaries = [];
          for (const meta of metas) {
            try {
              const parsed = await parseTranscript(meta, meta.provider, { sessionDir });
              summaries.push(buildSummary(meta, parsed));
            } catch (err: any) {
              if (debug) api.logger.error?.(`[session-chain-observer] Parse error: ${err.message}`);
            }
          }

          // Apply status filter
          const filtered =
            params.statusFilter === "errors_only"
              ? summaries.filter((s) => s.errorSteps > 0)
              : summaries;

          const text = formatSummaryText(filtered);
          const hints = buildSummaryHints(filtered);

          // Add navigation hint
          if (filtered.length > 0) {
            const firstKey = filtered[0].sessionKey;
            hints.push(
              `→ Next: Use chain_steps({sessionKey: "${firstKey}"}) to see the execution timeline.`,
            );
          }

          return {
            content: [{ type: "text", text: text + "\n\n" + hints.map((h) => `→ ${h}`).join("\n") }],
            details: { sessions: filtered, hints },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    }),
    {},
  );

  // ─── Tool 2: chain_steps (Layer 1) ─────────────────────────────────

  api.registerTool(
    () => ({
      name: "chain_steps",
      label: "Chain Steps",
      description:
        "List all tool call steps in a session as a timeline. Each step shows tool name, status, duration, truncated input/output, and cost. Use after chain_summary to understand the full execution flow, or filter to only error/slow/expensive steps.",
      parameters: Type.Object({
        sessionKey: Type.String({
          description: "Session key or session ID. Required.",
        }),
        provider: Type.Optional(
          stringEnum(["openclaw", "claude-code"] as const),
        ),
        sessionDir: Type.Optional(Type.String()),
        filter: Type.Optional(
          stringEnum(["all", "errors", "slow", "expensive"] as const),
        ),
        toolFilter: Type.Optional(
          Type.String({
            description: "Only show steps for this tool name (e.g. 'exec', 'message').",
          }),
        ),
        offset: Type.Optional(
          Type.Number({ description: "Skip first N steps for pagination. Default: 0." }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max steps to return. Default: 50." }),
        ),
        around: Type.Optional(
          Type.Number({
            description:
              "Center results around this step number, showing ±5 context steps. Overrides offset/limit.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const sessionKey = String(params.sessionKey ?? "").trim();
          const provider = providerParam(params);
          const sessionDir = String(params.sessionDir ?? cfg.claudeSessionDir ?? "").trim() || undefined;
          if (!sessionKey) {
            return {
              content: [{ type: "text", text: "Error: sessionKey is required." }],
              details: { error: "missing_session_key" },
            };
          }

          const resolved = await resolveAnySession(sessionKey, provider, { sessionDir });
          if (!resolved) {
            return {
              content: [{ type: "text", text: `Session not found: ${sessionKey}` }],
              details: { error: "session_not_found" },
            };
          }

          const parsed = await parseTranscript(resolved.meta, resolved.meta.provider, { sessionDir });
          const result = buildStepList(resolved.meta.sessionKey, parsed, {
            filter: params.filter,
            toolFilter: params.toolFilter,
            offset: params.offset,
            limit: params.limit ?? cfg.maxStepsPerPage,
            around: params.around,
            summaryInputChars: cfg.summaryInputChars,
            summaryOutputChars: cfg.summaryOutputChars,
          });

          const text = formatStepListText(result);
          const hints = buildStepListHints(result);

          return {
            content: [{ type: "text", text: text + "\n\n" + hints.map((h) => `→ ${h}`).join("\n") }],
            details: { ...result, hints },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    }),
    {},
  );

  // ─── Tool 3: chain_detail (Layer 2) ────────────────────────────────

  api.registerTool(
    () => ({
      name: "chain_detail",
      label: "Chain Detail",
      description:
        "Get complete input and output for a specific tool call step, including the agent's thinking before and after. Use after chain_steps to understand exactly what went wrong or what the agent was trying to do.",
      parameters: Type.Object({
        sessionKey: Type.String({
          description: "Session key or session ID. Required.",
        }),
        provider: Type.Optional(
          stringEnum(["openclaw", "claude-code"] as const),
        ),
        sessionDir: Type.Optional(Type.String()),
        step: Type.Number({
          description: "Step number (from chain_steps). Required.",
        }),
        includeThinking: Type.Optional(
          Type.Boolean({
            description:
              "Include agent thinking from before and after this step. Default: false.",
          }),
        ),
        includeInput: Type.Optional(Type.Boolean()),
        includeOutput: Type.Optional(Type.Boolean()),
        maxChars: Type.Optional(Type.Number()),
        includeAdjacentSteps: Type.Optional(
          Type.Boolean({
            description:
              "Include ±2 neighboring step summaries for context. Default: true.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const sessionKey = String(params.sessionKey ?? "").trim();
          const provider = providerParam(params);
          const sessionDir = String(params.sessionDir ?? cfg.claudeSessionDir ?? "").trim() || undefined;
          const step = Number(params.step);

          if (!sessionKey || isNaN(step)) {
            return {
              content: [{ type: "text", text: "Error: sessionKey and step are required." }],
              details: { error: "missing_params" },
            };
          }

          const resolved = await resolveAnySession(sessionKey, provider, { sessionDir });
          if (!resolved) {
            return {
              content: [{ type: "text", text: `Session not found: ${sessionKey}` }],
              details: { error: "session_not_found" },
            };
          }

          const parsed = await parseTranscript(resolved.meta, resolved.meta.provider, { sessionDir });
          const detail = await buildDetail(resolved.meta.sessionKey, parsed, step, {
            includeThinking: params.includeThinking,
            includeInput: params.includeInput,
            includeOutput: params.includeOutput,
            includeAdjacentSteps: params.includeAdjacentSteps,
            maxDetailChars: params.maxChars ?? cfg.maxDetailChars,
          });

          if (!detail) {
            return {
              content: [
                {
                  type: "text",
                  text: `Step ${step} not found in session ${sessionKey}. Total steps: ${parsed.steps.length}.`,
                },
              ],
              details: { error: "step_not_found", totalSteps: parsed.steps.length },
            };
          }

          const text = formatDetailText(detail);
          const hints = buildDetailHints(detail);

          return {
            content: [{ type: "text", text: text + "\n\n" + hints.map((h) => `→ ${h}`).join("\n") }],
            details: { ...detail, hints },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    }),
    {},
  );

  // ─── Tool 4: chain_patterns (Cross-session analysis) ───────────────

  api.registerTool(
    () => ({
      name: "chain_patterns",
      label: "Chain Patterns",
      description:
        "Analyze patterns across multiple sessions for an agent. Finds recurring failures, frequently failing tools, common error types, and cost trends. Use for systematic skill improvement rather than single-session debugging.",
      parameters: Type.Object({
        agentId: Type.String({
          description: "Agent ID to analyze. Required.",
        }),
        provider: Type.Optional(
          stringEnum(["openclaw", "claude-code"] as const),
        ),
        sessionDir: Type.Optional(Type.String()),
        hoursBack: Type.Optional(
          Type.Number({
            description:
              "Analyze sessions from the last N hours. Default: 168 (7 days).",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max sessions to analyze. Default: 20.",
          }),
        ),
        focus: Type.Optional(
          stringEnum(["all", "errors", "cost", "tools"] as const),
        ),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const agentId = String(params.agentId ?? "").trim();
          const provider = providerParam(params);
          const sessionDir = String(params.sessionDir ?? cfg.claudeSessionDir ?? "").trim() || undefined;
          if (!agentId) {
            return {
              content: [{ type: "text", text: "Error: agentId is required." }],
              details: { error: "missing_agent_id" },
            };
          }

          const result = await analyzePatterns(agentId, {
            provider: provider ?? "openclaw",
            hoursBack: params.hoursBack,
            limit: params.limit,
            focus: params.focus,
            sessionDir,
          });

          if (result.sessionsAnalyzed === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No sessions found for agent ${agentId} in the specified time range.`,
                },
              ],
              details: { ...result, hints: ["Try increasing hoursBack or check the agent ID."] },
            };
          }

          const text = formatPatternText(result);
          const hints = buildPatternHints(result);

          return {
            content: [{ type: "text", text: text + "\n\n" + hints.map((h) => `→ ${h}`).join("\n") }],
            details: { ...result, hints },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    }),
    {},
  );

  // ─── Tool 5: chain_content (Lazy content expansion) ────────────────

  api.registerTool(
    () => ({
      name: "chain_content",
      label: "Chain Content",
      description:
        "Read a specific lazy content reference returned by chain_steps or chain_detail. Use this for large tool inputs/outputs instead of loading raw transcript content.",
      parameters: Type.Object({
        refId: Type.String({ description: "Content reference ID from chain_steps or chain_detail." }),
        provider: Type.Optional(
          stringEnum(["openclaw", "claude-code"] as const),
        ),
        start: Type.Optional(Type.Number({ description: "Start character offset. Default: 0." })),
        chars: Type.Optional(Type.Number({ description: "Number of characters to return. Default: 8000." })),
      }),
      async execute(_toolCallId: string, params: any) {
        try {
          const provider = providerParam(params) ?? "openclaw";
          const content = await readSessionContent(
            String(params.refId ?? ""),
            provider,
            params.start,
            params.chars ?? cfg.maxDetailChars,
          );
          const suffix = content.hasMore ? `\n\n...(more available from start=${content.end})` : "";
          return {
            content: [{ type: "text", text: content.text + suffix }],
            details: content,
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    }),
    {},
  );

  api.logger.info?.("[session-chain-observer] Registered tools: chain_summary, chain_steps, chain_detail, chain_patterns, chain_content");
}
