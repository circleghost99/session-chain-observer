import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDetail } from "../detail-builder.js";
import { buildStepList } from "../step-builder.js";
import { buildSummary } from "../summary-builder.js";
import { parseTranscript, readSessionContent, resolveAnySession } from "../transcript-parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures");

async function testOpenClawRegression() {
  const file = path.join(fixtures, "openclaw-session.jsonl");
  const parsed = await parseTranscript(file, "openclaw");
  assert.equal(parsed.provider, "openclaw");
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].tool, "exec");
  assert.equal(parsed.inferenceEvents.length, 1);
  assert.equal(parsed.inferenceEvents[0].tokenUsage.totalReportedTokens, 30);
  const summary = buildSummary({
    provider: "openclaw",
    sessionId: "open-1",
    sessionKey: "open-1",
    sessionFile: file,
    status: "done",
    model: "test-model",
    modelProvider: "test",
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
  }, parsed);
  assert.equal(summary.totalSteps, 1);
  assert.equal(summary.totalTokens, 30);
}

async function testClaudeProvider() {
  const sessionDir = path.join(fixtures, "claude-projects");
  const resolved = await resolveAnySession("11111111-1111-4111-8111-111111111111", "claude-code", { sessionDir });
  assert.ok(resolved);

  const parsed = await parseTranscript(resolved.meta, "claude-code", { sessionDir });
  assert.equal(parsed.provider, "claude-code");
  assert.equal(parsed.subagents.length, 1);
  assert.equal(parsed.subagents[0].toolUseId, "agent-tool");
  assert.equal(parsed.subagents[0].orphan, false);
  assert.equal(parsed.steps.length, 4);
  assert.equal(parsed.steps[0].toolCallId, "tool-1");
  assert.equal(parsed.steps[1].toolCallId, "tool-2");
  assert.equal(parsed.steps[0].inferenceId, parsed.steps[1].inferenceId);
  assert.equal(parsed.steps[0].isSharedInferenceUsage, true);
  assert.equal(parsed.inferenceEvents[0].tokenUsage.totalReportedTokens, 20);

  const steps = buildStepList(resolved.meta.sessionKey, parsed);
  assert.equal(steps.steps[0].contentRefs.output.length, 1);
  assert.equal(steps.steps[0].tokenSummary.totalReportedTokens, 20);

  const detail = await buildDetail(resolved.meta.sessionKey, parsed, 1, { includeThinking: true });
  assert.ok(detail);
  assert.equal(detail.parentThinking, "Need two tools.");
  assert.equal(detail.tokenSummary.totalReportedTokens, 20);

  const ref = steps.steps[0].contentRefs.output[0].refId;
  const content = await readSessionContent(ref, "claude-code", 0, 5);
  assert.equal(content.text, "alpha");
  assert.equal(content.hasMore, true);
}

await testOpenClawRegression();
await testClaudeProvider();
console.log("session-chain-observer tests passed");
