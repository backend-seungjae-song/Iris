import { execFile as nodeExecFile } from "node:child_process";
import { randomBytes as nodeRandomBytes, randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { mutate as mutateBrowserState, wire as browserStateWire } from "../../browser-state-owner.js";
import {
  aiTargetsSnapshot,
  cdpExecutorReady,
  controlSnapshot,
  handleFor,
  profileRefToId,
  releaseControl,
  requestCdp,
  tabMeta,
  waitForTabWc,
  wakeSleepingTab,
} from "../../browser-runtime.js";
import { noteBrowserPick } from "../../browser-commands.js";
import { issuePromptTarget } from "../../prompt-targets.js";
import { snapshot } from "../../runtime-state.js";
import { stateHome } from "../../state-home.cjs";
import { buildPageTranslateScript } from "../../../web/js/browser/page-translate.js";
import { resolvePickSource as resolveBrowserPickSource } from "../../pick-source.js";
import { MAX_BROWSER_FRAME_JPEG_BYTES } from "../contract/ipc.js";
import { resolveMedia } from "../media-links.js";
import { publicHttpUrl, redactMacPaths } from "../public-text.js";

const DRAFT_MAX_COUNT = 8;
const DRAFT_MAX_TEXT_CHARS = 128 * 1024;
const DRAFT_MAX_TOTAL_BYTES = 384 * 1024;
const ELEMENT_EXPRESSION = `((point) => {
  const el = document.elementFromPoint(point.x, point.y);
  if (!el) return null;
  const esc = (v) => CSS.escape(String(v));
  const selector = (node) => {
    if (node.id) return "#" + esc(node.id);
    const bits = [];
    for (let cur = node; cur && cur.nodeType === 1 && bits.length < 6; cur = cur.parentElement) {
      let bit = cur.tagName.toLowerCase();
      const testid = cur.getAttribute("data-testid");
      if (testid) { bits.unshift(bit + '[data-testid="' + String(testid).replace(/["\\]/g, "\\$&") + '"]'); break; }
      if (cur.parentElement) {
        const same = [...cur.parentElement.children].filter((item) => item.tagName === cur.tagName);
        if (same.length > 1) bit += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      bits.unshift(bit);
    }
    return bits.join(" > ");
  };
  const box = el.getBoundingClientRect();
  return { selector: selector(el), text: String(el.innerText || el.getAttribute("aria-label") || el.textContent || "")
    .replace(/\\s+/g, " ").trim().slice(0, 300), rect: { x: Math.round(box.x), y: Math.round(box.y),
      width: Math.round(box.width), height: Math.round(box.height) } };
})`;
const PICK_EXPRESSION = `((point) => {
  const width = innerWidth || point.width, height = innerHeight || point.height;
  const x = Math.max(0, Math.min(width, point.x * width / point.width));
  const y = Math.max(0, Math.min(height, point.y * height / point.height));
  const el = document.elementFromPoint(x, y);
  if (!el) return { viewport: { width, height }, pick: null };
  const esc = (v) => CSS.escape(String(v));
  const one = (value) => { try { return document.querySelectorAll(value).length === 1; } catch { return false; } };
  const step = (node) => {
    let value = node.tagName.toLowerCase();
    if (node.id) return value + "#" + esc(node.id);
    const classes = [...node.classList].filter(Boolean).slice(0, 2);
    if (classes.length) value += "." + classes.map(esc).join(".");
    if (node.parentElement) {
      const same = [...node.parentElement.children].filter((item) => item.tagName === node.tagName);
      if (same.length > 1) value += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    return value;
  };
  const selector = (node) => {
    if (node.id && one("#" + esc(node.id))) return "#" + esc(node.id);
    const parts = [];
    for (let cur = node; cur && cur.nodeType === 1 && parts.length < 12; cur = cur.parentElement) {
      parts.unshift(step(cur));
      const value = parts.join(" > ");
      if (one(value)) return value;
    }
    return parts.join(" > ");
  };
  const secret = /^(access_?token|id_?token|refresh_?token|token|code|auth|authorization|session|sid|password|passwd|pwd|secret|api_?key|key|signature|sig)$/i;
  const redactUrl = (raw) => { try {
    const url = new URL(raw, location.href);
    [...url.searchParams.keys()].forEach((key) => { if (secret.test(key) && url.searchParams.get(key)) url.searchParams.set(key, "REDACTED"); });
    if (url.hash && /(^|[#&])(access_token|id_token|token|code)=/i.test(url.hash)) url.hash = "#REDACTED";
    return url.href;
  } catch { return String(raw || ""); } };
  const keep = new Set(["id","href","src","alt","title","role","type","name","placeholder","value","for"]);
  const attrs = [];
  for (const attr of [...(el.attributes || [])]) {
    if (attr.name === "class" || attr.name === "style") continue;
    if (!keep.has(attr.name) && !attr.name.startsWith("data-") && !attr.name.startsWith("aria-")) continue;
    let value = attr.value || "";
    const inputType = String(el.getAttribute?.("type") || "").toLowerCase();
    if (secret.test(attr.name) || attr.name === "value" && ["password", "hidden"].includes(inputType)) value = "REDACTED";
    if (attr.name === "href" || attr.name === "src") value = redactUrl(value);
    attrs.push(attr.name + '=\"' + (value.length > 60 ? value.slice(0, 60) + "…" : value) + '\"');
    if (attrs.length >= 8) break;
  }
  let html = String(el.outerHTML || "").replace(/\\s+/g, " ");
  if (String(el.getAttribute?.("type") || "").toLowerCase() === "password") {
    html = html.replace(/(value\\s*=\\s*\")[^\"]*\"/i, '$1REDACTED\"');
  }
  const frameworkSource = (node) => { try {
    const key = Object.keys(node).find((value) => value.startsWith("__reactFiber$") || value.startsWith("__reactInternalInstance$"));
    if (key) {
      let component = null;
      for (let fiber = node[key]; fiber; fiber = fiber.return) {
        if (!component && typeof fiber.type === "function") component = fiber.type.displayName || fiber.type.name || null;
        if (fiber._debugSource?.fileName) return { file: fiber._debugSource.fileName,
          line: fiber._debugSource.lineNumber || null, component, framework: "react" };
      }
      if (component) return { component, framework: "react" };
    }
    const vue = node.__vueParentComponent;
    if (vue?.type?.__file) return { file: vue.type.__file,
      component: vue.type.__name || vue.type.name || null, framework: "vue" };
    if (node.__vue__?.$options?.__file) return { file: node.__vue__.$options.__file, framework: "vue" };
  } catch {} return null; };
  const box = el.getBoundingClientRect();
  return { viewport: { width, height }, pick: {
    tag: el.tagName.toLowerCase(), id: el.id || null, cls: [...el.classList],
    selector: selector(el), usel: selector(el),
    text: String(el.innerText || el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300),
    attrs, title: String(document.title || "").trim().slice(0, 80), html: html.slice(0, 400),
    url: redactUrl(location.href), pageUrl: redactUrl(location.href), src: frameworkSource(el),
    rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
  } };
})`;

function jpegDimensions(buffer) {
  for (let offset = 2; offset + 9 < buffer.length;) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const size = buffer.readUInt16BE(offset + 2);
    if (!size) break;
    offset += 2 + size;
  }
  return null;
}

function cleanText(value, maximum) {
  return redactMacPaths(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "").slice(0, maximum);
}

function controllerName(value) {
  const name = cleanText(value, 34);
  return /^[0-9a-f]{16,}$/i.test(name) || /^w[^:\s]{1,20}:p[^\s]{1,20}$/i.test(name)
    || /^\[내부 식별자\]$/.test(name)
    ? "에이전트" : name;
}

function flattenBookmarks(items, folder = null) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.folder) out.push(...flattenBookmarks(item.items, cleanText(item.title, 60)));
    else if (item?.url) {
      const url = publicHttpUrl(item.url);
      if (url) out.push({ title: cleanText(item.title || item.url, 60), url, folder });
    }
    if (out.length >= 200) break;
  }
  return out.slice(0, 200);
}

function sourceLines(pick) {
  const source = pick.code || null;
  const framework = pick.src || null;
  const out = [];
  const grouped = (hits) => {
    const files = new Map();
    for (const hit of hits || []) {
      if (!hit?.file) continue;
      if (!files.has(hit.file)) files.set(hit.file, []);
      files.get(hit.file).push(hit.col ? `${hit.line}:${hit.col}` : hit.line);
    }
    return [...files].map(([file, lines]) => `${file}:${lines.join(", ")}`);
  };
  const primary = (hits) => (hits || []).filter((hit) => !hit.side);
  let found = 0;
  if (framework?.file) {
    out.push(`소스: ${framework.file}${framework.line ? `:${framework.line}` : ""} (${framework.framework} dev)`);
    found++;
  } else {
    for (const line of grouped(primary(source?.markup))) { out.push(`소스: ${line}`); found++; }
  }
  for (const line of grouped(primary(source?.style))) { out.push(`스타일: ${line}`); found++; }
  for (const line of grouped(primary(source?.script))) { out.push(`동작: ${line}`); found++; }
  for (const label of ["검사", "글"]) {
    const hits = [...(source?.markup || []), ...(source?.style || []), ...(source?.script || [])]
      .filter((hit) => hit.side === label);
    for (const line of grouped(hits)) { out.push(`${label}: ${line}`); found++; }
  }
  if (framework?.component) out.push(`컴포넌트: <${framework.component}> (${framework.framework})`);
  const where = source?.host ? ` (${source.host}${source.port && source.port !== 80 && source.port !== 443 ? `:${source.port}` : ""})` : "";
  if (source?.root) {
    out.push(`기준 폴더: ${source.root}${where}${found ? "" : ` (${source.why || "이 요소를 소스에서 못 찾음"})`}`);
    if (source.copy) out.push(`돌고 있는 사본: ${source.copy}`);
  } else if (source?.local) {
    out.push(`소스: 못 찾음${where} (${source.why || "기준 폴더를 잡지 못함"})`);
  }
  return out;
}

function pickBody(pick, tab, { burst, otherTab, delimiter, handle, currentHandle }) {
  const id = pick.id ? `#${pick.id}` : "";
  const classes = pick.cls?.length ? `.${pick.cls.slice(0, 4).join(".")}` : "";
  const title = cleanText(tab.meta?.title || tab.stored?.name || pick.title || "브라우저", 200);
  const tabLabel = handle ? `@${handle}${title ? `  ${title}` : ""}` : title;
  const pageUrl = publicHttpUrl(tab.meta?.url || tab.stored?.url || pick.pageUrl || pick.url) || pick.pageUrl || pick.url;
  const lines = [
    delimiter ? `등록 구분자: ${delimiter}` : null,
    ...sourceLines(pick),
    pick.title ? `제목: ${pick.title}` : null,
    `요소: <${pick.tag}${id}${classes}>${pick.text ? ` "${pick.text}"` : ""}`,
    `선택자: ${pick.selector}`,
    pick.usel && pick.usel !== pick.selector ? `재현 선택자: ${pick.usel}` : null,
    `요소 코드: ${pick.html}`,
    burst > 1 ? `연속 ${burst}번째${otherTab ? " · 앞과 다른 탭" : ""}` : null,
    handle && currentHandle && currentHandle !== handle ? `대상 탭: @${currentHandle}` : null,
    pick.url && pageUrl && pick.url !== pageUrl ? `요소가 있는 안쪽 문서: ${pick.url}` : null,
    pick.shot ? `요소 그림: ${pick.shot}` : null,
  ].filter(Boolean);
  return [`⟦Iris⟧ 요소 선택 ${pick.pid ? `#${pick.pid} ` : ""}· 탭 ${tabLabel} · ${pageUrl}`, ...lines, "⟦/Iris⟧"].join("\n");
}

export function createBrowserFeature(options) {
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const send = options.send;
  const agents = options.agents;
  const broadcast = options.broadcast || (() => {});
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const now = options.now || Date.now;
  const stateDir = options.stateDir || stateHome();
  const runCdp = options.requestCdp || requestCdp;
  const isReady = options.cdpReady || cdpExecutorReady;
  const wakeTab = options.wakeSleepingTab || wakeSleepingTab;
  const waitTabWc = options.waitForTabWc || waitForTabWc;
  const wakeTimeoutMs = options.wakeTimeoutMs || 12_000;
  const readState = options.browserState || browserStateWire;
  const mutateState = options.mutateBrowserState || mutateBrowserState;
  const readRuntime = options.runtimeSnapshot || snapshot;
  const readTabMeta = options.tabMeta || tabMeta;
  const currentControls = options.controlSnapshot || controlSnapshot;
  const findProfileId = options.profileRefToId || profileRefToId;
  const clearControl = options.releaseControl || releaseControl;
  const captureFrame = options.captureFrame || captureJpeg;
  const resolvePickSource = options.resolvePickSource || resolveBrowserPickSource;
  const tabHandle = options.handleForTab || handleFor;
  const readAiTargets = options.aiTargetsSnapshot || aiTargetsSnapshot;
  const issueTarget = options.issuePromptTarget || issuePromptTarget;
  const rememberPick = options.noteBrowserPick || noteBrowserPick;
  const tabRefs = new Map(), tabsByRef = new Map(), spaceRefs = new Map(), spacesByRef = new Map();
  const groupRefs = new Map(), groupsByRef = new Map();
  const fileWatches = new Map();
  const recordings = new Map();
  const drafts = new Map();
  const pickBursts = new Map();
  let pickSerial = 0;

  function refFor(map, reverse, id) {
    let ref = map.get(id);
    for (let attempt = 0; !ref && attempt < 64; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (reverse.has(candidate)) continue;
      ref = candidate; map.set(id, ref); reverse.set(ref, id);
    }
    if (!ref) throw new Error("remote-ref-unavailable");
    return ref;
  }

  function profileName(profile, state) {
    if (!profile) return "기본";
    return (state.profiles || []).find((item) => item.id === profile)?.name || "프로필";
  }

  function catalog() {
    const state = readState() || {};
    const labels = new Map((readRuntime().workspaces || []).map((item) => [item.id, cleanText(item.label || "스페이스", 80)]));
    const controls = new Map((currentControls() || []).map((item) => [item.tabId, item.labels || []]));
    const spaces = [], tabs = [], groups = [], liveSpaces = new Set(), liveTabs = new Set();
    for (const [spaceId, values] of Object.entries(state.tabsBySpace || {})) {
      const space = agents.refForSpace?.(spaceId) || refFor(spaceRefs, spacesByRef, spaceId);
      spaceRefs.set(spaceId, space); spacesByRef.set(space, spaceId);
      liveSpaces.add(spaceId);
      spaces.push({ ref: space, name: labels.get(spaceId) || "스페이스" });
      for (const group of Array.isArray(state.groupsBySpace?.[spaceId]) ? state.groupsBySpace[spaceId] : []) {
        if (!group?.id) continue;
        const groupRef = refFor(groupRefs, groupsByRef, `${spaceId}:${group.id}`);
        groups.push({ ref: groupRef, space, name: cleanText(group.name || "그룹", 80),
          collapsed: group.collapsed === true, ...(group.color ? { color: cleanText(group.color, 32) } : {}) });
      }
      for (const stored of Array.isArray(values) ? values : []) {
        if (!stored?.id || stored.kind) continue;
        liveTabs.add(stored.id);
        const ref = refFor(tabRefs, tabsByRef, stored.id);
        const meta = readTabMeta(stored.id) || {};
        const controlling = (controls.get(stored.id) || []).map(controllerName).filter(Boolean);
        const sessions = [...new Set((readAiTargets() || []).filter((target) => target.space === spaceId
          && (target.group && target.group === stored.group || target.tabId === stored.id || target.held?.includes(stored.id)))
          .map((target) => agents.resolvePane?.(target.pane)?.ref).filter(Boolean))];
        const groupRef = stored.group ? refFor(groupRefs, groupsByRef, `${spaceId}:${stored.group}`) : null;
        tabs.push({ ref, space, ...(groupRef ? { group: groupRef } : {}), sessions, title: cleanText(meta.title || stored.name || stored.title || "새 탭", 200),
          url: publicHttpUrl(meta.url || stored.url), profile: profileName(stored.profile, state),
          aiControlled: controlling.length > 0, controlling, active: state.activeBySpace?.[spaceId] === stored.id,
          sleeping: meta.wc == null });
      }
    }
    for (const [id, ref] of [...tabRefs]) if (!liveTabs.has(id)) { tabRefs.delete(id); tabsByRef.delete(ref); }
    for (const [id, ref] of [...spaceRefs]) if (!liveSpaces.has(id)) { spaceRefs.delete(id); spacesByRef.delete(ref); }
    const order = new Map((agents.list?.() || []).map((agent) => [agent.spaceRef, agent.spaceOrder]));
    spaces.sort((a, b) => (order.get(a.ref) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.ref) ?? Number.MAX_SAFE_INTEGER));
    return { spaces, groups, tabs };
  }

  function resolveTab(ref) {
    const id = tabsByRef.get(ref);
    if (!id) return null;
    const state = readState();
    for (const [spaceId, tabs] of Object.entries(state.tabsBySpace || {})) {
      const stored = (tabs || []).find((item) => item?.id === id);
      if (stored) return { id, ref, spaceId, stored, meta: readTabMeta(id) || null };
    }
    return null;
  }

  async function readyTab(tabRef) {
    let tab = resolveTab(tabRef);
    if (!tab) return { ok: false, code: "forbidden" };
    if (!isReady()) return { ok: false, code: "browser-controller-unavailable" };
    if (tab.meta?.wc) return { ok: true, tab };
    wakeTab(tab.id);
    const wc = await waitTabWc(tab.id, wakeTimeoutMs);
    tab = resolveTab(tabRef);
    if (!wc || !tab?.meta?.wc) return { ok: false, code: "browser-tab-unavailable" };
    if (!isReady()) return { ok: false, code: "browser-controller-unavailable" };
    return { ok: true, tab };
  }

  async function command(tabRef, cmd, args = {}) {
    const ready = await readyTab(tabRef);
    if (!ready.ok) return ready;
    try {
      const result = await runCdp(cmd, args, ready.tab.meta.wc, 30_000);
      return result?.ok === false ? { ok: false, code: "browser-command-unavailable" }
        : { ok: true, data: result?.data || result || {} };
    } catch { return { ok: false, code: "browser-command-unavailable" }; }
  }

  async function locate(tabRef, point) {
    const tab = resolveTab(tabRef);
    if (!tab) return { ok: false, code: "forbidden" };
    const dimensions = await command(tabRef, "eval", { expression: "({width:innerWidth,height:innerHeight})" });
    if (!dimensions.ok) return dimensions;
    const size = dimensions.data?.value || dimensions.data || {};
    const x = Math.max(0, Math.min(Number(size.width) || point.width, point.x * (Number(size.width) || point.width) / point.width));
    const y = Math.max(0, Math.min(Number(size.height) || point.height, point.y * (Number(size.height) || point.height) / point.height));
    const result = await command(tabRef, "eval", { expression: `${ELEMENT_EXPRESSION}(${JSON.stringify({ x, y })})` });
    if (!result.ok) return result;
    const raw = result.data?.value || result.data || null;
    if (!raw || typeof raw !== "object") return { ok: true, element: null };
    const box = raw.rect || {};
    const selector = cleanText(raw.selector, 2000);
    if (!selector) return { ok: true, element: null };
    return { ok: true, element: { selector, text: cleanText(raw.text, 300),
      rect: { x: Number(box.x) || 0, y: Number(box.y) || 0, width: Number(box.width) || 0,
        height: Number(box.height) || 0 } } };
  }

  async function pickAt(tabRef, point) {
    if (!resolveTab(tabRef)) return { ok: false, code: "forbidden" };
    const result = await command(tabRef, "eval", { expression: `${PICK_EXPRESSION}(${JSON.stringify(point)})` });
    if (!result.ok) return result;
    const raw = result.data?.value || result.data || {};
    const viewport = raw.viewport || {};
    const width = Number(viewport.width), height = Number(viewport.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ok: false, code: "browser-command-unavailable" };
    }
    if (!raw.pick || typeof raw.pick !== "object") return { ok: true, viewport: { width, height }, element: null, pick: null };
    const value = raw.pick, box = value.rect || {};
    const selector = cleanText(value.selector, 2000);
    const tag = cleanText(value.tag, 40).toLowerCase();
    if (!selector || !tag) return { ok: true, viewport: { width, height }, element: null, pick: null };
    const pick = {
      tag, id: value.id == null ? null : cleanText(value.id, 300),
      cls: Array.isArray(value.cls) ? value.cls.slice(0, 32).map((item) => cleanText(item, 120)).filter(Boolean) : [],
      selector, usel: cleanText(value.usel || selector, 2000), text: cleanText(value.text, 300),
      attrs: Array.isArray(value.attrs) ? value.attrs.slice(0, 8).map((item) => cleanText(item, 300)) : [],
      title: cleanText(value.title, 200), html: cleanText(value.html, 1000),
      url: publicHttpUrl(value.url), pageUrl: publicHttpUrl(value.pageUrl || value.url), src: value.src || null,
      rect: { x: Number(box.x) || 0, y: Number(box.y) || 0,
        width: Math.max(0, Number(box.width) || 0), height: Math.max(0, Number(box.height) || 0) },
    };
    return { ok: true, viewport: { width, height }, pick,
      element: { selector: pick.selector, text: pick.text, rect: pick.rect } };
  }

  async function focus(tabRef) {
    const result = await command(tabRef, "phonefocus");
    if (!result.ok) return result;
    const value = result.data?.value || result.data || {};
    const kind = ["none", "text", "multiline", "select"].includes(value.kind) ? value.kind : "none";
    return { ok: true, focus: { editable: value.editable === true, kind,
      multiline: value.multiline === true, selectedText: cleanText(value.selectedText, 4000) } };
  }

  async function dialog(tabRef, action, text) {
    if (action !== "get") {
      const answered = await command(tabRef, "dialog", { answer: action === "accept" ? "ok" : "cancel",
        ...(action === "accept" && text != null ? { text } : {}) });
      if (!answered.ok) return answered;
    }
    const result = await command(tabRef, "dialoginfo");
    if (!result.ok) return result;
    const value = result.data?.dialog || result.data?.value || null;
    if (!value) return { ok: true, dialog: null };
    const kind = ["alert", "confirm", "prompt", "beforeunload"].includes(value.kind || value.type)
      ? (value.kind || value.type) : "alert";
    return { ok: true, dialog: { kind, message: cleanText(value.message, 300) } };
  }

  async function pagePoint(tabRef, point) {
    const dimensions = await command(tabRef, "eval", { expression: "({width:innerWidth,height:innerHeight})" });
    if (!dimensions.ok) return dimensions;
    const size = dimensions.data?.value || dimensions.data || {};
    const width = Number(size.width) || point.width;
    const height = Number(size.height) || point.height;
    return { ok: true,
      x: Math.max(0, Math.min(width, point.x * width / point.width)),
      y: Math.max(0, Math.min(height, point.y * height / point.height)) };
  }

  function note(connId, line) {
    const record = recordings.get(connId);
    if (!record || record.paused || record.steps.length >= 200) return;
    record.steps.push(cleanText(line, 500));
  }

  async function captureJpeg(tab, width, desktop, record) {
    const result = await command(tab.ref, "screenshot", { settle: 0 });
    const source = result.ok && result.data?.path;
    if (!result.ok) return result;
    if (!source || !path.isAbsolute(source)) return { ok: false, code: "browser-frame-unavailable" };
    const runner = promisify(options.execFile || nodeExecFile);
    const directory = path.join(stateDir, "remote", "frames");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, `${record.connId}-${record.seq + 1}.jpg`);
    try {
      for (const scale of [1, 0.85, 0.7, 0.55]) {
        const target = Math.max(240, Math.round((desktop ? Math.max(width, 720) : width) * scale));
        for (const quality of [78, 68, 58, 48]) {
          await runner("/usr/bin/sips", ["--resampleWidth", String(target), "-s", "format", "jpeg",
            "-s", "formatOptions", String(quality), source, "--out", destination], { timeout: 3_000, maxBuffer: 64 * 1024 });
          const bytes = fs.readFileSync(destination);
          if (bytes.length <= MAX_BROWSER_FRAME_JPEG_BYTES) return { ok: true, bytes,
            ...(jpegDimensions(bytes) || { width: target, height: target }) };
        }
      }
      return { ok: false, code: "browser-frame-unavailable" };
    } catch { return { ok: false, code: "browser-frame-unavailable" }; }
    finally { try { fs.unlinkSync(destination); } catch {} }
  }

  async function pollFrame(record, scheduleNext = true) {
    if (fileWatches.get(record.connId) !== record || record.reading) {
      return { ok: false, code: "browser-frame-unavailable" };
    }
    record.reading = true;
    const tab = resolveTab(record.tabRef);
    const frame = tab ? await captureFrame(tab, record.width, record.desktop, record) : null;
    record.reading = false;
    if (fileWatches.get(record.connId) !== record) return { ok: false, code: "browser-frame-unavailable" };
    if (frame?.bytes) {
      const hash = createHash("sha256").update(frame.bytes).digest("hex");
      if (hash !== record.hash) {
        record.hash = hash; record.seq++;
        send(record.connId, { type: "browser.frame", tab: record.tabRef, seq: record.seq,
          width: frame.width, height: frame.height, jpeg: frame.bytes.toString("base64") });
      }
    } else {
      return frame?.ok === false ? frame : { ok: false, code: "browser-frame-unavailable" };
    }
    if (scheduleNext) {
      record.timer = setTimer(() => { record.timer = null; void pollFrame(record); }, Math.ceil(1000 / record.fps));
      record.timer?.unref?.();
    }
    return { ok: true };
  }

  function createDraft(entry, agentRef, kind, summary, body, display = body) {
    const agent = agents.resolve(agentRef);
    if (!agent || !["claude", "codex"].includes(agent.kind)) return { ok: false, code: "forbidden" };
    let bucket = drafts.get(entry.connId);
    if (!bucket) { bucket = new Map(); drafts.set(entry.connId, bucket); }
    if (bucket.size >= DRAFT_MAX_COUNT) return { ok: false, code: "limit-exceeded" };
    if (!body || body.length > DRAFT_MAX_TEXT_CHARS || !display || display.length > DRAFT_MAX_TEXT_CHARS) {
      return { ok: false, code: "limit-exceeded" };
    }
    const storedBytes = [...bucket.values()].reduce((sum, draft) => sum + draft.bytes, 0);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (storedBytes + bodyBytes > DRAFT_MAX_TOTAL_BYTES) {
      return { ok: false, code: "limit-exceeded" };
    }
    let ref;
    for (let attempt = 0; !ref && attempt < 64; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (!bucket.has(candidate)) ref = candidate;
    }
    if (!ref) return { ok: false, code: "unavailable" };
    const draft = { ref, agent: agentRef, kind, summary: cleanText(summary, 80), body, display, bytes: bodyBytes };
    bucket.set(ref, draft);
    return { ok: true, draft };
  }

  return {
    interactiveAvailable: () => !!isReady(),
    catalog,
    resolveTab,
    refForTabId(tabId) { catalog(); return tabRefs.get(tabId) || null; },
    profiles() { return (readState().profiles || []).map((item) => cleanText(item.name, 60)).filter(Boolean); },
    async watchFrame(entry, request) {
      const previous = fileWatches.get(entry.connId);
      if (previous?.timer) clearTimer(previous.timer);
      fileWatches.delete(entry.connId);
      const ready = await readyTab(request.tab);
      if (!ready.ok) return ready;
      const record = { connId: entry.connId, tabRef: request.tab, width: request.width, fps: request.fps,
        desktop: request.desktop, seq: 0, hash: null, timer: null, reading: false };
      fileWatches.set(entry.connId, record);
      const first = await pollFrame(record, false);
      if (!first.ok) {
        if (fileWatches.get(entry.connId) === record) fileWatches.delete(entry.connId);
        return first;
      }
      if (fileWatches.get(entry.connId) === record) {
        record.timer = setTimer(() => { record.timer = null; void pollFrame(record); }, Math.ceil(1000 / record.fps));
        record.timer?.unref?.();
      }
      return { ok: true };
    },
    async pointer(entry, request) {
      const found = await locate(request.tab, request);
      if (!found.ok || !found.element?.selector) return found;
      const result = await command(request.tab, request.action === "double" ? "dblclick" : "click", { sel: found.element.selector });
      if (result.ok) note(entry.connId, `${request.action === "double" ? "더블 클릭" : "클릭"} · ${found.element.text || found.element.selector}`);
      return result;
    },
    async mouse(entry, request) {
      const point = await pagePoint(request.tab, request);
      if (!point.ok) return point;
      const result = await command(request.tab, "mouse", {
        action: request.action, x: point.x, y: point.y,
        ...(request.action === "wheel" ? { dy: request.dy } : {}),
      });
      if (result.ok && request.action === "click") note(entry.connId, `좌표 클릭 · ${Math.round(point.x)},${Math.round(point.y)}`);
      if (result.ok && request.action === "double") note(entry.connId, `좌표 더블 클릭 · ${Math.round(point.x)},${Math.round(point.y)}`);
      if (result.ok && request.action === "wheel") note(entry.connId, `휠 · ${request.dy}px`);
      return result;
    },
    async hoverElement(tabRef, request) { return pickAt(tabRef, request); },
    focus,
    async dialog(request) { return dialog(request.tab, request.action, request.text); },
    async type(entry, request) { const result = await command(request.tab, "phonetype", { text: request.text });
      if (result.ok) note(entry.connId, `글자 입력 · ${request.text.length}자`); return result; },
    async key(entry, request) {
      const prefix = [request.modifiers.ctrl && "Ctrl", request.modifiers.alt && "Alt", request.modifiers.shift && "Shift",
        request.modifiers.cmd && "Meta"].filter(Boolean);
      const value = [...prefix, request.key].join("+");
      const result = await command(request.tab, "phonekey", { key: value });
      if (result.ok) note(entry.connId, `키 · ${value}`); return result;
    },
    async scroll(entry, request) { const result = await command(request.tab, "scroll", { amount: String(request.dy) });
      if (result.ok) note(entry.connId, `스크롤 · ${request.dy}px`); return result; },
    async history(entry, request) { const result = await command(request.tab, request.action);
      if (result.ok) note(entry.connId, `브라우저 · ${request.action}`); return result; },
    async navigate(entry, request) { const result = await command(request.tab, "goto", { url: request.url, entry: true });
      if (result.ok) note(entry.connId, `주소 이동 · ${request.url}`); return result; },
    async newTab(request) {
      catalog();
      const agent = request.agent === undefined ? null : agents.resolve(request.agent);
      if (request.agent !== undefined && (!agent || agent.spaceRef !== request.space)) return { ok: false, code: "forbidden" };
      const spaceId = agent?.source?.workspaceId || spacesByRef.get(request.space);
      if (!spaceId) return { ok: false, code: "forbidden" };
      const url = request.media === undefined ? (request.url === undefined ? "https://www.google.com/" : publicHttpUrl(request.url))
        : agent && resolveMedia(request.media, agent, { stateDir });
      if (!url) return { ok: false, code: request.media ? "forbidden" : "invalid-request" };
      const profile = request.profile === undefined ? undefined : findProfileId(request.profile);
      if (request.profile !== undefined && profile == null) return { ok: false, code: "forbidden" };
      const id = `browser:phone.${randomUUID()}`;
      const mutation = { op: "tab.open", space: spaceId, id, url,
        title: request.title || "폰에서 연 탭", background: false };
      if (profile !== undefined) mutation.profile = profile;
      const changed = mutateState(mutation);
      if (changed) broadcast({ type: "browser-state", state: readState() });
      return { ok: changed, code: changed ? null : "unavailable", tab: changed ? refFor(tabRefs, tabsByRef, id) : null };
    },
    locate,
    async pickElement(entry, request) {
      const found = await pickAt(request.tab, request);
      if (!found.ok || !found.pick) return found;
      const tab = resolveTab(request.tab);
      if (!tab) return { ok: false, code: "forbidden" };
      const agent = agents.resolve(request.agent);
      const pane = agent?.source?.paneId;
      if (!pane) return { ok: false, code: "forbidden" };
      try { found.pick.code = await resolvePickSource(found.pick); } catch { found.pick.code = null; }
      try {
        const shot = await command(request.tab, "screenshot", { sel: found.pick.usel || found.pick.selector });
        if (shot.ok && path.isAbsolute(shot.data?.path || "")) found.pick.shot = shot.data.path;
      } catch {}
      found.pick.pid = `p${(++pickSerial).toString(36)}`;
      const previous = pickBursts.get(entry.connId);
      const at = now();
      const burst = previous && at - previous.at < 20_000 ? previous.count + 1 : 1;
      const otherTab = !!(burst > 1 && previous?.tab && previous.tab !== tab.id);
      pickBursts.set(entry.connId, { at, count: burst, tab: tab.id });
      found.pick.burst = burst;
      found.pick.otherTab = otherTab;
      const handle = tabHandle(tab.id);
      let delimiter = null;
      try {
        delimiter = issueTarget({ pane, kind: "element", ref: `@${handle}`,
          target: { tabId: tab.id }, label: tab.meta?.title || tab.stored?.name || "" }).delimiter;
      } catch { return { ok: false, code: "browser-command-unavailable" }; }
      const currentTab = (readAiTargets() || []).find((target) => target?.pane === pane)?.tabId;
      const currentHandle = currentTab ? tabHandle(currentTab) : null;
      rememberPick(pane, tab.id, found.pick);
      const body = pickBody(found.pick, tab, { burst, otherTab, delimiter, handle, currentHandle });
      return { ...createDraft(entry, request.agent, "element", found.pick.text || found.pick.selector,
        body, redactMacPaths(body)),
        element: found.element };
    },
    async sendElement(entry, request) {
      const found = await locate(request.tab, request);
      if (!found.ok || !found.element) return found;
      const element = found.element;
      const body = `[브라우저 요소]\n선택자: ${element.selector}\n글자: ${element.text || "(없음)"}\n영역: ${element.rect.x},${element.rect.y} ${element.rect.width}×${element.rect.height}\n\n${request.text}`;
      return { ...createDraft(entry, request.agent, "element", element.text || element.selector, body), element };
    },
    recordStart(entry, tab) { if (!resolveTab(tab)) return null; const record = { tab, paused: false, steps: [], startedAt: now() };
      recordings.set(entry.connId, record); return { ...record, elapsedMs: 0 }; },
    recordPause(entry, paused) { const record = recordings.get(entry.connId); if (!record) return null; record.paused = paused;
      return { ...record, elapsedMs: Math.max(0, now() - record.startedAt) }; },
    async recordFinish(entry, agent, noteText) {
      const record = recordings.get(entry.connId); if (!record) return null;
      const body = ["[폰 브라우저 조작 기록]", ...record.steps.map((step, index) => `${index + 1}. ${step}`),
        noteText ? `\n메모: ${noteText}` : ""].filter(Boolean).join("\n");
      const result = createDraft(entry, agent, "record", `${record.steps.length}단계`, body);
      if (result.ok) recordings.delete(entry.connId);
      return { ...record, elapsedMs: Math.max(0, now() - record.startedAt), ...result };
    },
    async sendSketch(entry, request) {
      const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(request.image);
      if (!match) return { ok: false, code: "invalid-request" };
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 36 * 1024 || bytes.toString("base64") !== match[2]) {
        return { ok: false, code: "invalid-request" };
      }
      const directory = path.join(stateDir, "remote", "sketches");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${Date.now()}-${randomBytes(8).toString("hex")}.${match[1] === "jpeg" ? "jpg" : "png"}`);
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      const tab = resolveTab(request.tab);
      const title = cleanText(tab?.meta?.title || tab?.stored?.title || "브라우저 화면", 200);
      const body = `[폰 화면 스케치]\n대상: ${title}\n그림: ${file}\n\n${request.text}`;
      const display = `[폰 화면 스케치]\n대상: ${title}\n그림: Mac에 저장됨\n\n${request.text}`;
      const result = createDraft(entry, request.agent, "sketch", title, body, display);
      if (!result.ok) {
        try { fs.unlinkSync(file); } catch {}
      }
      return result;
    },
    removeDraft(entry, request) {
      const bucket = drafts.get(entry.connId);
      if (!bucket?.has(request.ref)) return { ok: false, code: "forbidden" };
      bucket.delete(request.ref);
      if (bucket.size === 0) drafts.delete(entry.connId);
      return { ok: true };
    },
    expandDrafts(connId, agentRef, refs, text) {
      if (!refs.length) return { ok: true, text, consume() {} };
      const bucket = drafts.get(connId);
      const selected = refs.map((ref) => bucket?.get(ref));
      if (new Set(refs).size !== refs.length || selected.some((draft) => !draft || draft.agent !== agentRef)) {
        return { ok: false, code: "forbidden" };
      }
      return {
        ok: true,
        text: [text, ...selected.map((draft) => draft.body)].filter(Boolean).join("\n\n"),
        consume() {
          for (const ref of refs) bucket.delete(ref);
          if (bucket.size === 0) drafts.delete(connId);
        },
      };
    },
    setProfile(request) {
      const tab = resolveTab(request.tab), profile = findProfileId(request.profile);
      if (!tab || profile == null) return { ok: false, code: "forbidden" };
      const changed = mutateState({ op: "tab.profile", space: tab.spaceId, id: tab.id, profile });
      if (changed) broadcast({ type: "browser-state", state: readState() });
      return { ok: true, changed };
    },
    async desktop(request) { return command(request.tab, "viewport", request.enabled
      ? { width: 1280, height: 800, dpr: 1 } : { clear: true }); },
    async translate(request) {
      const result = await command(request.tab, "eval", { expression: buildPageTranslateScript() });
      const value = result.data?.value || result.data;
      return result.ok && value?.ok === true ? { ok: true } : { ok: false, code: "unavailable" };
    },
    bookmarks(spaceRef) {
      const spaceId = spacesByRef.get(spaceRef);
      if (!spaceId) return null;
      const state = readState();
      return [...flattenBookmarks(state.bookmarksBySpace?.[spaceId]), ...flattenBookmarks(state.bookmarksCommon)]
        .slice(0, 200);
    },
    setBookmark(request) {
      const tab = resolveTab(request.tab);
      const url = tab?.meta?.url || tab?.stored?.url;
      if (!tab || !url) return { ok: false, code: "forbidden" };
      const changed = mutateState({ op: request.bookmarked ? "bookmark.add" : "bookmark.remove",
        space: tab.spaceId, url, title: tab.meta?.title || tab.stored?.title || url });
      if (changed) broadcast({ type: "browser-state", state: readState() });
      return { ok: true, changed };
    },
    direct(request) {
      const tab = resolveTab(request.tab);
      if (!tab) return { ok: false, code: "forbidden" };
      return { ok: true, changed: clearControl(tab.id) };
    },
    closeConnection(connId) {
      const watch = fileWatches.get(connId);
      if (watch?.timer) clearTimer(watch.timer);
      fileWatches.delete(connId); recordings.delete(connId); drafts.delete(connId); pickBursts.delete(connId);
    },
    close() {
      for (const connId of [...new Set([...fileWatches.keys(), ...drafts.keys()])]) this.closeConnection(connId);
      recordings.clear(); drafts.clear(); pickBursts.clear();
    },
  };
}
