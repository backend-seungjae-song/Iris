import { RunManager, listScripts } from "./run.js";
import { initRunHandler, handleRun } from "./run-handler.js";
import { handleGit } from "./git-handlers.js";
import { handleArchive, initArchiveHandlers } from "./archive-handlers.js";
import { handleUsage, initUsageHandlers, usageOnConnect } from "./usage-handlers.js";
import { handleUsageHistory, initUsageHistory, stopUsageHistory, usageHistoryOnConnect } from "./usage-history-handlers.js";
import { initMemoService, handleMemoMessage, memosWire, memoNotesWire, archivesOut } from "./memo-service.js";
import { handleMemolabState, handleMemolabUI } from "./memolab-store.js";
import { handleLocaldev } from "./localdev-bridge.js";
import { agentChatOnConnect, handleAgentChat, initAgentChat } from "./agent-chat.js";
import { isPathAllowed as fsPathAllowed } from "./runtime-state.js";
import { isLoopbackRequest } from "./http-handler.js";

function runHttp(req, res, ctx) {
    const runMgr = ctx.runManager;
    if (!isLoopbackRequest(req)) { res.writeHead(403).end('{"ok":false,"error":"local only (AC5)"}'); return; }
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let j; try { j = JSON.parse(body || "{}"); } catch { res.writeHead(400).end('{"ok":false,"error":"bad json"}'); return; }
      const cmd = String(j.cmd || ""), dir = j.path;
      const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (!dir || !fsPathAllowed(dir)) return reply({ ok: false, error: "허용되지 않은 경로(스페이스 root path 필요)" });
      if (cmd === "list") return reply(listScripts(dir));
      if (cmd === "status") return reply({ ok: true, ...runMgr.status(dir) });
      if (cmd === "start") return reply(runMgr.start(dir, String(j.script || "")));
      if (cmd === "stop") return reply(runMgr.stop(dir));
      return reply({ ok: false, error: "알 수 없는 cmd: " + cmd });
    });
}

export const capabilities = [
  {
    id: "usage", wsPrefixes: ["usage."],
    init(ctx) {
      initUsageHandlers(ctx);
      initUsageHistory(ctx);
      ctx.onShutdown(stopUsageHistory);
    },
    onConnect(ws) { if (ws._local) { usageOnConnect(ws); usageHistoryOnConnect(ws); } },
    handle(ws, msg) {
      if (msg.type.startsWith("usage.history.")) { handleUsageHistory(ws, msg); return true; }
      if (msg.type.startsWith("usage.")) { handleUsage(ws, msg); return true; }
      return false;
    },
  },
  {
    id: "archive", wsPrefixes: ["archive."],
    init(ctx) { initArchiveHandlers(ctx); },
    handle(ws, msg) { if (!msg.type.startsWith("archive.")) return false; handleArchive(ws, msg); return true; },
  },
  {
    id: "run", wsPrefixes: ["run."],
    init(ctx) {
      ctx.runManager = new RunManager(ctx.broadcastLocal);
      initRunHandler({ listScripts, runManager: ctx.runManager });
      ctx.onShutdown(() => ctx.runManager.stopAll());
      ctx.onExit(() => ctx.runManager.persistPids());
    },
    handle(ws, msg) { if (!msg.type.startsWith("run.")) return false; handleRun(ws, msg); return true; },
    http: [{ method: "POST", path: "/run-cmd", handler: runHttp }],
  },
  {
    id: "sourcecontrol", wsPrefixes: ["git."],
    handle(ws, msg) { if (!msg.type.startsWith("git.")) return false; handleGit(ws, msg); return true; },
  },
  {
    id: "localdev", wsPrefixes: ["localdev."],
    handle: handleLocaldev,
  },
  {
    id: "agentchat", wsPrefixes: ["agentchat."],
    init(ctx) { initAgentChat(ctx); },
    onConnect: agentChatOnConnect,
    handle: handleAgentChat,
  },
  {
    id: "memolab", wsPrefixes: [],
    http: [
      { method: "GET", path: "/memolab-state", handler: handleMemolabState },
      { method: "PUT", path: "/memolab-state", handler: handleMemolabState },
      { method: "GET", path: "/memolab-ui", handler: handleMemolabUI },
      { method: "PUT", path: "/memolab-ui", handler: handleMemolabUI },
      { method: "GET", path: "/memolab/", prefix: true, handler: () => false },
    ],
  },
  {
    // 메모 창과 스페이스 열쇠 이관이 함께 쓰므로 본 창에서 꺼도 저장소는 유지한다.
    id: "memo", serverAlways: true, wsPrefixes: ["memo.", "memo-", "memos"],
    init(ctx) { initMemoService(ctx); },
    handle: handleMemoMessage,
    onConnect(ws) {
      ws.send(JSON.stringify(memosWire()));
      ws.send(JSON.stringify(memoNotesWire()));
      ws.send(JSON.stringify({ type: "memo-archives", archives: archivesOut() }));
    },
  },
];

// 꺼짐 판정은 부팅 한 번만 한다. HTTP 소유 경로는 꺼져도 예약해 정적 서빙으로 새지 않게 한다.
export function createCapabilityHost(hidden, ctx) {
  const active = capabilities.filter((cap) => cap.serverAlways || !hidden.has(cap.id));
  const initialized = new Set();
  const routes = capabilities.flatMap((cap) => (cap.http || []).map((route) => ({ cap, route })));
  return {
    init(always) {
      for (const cap of active) {
        if (!!cap.serverAlways !== always || initialized.has(cap.id)) continue;
        cap.init?.(ctx);
        initialized.add(cap.id);
      }
    },
    onConnect(ws) { for (const cap of active) cap.onConnect?.(ws); },
    handle(ws, msg) { return active.some((cap) => cap.handle?.(ws, msg)); },
    http(req, res, pathname) {
      const owned = routes.filter(({ route }) => route.prefix
        ? pathname.toLowerCase() === route.path.slice(0, -1).toLowerCase() || pathname.toLowerCase().startsWith(route.path.toLowerCase()) : pathname === route.path);
      if (!owned.length) return false;
      const match = owned.find(({ cap, route }) => active.includes(cap) && route.method === req.method);
      if (!match) { res.writeHead(404).end("not found"); return true; }
      return match.route.handler(req, res, ctx) !== false;
    },
  };
}
