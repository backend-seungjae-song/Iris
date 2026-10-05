import fs from "node:fs";
import path from "node:path";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

import { createAgentDraftWriter } from "../../agent-draft.js";
import { handleGit } from "../../git-handlers.js";
import { createGithubPrHandler } from "../../github-pr-handler.js";
import { snapshot } from "../../runtime-state.js";
import { redactMacPaths, truncateUtf8 } from "../public-text.js";

function executablePath(name) {
  const candidates = process.platform === "win32"
    ? (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir.replace(/^"|"$/g, ""), `${name}.exe`))
    : [`/usr/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  return candidates.find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

function capture(handler, message) {
  const values = [];
  const ws = { _local: true, readyState: 1, send(raw) { try { values.push(JSON.parse(raw)); } catch {} } };
  const result = handler(ws, message);
  return Promise.resolve(result).then(() => values[0] || null);
}

function bounded(value, maximumBytes) {
  return truncateUtf8(redactMacPaths(value), maximumBytes);
}

function publicDiff(value, root) {
  const rootPrefix = `${root}${path.sep}`;
  const relativeHeaders = String(value ?? "").split("\n").map((line) => {
    if (!line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) return line;
    return line.split(`a${rootPrefix}`).join("a/").split(`b${rootPrefix}`).join("b/")
      .split(rootPrefix).join("");
  }).join("\n");
  const devNull = "__IRIS_DIFF_DEV_NULL__";
  return redactMacPaths(relativeHeaders.split("/dev/null").join(devNull)).split(devNull).join("/dev/null");
}

function gitSummary(root, base, execute = execFileSync, executable = executablePath("git")) {
  if (!executable || !base) return { commitCount: null, additions: null, deletions: null, files: new Map() };
  try {
    const options = { cwd: root, encoding: "utf8", timeout: 3_000, maxBuffer: 2 * 1024 * 1024 };
    const commitCount = Number(execute(executable, ["rev-list", "--count", `${base}..HEAD`], options).trim());
    const rows = execute(executable, ["diff", "--numstat", base, "--"], options).trim().split("\n").filter(Boolean);
    const files = new Map(); let additions = 0, deletions = 0;
    for (const row of rows) {
      const [added, removed, ...pathParts] = row.split("\t");
      const pathName = pathParts.join("\t");
      const plus = /^\d+$/.test(added) ? Number(added) : null;
      const minus = /^\d+$/.test(removed) ? Number(removed) : null;
      files.set(pathName, { additions: plus, deletions: minus });
      if (plus != null) additions += plus;
      if (minus != null) deletions += minus;
    }
    return { commitCount, additions, deletions, files };
  } catch {
    return { commitCount: null, additions: null, deletions: null, files: new Map() };
  }
}

export function createSourceControlFeature(options) {
  const agents = options.agents;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const getHerdr = options.getHerdr || (() => null);
  const getSnapshot = options.runtimeSnapshot || snapshot;
  const gitHandler = options.gitHandler || handleGit;
  const githubHandler = options.githubHandler || createGithubPrHandler(options.githubOptions);
  const refs = new Map(), filesByRef = new Map();
  let githubProbe = { at: 0, available: false };
  const herdrProxy = {
    paneGet(...args) { return getHerdr().paneGet(...args); },
    paneSendText(...args) { return getHerdr().paneSendText(...args); },
  };
  const draftWriter = options.draftWriter || createAgentDraftWriter({ herdr: herdrProxy, getSnapshot });

  function rootFor(agent) {
    const source = agent?.source || {};
    if (typeof source.cwd === "string" && path.isAbsolute(source.cwd)) return source.cwd;
    const workspace = (getSnapshot().workspaces || []).find((item) => item.id === source.workspaceId);
    return typeof workspace?.folder === "string" && path.isAbsolute(workspace.folder) ? workspace.folder : null;
  }

  function refFor(agentRef, root, item) {
    const key = `${agentRef}\0${root}\0${item.rel}\0${item.staged ? "s" : "w"}`;
    let ref = refs.get(key);
    for (let attempt = 0; !ref && attempt < 64; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (filesByRef.has(candidate)) continue;
      ref = candidate; refs.set(key, ref); filesByRef.set(ref, { agentRef, root, ...item });
    }
    if (!ref) throw new Error("git-ref-unavailable");
    return ref;
  }

  async function status(agentRef) {
    const agent = agents.resolve(agentRef), requested = rootFor(agent);
    if (!agent || !requested) return { ok: false, code: "forbidden" };
    const value = await capture(gitHandler, { type: "git.status", path: requested });
    if (!value?.isRepo || value.type === "git-error") return { ok: false, code: "unavailable" };
    const base = String(value.base || "").slice(0, 300);
    const summary = gitSummary(value.root, base, options.execFileSync, options.gitExecutable);
    const files = [];
    for (const [staged, list] of [[true, value.staged], [false, value.changes]]) {
      for (const item of list || []) files.push({ ref: refFor(agentRef, value.root, { rel: item.rel, oldRel: item.oldRel,
        staged, untracked: !!item.untracked }), path: String(item.rel || "").slice(0, 1000), code: item.code,
        staged, untracked: !!item.untracked, additions: summary.files.get(item.rel)?.additions ?? null,
        deletions: summary.files.get(item.rel)?.deletions ?? null });
    }
    return { ok: true, data: { branch: String(value.branch || "").slice(0, 300), ahead: Number(value.ahead) || 0,
      behind: Number(value.behind) || 0, base, commitCount: summary.commitCount, additions: summary.additions,
      deletions: summary.deletions, files: files.slice(0, 500), bases: (value.branches || []).slice(0, 200) } };
  }

  async function diff(request) {
    const agent = agents.resolve(request.agent), file = filesByRef.get(request.file);
    if (!agent || !file || file.agentRef !== request.agent) return { ok: false, code: "forbidden" };
    const message = { type: "git.diff", path: file.root, file: path.join(file.root, file.rel),
      untracked: file.untracked, staged: request.view === "staged" };
    if (request.view === "branch") { message.mode = "worktree"; message.base = request.base; message.oldRel = file.oldRel; }
    const value = await capture(gitHandler, message);
    if (!value || value.error) return { ok: false, code: "unavailable" };
    return { ok: true, file, patch: truncateUtf8(publicDiff(value.patch, file.root), 48_000) };
  }

  function draftTarget(agent) {
    const source = agent?.source || {};
    return { paneId: source.paneId, terminalId: source.terminalId, spaceId: source.workspaceId };
  }

  async function writeDraft(agentRef, requestId, text) {
    const agent = agents.resolve(agentRef);
    if (!agent) return { ok: false, code: "forbidden" };
    try { await draftWriter({ requestId, ...draftTarget(agent), text }); return { ok: true }; }
    catch { return { ok: false, code: agent.status === "working" ? "busy" : "unavailable" }; }
  }

  async function github(agentRef, operation, extra = {}) {
    const agent = agents.resolve(agentRef), requested = rootFor(agent);
    if (!agent || !requested) return { ok: false, code: "forbidden" };
    const value = await capture(githubHandler, { type: `githubpr.${operation}`, requestId: `remote-${Date.now()}`,
      path: requested, ...extra });
    if (!value?.ok) return { ok: false, code: value?.error?.code === "local_only" ? "forbidden" : "unavailable" };
    return { ok: true, data: value };
  }

  return {
    gitAvailable: () => options.gitAvailable == null ? !!executablePath("git") : !!options.gitAvailable,
    githubAvailable() {
      if (options.githubAvailable != null) return !!options.githubAvailable;
      if (Date.now() - githubProbe.at < 30_000) return githubProbe.available;
      const executable = executablePath("gh");
      let available = false;
      if (executable) {
        try { execFileSync(executable, ["auth", "status"], { timeout: 3_000, stdio: "ignore" }); available = true; }
        catch {}
      }
      githubProbe = { at: Date.now(), available };
      return available;
    },
    status,
    diff,
    async diffDraft(request) {
      const file = filesByRef.get(request.file);
      if (!file || file.agentRef !== request.agent) return { ok: false, code: "forbidden" };
      const side = request.side === "old" ? "변경 전" : "변경 후";
      return writeDraft(request.agent, `remote-diff:${request.rid}`,
        `[diff 줄 의견]\n파일: ${file.rel}\n${side} ${request.line}행\n\n${request.text}`);
    },
    async pr(agentRef) {
      const result = await github(agentRef, "status");
      if (!result.ok) return result;
      const { root: _root, ...raw } = result.data.pr || {};
      const clean = (value, maximum) => redactMacPaths(value).slice(0, maximum);
      const pr = {
        number: Number(raw.number) || 0, title: clean(raw.title, 500), url: clean(raw.url, 1000),
        state: clean(raw.state, 40), isDraft: !!raw.isDraft, head: clean(raw.head, 300), base: clean(raw.base, 300),
        author: clean(raw.author, 120), body: clean(raw.body, 20_000),
        comments: (Array.isArray(raw.comments) ? raw.comments : []).slice(-100).map((item) => ({ author: clean(item.author, 120),
          body: clean(item.body, 12_000), createdAt: clean(item.createdAt, 80), url: clean(item.url, 1000) })),
        reviews: (Array.isArray(raw.reviews) ? raw.reviews : []).slice(-100).map((item) => ({ author: clean(item.author, 120),
          body: clean(item.body, 12_000), state: clean(item.state, 40), submittedAt: clean(item.submittedAt, 80),
          url: clean(item.url, 1000) })),
        reviewComments: (Array.isArray(raw.reviewComments) ? raw.reviewComments : []).slice(0, 100).map((item) => ({ author: clean(item.author, 120),
          body: clean(item.body, 12_000), createdAt: clean(item.createdAt, 80), path: clean(item.path, 1000),
          line: Number.isSafeInteger(item.line) ? item.line : null, url: clean(item.url, 1000) })),
        files: (Array.isArray(raw.files) ? raw.files : []).slice(0, 500).map((item) => ({ path: clean(item.path, 1000),
          additions: Number(item.additions) || 0, deletions: Number(item.deletions) || 0 })),
        checks: (Array.isArray(raw.checks) ? raw.checks : []).slice(0, 150).map((item) => ({ name: clean(item.name, 200),
          conclusion: clean(item.conclusion, 40), status: clean(item.status, 40), detailsUrl: clean(item.detailsUrl, 1000),
          runId: typeof item.runId === "string" && /^\d{1,18}$/.test(item.runId) ? item.runId : null })),
        reviewCommentsLimited: !!raw.reviewCommentsLimited,
        reviewCommentsError: raw.reviewCommentsError ? clean(raw.reviewCommentsError, 300) : "",
      };
      return { ok: true, pr };
    },
    async checkLog(agentRef, run) {
      const result = await github(agentRef, "log", { runId: run });
      if (!result.ok) return result;
      return { ok: true, log: bounded(result.data.log, 40_000) };
    },
    async checkDraft(request) {
      const result = await this.checkLog(request.agent, request.run);
      if (!result.ok) return result;
      const text = [`[GitHub 검사 실패 로그 · run ${request.run}]`, request.text || "", "```", result.log.text, "```"]
        .filter(Boolean).join("\n").slice(0, 64_000);
      return writeDraft(request.agent, `remote-check:${request.rid}`, text);
    },
  };
}
