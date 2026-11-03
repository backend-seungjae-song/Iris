import { isErrorCode } from "./errors.js";
import { isRequestId } from "./requests.js";
import { hasExactKeys, isString } from "./validate.js";

const REF = /^[0-9a-f]{32}$/;
const AGENT_KINDS = new Set(["claude", "codex", "other", "terminal"]);
const AGENT_STATUSES = new Set(["working", "idle", "done", "blocked", "unknown"]);
const ITEM_ROLES = new Set(["user", "assistant", "tool"]);
const REQUEST_KINDS = new Set(["claude-permission", "claude-question", "browser-user", "terminal-prompt"]);

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function finite(value) {
  return Number.isFinite(value);
}

function modifiers(value) {
  return hasExactKeys(value, ["ctrl", "alt", "shift", "cmd"])
    && [value.ctrl, value.alt, value.shift, value.cmd].every((item) => typeof item === "boolean");
}

function terminalKey(value) {
  return hasExactKeys(value, ["id", "label", "key", "modifiers"], ["then"])
    && isString(value.id, 1, 32) && /^[A-Za-z0-9_-]+$/.test(value.id)
    && isString(value.label, 1, 24) && isString(value.key, 1, 24) && modifiers(value.modifiers)
    && (value.then === undefined || Array.isArray(value.then) && value.then.length >= 1 && value.then.length <= 7
      && value.then.every((step) => hasExactKeys(step, ["key", "modifiers"])
        && isString(step.key, 1, 24) && modifiers(step.modifiers)));
}

function browserSpace(value) {
  return hasExactKeys(value, ["ref", "name"]) && REF.test(value.ref) && isString(value.name, 1, 80);
}
function browserGroup(value) {
  return hasExactKeys(value, ["ref", "space", "name", "collapsed"], ["color"])
    && REF.test(value.ref) && REF.test(value.space) && isString(value.name, 1, 80)
    && typeof value.collapsed === "boolean" && (value.color === undefined || isString(value.color, 1, 32));
}

function browserTab(value) {
  return hasExactKeys(value, ["ref", "space", "title", "url", "profile", "aiControlled", "controlling", "active", "sleeping"], ["sessions", "group"])
    && REF.test(value.ref) && REF.test(value.space) && isString(value.title, 1, 200)
    && isString(value.url, 0, 2048) && isString(value.profile, 1, 60)
    && typeof value.aiControlled === "boolean" && Array.isArray(value.controlling)
    && value.controlling.length <= 100 && value.controlling.every((item) => isString(item, 1, 34))
    && (value.sessions === undefined || Array.isArray(value.sessions) && value.sessions.length <= 100 && value.sessions.every((ref) => REF.test(ref)))
    && (value.group === undefined || REF.test(value.group))
    && typeof value.active === "boolean" && typeof value.sleeping === "boolean";
}

function rect(value) {
  return hasExactKeys(value, ["x", "y", "width", "height"])
    && finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height);
}

function browserElement(value) {
  return hasExactKeys(value, ["selector", "text", "rect"])
    && isString(value.selector, 1, 2000) && isString(value.text, 0, 300) && rect(value.rect);
}

function bookmark(value) {
  return hasExactKeys(value, ["title", "url", "folder"])
    && isString(value.title, 1, 60) && isString(value.url, 1, 2048)
    && (value.folder === null || isString(value.folder, 1, 60));
}

function gitFile(value) {
  return hasExactKeys(value, ["ref", "path", "code", "staged", "untracked", "additions", "deletions"])
    && REF.test(value.ref) && isString(value.path, 1, 1000) && isString(value.code, 1, 20)
    && typeof value.staged === "boolean" && typeof value.untracked === "boolean"
    && (value.additions === null || Number.isSafeInteger(value.additions) && value.additions >= 0)
    && (value.deletions === null || Number.isSafeInteger(value.deletions) && value.deletions >= 0);
}

function prComment(value) {
  return hasExactKeys(value, ["author", "body", "createdAt", "url"])
    && isString(value.author, 0, 120) && isString(value.body, 0, 12000)
    && isString(value.createdAt, 0, 80) && isString(value.url, 0, 1000);
}

function prReview(value) {
  return hasExactKeys(value, ["author", "body", "state", "submittedAt", "url"])
    && isString(value.author, 0, 120) && isString(value.body, 0, 12000)
    && isString(value.state, 0, 40) && isString(value.submittedAt, 0, 80) && isString(value.url, 0, 1000);
}

function prReviewComment(value) {
  return hasExactKeys(value, ["author", "body", "createdAt", "path", "line", "url"])
    && isString(value.author, 0, 120) && isString(value.body, 0, 12000)
    && isString(value.createdAt, 0, 80) && isString(value.path, 0, 1000)
    && (value.line === null || Number.isSafeInteger(value.line)) && isString(value.url, 0, 1000);
}

function pullRequest(value) {
  return hasExactKeys(value, ["number", "title", "url", "state", "isDraft", "head", "base", "author", "body",
    "comments", "reviews", "reviewComments", "files", "checks", "reviewCommentsLimited", "reviewCommentsError"])
    && Number.isSafeInteger(value.number) && value.number > 0 && isString(value.title, 0, 500)
    && isString(value.url, 0, 1000) && isString(value.state, 0, 40) && typeof value.isDraft === "boolean"
    && isString(value.head, 0, 300) && isString(value.base, 0, 300) && isString(value.author, 0, 120)
    && isString(value.body, 0, 20000) && Array.isArray(value.comments) && value.comments.length <= 100
    && value.comments.every(prComment) && Array.isArray(value.reviews) && value.reviews.length <= 100
    && value.reviews.every(prReview) && Array.isArray(value.reviewComments) && value.reviewComments.length <= 100
    && value.reviewComments.every(prReviewComment) && Array.isArray(value.files) && value.files.length <= 500
    && value.files.every((item) => hasExactKeys(item, ["path", "additions", "deletions"])
      && isString(item.path, 1, 1000) && Number.isSafeInteger(item.additions) && Number.isSafeInteger(item.deletions))
    && Array.isArray(value.checks) && value.checks.length <= 150
    && value.checks.every((item) => hasExactKeys(item, ["name", "conclusion", "status", "detailsUrl", "runId"])
      && isString(item.name, 1, 200) && isString(item.conclusion, 0, 40) && isString(item.status, 0, 40)
      && isString(item.detailsUrl, 0, 1000) && (item.runId === null || /^\d{1,18}$/.test(item.runId)))
    && typeof value.reviewCommentsLimited === "boolean" && isString(value.reviewCommentsError, 0, 300);
}

export function isAgentProjection(value) {
  return hasExactKeys(value, ["ref", "name", "kind", "status", "question", "space", "spaceRef", "spaceOrder",
    "sessionOrder", "parent", "lastActivityAt", "can"])
    && REF.test(value.ref) && isString(value.name) && AGENT_KINDS.has(value.kind)
    && AGENT_STATUSES.has(value.status) && typeof value.question === "boolean"
    && isString(value.space) && REF.test(value.spaceRef) && Number.isSafeInteger(value.spaceOrder) && value.spaceOrder >= 0
    && Number.isSafeInteger(value.sessionOrder) && value.sessionOrder >= 0
    && (value.parent === null || REF.test(value.parent))
    && (value.lastActivityAt === null || timestamp(value.lastActivityAt))
    && hasExactKeys(value.can, ["stop", "message"])
    && typeof value.can.stop === "boolean" && typeof value.can.message === "boolean";
}

export function isItemProjection(value) {
  return hasExactKeys(value, ["role", "text"], ["tool", "at"])
    && ITEM_ROLES.has(value.role) && isString(value.text, 0, 4000)
    && (value.tool === undefined || isString(value.tool))
    && (value.at === undefined || timestamp(value.at));
}

const PROMPT_VARIANTS = new Set(["command", "edit", "network", "permissions", "tool", "plan", "trust", "review", "approval", "choice"]);
const PROMPT_ROLES = new Set(["allow", "allowAlways", "deny", "text", "choice", "chat"]);

function isPromptBody(body) {
  const p = body?.screen;
  if (hasExactKeys(body, ["questions", "screen"]) && p === null) return Array.isArray(body.questions)
    && (body.questions.length === 0 || isQuestionBody({ questions: body.questions }));
  return hasExactKeys(body, ["questions", "screen"]) && isQuestionBody({ questions: body.questions })
    && hasExactKeys(p, ["question", "options", "selectedRow", "multiSelect", "hash", "columns", "rows"], ["title", "detail", "variant", "step", "steps", "tool", "target"])
    && (p.step === undefined || (Number.isSafeInteger(p.step) && p.step >= 1 && p.step <= 20))
    && (p.steps === undefined || (Number.isSafeInteger(p.steps) && p.steps >= 2 && p.steps <= 20))
    && (p.title === undefined || isString(p.title, 0, 400)) && (p.detail === undefined || isString(p.detail, 0, 4000))
    && (p.tool === undefined || isString(p.tool, 1, 128)) && (p.target === undefined || isString(p.target, 1, 300))
    && (p.variant === undefined || PROMPT_VARIANTS.has(p.variant))
    && isString(p.question, 1, 1000) && /^[0-9a-f]{64}$/.test(p.hash)
    && Number.isSafeInteger(p.columns) && p.columns > 0 && p.columns <= 4096
    && Number.isSafeInteger(p.rows) && p.rows > 0 && p.rows <= 4096
    && typeof p.multiSelect === "boolean" && Array.isArray(p.options) && p.options.length >= 2 && p.options.length <= 12
    && p.options.every(o => hasExactKeys(o, ["row", "text", "selectable"], ["role", "description", "checked"]) && (o.checked === undefined || typeof o.checked === "boolean") && (o.description === undefined || isString(o.description, 0, 300)) && (o.role === undefined || PROMPT_ROLES.has(o.role)) && Number.isSafeInteger(o.row)
      && o.row > 0 && o.row <= p.rows && isString(o.text, 1, 300) && typeof o.selectable === "boolean")
    && p.options.some(o => o.row === p.selectedRow);
}

function isQuestionBody(body) {
  return hasExactKeys(body, ["questions"]) && Array.isArray(body.questions) && body.questions.length > 0
    && body.questions.every((question) => hasExactKeys(question, ["question", "header", "multiSelect", "options"])
      && isString(question.question) && isString(question.header)
      && typeof question.multiSelect === "boolean" && Array.isArray(question.options)
      && question.options.length > 0 && question.options.every((option) => hasExactKeys(option, ["label", "description"])
        && isString(option.label) && isString(option.description, 0)));
}

function isPermissionBody(body) {
  return hasExactKeys(body, ["tool", "description", "input"])
    && isString(body.tool) && isString(body.description, 0) && isString(body.input, 0);
}

function isBrowserUserBody(body) {
  return hasExactKeys(body, ["title", "text", "choices"], ["tab"])
    && isString(body.title, 1, 60) && isString(body.text, 1, 500)
    && Array.isArray(body.choices) && body.choices.length === 2
    && body.choices.every((choice) => isString(choice, 1, 20))
    && (body.tab === undefined || REF.test(body.tab));
}

export function isRequestProjection(value) {
  return hasExactKeys(value, ["ref", "agent", "kind", "createdAt", "expiresAt", "body"])
    && REF.test(value.ref) && REF.test(value.agent) && REQUEST_KINDS.has(value.kind)
    && timestamp(value.createdAt) && timestamp(value.expiresAt) && value.expiresAt > value.createdAt
    && (value.kind === "claude-permission" ? isPermissionBody(value.body)
      : value.kind === "terminal-prompt" ? isPromptBody(value.body)
      : value.kind === "claude-question" ? isQuestionBody(value.body) : isBrowserUserBody(value.body));
}

export function isErrorProjection(value) {
  return hasExactKeys(value, ["type", "error"], ["rid"])
    && value.type === "error"
    && (value.rid === undefined || isRequestId(value.rid))
    && hasExactKeys(value.error, ["code"])
    && isErrorCode(value.error.code);
}

export function isOperationProjection(value) {
  if (hasExactKeys(value, ["type", "rid"]) && value.type === "pong") return isRequestId(value.rid);
  if (hasExactKeys(value, ["type", "agents"]) && value.type === "agents") {
    return Array.isArray(value.agents) && value.agents.every(isAgentProjection);
  }
  if (hasExactKeys(value, ["type", "requests"]) && value.type === "requests") {
    return Array.isArray(value.requests) && value.requests.every(isRequestProjection);
  }
  if (hasExactKeys(value, ["type", "questions"]) && value.type === "terminal.questions") {
    return Array.isArray(value.questions) && value.questions.length <= 32
      && Buffer.byteLength(JSON.stringify(value.questions)) <= 32 * 1024
      && value.questions.every((question) => isRequestProjection(question) && ["claude-question", "terminal-prompt"].includes(question.kind));
  }
  if (hasExactKeys(value, ["type", "rid", "agent", "items", "before"]) && value.type === "transcript") {
    return isRequestId(value.rid) && REF.test(value.agent) && Array.isArray(value.items)
      && value.items.every(isItemProjection) && (value.before === null || REF.test(value.before));
  }
  if (hasExactKeys(value, ["type", "agent", "items"]) && value.type === "transcript.append") {
    return REF.test(value.agent) && Array.isArray(value.items) && value.items.length > 0
      && value.items.every(isItemProjection);
  }
  if (hasExactKeys(value, ["type", "rid", "result"]) && value.type === "agent.stop.result") {
    return isRequestId(value.rid) && ["sent", "not-working", "unsupported"].includes(value.result);
  }
  if (hasExactKeys(value, ["type", "rid", "result"]) && value.type === "agent.message.result") {
    return isRequestId(value.rid) && ["delivered", "sent", "failed", "unsupported"].includes(value.result);
  }
  if (hasExactKeys(value, ["type", "rid", "result"]) && value.type === "request.answer.result") {
    return isRequestId(value.rid) && ["delivered", "already-answered", "expired", "failed"].includes(value.result);
  }
  if (hasExactKeys(value, ["type", "rid", "result"], ["tab"]) && value.type === "remote.action.result") {
    return isRequestId(value.rid) && ["done", "unchanged", "sent"].includes(value.result)
      && (value.tab === undefined || REF.test(value.tab));
  }
  if (hasExactKeys(value, ["type", "rid", "agent", "revision", "text", "truncated"], ["hash", "columns", "rows", "mouseMode", "error"])
      && value.type === "terminal.watch.result") {
    return isRequestId(value.rid) && REF.test(value.agent) && Number.isSafeInteger(value.revision)
      && value.revision >= 0 && isString(value.text, 0, 49152) && typeof value.truncated === "boolean"
      && (value.hash === undefined || /^[0-9a-f]{64}$/.test(value.hash))
      && (value.columns === undefined || Number.isSafeInteger(value.columns) && value.columns > 0 && value.columns <= 4096)
      && (value.rows === undefined || Number.isSafeInteger(value.rows) && value.rows > 0 && value.rows <= 4096)
      && (value.mouseMode === undefined || typeof value.mouseMode === "boolean")
      && (value.error === undefined || ["terminal-frame-too-large", "terminal-layout-unavailable", "terminal-read-unavailable", "terminal-read-timeout", "terminal-screen-stale"].includes(value.error));
  }
  if (hasExactKeys(value, ["type", "agent", "revision", "text", "truncated"], ["hash", "columns", "rows", "mouseMode", "error"])
      && value.type === "terminal.frame") {
    return REF.test(value.agent) && Number.isSafeInteger(value.revision) && value.revision >= 0
      && isString(value.text, 0, 49152) && typeof value.truncated === "boolean"
      && (value.hash === undefined || /^[0-9a-f]{64}$/.test(value.hash))
      && (value.columns === undefined || Number.isSafeInteger(value.columns) && value.columns > 0 && value.columns <= 4096)
      && (value.rows === undefined || Number.isSafeInteger(value.rows) && value.rows > 0 && value.rows <= 4096)
      && (value.mouseMode === undefined || typeof value.mouseMode === "boolean")
      && (value.error === undefined || ["terminal-frame-too-large", "terminal-layout-unavailable", "terminal-read-unavailable", "terminal-read-timeout", "terminal-screen-stale"].includes(value.error));
  }
  if (hasExactKeys(value, ["type", "rid", "agent", "text", "columns", "lineCount"]) && value.type === "terminal.scrollback.result") {
    return isRequestId(value.rid) && REF.test(value.agent) && isString(value.text, 0, 49152)
      && Number.isSafeInteger(value.columns) && value.columns > 0 && value.columns <= 4096
      && Number.isSafeInteger(value.lineCount) && value.lineCount > 0 && value.lineCount <= 49153;
  }
  if (hasExactKeys(value, ["type", "rid", "keys", "defaults", "macShortcuts"])
      && value.type === "terminal.keys") {
    return isRequestId(value.rid) && Array.isArray(value.keys) && value.keys.length <= 24 && value.keys.every(terminalKey)
      && Array.isArray(value.defaults) && value.defaults.length <= 24 && value.defaults.every(terminalKey)
      && Array.isArray(value.macShortcuts) && value.macShortcuts.every((item) => hasExactKeys(item, ["id", "label", "keys"])
        && isString(item.id, 1, 100) && isString(item.label, 1, 100) && isString(item.keys, 1, 100));
  }
  if (hasExactKeys(value, ["type", "rid", "spaces", "tabs"], ["groups"]) && value.type === "browser.tabs.result") {
    return isRequestId(value.rid) && Array.isArray(value.spaces) && value.spaces.every(browserSpace)
      && (value.groups === undefined || Array.isArray(value.groups) && value.groups.every(browserGroup))
      && Array.isArray(value.tabs) && value.tabs.every(browserTab);
  }
  if (hasExactKeys(value, ["type", "rid", "tab", "watching"]) && value.type === "browser.frame.watch.result") {
    return isRequestId(value.rid) && REF.test(value.tab) && value.watching === true;
  }
  if (hasExactKeys(value, ["type", "tab", "error"]) && value.type === "browser.frame.status") {
    return REF.test(value.tab) && (value.error === null || ["browser-frame-unavailable", "browser-tab-unavailable",
      "browser-controller-unavailable", "browser-command-unavailable"].includes(value.error));
  }
  if (hasExactKeys(value, ["type", "tab", "seq", "width", "height", "jpeg"])
      && value.type === "browser.frame") {
    return REF.test(value.tab) && Number.isSafeInteger(value.seq) && value.seq > 0
      && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0
      && isString(value.jpeg, 1, 512 * 1024) && /^[A-Za-z0-9+/]+={0,2}$/.test(value.jpeg);
  }
  if (hasExactKeys(value, ["type", "rid", "element"]) && value.type === "browser.element.result") {
    return isRequestId(value.rid) && (value.element === null || browserElement(value.element));
  }
  if (hasExactKeys(value, ["type", "rid", "viewport", "element"]) && value.type === "browser.element.hover.result") {
    return isRequestId(value.rid) && hasExactKeys(value.viewport, ["width", "height"])
      && finite(value.viewport.width) && value.viewport.width > 0 && finite(value.viewport.height) && value.viewport.height > 0
      && (value.element === null || browserElement(value.element));
  }
  if (hasExactKeys(value, ["type", "rid", "editable", "kind", "multiline", "selectedText"])
      && value.type === "browser.focus.result") {
    return isRequestId(value.rid) && typeof value.editable === "boolean"
      && ["none", "text", "multiline", "select"].includes(value.kind)
      && typeof value.multiline === "boolean" && isString(value.selectedText, 0, 4000);
  }
  if (hasExactKeys(value, ["type", "rid", "dialog"]) && value.type === "browser.dialog.result") {
    return isRequestId(value.rid) && (value.dialog === null
      || hasExactKeys(value.dialog, ["kind", "message"])
      && ["alert", "confirm", "prompt", "beforeunload"].includes(value.dialog.kind)
      && isString(value.dialog.message, 0, 300));
  }
  if (hasExactKeys(value, ["type", "rid", "state", "steps", "elapsedMs"]) && value.type === "browser.record.result") {
    return isRequestId(value.rid) && ["recording", "paused", "finished"].includes(value.state)
      && Array.isArray(value.steps) && value.steps.every((step) => isString(step, 1, 500))
      && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0;
  }
  if (hasExactKeys(value, ["type", "rid", "ref", "kind", "summary", "content"])
      && value.type === "browser.draft.result") {
    return isRequestId(value.rid) && REF.test(value.ref)
      && ["element", "record", "sketch"].includes(value.kind)
      && isString(value.summary, 1, 80) && isString(value.content, 1, 128 * 1024);
  }
  if (hasExactKeys(value, ["type", "rid", "profiles"]) && value.type === "browser.profiles.result") {
    return isRequestId(value.rid) && Array.isArray(value.profiles) && value.profiles.every((name) => isString(name, 1, 60));
  }
  if (hasExactKeys(value, ["type", "rid", "bookmarks"]) && value.type === "browser.bookmarks.result") {
    return isRequestId(value.rid) && Array.isArray(value.bookmarks) && value.bookmarks.length <= 200
      && value.bookmarks.every(bookmark);
  }
  if (hasExactKeys(value, ["type", "rid", "branch", "ahead", "behind", "base", "commitCount", "additions", "deletions", "files", "bases"])
      && value.type === "git.changes.result") {
    return isRequestId(value.rid) && isString(value.branch, 0, 300) && Number.isSafeInteger(value.ahead)
      && Number.isSafeInteger(value.behind) && isString(value.base, 0, 300)
      && (value.commitCount === null || Number.isSafeInteger(value.commitCount) && value.commitCount >= 0)
      && (value.additions === null || Number.isSafeInteger(value.additions) && value.additions >= 0)
      && (value.deletions === null || Number.isSafeInteger(value.deletions) && value.deletions >= 0)
      && Array.isArray(value.files) && value.files.length <= 500
      && value.files.every(gitFile) && Array.isArray(value.bases) && value.bases.length <= 200
      && value.bases.every((base) => isString(base, 1, 300));
  }
  if (hasExactKeys(value, ["type", "rid", "file", "patch", "truncated"])
      && value.type === "git.diff.result") {
    return isRequestId(value.rid) && REF.test(value.file) && isString(value.patch, 0, 48000)
      && typeof value.truncated === "boolean";
  }
  if (hasExactKeys(value, ["type", "rid", "pr"]) && value.type === "github.pr.result") {
    return isRequestId(value.rid) && pullRequest(value.pr);
  }
  if (hasExactKeys(value, ["type", "rid", "run", "log", "truncated"])
      && value.type === "github.check.log.result") {
    return isRequestId(value.rid) && /^\d{1,18}$/.test(value.run) && isString(value.log, 0, 40000)
      && typeof value.truncated === "boolean";
  }
  return false;
}
