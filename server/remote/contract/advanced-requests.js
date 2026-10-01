import { hasExactKeys, isHex, isString } from "./validate.js";

const REF = (value) => isHex(value, 16);
const RID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);
const safeText = (value, min, max) => isString(value, min, max)
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const httpUrl = (value) => {
  if (!isString(value, 1, 2048) || /[\x00-\x20\x7f]/.test(value)) return false;
  try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; }
  catch { return false; }
};
const modifiers = (value) => hasExactKeys(value, ["ctrl", "alt", "shift", "cmd"])
  && [value.ctrl, value.alt, value.shift, value.cmd].every((item) => typeof item === "boolean");
const keyName = (value) => safeText(value, 1, 24) && !/[\r\n]/.test(value);
const keyButton = (value) => hasExactKeys(value, ["id", "label", "key", "modifiers"])
  && safeText(value.id, 1, 32) && /^[A-Za-z0-9_-]+$/.test(value.id)
  && safeText(value.label, 1, 24) && keyName(value.key) && modifiers(value.modifiers);
const pointRequest = (value, type, extra = [], optional = []) => hasExactKeys(value,
  ["type", "rid", "tab", "x", "y", "width", "height", ...extra], optional)
  && value.type === type && RID(value.rid) && REF(value.tab)
  && finite(value.x, 0, 4096) && finite(value.y, 0, 4096)
  && integer(value.width, 1, 4096) && integer(value.height, 1, 4096)
  && value.x <= value.width && value.y <= value.height;

export const ADVANCED_REQUEST_TYPES = Object.freeze([
  "terminal.watch", "terminal.input", "terminal.key", "terminal.select", "terminal.mouse", "terminal.scrollback", "terminal.keys.get", "terminal.keys.set",
  "browser.tabs", "browser.frame.watch", "browser.pointer", "browser.mouse", "browser.type", "browser.key",
  "browser.scroll", "browser.history", "browser.navigate", "browser.tab.new", "browser.element",
  "browser.element.hover", "browser.element.pick", "browser.element.send", "browser.focus", "browser.dialog",
  "browser.record.start", "browser.record.pause", "browser.record.finish",
  "browser.sketch.send", "browser.draft.remove", "browser.profiles", "browser.profile.set", "browser.desktop",
  "browser.translate", "browser.bookmarks", "browser.bookmark.set", "browser.direct",
  "git.changes", "git.diff", "git.diff.draft", "github.pr", "github.check.log", "github.check.draft",
]);

const validators = new Map([
  ["terminal.watch", (v) => hasExactKeys(v, ["type", "rid", "agent"]) && RID(v.rid) && REF(v.agent)],
  ["terminal.input", (v) => hasExactKeys(v, ["type", "rid", "agent", "text"])
    && RID(v.rid) && REF(v.agent) && safeText(v.text, 1, 4000)],
  ["terminal.key", (v) => hasExactKeys(v, ["type", "rid", "agent", "key", "modifiers"])
    && RID(v.rid) && REF(v.agent) && keyName(v.key) && modifiers(v.modifiers)],
  ["terminal.select", (v) => hasExactKeys(v, ["type", "rid", "agent", "hash", "columns", "rows", "row"])
    && RID(v.rid) && REF(v.agent) && typeof v.hash === "string" && /^[0-9a-f]{64}$/.test(v.hash)
    && integer(v.columns, 1, 4096) && integer(v.rows, 1, 4096) && integer(v.row, 1, v.rows)],
  ["terminal.mouse", (v) => hasExactKeys(v, ["type", "rid", "agent", "hash", "columns", "rows", "column", "row", "action"],
    v.action === "wheel" ? ["dy"] : [])
    && RID(v.rid) && REF(v.agent) && typeof v.hash === "string" && /^[0-9a-f]{64}$/.test(v.hash)
    && integer(v.columns, 1, 4096) && integer(v.rows, 1, 4096) && integer(v.row, 1, v.rows) && integer(v.column, 1, v.columns)
    && ["click", "double", "context", "down", "drag", "up", "wheel"].includes(v.action)
    && (v.action === "wheel" ? integer(v.dy, -20000, 20000) && v.dy !== 0 : v.dy === undefined)],
  ["terminal.scrollback", (v) => hasExactKeys(v, ["type", "rid", "agent"]) && RID(v.rid) && REF(v.agent)],
  ["terminal.keys.get", (v) => hasExactKeys(v, ["type", "rid"]) && RID(v.rid)],
  ["terminal.keys.set", (v) => hasExactKeys(v, ["type", "rid", "keys"])
    && RID(v.rid) && Array.isArray(v.keys) && v.keys.length <= 24
    && new Set(v.keys.map((item) => item.id)).size === v.keys.length && v.keys.every(keyButton)],

  ["browser.tabs", (v) => hasExactKeys(v, ["type", "rid"]) && RID(v.rid)],
  ["browser.frame.watch", (v) => hasExactKeys(v, ["type", "rid", "tab", "width", "fps", "desktop"])
    && RID(v.rid) && REF(v.tab) && integer(v.width, 240, 2560) && integer(v.fps, 1, 4)
    && typeof v.desktop === "boolean"],
  ["browser.pointer", (v) => pointRequest(v, "browser.pointer", ["action"])
    && ["click", "double"].includes(v.action)],
  ["browser.mouse", (v) => pointRequest(v, "browser.mouse", ["action"], v.action === "wheel" ? ["dy"] : [])
    && ["move", "click", "double", "context", "wheel", "down", "drag", "up"].includes(v.action)
    && (v.action === "wheel" ? integer(v.dy, -20000, 20000) && v.dy !== 0 : v.dy === undefined)],
  ["browser.type", (v) => hasExactKeys(v, ["type", "rid", "tab", "text"])
    && RID(v.rid) && REF(v.tab) && safeText(v.text, 1, 4000)],
  ["browser.key", (v) => hasExactKeys(v, ["type", "rid", "tab", "key", "modifiers"])
    && RID(v.rid) && REF(v.tab) && keyName(v.key) && modifiers(v.modifiers)],
  ["browser.scroll", (v) => hasExactKeys(v, ["type", "rid", "tab", "dy"])
    && RID(v.rid) && REF(v.tab) && integer(v.dy, -20000, 20000) && v.dy !== 0],
  ["browser.history", (v) => hasExactKeys(v, ["type", "rid", "tab", "action"])
    && RID(v.rid) && REF(v.tab) && ["back", "forward", "reload"].includes(v.action)],
  ["browser.navigate", (v) => hasExactKeys(v, ["type", "rid", "tab", "url"])
    && RID(v.rid) && REF(v.tab) && httpUrl(v.url)],
  ["browser.tab.new", (v) => hasExactKeys(v, ["type", "rid", "space"], ["url", "title", "profile", "agent", "media"])
    && RID(v.rid) && REF(v.space) && (v.url === undefined || httpUrl(v.url))
    && (v.agent === undefined || REF(v.agent))
    && (v.media === undefined || REF(v.media) && REF(v.agent) && v.url === undefined)
    && (v.title === undefined || safeText(v.title, 1, 80))
    && (v.profile === undefined || safeText(v.profile, 1, 60))],
  ["browser.element", (v) => pointRequest(v, "browser.element")],
  ["browser.element.hover", (v) => pointRequest(v, "browser.element.hover")],
  ["browser.element.pick", (v) => pointRequest(v, "browser.element.pick", ["agent"])
    && REF(v.agent)],
  ["browser.element.send", (v) => pointRequest(v, "browser.element.send", ["agent", "text"])
    && REF(v.agent) && safeText(v.text, 1, 2000)],
  ["browser.focus", (v) => hasExactKeys(v, ["type", "rid", "tab"])
    && RID(v.rid) && REF(v.tab)],
  ["browser.dialog", (v) => hasExactKeys(v, ["type", "rid", "tab", "action"], v.action === "accept" ? ["text"] : [])
    && RID(v.rid) && REF(v.tab) && ["get", "accept", "cancel"].includes(v.action)
    && (v.action === "accept" ? v.text === undefined || safeText(v.text, 0, 2000) : v.text === undefined)],
  ["browser.record.start", (v) => hasExactKeys(v, ["type", "rid", "tab"])
    && RID(v.rid) && REF(v.tab)],
  ["browser.record.pause", (v) => hasExactKeys(v, ["type", "rid", "paused"])
    && RID(v.rid) && typeof v.paused === "boolean"],
  ["browser.record.finish", (v) => hasExactKeys(v, ["type", "rid", "agent"], ["note"])
    && RID(v.rid) && REF(v.agent) && (v.note === undefined || safeText(v.note, 1, 2000))],
  ["browser.sketch.send", (v) => hasExactKeys(v, ["type", "rid", "agent", "tab", "image", "text"])
    && RID(v.rid) && REF(v.agent) && REF(v.tab) && safeText(v.text, 1, 2000)
    && isString(v.image, 24, 48 * 1024) && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.image)],
  ["browser.draft.remove", (v) => hasExactKeys(v, ["type", "rid", "ref"])
    && RID(v.rid) && REF(v.ref)],
  ["browser.profiles", (v) => hasExactKeys(v, ["type", "rid"]) && RID(v.rid)],
  ["browser.profile.set", (v) => hasExactKeys(v, ["type", "rid", "tab", "profile"])
    && RID(v.rid) && REF(v.tab) && safeText(v.profile, 1, 60)],
  ["browser.desktop", (v) => hasExactKeys(v, ["type", "rid", "tab", "enabled"])
    && RID(v.rid) && REF(v.tab) && typeof v.enabled === "boolean"],
  ["browser.translate", (v) => hasExactKeys(v, ["type", "rid", "tab"])
    && RID(v.rid) && REF(v.tab)],
  ["browser.bookmarks", (v) => hasExactKeys(v, ["type", "rid", "space"])
    && RID(v.rid) && REF(v.space)],
  ["browser.bookmark.set", (v) => hasExactKeys(v, ["type", "rid", "tab", "bookmarked"])
    && RID(v.rid) && REF(v.tab) && typeof v.bookmarked === "boolean"],
  ["browser.direct", (v) => hasExactKeys(v, ["type", "rid", "tab"])
    && RID(v.rid) && REF(v.tab)],

  ["git.changes", (v) => hasExactKeys(v, ["type", "rid", "agent"])
    && RID(v.rid) && REF(v.agent)],
  ["git.diff", (v) => hasExactKeys(v, ["type", "rid", "agent", "file", "view"], ["base"])
    && RID(v.rid) && REF(v.agent) && REF(v.file) && ["working", "staged", "branch"].includes(v.view)
    && (v.base === undefined || safeText(v.base, 1, 200))],
  ["git.diff.draft", (v) => hasExactKeys(v, ["type", "rid", "agent", "file", "side", "line", "text"])
    && RID(v.rid) && REF(v.agent) && REF(v.file) && ["old", "new"].includes(v.side)
    && integer(v.line, 1, 10_000_000) && safeText(v.text, 1, 4000)],
  ["github.pr", (v) => hasExactKeys(v, ["type", "rid", "agent"])
    && RID(v.rid) && REF(v.agent)],
  ["github.check.log", (v) => hasExactKeys(v, ["type", "rid", "agent", "run"])
    && RID(v.rid) && REF(v.agent) && typeof v.run === "string" && /^\d{1,18}$/.test(v.run)],
  ["github.check.draft", (v) => hasExactKeys(v, ["type", "rid", "agent", "run"], ["text"])
    && RID(v.rid) && REF(v.agent) && typeof v.run === "string" && /^\d{1,18}$/.test(v.run)
    && (v.text === undefined || safeText(v.text, 1, 2000))],
]);

export function isAdvancedRequest(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && validators.has(value.type) && validators.get(value.type)(value);
}

export function hasAdvancedRequestType(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && validators.has(value.type);
}
