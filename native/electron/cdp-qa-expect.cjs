const { randomBytes } = require("node:crypto");

// 페이지 전역값과 분리된 조회. 프레임 검사 실패는 판정 실패로 기록.
function rendered(element) {
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  for (let node = element; node; node = node.parentElement) {
    const css = getComputedStyle(node);
    if (css.display === "none" || css.contentVisibility === "hidden" || Number(css.opacity) === 0) return false;
  }
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function inspectDocument(selector) {
  const entries = [];
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  const textOf = (element) => {
    if (element.localName === "input") {
      return ["text", "search", "email", "url", "tel", "number", "submit", "reset", "button"].includes(element.type)
        ? normalize(String(element.value || "")) : "";
    }
    if (element.localName === "textarea") return normalize(String(element.value || ""));
    if (element.localName === "select") return normalize(Array.from(element.selectedOptions).map((option) => option.label).join(" "));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = "", previous = null, node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || !rendered(node.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length) continue;
      const first = rects[0], last = rects.at(-1);
      if (previous && (Math.abs(previous.top - first.top) > 1 || first.left - previous.right > 1)) text += " ";
      text += node.textContent;
      previous = last;
    }
    return normalize(text);
  };
  const all = document.querySelectorAll(selector);
  for (const element of all) {
    if (rendered(element)) {
      const b=element.getBoundingClientRect();
      entries.push({text:textOf(element),tag:element.localName,rect:{x:b.x,y:b.y,width:b.width,height:b.height}});
    }
  }
  return { entries, queried: all.length };
}

function valueOf(response) {
  if (response?.exceptionDetails) throw new Error("QA 프레임의 조회 중 예외가 발생했습니다");
  if (!response?.result || !Object.hasOwn(response.result, "value")) throw new Error("QA 프레임의 조회 결과가 없습니다");
  return response.result.value;
}

async function inspectFrames(send, selector) {
  const sessions = send.frames();
  if (!Array.isArray(sessions) || !sessions.length || !sessions.includes(null)) throw new Error("QA 프레임 목록이 불완전합니다");
  const frames = new Map();
  for (const sid of new Set(sessions)) {
    const response = await send.on(sid)("Page.getFrameTree");
    const seen = new Set();
    const visit = (tree, parentId = null, root = true) => {
      const id = tree?.frame?.id;
      if (typeof id !== "string" || !id || seen.has(id)) throw new Error("QA 프레임 구조가 올바르지 않습니다");
      seen.add(id);
      const existing = frames.get(id);
      const parent = parentId || tree.frame.parentId || existing?.parentId || null;
      if (existing && parent && existing.parentId && parent !== existing.parentId) throw new Error("QA 부모 프레임이 일치하지 않습니다");
      if (!existing || root) frames.set(id, { id, sid, parentId: parent, contextId: null });
      else if (!existing.parentId) existing.parentId = parent;
      if (tree.childFrames != null && !Array.isArray(tree.childFrames)) throw new Error("QA 자식 프레임 구조가 올바르지 않습니다");
      for (const child of tree.childFrames || []) visit(child, id, false);
    };
    visit(response?.frameTree);
  }
  const worldName = "iris-qa-expect-" + randomBytes(16).toString("hex");
  for (const frame of frames.values()) {
    if (frame.parentId && !frames.has(frame.parentId)) throw new Error("QA 부모 프레임을 찾지 못했습니다");
    const world = await send.on(frame.sid)("Page.createIsolatedWorld", { frameId: frame.id, worldName });
    if (!Number.isInteger(world?.executionContextId) || world.executionContextId <= 0) throw new Error("QA 프레임의 격리 영역을 만들지 못했습니다");
    frame.contextId = world.executionContextId;
  }
  const visible = new Map();
  const isFrameVisible = async (frame, ancestors = new Set()) => {
    if (visible.has(frame.id)) return visible.get(frame.id);
    if (ancestors.has(frame.id)) throw new Error("QA 프레임 구조에 순환이 있습니다");
    ancestors.add(frame.id);
    let shown = true;
    if (frame.parentId) {
      const parent = frames.get(frame.parentId);
      const parentSend = send.on(parent.sid);
      const owner = await parentSend("DOM.getFrameOwner", { frameId: frame.id });
      if (!owner?.backendNodeId) throw new Error("QA iframe 요소를 찾지 못했습니다");
      const resolved = await parentSend("DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId: parent.contextId });
      const objectId = resolved?.object?.objectId;
      if (!objectId) throw new Error("QA iframe의 표시 상태를 확인할 수 없습니다");
      try {
        const result = await parentSend("Runtime.callFunctionOn", { objectId, returnByValue: true,
          functionDeclaration: `function() { const rendered = ${rendered.toString()}; return rendered(this); }` });
        const value = valueOf(result);
        if (typeof value !== "boolean") throw new Error("QA iframe의 표시 결과가 올바르지 않습니다");
        shown = value;
      } finally { await parentSend("Runtime.releaseObject", { objectId }); }
      shown = (await isFrameVisible(parent, ancestors)) && shown;
    }
    visible.set(frame.id, shown);
    return shown;
  };
  const entries = [];
  let queried = 0;
  for (const frame of frames.values()) {
    const result = await send.on(frame.sid)("Runtime.evaluate", {
      expression: `(() => { const rendered = ${rendered.toString()}; return (${inspectDocument.toString()})(${JSON.stringify(selector)}); })()`,
      contextId: frame.contextId, returnByValue: true, awaitPromise: false,
    });
    const value = valueOf(result);
    if (!value || !Array.isArray(value.entries) || !Number.isInteger(value.queried) || value.queried < 0
      || value.entries.length > value.queried || value.entries.some((entry) => typeof entry?.text !== "string" || typeof entry.tag !== "string")) {
      throw new Error("QA 프레임의 조회 결과가 올바르지 않습니다");
    }
    queried += value.queried;
    if (await isFrameVisible(frame)) entries.push(...value.entries.map((entry) => ({ ...entry, rect:frame.parentId ? null : entry.rect, frameId: frame.id })));
  }
  return { entries, queried, frames: frames.size };
}

function createQaExpectCommands({ screenshot } = {}) {
  if (typeof screenshot !== "function") throw new Error("QA 판정의 화면 캡처 함수가 필요합니다");
  return {
    async "qa-expect"(send, wc, args = {}) {
      const mode = args.mode;
      if (!["exists", "absent", "contains", "equals"].includes(mode)) throw new Error("지원하지 않는 QA 판정입니다");
      if (args.sel != null && (typeof args.sel !== "string" || !args.sel.trim())) throw new Error("QA 선택자가 올바르지 않습니다");
      if (args.text != null && typeof args.text !== "string") throw new Error("QA 판정 문자가 올바르지 않습니다");
      if (["contains", "equals"].includes(mode) && typeof args.text !== "string") throw new Error("QA 판정 문자가 필요합니다");
      const selector = args.sel || "body";
      const want = args.text == null ? null : args.text.replace(/\s+/g, " ").trim();
      let inspection, inspectionError = null;
      try { inspection = await inspectFrames(send, selector); }
      catch (error) { inspectionError = String(error?.message || error); }
      const entries = inspection?.entries || [];
      const hit = mode === "exists" || (mode === "absent" && want == null) ? entries[0]
        : entries.find((entry) => mode === "equals" ? entry.text === want : entry.text.includes(want));
      const pass = !inspectionError && (mode === "absent" ? !hit : !!hit);
      const expected = mode === "absent" ? `${selector}${want == null ? " 없음" : `에 “${want}” 없음`}`
        : mode === "exists" ? `${selector} 있음` : `${selector} ${mode === "equals" ? "=" : "⊃"} “${want}”`;
      let shot = null, shotError = null, captureMetadata = {};
      try {
        const captured = await screenshot(send, wc, { stable:false, ...(hit?.rect ? {mark:{...hit.rect,label:expected}}:{}), caption: `${pass ? "통과" : "실패"} · ${expected}`, dpr: args.dpr, tab: args.tab });
        if (captured?.error || captured?.ok === false || typeof captured?.path !== "string" || !captured.path) {
          throw new Error(captured?.error || "QA 판정의 화면 파일을 확인하지 못했습니다");
        }
        shot = captured.path;
        captureMetadata = { tab:captured.tab, captureTarget:captured.captureTarget, viewport:captured.viewport, stability:captured.stability };
      } catch (error) { shotError = String(error?.message || error); }
      return { ok: true, pass: pass && !shotError, expected, displayExpected: expected,
        found: !!entries.length, got: (hit || entries[0])?.text.slice(0, 300) ?? null,
        element: (hit || entries[0])?.tag ?? null, matched: entries.length,
        frames: inspection?.frames ?? null, queried: inspection?.queried ?? null,
        url: wc.getURL(), shot, shotError, inspectionError, ...captureMetadata };
    },
  };
}

module.exports = { createQaExpectCommands };
