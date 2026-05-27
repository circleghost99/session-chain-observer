import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

import { resolveSession, listSessionsForAgent, parseTranscript } from "./transcript-parser.ts";
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

function handleApi(req: http.IncomingMessage, res: http.ServerResponse): boolean {
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
    if (!sessionKey && !agentId) {
      jsonReply(res, { error: "Provide sessionKey or agentId" }, 400);
      return true;
    }

    const metas = sessionKey
      ? (() => { const m = resolveSession(sessionKey); return m ? [m] : []; })()
      : listSessionsForAgent(agentId!, {
          hoursBack: Number(q.hoursBack) || 72,
          limit: Number(q.limit) || 10,
        });

    const summaries = metas.map((meta) => {
      try {
        const parsed = parseTranscript(meta.sessionFile);
        return buildSummary(meta, parsed);
      } catch { return null; }
    }).filter(Boolean);

    const filtered = q.statusFilter === "errors_only"
      ? summaries.filter((s: any) => s.errorSteps > 0)
      : summaries;

    jsonReply(res, { sessions: filtered, hints: buildSummaryHints(filtered as any) });
    return true;
  }

  if (pathname === "/api/steps") {
    const sessionKey = q.sessionKey?.trim();
    if (!sessionKey) { jsonReply(res, { error: "sessionKey required" }, 400); return true; }

    const meta = resolveSession(sessionKey);
    if (!meta) { jsonReply(res, { error: "Session not found" }, 404); return true; }

    const parsed = parseTranscript(meta.sessionFile);
    const result = buildStepList(meta.sessionKey, parsed, {
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
    const step = Number(q.step);
    if (!sessionKey || isNaN(step)) { jsonReply(res, { error: "sessionKey and step required" }, 400); return true; }

    const meta = resolveSession(sessionKey);
    if (!meta) { jsonReply(res, { error: "Session not found" }, 404); return true; }

    const parsed = parseTranscript(meta.sessionFile);
    const detail = buildDetail(meta.sessionKey, parsed, step);
    if (!detail) { jsonReply(res, { error: `Step ${step} not found` }, 404); return true; }

    jsonReply(res, { ...detail, hints: buildDetailHints(detail) });
    return true;
  }

  if (pathname === "/api/patterns") {
    const agentId = q.agentId?.trim();
    if (!agentId) { jsonReply(res, { error: "agentId required" }, 400); return true; }

    const result = analyzePatterns(agentId, {
      hoursBack: Number(q.hoursBack) || 168,
      limit: Number(q.limit) || 20,
      focus: q.focus || undefined,
    });

    jsonReply(res, { ...result, hints: buildPatternHints(result) });
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

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    if (!handleApi(req, res)) {
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
