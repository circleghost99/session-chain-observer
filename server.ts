import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

import { readSessionContent, resolveAnySession, listSessionsForAgent, parseTranscript, type ProviderId } from "./transcript-parser.ts";
import { buildSummary, buildSummaryHints } from "./summary-builder.ts";
import { buildStepList, buildStepListHints } from "./step-builder.ts";
import { buildDetail, buildDetailHints } from "./detail-builder.ts";
import { analyzePatterns, buildPatternHints } from "./pattern-analyzer.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 18790);

// ─── Helpers ─────────────────────────────────────────────────────────

function jsonReply(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const params: Record<string, string> = {};
  for (const part of url.slice(idx + 1).split("&")) {
    const [k, v] = part.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return params;
}

function providerFromQuery(q: Record<string, string>): ProviderId | undefined {
  if (q.provider === "claude-code") return "claude-code";
  if (q.provider === "openclaw") return "openclaw";
  return undefined;
}

function listAgents(): string[] {
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((d) => {
      const sessionsFile = path.join(agentsDir, d, "sessions", "sessions.json");
      return fs.existsSync(sessionsFile);
    })
    .sort();
}

// ─── Routes ──────────────────────────────────────────────────────────

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];
  const q = parseQuery(url);

  if (pathname === "/api/agents") {
    jsonReply(res, { agents: listAgents() });
    return true;
  }

  if (pathname === "/api/summary") {
    const sessionKey = q.sessionKey?.trim();
    const agentId = q.agentId?.trim();
    const provider = providerFromQuery(q);
    const sessionDir = q.sessionDir?.trim() || undefined;
    if (!sessionKey && !agentId) {
      jsonReply(res, { error: "Provide sessionKey or agentId" }, 400);
      return true;
    }

    const metas = sessionKey
      ? []
      : await listSessionsForAgent(agentId!, {
          provider: provider ?? "openclaw",
          hoursBack: Number(q.hoursBack) || 72,
          limit: Number(q.limit) || 10,
          sessionDir,
        });
    if (sessionKey) {
      const resolved = await resolveAnySession(sessionKey, provider, { sessionDir });
      if (resolved) metas.push(resolved.meta);
    }

    const summaries = (await Promise.all(metas.map(async (meta) => {
      try {
        const parsed = await parseTranscript(meta, meta.provider, { sessionDir });
        return buildSummary(meta, parsed);
      } catch { return null; }
    }))).filter(Boolean);

    const filtered = q.statusFilter === "errors_only"
      ? summaries.filter((s: any) => s.errorSteps > 0)
      : summaries;

    jsonReply(res, { sessions: filtered, hints: buildSummaryHints(filtered as any) });
    return true;
  }

  if (pathname === "/api/steps") {
    const sessionKey = q.sessionKey?.trim();
    const provider = providerFromQuery(q);
    const sessionDir = q.sessionDir?.trim() || undefined;
    if (!sessionKey) { jsonReply(res, { error: "sessionKey required" }, 400); return true; }

    const resolved = await resolveAnySession(sessionKey, provider, { sessionDir });
    if (!resolved) { jsonReply(res, { error: "Session not found" }, 404); return true; }

    const parsed = await parseTranscript(resolved.meta, resolved.meta.provider, { sessionDir });
    const result = buildStepList(resolved.meta.sessionKey, parsed, {
      filter: q.filter || undefined,
      toolFilter: q.toolFilter || undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      limit: q.limit ? Number(q.limit) : 200,
      around: q.around ? Number(q.around) : undefined,
    });

    jsonReply(res, { ...result, hints: buildStepListHints(result) });
    return true;
  }

  if (pathname === "/api/detail") {
    const sessionKey = q.sessionKey?.trim();
    const provider = providerFromQuery(q);
    const sessionDir = q.sessionDir?.trim() || undefined;
    const step = Number(q.step);
    if (!sessionKey || isNaN(step)) { jsonReply(res, { error: "sessionKey and step required" }, 400); return true; }

    const resolved = await resolveAnySession(sessionKey, provider, { sessionDir });
    if (!resolved) { jsonReply(res, { error: "Session not found" }, 404); return true; }

    const parsed = await parseTranscript(resolved.meta, resolved.meta.provider, { sessionDir });
    const detail = await buildDetail(resolved.meta.sessionKey, parsed, step, {
      includeThinking: q.includeThinking === "true",
      includeInput: q.includeInput !== "false",
      includeOutput: q.includeOutput !== "false",
      maxDetailChars: Number(q.maxChars) || undefined,
    });
    if (!detail) { jsonReply(res, { error: `Step ${step} not found` }, 404); return true; }

    jsonReply(res, { ...detail, hints: buildDetailHints(detail) });
    return true;
  }

  if (pathname === "/api/patterns") {
    const agentId = q.agentId?.trim();
    const provider = providerFromQuery(q);
    const sessionDir = q.sessionDir?.trim() || undefined;
    if (!agentId) { jsonReply(res, { error: "agentId required" }, 400); return true; }

    const result = await analyzePatterns(agentId, {
      provider: provider ?? "openclaw",
      hoursBack: Number(q.hoursBack) || 168,
      limit: Number(q.limit) || 20,
      focus: q.focus || undefined,
      sessionDir,
    });

    jsonReply(res, { ...result, hints: buildPatternHints(result) });
    return true;
  }

  if (pathname === "/api/content") {
    const refId = q.refId?.trim();
    const provider = providerFromQuery(q);
    if (!refId) { jsonReply(res, { error: "refId required" }, 400); return true; }
    const content = await readSessionContent(refId, provider ?? "openclaw", q.start ? Number(q.start) : undefined, q.chars ? Number(q.chars) : undefined);
    jsonReply(res, content);
    return true;
  }

  return false;
}

// ─── Static file serving ─────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  let filePath = req.url?.split("?")[0] ?? "/";
  if (filePath === "/") filePath = "/index.html";

  const fullPath = path.join(__dirname, "public", filePath);
  const ext = path.extname(fullPath);

  if (!fs.existsSync(fullPath)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" });
  fs.createReadStream(fullPath).pipe(res);
}

// ─── Server ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    if (!(await handleApi(req, res))) {
      jsonReply(res, { error: "Unknown endpoint" }, 404);
    }
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Session Chain Observer UI`);
  console.log(`  http://localhost:${PORT}\n`);
});
