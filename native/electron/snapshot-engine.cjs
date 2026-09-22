// 접근성 스냅샷 엔진. Orca(src/main/browser/snapshot-engine.ts)에서 이식했다(CJS, 타입 제거, 로직 동일).
// CDP Accessibility.getFullAXTree로 접근성 트리를 걷어 요소 ref(@e1…)를 부여하고, ARIA 없는
// cursor:pointer/onclick/tabindex 요소(SPA 컨트롤)를 승격해 ref로 노출한다. AI가 비전 없이
// "click @e5"로 요소를 지목할 수 있게 하는 핵심. sendCommand = webContents.debugger.sendCommand 래퍼.

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
  "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem",
]);
const LANDMARK_ROLES = new Set([
  "banner", "navigation", "main", "complementary", "contentinfo", "region", "form", "search",
]);
const HEADING_PATTERN = /^heading$/;
const SKIP_ROLES = new Set(["none", "presentation", "generic"]);

// 예산·질의·이어보기. 전체를 항상 돌려주면 큰 화면에서 토큰 사용량이 커지고, 상호작용 요소만
// 남기면 오류 문구·상태·금액·안내가 사라진다. QA는 버튼보다 그런 텍스트를 더 많이 읽는다.
// 그래서 자르는 기준을 노드 수가 아니라 직렬화 바이트로 두고, 잘린 구간에 있던 alert·status·
// heading은 따로 요약해 남긴다. 나머지는 커서로 이어서 본다.
const SNAP_BUDGET = Number(process.env.IRIS_SNAPSHOT_BUDGET) || 20000;   // 바이트
const KEEP_ROLES = new Set(["alert", "alertdialog", "status", "heading", "log"]);

// opts.frames 는 교차 출처 iframe의 CDP 세션 목록 [{ sid, send }]이다. 그 안은 별도 타깃이라
// 최상위 접근성 트리에 포함되지 않는다. 각각 순회해 뒤에 이어 붙이고, ref 번호는 이어서 매긴다.
// 프레임마다 번호를 새로 매기면 같은 @e5가 두 곳을 가리킨다. 어느 프레임의 요소인지는 refMap의
// sid가 보관하므로 이름에 표시할 필요가 없다(Orca와 같은 방식이다).
async function buildSnapshot(sendCommand, opts) {
  await sendCommand("Accessibility.enable");
  const { nodes } = await sendCommand("Accessibility.getFullAXTree");
  const nodeById = new Map();
  for (const node of nodes) nodeById.set(node.nodeId, node);

  const entries = [];
  let refCounter = 1;
  const root = nodes[0];
  if (!root) return { snapshot: "", refs: [], refMap: new Map() };

  walkTree(root, nodeById, 0, entries, () => "e" + refCounter++);

  // ARIA 없는 시각적 인터랙티브 요소(styled div 등) 승격.
  const cursorInteractiveEntries = await findCursorInteractiveElements(sendCommand, entries);
  for (const cie of cursorInteractiveEntries) { cie.ref = `@e${refCounter++}`; entries.push(cie); }

  // 교차 출처 iframe은 접근성 트리를 자기 세션으로만 제공한다. 부모 트리 뒤에 이어 붙이고
  // 그 구간의 ref가 어느 세션 것인지 기록한다. click·fill 이 그 세션으로 가야 하기 때문이다.
  const refSid = new Map();
  for (const f of (opts && opts.frames) || []) {
    try {
      await f.send("Accessibility.enable");
      const r = await f.send("Accessibility.getFullAXTree");
      const fnodes = (r && r.nodes) || [];
      if (!fnodes.length) continue;
      const fById = new Map();
      for (const n of fnodes) fById.set(n.nodeId, n);
      const start = refCounter;
      walkTree(fnodes[0], fById, 1, entries, () => "e" + refCounter++);
      for (let i = start; i < refCounter; i++) refSid.set(`@e${i}`, f.sid);
    } catch { /* 사라진 프레임은 건너뛴다 */ }
  }

  const refMap = new Map();
  const refs = [];
  const lines = [];

  const nameCounts = new Map();
  const nameOccurrence = new Map();
  for (const entry of entries) {
    if (entry.ref) { const key = `${entry.role}:${entry.name}`; nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1); }
  }
  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    if (entry.ref) {
      const key = `${entry.role}:${entry.name}`;
      const total = nameCounts.get(key) ?? 1;
      let displayName = entry.name;
      const nth = (nameOccurrence.get(key) ?? 0) + 1;
      nameOccurrence.set(key, nth);
      if (total > 1 && nth > 1) displayName = `${entry.name} (${ordinal(nth)})`;
      lines.push(`${indent}[${entry.ref}] ${entry.role} "${displayName}"`);
      refs.push({ ref: entry.ref, role: entry.role, name: displayName });
      refMap.set(entry.ref, {
        backendDOMNodeId: entry.backendDOMNodeId, role: entry.role, name: entry.name,
        sid: refSid.get(entry.ref) || null,   // iframe 안 요소면 그 세션. 최상위면 null.
        nth: total > 1 ? nth : undefined,
      });
    } else {
      lines.push(`${indent}${entry.role} "${entry.name}"`);
    }
  }
  // 질의·예산은 ref를 붙인 뒤에 적용한다. 먼저 잘라내면 같은 요소가 화면마다 다른 번호를
  // 받아 같은 ref가 실행할 때마다 다른 요소를 가리킨다.
  const o = opts || {};
  const shown = selectLines(entries, lines, o);
  return {
    snapshot: shown.text, refs, refMap,
    total: lines.length, shownCount: shown.count,
    truncated: shown.truncated, cursor: shown.cursor, bytes: Buffer.byteLength(shown.text),
    query: shown.query,
  };
}

// entries와 lines는 같은 순서·같은 길이다. 여기서는 무엇을 보여줄지만 정한다.
function selectLines(entries, lines, o) {
  const budget = Number(o.budget) > 0 ? Number(o.budget) : SNAP_BUDGET;
  const start = Number(o.cursor) > 0 ? Number(o.cursor) : 0;
  const want = {
    role: o.role ? String(o.role).toLowerCase() : null,
    name: o.name ? String(o.name).toLowerCase() : null,
    region: o.region ? String(o.region).toLowerCase() : null,
  };

  // region은 landmark 하나의 안쪽이다. landmark는 depth로 구간이 갈린다.
  let keep = entries.map((_, i) => i);
  if (want.region) {
    keep = [];
    let inside = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const isLandmark = !e.ref && /^\[.*\]$/.test(e.role);
      if (inside != null && e.depth <= inside) inside = null;
      if (isLandmark && (e.role.toLowerCase().includes(want.region) || String(e.name || "").toLowerCase().includes(want.region))) {
        inside = e.depth; keep.push(i); continue;
      }
      if (inside != null) keep.push(i);
    }
  }
  if (want.role || want.name) {
    keep = keep.filter((i) => {
      const e = entries[i];
      if (want.role && !String(e.role).toLowerCase().includes(want.role)) return false;
      if (want.name && !String(e.name).toLowerCase().includes(want.name)) return false;
      return true;
    });
  }
  const queried = want.role || want.name || want.region;

  // 이어보기 커서는 원본 줄 번호다. 질의가 바뀌어도 같은 자리를 가리킨다.
  const body = [], skippedKeep = [];
  let used = 0, cursor = null;
  for (const i of keep) {
    if (i < start) continue;
    const line = lines[i];
    const size = Buffer.byteLength(line) + 1;
    if (cursor == null && used + size > budget) {
      // 예산을 넘는 첫 줄에서 멈춘다. 큰 줄만 건너뛰고 뒤의 작은 줄을 계속 담으면, 커서가 가리키는
      // 위치 뒤쪽이 이미 출력된 상태가 되어 다음 페이지에 같은 줄이 다시 나온다.
      // 한 줄이 예산보다 크면 전진할 수 없으므로, 그 줄은 혼자라도 출력하고 넘어간다.
      if (!body.length) { body.push(line); used += size; continue; }
      cursor = i;
    }
    if (cursor != null) {
      const e = entries[i];
      if (KEEP_ROLES.has(String(e.role).toLowerCase())) skippedKeep.push(line.trim());
      continue;
    }
    body.push(line); used += size;
  }

  let text = body.join("\n");
  const parts = [];
  if (skippedKeep.length) {
    // 잘린 구간의 경고·상태·제목은 버리지 않는다. 사용자가 화면에서 먼저 읽는 정보다.
    parts.push(`\n\n[잘린 구간의 경고·상태·제목 ${skippedKeep.length}개]\n` +
      skippedKeep.slice(0, 40).map((x) => "  " + x).join("\n"));
  }
  if (cursor != null) {
    parts.push(`\n\n[${budget}바이트에서 끊었다. 이어 보려면 cursor=${cursor} — ` +
      `또는 role·name·region으로 좁혀라. 전체를 다시 받으면 토큰만 는다]`);
  }
  text += parts.join("");
  return { text, count: body.length, truncated: cursor != null, cursor,
           query: queried ? { role: want.role, name: want.name, region: want.region } : null };
}

function walkTree(node, nodeById, depth, entries, nextRef) {
  if (node.ignored) { walkChildren(node, nodeById, depth, entries, nextRef); return; }
  const role = node.role?.value ?? "";
  const name = node.name?.value ?? "";
  if (SKIP_ROLES.has(role)) { walkChildren(node, nodeById, depth, entries, nextRef); return; }

  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isHeading = HEADING_PATTERN.test(role);
  const isLandmark = LANDMARK_ROLES.has(role);
  const isStaticText = role === "staticText" || role === "StaticText";

  if (!isInteractive && !isHeading && !isLandmark && !isStaticText) { walkChildren(node, nodeById, depth, entries, nextRef); return; }
  if (!name && !isLandmark) { walkChildren(node, nodeById, depth, entries, nextRef); return; }

  const hasFocusable = isInteractive && isFocusable(node);

  if (isLandmark) {
    entries.push({ ref: "", role: formatLandmarkRole(role, name), name: name || role, backendDOMNodeId: node.backendDOMNodeId ?? 0, depth });
    walkChildren(node, nodeById, depth + 1, entries, nextRef); return;
  }
  if (isHeading) { entries.push({ ref: "", role: "heading", name, backendDOMNodeId: node.backendDOMNodeId ?? 0, depth }); walkChildren(node, nodeById, depth + 1, entries, nextRef); return; } // heading 자식 순회. `<h2><a>제목</a></h2>` 형 링크의 ref 보존
  if (isStaticText && name.trim().length > 0) { entries.push({ ref: "", role: "text", name: name.trim(), backendDOMNodeId: node.backendDOMNodeId ?? 0, depth }); return; }
  if (isInteractive && (hasFocusable || node.backendDOMNodeId)) {
    const ref = `@${nextRef()}`;   // nextRef가 접두어까지 붙여 준다("e3"·"f2e3")
    entries.push({ ref, role: formatInteractiveRole(role), name: name || "(unlabeled)", backendDOMNodeId: node.backendDOMNodeId ?? 0, depth }); return;
  }
  walkChildren(node, nodeById, depth, entries, nextRef);
}

function walkChildren(node, nodeById, depth, entries, nextRef) {
  if (!node.childIds) return;
  for (const childId of node.childIds) { const child = nodeById.get(childId); if (child) walkTree(child, nodeById, depth, entries, nextRef); }
}

function isFocusable(node) {
  if (!node.properties) return true;
  const focusable = node.properties.find((p) => p.name === "focusable");
  if (focusable && focusable.value.value === false) return false;
  return true;
}

function formatInteractiveRole(role) {
  switch (role) {
    case "textbox": case "searchbox": return "text input";
    case "combobox": return "combobox";
    case "menuitem": case "menuitemcheckbox": case "menuitemradio": return "menu item";
    case "spinbutton": return "number input";
    case "treeitem": return "tree item";
    default: return role;
  }
}
function formatLandmarkRole(role, name) {
  if (name) return `[${name}]`;
  switch (role) {
    case "banner": return "[Header]";
    case "navigation": return "[Navigation]";
    case "main": return "[Main Content]";
    case "complementary": return "[Sidebar]";
    case "contentinfo": return "[Footer]";
    case "search": return "[Search]";
    default: return `[${role}]`;
  }
}
function ordinal(n) { const s = ["th", "st", "nd", "rd"]; const v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; }

// cursor:pointer/onclick/tabindex/contenteditable 요소를 페이지 JS로 찾아 backendNodeId로 해석.
async function findCursorInteractiveElements(sendCommand, existingEntries) {
  const existingNodeIds = new Set(existingEntries.map((e) => e.backendDOMNodeId));
  const results = [];
  try {
    const { result } = await sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const SKIP_ROLES = new Set(['button','link','textbox','checkbox','radio','tab',
          'menuitem','option','switch','slider','combobox','searchbox','spinbutton','treeitem',
          'menuitemcheckbox','menuitemradio']);
        const SKIP_TAGS = new Set(['input','button','select','textarea','a']);
        const seen = new Set(); const found = []; const matchedElements = [];
        function check(el) {
          if (seen.has(el)) return; seen.add(el);
          const tag = el.tagName.toLowerCase();
          if (SKIP_TAGS.has(tag)) return;
          const role = el.getAttribute('role');
          if (role && SKIP_ROLES.has(role)) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const text = (el.ariaLabel || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80);
          if (!text) return;
          found.push({ text, tag }); matchedElements.push(el);
          if (found.length >= 50) return;
        }
        document.querySelectorAll('[onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]').forEach(el => { if (found.length < 50) check(el); });
        document.querySelectorAll('div, span, li, td, img, svg, label').forEach(el => {
          if (found.length >= 50) return;
          try { if (window.getComputedStyle(el).cursor === 'pointer') check(el); } catch {}
        });
        window.__acCursorInteractive = matchedElements;
        return JSON.stringify(found);
      })()`,
      returnByValue: true,
    });
    const elements = JSON.parse(result.value);
    for (let i = 0; i < elements.length; i++) {
      try {
        const { result: objResult } = await sendCommand("Runtime.evaluate", { expression: `window.__acCursorInteractive[${i}]` });
        if (!objResult.objectId) continue;
        const { node } = await sendCommand("DOM.describeNode", { objectId: objResult.objectId });
        if (existingNodeIds.has(node.backendNodeId)) continue;
        results.push({ ref: "", role: "clickable", name: elements[i].text, backendDOMNodeId: node.backendNodeId, depth: 0 });
      } catch { continue; }
    }
    await sendCommand("Runtime.evaluate", { expression: "delete window.__acCursorInteractive", returnByValue: true });
  } catch { /* DOM 쿼리 실패는 비치명 */ }
  return results;
}

module.exports = { buildSnapshot };
