// QA 전용 CDP 입력·수신 기록. 페이지 조회 외의 상태 변경은 CDP Input만.

const { randomBytes } = require("node:crypto");
const { inspectLoginPage, inIsolatedWorld } = require("./cdp-qa-login.cjs");
const { dispatchKey } = require("./cdp-qa-keys.cjs");
const EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "pointermove", "mousemove", "wheel", "keydown", "keyup", "beforeinput", "input"];
const captureStart = (binding) => `(() => {
  if (window.__irisQaInputCapture) window.__irisQaInputCapture.stop();
  const events = [], types = ${JSON.stringify(EVENTS)}, binding = ${JSON.stringify(binding)};
  const meta = (node) => {
    if (!node || node.nodeType !== 1) return { role: "", name: "", tag: "" };
    const tag = node.localName || "";
    const roles = { a: "link", button: "button", input: node.type === "checkbox" ? "checkbox" : "textbox", textarea: "textbox", select: "combobox", option: "option" };
    return { role: node.getAttribute("role") || roles[tag] || tag,
      name: (node.getAttribute("aria-label") || node.labels?.[0]?.innerText || node.innerText || node.getAttribute("title") || "").trim().slice(0, 200), tag };
  };
  const listener = (event) => {
    const record = { type: event.type, trusted: event.isTrusted === true, ...meta(event.composedPath?.()[0] || event.target) };
    events.push(record);
    if (binding && typeof window[binding] === "function") window[binding](JSON.stringify(record));
  };
  const docs = [], visit = (doc) => { if (!doc || docs.includes(doc)) return; docs.push(doc);
    for (const frame of doc.querySelectorAll("iframe,frame")) { try { visit(frame.contentDocument); } catch {} }
  };
  visit(document);
  for (const doc of docs) for (const type of types) doc.addEventListener(type, listener, true);
  window.__irisQaInputCapture = { events, stop() { for (const doc of docs) for (const type of types) doc.removeEventListener(type, listener, true); } };
  return true;
})()`;
const CAPTURE_END = `(() => { const capture = window.__irisQaInputCapture; if (!capture) return []; capture.stop();
  delete window.__irisQaInputCapture; return capture.events; })()`;
const FOCUS_META = `(() => { let node = document.activeElement, offsetX = 0, offsetY = 0;
  while (node && (node.localName === "iframe" || node.localName === "frame")) {
    let child; try { child = node.contentDocument?.activeElement; } catch {}
    if (!child) break;
    const frame = node.getBoundingClientRect(); offsetX += frame.left; offsetY += frame.top; node = child;
  }
  if (!node || node === document.body) return null;
  const tag = node.localName || ""; const roles = { a: "link", button: "button", input: node.type === "checkbox" ? "checkbox" : "textbox", textarea: "textbox", select: "combobox" };
  const rect = node.getBoundingClientRect();
  return { role: node.getAttribute("role") || roles[tag] || tag,
    name: (node.getAttribute("aria-label") || node.labels?.[0]?.innerText || node.innerText || node.getAttribute("title") || "").trim().slice(0, 200), tag,
    at: { x: offsetX + rect.left + rect.width / 2, y: offsetY + rect.top + rect.height / 2 },
    disabled: node.matches(":disabled") || node.closest("[inert],[aria-disabled='true']") != null };
})()`;

function requirePoint(args, width, height, prefix = "") {
  const x = Number(args[prefix + "x"]), y = Number(args[prefix + "y"]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height)
    throw new Error("QA 입력 좌표가 화면 밖입니다");
  return { x, y };
}

async function evaluate(send, expression, sid = null, contextId = null) {
  const out = await send.on(sid)("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false,
    ...(contextId ? { contextId } : {}) });
  return out?.result?.value;
}

async function viewport(send) {
  const metrics = await send("Page.getLayoutMetrics");
  const view = metrics.cssVisualViewport || metrics.visualViewport || {};
  const width = Number(view.clientWidth), height = Number(view.clientHeight);
  if (!(width > 0 && height > 0)) throw new Error("QA 탭 화면의 크기를 확인할 수 없습니다");
  return { width, height };
}

function axValue(node, field) { return String(node?.[field]?.value || ""); }

async function nodeMeta(send, backendNodeId, sid = null) {
  const ax = await send.on(sid)("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }).catch(() => null);
  const first = ax?.nodes?.find((node) => node.backendDOMNodeId === backendNodeId) || ax?.nodes?.[0];
  const desc = await send.on(sid)("DOM.describeNode", { backendNodeId }).catch(() => null);
  const tag = String(desc?.node?.localName || "");
  const attributes = desc?.node?.attributes || [];
  const attr = (key) => { const at = attributes.indexOf(key); return at >= 0 ? attributes[at + 1] : ""; };
  return { role: axValue(first, "role") || attr("role") || tag,
    name: axValue(first, "name") || attr("aria-label") || "", tag, backendNodeId };
}

async function hit(send, point) {
  await send("DOM.enable");
  const located = await send("DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false });
  if (!located?.backendNodeId) throw new Error("QA 입력 좌표의 맨 위 요소를 찾지 못했습니다");
  const target = await nodeMeta(send, located.backendNodeId);
  const resolved = await send("DOM.resolveNode", { backendNodeId: located.backendNodeId });
  const objectId = resolved?.object?.objectId;
  if (objectId) {
    const check = await send("Runtime.callFunctionOn", { objectId, returnByValue: true,
      functionDeclaration: "function(){ return { disabled: this.matches?.(':disabled') || this.closest?.('[inert],[aria-disabled=\"true\"]') != null }; }" });
    if (check?.result?.value?.disabled) throw new Error("QA 입력 대상이 비활성 상태입니다");
  }
  return target;
}

// 맨 위 요소가 기대 대상과 같은지. 체크박스 label 안 span·선택 상자 값 span 처럼 대상 안쪽의 다른 요소가 맨 위일 수 있어
// role·name 이 다르면 기대 대상 요소가 맨 위 요소를 감싸는지 확인(대상 찾기의 element.contains 기준과 같음)
// 포커스 요소의 role·이름을 qa_snapshot 과 같은 접근성 노드에서 읽음. 페이지 안 계산은 placeholder·aria-labelledby·
// searchbox 같은 role 을 몰라 같은 입력칸을 다른 대상으로 판정함
const roleKey = (role) => { const lower = String(role || "").toLowerCase(); return lower === "image" ? "img" : lower; };
async function focusedAx(send) {
  const out = await send("Runtime.evaluate", { returnByValue: false, expression: "(() => { let n = document.activeElement; while (n && (n.localName === 'iframe' || n.localName === 'frame')) { let c; try { c = n.contentDocument?.activeElement; } catch {} if (!c) break; n = c; } return n === document.body ? null : n; })()" }).catch(() => null);
  const objectId = out?.result?.objectId;
  if (!objectId) return null;
  try {
    const backendNodeId = (await send("DOM.describeNode", { objectId }).catch(() => null))?.node?.backendNodeId;
    return backendNodeId ? await nodeMeta(send, backendNodeId) : null;
  } finally { await send("Runtime.releaseObject", { objectId }).catch(() => {}); }
}
async function focusMatches(send, focused, expected) {
  if (focused?.role === expected?.role && focused?.name === expected?.name) return true;
  const ax = await focusedAx(send);
  return !!ax && roleKey(ax.role) === roleKey(expected?.role) && ax.name === expected?.name;
}

async function sameTarget(send, current, expected) {
  if (current.role === expected?.role && current.name === expected?.name) return true;
  const text = typeof expected?.text === "string" ? expected.text : null;
  if (text == null && !(expected?.role && expected?.name)) return false;
  const tree = await send("Accessibility.getFullAXTree").catch(() => null);
  const outers = (tree?.nodes || []).filter((node) => !node.ignored && node.backendDOMNodeId && node.backendDOMNodeId !== current.backendNodeId
    && (text != null ? axValue(node, "name").includes(text) : axValue(node, "role").toLowerCase() === expected.role.toLowerCase() && axValue(node, "name") === expected.name));
  if (!outers.length) return false;
  const innerId = (await send("DOM.resolveNode", { backendNodeId: current.backendNodeId }).catch(() => null))?.object?.objectId;
  if (!innerId) return false;
  try {
    for (const node of outers) {
      const objectId = (await send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId }).catch(() => null))?.object?.objectId;
      if (!objectId) continue;
      try {
        const out = await send("Runtime.callFunctionOn", { objectId, returnByValue: true, arguments: [{ objectId: innerId }],
          functionDeclaration: "function(inner){ const element = this.nodeType === 3 ? this.parentElement : this; return { inside: !!element && element !== inner && element.contains(inner) }; }" });
        if (out?.result?.value?.inside === true) return true;
      } finally { await send("Runtime.releaseObject", { objectId }).catch(() => {}); }
    }
  } finally { await send("Runtime.releaseObject", { objectId: innerId }).catch(() => {}); }
  return false;
}

// 안 보이는 탭의 선택 상자를 진짜 마우스로 누르면 macOS 목록 창이 사람이 보는 화면 위에 열림
// - mousedown 기본 동작을 막으면 목록 창이 열리지 않음. 포커스는 직접 옮겨 이어지는 글자 입력으로 고름
// - mousedown 외 이벤트(mouseup·click)는 그대로 전달. 누른 횟수만큼 막은 뒤 스스로 해제, 못 누른 경우 2초 뒤 해제
// - 격리 영역에서 걸어 페이지 스크립트에 드러나지 않음
function selectPopupGuard(presses) {
  return `(() => {
    let left = ${Number(presses) || 1};
    const guard = (event) => {
      const select = event.target?.closest?.("select");
      if (select) { event.preventDefault(); try { select.focus({ preventScroll: true }); } catch {} }
      if (--left <= 0) removeEventListener("mousedown", guard, true);
    };
    addEventListener("mousedown", guard, true);
    setTimeout(() => removeEventListener("mousedown", guard, true), 2000);
    return true;
  })()`;
}

const EXPECTED_EVENTS = {
  click: ["click"], dblclick: ["dblclick"], hover: ["mousemove", "pointermove"],
  drag: ["mouseup"], scroll: ["wheel"], type: ["input"], key: ["keydown"], typeahead: ["input"],
};
// 휠 입력은 CDP 응답이 페이지의 wheel 이벤트보다 먼저 올 수 있음(실제로 스크롤했는데 수신 0건). 상한까지 도착을 기다림
async function awaitReceived(send, action, recorder, limitMs = 1000) {
  const expected = EXPECTED_EVENTS[action] || [];
  const seen = async () => {
    if (recorder.received.some((event) => expected.includes(event.type) && event.trusted)) return true;
    for (const [sid, contextId] of recorder.contexts) {
      const found = await evaluate(send, "(window.__irisQaInputCapture?.events || []).map(e => e.type + ':' + e.trusted)", sid, contextId).catch(() => null);
      if (Array.isArray(found) && found.some((entry) => expected.some((type) => entry === type + ":true"))) return true;
    }
    return false;
  };
  for (const started = Date.now(); !(await seen()) && Date.now() - started < limitMs;) await new Promise((resolve) => setTimeout(resolve, 25));
}

async function capture(send, action, recorder) {
  const fromPage = [];
  for (const [sid, contextId] of recorder.contexts) {
    try { const found = await evaluate(send, CAPTURE_END, sid, contextId); if (Array.isArray(found)) fromPage.push(...found); } catch {}
  }
  const expected = EXPECTED_EVENTS[action] || [];
  await new Promise((resolve) => setImmediate(resolve));
  const received = recorder.received.some((event) => expected.includes(event.type) && event.trusted)
    ? [...recorder.received] : fromPage;
  const trusted = received.some((event) => expected.includes(event.type) && event.trusted);
  if (!trusted) throw new Error("QA 실제 입력의 수신을 확인하지 못했습니다");
  return { received, trusted };
}

async function armCapture(send, wc) {
  const received = [];
  const binding = wc?.debugger?.on ? "__irisQaInput_" + randomBytes(8).toString("hex") : "";
  const contexts = [];
  const worldName = binding ? binding + "_world" : "";
  const listener = (_event, method, params) => {
    if (method !== "Runtime.bindingCalled" || params?.name !== binding) return;
    try { const record = JSON.parse(params.payload); if (EVENTS.includes(record.type)) received.push(record); } catch {}
  };
  if (binding) wc.debugger.on("message", listener);
  try {
    for (const sid of send.frames()) {
      try {
        let contextId = null;
        if (binding) {
          const frameTree = await send.on(sid)("Page.getFrameTree");
          const frameId = frameTree?.frameTree?.frame?.id;
          if (!frameId) throw new Error("QA 이벤트 수신 프레임을 확인할 수 없습니다");
          await send.on(sid)("Runtime.addBinding", { name: binding, executionContextName: worldName });
          const world = await send.on(sid)("Page.createIsolatedWorld", { frameId, worldName });
          contextId = world?.executionContextId;
          if (!contextId) throw new Error("QA 이벤트 수신 격리 영역을 만들지 못했습니다");
        }
        await evaluate(send, captureStart(binding), sid, contextId);
        contexts.push([sid, contextId]);
      } catch (error) {
        if (sid == null) throw error;
      }
    }
  } catch (error) {
    if (binding) wc.debugger.removeListener("message", listener);
    throw error;
  }
  return { received, contexts, async release() {
    if (!binding) return;
    wc.debugger.removeListener("message", listener);
    for (const sid of send.frames()) await send.on(sid)("Runtime.removeBinding", { name: binding }).catch(() => {});
  } };
}

// 휠 아래 요소부터 문서까지 스크롤할 수 있는 영역의 위치. 휠 이벤트가 전달돼도 위치가 그대로인 경우를 결과에 남기기 위함(C5 정상 -6000).
// transform 으로 움직이는 화면(지도·캐러셀·가상 목록)은 위치가 그대로여도 움직이므로 실패로 판정하지 않음
const scrollAreas = (point) => `const list = []; let node = document.elementFromPoint(${Number(point.x)}, ${Number(point.y)});
  while (node && node.nodeType === 1) { const style = getComputedStyle(node);
    if ((node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) && /(auto|scroll|overlay)/.test(style.overflowY + style.overflowX)) list.push(node);
    node = node.parentElement || node.getRootNode?.().host || null; }
  const root = document.scrollingElement || document.documentElement; if (root && !list.includes(root)) list.push(root);
  const name = (n) => n.localName + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : '');`;
const scrollState = (point) => `(() => { ${scrollAreas(point)}
  return list.map((n) => ({ el: name(n), top: Math.round(n.scrollTop), left: Math.round(n.scrollLeft), maxTop: n.scrollHeight - n.clientHeight, maxLeft: n.scrollWidth - n.clientWidth })); })()`;
// 휠 이벤트를 받은 뒤 페이지가 기본 동작을 막았는지 보려고 이벤트 객체를 잡아 둠. 수동 리스너라 스크롤을 막지 않음
const WHEEL_PROBE = `(() => { const key = Symbol.for("iris.qaWheel"); window[key] = null;
  addEventListener("wheel", (event) => { window[key] = event; }, { capture: true, once: true, passive: true }); })()`;
// 페이지가 막지 않은 휠인데 위치가 그대로면 브라우저 기본 동작(휠 아래에서 그 방향으로 움직일 수 있는 첫 영역 스크롤)을 대신함.
// 화면을 그리지 않는 배경 탭에서 휠은 전달되는데 위치가 그대로이던 사례(qa-6face637 seq 895, qa-2ab6e345 seq 130·157)
const scrollDefault = (point, deltaX, deltaY) => `(() => { const key = Symbol.for("iris.qaWheel"), event = window[key]; window[key] = null;
  if (!event) return { missing: true }; if (event.defaultPrevented) return { prevented: true };
  ${scrollAreas(point)}
  for (const n of list) { const top = n.scrollTop, left = n.scrollLeft; n.scrollBy({ top: ${Number(deltaY)}, left: ${Number(deltaX)}, behavior: "instant" });
    if (n.scrollTop !== top || n.scrollLeft !== left) return { moved: true, el: name(n), top: Math.round(n.scrollTop), left: Math.round(n.scrollLeft) }; }
  return { moved: false }; })()`;
const canScroll = (areas, deltaX, deltaY) => (areas || []).some((a) => (deltaY < 0 && a.top > 0) || (deltaY > 0 && a.top < a.maxTop - 1)
  || (deltaX < 0 && a.left > 0) || (deltaX > 0 && a.left < a.maxLeft - 1));

async function mouse(send, type, point, extra = {}) {
  return send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra });
}


// 사용자 포커스 보호 중 QA 탭에 글자 보내기: 진짜 키 이벤트를 이 탭 위젯에만 전달(wc.sendInputEvent)
// 코드 포인트 단위: 크로미움 키 이벤트 글자 칸이 4단위라 ZWJ 이모지를 한 번에 보내면 잘림(실측)
function sendCharsToTab(wc, text) {
  for (const ch of Array.from(String(text))) wc.sendInputEvent({ type: "char", keyCode: ch });
}
const FOCUS_GUARDED_ERROR = "사용자 포커스 보호: 이 QA 탭은 사용자가 쓰는 창에 있고 탭에 포커스를 줄 수 없어 진짜 클릭·키를 보내지 않습니다"
  + " — 탭이 화면에 보이는지 확인한 뒤 다시 하세요";

const USER_TYPING_ERROR = "사용자 입력 보호: 사용자가 같은 창에서 계속 입력 중이라 포커스를 빌리지 않았습니다"
  + " — 잠시 뒤 다시 하세요";

// prepareFocus(wc): "trusted"(CDP 진짜 입력 사용 가능), "borrowed"(사용자 포커스를 입력 동안만 빌림),
// "guarded"(빌리지 못함), "busy"(사용자가 계속 입력 중). 기본값은 trusted. 실제 조립부(cdp-control.cjs)가 user-focus.cjs 판정을 넘김
// returnFocus(wc): borrowed 입력 뒤 사용자 포커스 반환
// isTabShown(wc): 사람이 지금 이 탭을 보고 있는지. 조립부 판정은 모르면 false(안 보이는 탭으로 다룸)
function createQaInputCommands({ prepareFocus = async () => "trusted", returnFocus = async () => null, isTabShown = () => true } = {}) {
  return {
    async "qa-select-resolve"(send, _wc, args = {}) {
      const size = await viewport(send);
      const point = requirePoint(args, size.width, size.height);
      const target = await hit(send, point);
      const resolved = await send("DOM.resolveNode", { backendNodeId: target.backendNodeId });
      const objectId = resolved?.object?.objectId;
      if (!objectId) throw new Error("QA 선택 목록을 확인할 수 없습니다");
      let inspected;
      try {
        const response = await send("Runtime.callFunctionOn", { objectId, returnByValue: true,
          functionDeclaration: "function(){ const s = this.localName === 'select' ? this : this.closest?.('select'); if (!s) return null; return { selectedIndex: s.selectedIndex, multiple: s.multiple, disabled: s.disabled || s.closest('[inert],[aria-disabled=\"true\"]') != null, options: Array.from(s.options).map((o,i)=>({index:i,value:o.value,text:o.label.trim(),disabled:o.disabled || o.parentElement?.disabled === true})) }; }" });
        inspected = response?.result?.value;
      } finally { await send("Runtime.releaseObject", { objectId }); }
      if (!inspected || !Array.isArray(inspected.options)) throw new Error("QA 입력 대상이 native select가 아닙니다");
      if (inspected.disabled || inspected.multiple) throw new Error("비활성 또는 복수 선택 목록은 지원하지 않습니다");
      const selectors = [args.index != null, args.value != null, args.text != null].filter(Boolean).length;
      if (selectors !== 1) throw new Error("선택할 index·value·text 중 하나가 필요합니다");
      const matches = inspected.options.filter((option) => args.index != null ? option.index === args.index
        : args.value != null ? option.value === args.value : option.text === args.text);
      if (matches.length !== 1) throw new Error(matches.length ? "선택 옵션이 여러 개입니다" : "선택 옵션을 찾지 못했습니다");
      const option = matches[0];
      if (option.disabled) throw new Error("선택 옵션이 비활성 상태입니다");
      const keySteps = inspected.options.filter((entry) => entry.index < option.index && !entry.disabled).length;
      // macOS 의 닫힌 선택 상자는 화살표 키로 값이 바뀌지 않고 메뉴만 열림. 첫 글자 입력은 지금 선택 다음부터
      // 그 글자로 시작하는 항목을 차례로 고르므로(끝에서 처음으로 돌아감) 목표까지의 입력 횟수를 계산
      const first = Array.from(option.text)[0], fold = (value) => String(value || "").toLocaleLowerCase();
      if (!first || /\s/.test(first)) throw new Error("선택 옵션의 글자가 없어 키보드로 고를 수 없습니다");
      const current = inspected.selectedIndex;
      const order = [...inspected.options.slice(current + 1), ...inspected.options.slice(0, Math.max(current + 1, 0))]
        .filter((entry) => !entry.disabled && fold(Array.from(entry.text)[0]) === fold(first));
      const typeahead = { char: first, count: option.index === current ? 0 : order.indexOf(option) + 1 };
      return { ok: true, index: option.index, selectedIndex: current, keySteps, typeahead, selected: option.text, value: option.value, target, at: point };
    },
    async "qa-locate"(send, _wc, args = {}) {
      const role = String(args.role || ""), name = String(args.name || "");
      if (!role || !name) throw new Error("QA 대상의 역할과 이름이 필요합니다");
      const size = await viewport(send);
      const tree = await send("Accessibility.getFullAXTree");
      const matches = (tree?.nodes || []).filter((node) => axValue(node, "role") === role && axValue(node, "name") === name && node.backendDOMNodeId && !node.ignored);
      const visible = [];
      for (const node of matches) {
        const box = await send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId }).catch(() => null);
        const quad = box?.model?.border;
        if (!quad || quad.length !== 8) continue;
        const point = { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
          y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
        try { requirePoint(point, size.width, size.height); visible.push({ backendNodeId: node.backendDOMNodeId, point }); } catch {}
      }
      if (visible.length !== 1) throw new Error(visible.length ? "QA 대상이 여러 개입니다" : "화면에 보이는 QA 대상을 찾지 못했습니다");
      const { backendNodeId, point } = visible[0];
      const top = await hit(send, point);
      const resolved = await send("DOM.resolveNode", { backendNodeId });
      const objectId = resolved?.object?.objectId;
      if (!objectId) throw new Error("QA 대상의 위치를 확인할 수 없습니다");
      const check = await send("Runtime.callFunctionOn", { objectId, returnByValue: true,
        functionDeclaration: "function(x,y){ const top = document.elementFromPoint(x,y); return { top: !!top && (top === this || this.contains(top)), disabled: this.matches?.(':disabled') || this.closest?.('[inert],[aria-disabled=\"true\"]') != null }; }",
        arguments: [{ value: point.x }, { value: point.y }] });
      if (!check?.result?.value?.top) throw new Error("QA 대상 위에 다른 요소가 있습니다");
      if (check.result.value.disabled) throw new Error("QA 대상이 비활성 상태입니다");
      return { ok: true, x: Math.round(point.x), y: Math.round(point.y), at: { x: Math.round(point.x), y: Math.round(point.y) }, target: top };
    },
    // 지금 포커스가 있는 요소의 role·name. qa_play 가 이미 포커스된 입력칸을 다시 누를지 정할 때 씀
    async "qa-focused"(send) { return { ok: true, focused: await focusedAx(send) || await evaluate(send, FOCUS_META) }; },
    async "qa-input"(send, wc, args = {}) {
      const action = String(args.action || "");
      if (!["click", "dblclick", "hover", "drag", "type", "key", "scroll", "typeahead"].includes(action)) throw new Error("지원하지 않는 QA 입력입니다");
      const sensitive = await inIsolatedWorld(send, `(${inspectLoginPage.toString()})()`);
      if (!sensitive || !Array.isArray(sensitive.reasons)) throw new Error("QA 입력 전 결제·본인확인 화면 조회 실패");
      if (sensitive.reasons.length) return { ok: false, humanRequired: true, reason: sensitive.reasons.join(" · ") };
      const size = await viewport(send);
      const pointer = ["click", "dblclick", "hover", "drag", "scroll"].includes(action);
      const at = pointer ? requirePoint(args, size.width, size.height) : null;
      const to = action === "drag" ? requirePoint({ x: args.toX, y: args.toY }, size.width, size.height) : null;
      const target = at ? await hit(send, at) : await evaluate(send, FOCUS_META);
      if (!target && !(action === "key" && args.key === "Tab")) throw new Error("QA 키 입력 대상에 포커스가 없습니다");
      if (target?.disabled) throw new Error("QA 입력 대상이 비활성 상태입니다");
      if (!at && target) requirePoint(target.at || {}, size.width, size.height);
      if (!pointer && args.expectedTarget && !(await focusMatches(send, target, args.expectedTarget)))
        throw new Error("재생 입력의 포커스 대상이 다릅니다");
      if (action === "type" && typeof args.text !== "string") throw new Error("QA 입력 문자가 필요합니다");
      if (action === "key" && !args.key) throw new Error("QA 키가 필요합니다");
      if (action === "typeahead" && (typeof args.text !== "string" || Array.from(args.text).length !== 1)) throw new Error("QA 선택 글자는 한 글자여야 합니다");
      const deltaX = Number(args.deltaX || 0), deltaY = Number(args.deltaY || 0);
      if (action === "scroll" && (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (!deltaX && !deltaY))) throw new Error("QA 스크롤 이동량이 올바르지 않습니다");
      // 휠·마우스 이동은 포커스를 옮기지 않음(실측). 누르기·키·글자만 판정
      // 포커스를 빌리는 시간을 줄이려고 입력 기록 준비를 먼저 함
      const recorder = await armCapture(send, wc);
      const focus = action === "hover" || action === "scroll" ? "trusted" : await prepareFocus(wc);
      const borrowed = focus === "borrowed", trusted = focus === "trusted" || borrowed;
      if (!trusted && !["type", "typeahead"].includes(action)) {
        await recorder.release();
        throw new Error(focus === "busy" ? USER_TYPING_ERROR : FOCUS_GUARDED_ERROR);
      }
      let evidence, inputError, scrolled;
      try {
        if(pointer && args.expectedTarget){const current=await hit(send,at);if(current.backendNodeId!==target.backendNodeId||!(await sameTarget(send,current,args.expectedTarget)))throw new Error("재생 좌표의 맨 위 대상이 바뀌었습니다");}
        if (action === "click" || action === "dblclick") {
          const times = action === "dblclick" ? 2 : 1;
          if (!isTabShown(wc)) await inIsolatedWorld(send, selectPopupGuard(times));
          await mouse(send, "mouseMoved", at);
          for (let count = 1; count <= times; count++) {
            if (args.expectedTarget) {
              const current = await hit(send, at);
              if (current.backendNodeId !== target.backendNodeId || !(await sameTarget(send, current, args.expectedTarget)))
                throw new Error("재생 좌표의 맨 위 대상이 바뀌었습니다");
            }
            await mouse(send, "mousePressed", at, { button: "left", clickCount: count });
            await mouse(send, "mouseReleased", at, { button: "left", clickCount: count });
          }
        } else if (action === "hover") await mouse(send, "mouseMoved", at);
        else if (action === "drag") {
          await mouse(send, "mouseMoved", at);
          if(args.expectedTarget){const current=await hit(send,at);if(current.backendNodeId!==target.backendNodeId||!(await sameTarget(send,current,args.expectedTarget)))throw new Error("재생 좌표의 맨 위 대상이 바뀌었습니다");}
          await mouse(send, "mousePressed", at, { button: "left", clickCount: 1 });
          for (let step = 1; step <= 5; step++) await mouse(send, "mouseMoved", {
            x: at.x + (to.x - at.x) * step / 5, y: at.y + (to.y - at.y) * step / 5,
          }, { button: "left", buttons: 1 });
          await mouse(send, "mouseReleased", to, { button: "left", clickCount: 1 });
        } else if (action === "scroll") {
          await mouse(send, "mouseMoved", at);
          if(args.expectedTarget){const current=await hit(send,at);if(current.backendNodeId!==target.backendNodeId||!(await sameTarget(send,current,args.expectedTarget)))throw new Error("재생 좌표의 맨 위 대상이 바뀌었습니다");}
          const before = await evaluate(send, scrollState(at)).catch(() => null);
          await evaluate(send, WHEEL_PROBE).catch(() => null);
          await mouse(send, "mouseWheel", at, { deltaX, deltaY });
          scrolled = { before, possible: canScroll(before, deltaX, deltaY) };
        } else {
          if (args.expectedTarget) {
            const focused = await evaluate(send, FOCUS_META);
            if (!(await focusMatches(send, focused, args.expectedTarget)))
              throw new Error("재생 입력 직전에 포커스 대상이 바뀌었습니다");
            if (focused.disabled) throw new Error("QA 입력 대상이 비활성 상태입니다");
            requirePoint(focused.at || {}, size.width, size.height);
          }
          if (typeof args.verifyBeforeInput === "function") await args.verifyBeforeInput();
          if (!trusted) sendCharsToTab(wc, args.text);
          else if (action === "type") await send("Input.insertText", { text: args.text });
          else if (action === "typeahead") await send("Input.dispatchKeyEvent", { type: "char", text: args.text });
          else await dispatchKey(send, args.key);
        }
      } catch (error) { inputError = error; }
      // 빌린 포커스는 입력 직후 반환. 빌린 사이 사용자가 친 키가 QA 탭으로 가는 시간을 줄임
      let focusReturn = null;
      if (borrowed) { try { focusReturn = await returnFocus(wc); } catch {} }
      if (!inputError && action === "scroll") {
        await awaitReceived(send, action, recorder);
        // 부드러운 스크롤을 위해 상한까지 위치 변화를 기다림
        const print = (areas) => JSON.stringify((areas || []).map((a) => [a.top, a.left]));
        for (const started = Date.now(); scrolled.before && scrolled.possible && Date.now() - started < 1000;) {
          scrolled.after = await evaluate(send, scrollState(at)).catch(() => null);
          if (!scrolled.after || print(scrolled.after) !== print(scrolled.before)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        scrolled.unchanged = !!(scrolled.before && scrolled.possible && scrolled.after && print(scrolled.after) === print(scrolled.before));
        if (scrolled.unchanged) {
          const applied = await evaluate(send, scrollDefault(at, deltaX, deltaY)).catch(() => null);
          if (applied?.moved) { scrolled.unchanged = false; scrolled.applied = applied; }
          else scrolled.prevented = applied?.prevented === true;
        }
      }
      try { evidence = await capture(send, action, recorder); } catch (error) { if (!inputError) inputError = error; }
      await recorder.release();
      if (inputError) throw inputError;
      const point = at || target?.at || null;
      return { ok: true, action, via: trusted ? "cdp-input" : "tab-key-input", ...(borrowed ? { focusBorrowed: true, focusReturn } : {}), at: point && { x: Math.round(point.x), y: Math.round(point.y) },
        target, ...(args.selected ? { selected: args.selected } : {}), ...(scrolled ? { atEdge: !scrolled.possible, ...(scrolled.unchanged ? { scrollUnchanged: true, scrollNote: `휠 입력 뒤 스크롤 위치 그대로(${JSON.stringify((scrolled.before || []).map((a) => [a.el, a.top, a.left, a.maxTop]))})${scrolled.prevented ? '. 페이지가 휠 기본 동작을 막음' : ''}. 다음 단계 대상이 창 밖이면 이 스크롤이 화면에 반영되지 않은 것` } : {}),
          ...(scrolled.applied ? { scrollApplied: scrolled.applied.el, scrollNote: `휠은 전달됐지만 위치가 그대로라 페이지가 막지 않은 휠의 기본 동작대로 ${scrolled.applied.el}을 옮김(${scrolled.applied.top}, ${scrolled.applied.left})` } : {}) } : {}), ...evidence };
    },
  };
}

module.exports = { createQaInputCommands };
