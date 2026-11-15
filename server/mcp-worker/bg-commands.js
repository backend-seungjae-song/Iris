// 세션 공유 백그라운드 탭 명령: bg_eval, figma_dump
// - 탭 열기·찾기는 host browser.bgOpen (메인 bg-tabs.cjs 가 같은 프로필·주소를 탭 하나로 묶음)
// - 오래 걸리는 페이지 작업은 페이지 안 작업(window.__irisJobs)으로 돌리고 짧은 eval 로 상태만 읽음
//   · 명령 단위 시간 제한(25초)에 걸리지 않게
// - 큰 결과는 host browser.bgSave 로 메인이 직접 파일에 씀 · 서버 명령 결과 보관에 남지 않게
// - 캐시 없음: 결과는 요청마다 새 파일

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const READY_TIMEOUT_MS = 60000;
// 페이지가 큰 작업(직렬화·내보내기)으로 바쁘면 상태 조회 eval 이 실패함 · 이 시간까지는 다시 물음
const POLL_FAIL_MS = 120000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 500;
const INLINE_MAX = 32 * 1024;
const JOB_TTL_MS = 20 * 60 * 1000;

// url 의 node-id(163-17) 또는 인자(163:17·163-17) → Figma 노드 id · 없으면 null
export function figmaNodeId(url, node) {
  const raw = node != null && String(node).trim() !== "" ? String(node).trim()
    : (() => { try { return new URL(String(url)).searchParams.get("node-id") || ""; } catch { return ""; } })();
  const id = raw.replace(/-/g, ":");
  return /^[A-Za-z]?\d+:\d+(?:;\d+:\d+)*$/.test(id) ? id : null;
}

// 같은 초에 여러 세션이 저장해도 겹치지 않게 호출마다 다른 조각(unique)을 붙임
export function outFileName(stamp, unique, label, ext) {
  const safe = String(label).replace(/[^A-Za-z0-9가-힣_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "out";
  return `${stamp}-${unique}-${safe}.${ext}`;
}

// 결과 파일 보관 기간 · 요청마다 새 파일이라 지우지 않으면 같은 노드 덤프가 계속 쌓임
const OUT_KEEP_MS = 24 * 60 * 60 * 1000;
const OUT_NAME = /^\d{8}-\d{6}-[a-z0-9]+-.+\.(json|txt|png|svg)$/;

// figma_dump 에셋 폴더: 덤프 파일 이름에서 .json 을 뺀 이름 + -assets
const OUT_ASSET_DIR = /^\d{8}-\d{6}-[a-z0-9]+-.+-assets$/;
export function assetDirFor(dumpPath) {
  return dumpPath.replace(/\.json$/, "") + "-assets";
}

// 보관 기간이 지난 결과 파일·에셋 폴더 이름 · outFileName 이 만든 이름만(사용자가 out 으로 준 파일은 대상 아님)
export function expiredOutFiles(entries, now, keepMs = OUT_KEEP_MS) {
  return entries.filter((e) => (OUT_NAME.test(e.name) || OUT_ASSET_DIR.test(e.name)) && now - e.mtimeMs > keepMs).map((e) => e.name);
}

// 같은 대상(이름 끝부분)의 이전 결과 파일 후보 · 새 파일 자신은 뺌
export function sameLabelFiles(names, file) {
  const base = path.basename(file);
  const tail = base.replace(/^\d{8}-\d{6}-[a-z0-9]+-/, "");
  return names.filter((n) => n !== base && OUT_NAME.test(n) && n.replace(/^\d{8}-\d{6}-[a-z0-9]+-/, "") === tail);
}

// 같은 Figma 파일이면 주소 모양(/file·/design, 파일 이름, node-id·m·p·t 등 쿼리)과 관계없이 같은 탭 주소 · 탭 하나가 수백 MB
export function figmaFileUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { u = null; }
  const m = u && /(^|\.)figma\.com$/.test(u.hostname) && u.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?(?:\/|$)/);
  if (!m) throw new Error("Figma 파일 주소(https://www.figma.com/design/...)가 아닙니다.");
  // m=dev 를 붙이지 않음: Dev Mode 권한이 없는 파일은 업그레이드 안내만 뜨고 window.figma 가 없음(일반 보기는 됨)
  return `https://www.figma.com/design/${m[1]}${m[2] ? `/branch/${m[2]}` : ""}`;
}

// 페이지 안 작업 시작 · body 는 async 함수 본문(문자열), 반환값은 문자열이나 JSON 으로 바꿀 값
// 직렬화도 같은 체인 안에서 함: 깊은 트리의 JSON 실패가 running 으로 남지 않게
// 가져가지 않은 결과는 JOB_TTL_MS 뒤 페이지가 스스로 지움(worker 가 중간에 죽은 경우)
export function jobStartExpression(jobId, body) {
  const id = JSON.stringify(jobId);
  return `(() => {
  const jobs = window.__irisJobs || (window.__irisJobs = {});
  const job = jobs[${id}] = { state: "running", progress: 0, meta: null, text: "", error: null };
  (async (job) => {
    const value = await (async (job) => { ${body} })(job);
    return typeof value === "string" ? value : JSON.stringify(value, (_k, v) => typeof v === "symbol" ? "mixed" : v);
  })(job).then((text) => { job.text = text; job.state = "done"; },
    (error) => { job.state = "error"; job.error = String((error && (error.stack || error.message)) || error); });
  setTimeout(() => { if (jobs[${id}] === job) delete jobs[${id}]; }, ${JOB_TTL_MS});
  return "started";
})()`;
}

export function jobPollExpression(jobId) {
  return `(() => { const j = (window.__irisJobs || {})[${JSON.stringify(jobId)}];
  return j ? { state: j.state, progress: j.progress, meta: j.meta, length: j.text.length, error: j.error } : { state: "missing" }; })()`;
}

export function jobDropExpression(jobId) {
  return `(() => { if (window.__irisJobs) delete window.__irisJobs[${JSON.stringify(jobId)}]; return true; })()`;
}

// 파일이 끝내 준비되지 않았을 때 이유를 고르려고 읽는 페이지 상태 · 버튼 이름은 한국어·영어 화면 둘 다 · 로그인 안 한 화면은 "가입"만 보이기도 함
export const FIGMA_DIAG_EXPRESSION = `(() => {
  const labels = [...document.querySelectorAll("button,a,[role=button]")].map((b) => (b.innerText || b.getAttribute("aria-label") || "").trim()).filter(Boolean);
  const has = (re) => labels.some((x) => re.test(x));
  return { href: location.href, title: document.title, hasFigma: typeof window.figma === "object",
    login: has(/^(로그인|가입|Log in|Sign in|Sign up)$/i), requestAccess: has(/액세스 요청|접근 요청|Request access/i),
    requestEdit: has(/편집 권한 요청|Request edit access/i) };
})()`;

// 준비 시간 초과 이유 · 진단을 못 읽었으면 일반 문구
export function figmaNotReadyReason(d) {
  if (d?.login) return "이 profile 은 Figma 에 로그인되어 있지 않습니다. 같은 profile 로 browser_new_tab 을 열어 로그인한 뒤 다시 요청하세요.";
  if (d?.requestAccess) return "이 profile 의 Figma 계정은 이 파일에 접근 권한이 없습니다. 권한이 있는 profile 로 요청하세요.";
  if (d?.requestEdit) return "이 profile 의 Figma 계정은 이 파일을 볼 수만 있고('편집 권한 요청' 버튼), 이 상태에서는 Figma 가 읽기 API(window.figma)를 열지 않습니다. 파일 팀에 속한 profile 로 요청하세요.";
  const where = d?.href ? ` 주소 ${String(d.href).slice(0, 120)}, 제목 '${d.title || ""}'.` : "";
  return `Figma 파일이 열리지 않았습니다.${where} 로그인이 필요한 파일이면 profile 로 로그인된 칸을 지정하세요.`;
}

export const FIGMA_READY_EXPRESSION = "(() => { try { return typeof figma === 'object' && !!figma.root && figma.root.children.length > 0; } catch { return false; } })()";

const FIGMA_KEYS = ["visible", "locked", "x", "y", "width", "height", "absoluteBoundingBox", "rotation", "opacity", "blendMode", "isMask", "clipsContent",
  "layoutMode", "layoutWrap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing", "counterAxisSpacing",
  "primaryAxisAlignItems", "counterAxisAlignItems", "counterAxisAlignContent", "primaryAxisSizingMode", "counterAxisSizingMode",
  "layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign", "layoutGrow", "layoutPositioning", "itemReverseZIndex",
  "constraints", "minWidth", "maxWidth", "minHeight", "maxHeight", "fills", "strokes", "strokeWeight", "strokeTopWeight",
  "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign", "strokeCap", "strokeJoin", "dashPattern",
  "effects", "cornerRadius", "cornerSmoothing", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  "boundVariables", "characters", "fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing",
  "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textCase", "textDecoration", "textTruncation", "maxLines",
  "componentProperties", "variantProperties", "componentPropertyDefinitions", "overflowDirection", "vectorPaths", "arcData",
  "pointCount", "innerRadius", "booleanOperation", "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId",
  "reactions", "strokesIncludedInLayout", "maskType", "exportSettings", "relativeTransform", "annotations", "scrollBehavior",
  "numberOfFixedChildren", "leadingTrim", "paragraphIndent", "componentPropertyReferences", "explicitVariableModes", "layoutGrids",
  "resolvedVariableModes", "absoluteRenderBounds", "targetAspectRatio", "inferredAutoLayout", "isAsset", "overrides", "listSpacing",
  "textDecorationStyle", "textDecorationColor"];
// 그리드 속성은 모든 노드에 기본값으로 있음 → 그리드 컨테이너와 그 자식에서만 담음
const FIGMA_GRID_KEYS = ["gridRowCount", "gridColumnCount", "gridRowGap", "gridColumnGap", "gridRowSizes", "gridColumnSizes",
  "gridAutoTracks", "gridItemsPositioning", "gridRowSizingCSS", "gridColumnSizingCSS"];
const FIGMA_GRID_CHILD_KEYS = ["gridRowAnchorIndex", "gridColumnAnchorIndex", "gridRowSpan", "gridColumnSpan",
  "gridChildHorizontalAlign", "gridChildVerticalAlign"];
const FIGMA_SEGMENT_FIELDS = ["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "fills", "textDecoration",
  "textCase", "hyperlink", "listOptions", "indentation", "boundVariables", "textStyleId", "fillStyleId", "openTypeFeatures",
  "listSpacing", "paragraphIndent", "paragraphSpacing", "textDecorationStyle", "textDecorationColor"];

// 섹션은 자식이 아니어도 영역 안의 형제 노드를 함께 그림(내보내기 png 에 나옴) → 같은 부모 아래 영역이 겹치는 노드
// 노드가 놓인 페이지를 먼저 불러옴 · 안 불러온 페이지는 children 이 비어 보일 수 있음
const FIGMA_SCOPE_JS = `
  const pageOf = (n) => { let p = n; while (p && p.type !== "PAGE") p = p.parent; return p; };
  async function loadPageOf(n) { const p = pageOf(n); if (p && typeof p.loadAsync === "function") { try { await p.loadAsync(); } catch (e) {} } }
  function sectionOverlap(n) {
    if (n.type !== "SECTION" || !n.parent || !("children" in n.parent)) return [];
    const b = n.absoluteBoundingBox; if (!b) return [];
    const sibs = n.parent.children, at = sibs.indexOf(n), out = [];
    sibs.forEach((c, i) => {
      if (c === n) return;
      const a = c.absoluteBoundingBox;
      if (!a || !(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y)) return;
      out.push({ node: c, inside: a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height, aboveSection: i > at });
    });
    return out;
  }`;

// 요청 노드부터 하위 전체를 깊이 제한 없이 직렬화 · 사용자 화면(currentPage·viewport·selection)은 바꾸지 않음
// 읽지 못한 필드는 빼지 않고 { error } 로 남김
export function figmaDumpBody(nodeId) {
  return `
  const f = window.figma;
  // Dev Mode 기본값은 숨긴 인스턴스 자식을 children 에서 뺌 → 덤프 동안만 끔 · 동시 덤프는 수로 세어 마지막이 복원
  const w = window;
  if (!w.__irisNoSkip) { w.__irisNoSkip = 0; w.__irisSkipPrev = f.skipInvisibleInstanceChildren; }
  w.__irisNoSkip++;
  try { f.skipInvisibleInstanceChildren = false; } catch (e) {}
  try {
  ${FIGMA_SCOPE_JS}
  const node = await f.getNodeByIdAsync(${JSON.stringify(nodeId)});
  if (!node) throw new Error("노드 ${nodeId} 를 찾지 못했습니다(지워졌거나 다른 파일의 노드). 페이지: " + f.root.children.map((p) => p.name + "(" + p.id + ")").join(", "));
  await loadPageOf(node);
  const KEYS = ${JSON.stringify(FIGMA_KEYS)};
  const SEG = ${JSON.stringify(FIGMA_SEGMENT_FIELDS)};
  const GRID = ${JSON.stringify(FIGMA_GRID_KEYS)};
  const GRID_CHILD = ${JSON.stringify(FIGMA_GRID_CHILD_KEYS)};
  const err = (e) => ({ error: String((e && e.message) || e) });
  async function ser(n) {
    const o = { id: n.id, type: n.type, name: n.name };
    const keys = [...KEYS];
    if (n.layoutMode === "GRID") keys.push(...GRID);
    if (n.parent && n.parent.layoutMode === "GRID") keys.push(...GRID_CHILD);
    for (const k of keys) {
      if (!(k in n)) continue;
      try { const v = n[k]; if (v !== undefined) o[k] = v; } catch (e) { o[k] = err(e); }
    }
    if (n.type === "TEXT") { try { o.textSegments = n.getStyledTextSegments(SEG); } catch (e) { o.textSegments = err(e); } }
    if (n.type === "INSTANCE") {
      try {
        const m = await n.getMainComponentAsync();
        o.mainComponent = m ? { id: m.id, name: m.name, key: m.key, remote: m.remote,
          set: m.parent && m.parent.type === "COMPONENT_SET" ? { id: m.parent.id, name: m.parent.name, key: m.parent.key,
            componentPropertyDefinitions: m.parent.componentPropertyDefinitions } : null } : null;
      } catch (e) { o.mainComponent = err(e); }
    }
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") { try { o.key = n.key; } catch (e) { o.key = err(e); } }
    if (typeof n.getCSSAsync === "function") { try { o.css = await n.getCSSAsync(); } catch (e) { o.css = err(e); } }
    collectRefs(o);
    job.progress++;
    if ("children" in n) { o.children = []; for (const c of n.children) o.children.push(await ser(c)); }
    return o;
  }
  // 스타일·변수·프로토타입 목적지는 id 만 있어 구현에 쓸 이름을 표로 따로 담음
  const styleIds = new Set(), varIds = new Set(), destIds = new Set();
  const STYLE_KEYS = ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId"];
  function aliases(v) {
    if (!v || typeof v !== "object") return;
    if (v.type === "VARIABLE_ALIAS" && typeof v.id === "string") { varIds.add(v.id); return; }
    for (const x of Object.values(v)) aliases(x);
  }
  function collectRefs(o) {
    const segs = Array.isArray(o.textSegments) ? o.textSegments : [];
    for (const x of [o, ...segs]) {
      for (const k of STYLE_KEYS) if (typeof x[k] === "string" && x[k]) styleIds.add(x[k]);
      aliases(x.boundVariables);
      aliases(x.fills); aliases(x.strokes); aliases(x.effects);
    }
    // 조건 분기 안의 동작까지 · 변수 바꾸기 동작의 변수도 이름 표에
    (function refs(v) {
      if (!v || typeof v !== "object") return;
      if (typeof v.destinationId === "string") destIds.add(v.destinationId);
      if (typeof v.variableId === "string") varIds.add(v.variableId);
      for (const x of Object.values(v)) refs(x);
    })(o.reactions);
  }
  async function names() {
    const styles = {}, variables = {}, destinations = {};
    for (const id of styleIds) {
      try { const st = await f.getStyleByIdAsync(id); styles[id] = st ? { name: st.name, type: st.type, description: st.description || "", remote: st.remote } : null; } catch (e) { styles[id] = err(e); }
    }
    // 별칭이 가리키는 변수도 표에 넣으려고 값 안의 별칭을 따라가며 반복
    const seen = new Set();
    while ([...varIds].some((id) => !seen.has(id))) {
      const id = [...varIds].find((x) => !seen.has(x));
      seen.add(id);
      try {
        const v = await f.variables.getVariableByIdAsync(id);
        const col = v ? await f.variables.getVariableCollectionByIdAsync(v.variableCollectionId) : null;
        variables[id] = v ? { name: v.name, type: v.resolvedType, collection: col ? col.name : null, valuesByMode: v.valuesByMode,
          modes: col ? col.modes : null, codeSyntax: v.codeSyntax } : null;
        if (v) aliases(v.valuesByMode);
      } catch (e) { variables[id] = err(e); }
    }
    for (const id of destIds) {
      try {
        const d = await f.getNodeByIdAsync(id);
        destinations[id] = d ? { name: d.name, type: d.type, overlayPositionType: d.overlayPositionType, overlayBackground: d.overlayBackground,
          overlayBackgroundInteraction: d.overlayBackgroundInteraction } : null;
      } catch (e) { destinations[id] = err(e); }
    }
    return { styles, variables, destinations };
  }
  const page = pageOf(node);
  const tree = await ser(node);
  const overlapping = [];
  for (const o of sectionOverlap(node)) overlapping.push({ inside: o.inside, aboveSection: o.aboveSection, node: await ser(o.node) });
  job.meta = { fileKey: f.fileKey, page: page ? { id: page.id, name: page.name } : null, nodeCount: job.progress, name: node.name };
  return { ...job.meta, ...(await names()), root: tree, ...(overlapping.length ? { overlapping } : {}) };
  } finally {
    if (--w.__irisNoSkip === 0) { try { f.skipInvisibleInstanceChildren = w.__irisSkipPrev; } catch (e) {} }
  }`;
}

// png 는 2배, 긴 변이 EXPORT_MAX_PX 를 넘으면 그만큼 줄임(페이지 전체 2배는 내보내는 동안 탭이 멈춤) · svg 는 문자열 · base64 로 돌려줌
const EXPORT_MAX_PX = 8192;
export function figmaExportBody(nodeId, format) {
  const fmt = format === "svg" ? "SVG_STRING" : "PNG";
  return `
  const node = await window.figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
  if (!node) throw new Error("노드 ${nodeId} 를 찾지 못했습니다.");
  // 페이지는 크기가 없어 자식 테두리를 합쳐 잼
  let w = node.width, h = node.height;
  if (node.type === "PAGE") {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const c of node.children) { const b = c.absoluteBoundingBox; if (!b) continue;
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height); }
    w = x2 - x1; h = y2 - y1;
  }
  const longest = Math.max(w || 0, h || 0);
  const scale = longest > 0 ? Math.min(2, ${EXPORT_MAX_PX} / longest) : 2;
  job.meta = { scale, width: Math.round((w || 0) * scale), height: Math.round((h || 0) * scale) };
  const out = await node.exportAsync(${fmt === "PNG" ? "{ format: \"PNG\", constraint: { type: \"SCALE\", value: scale } }" : "{ format: \"SVG_STRING\" }"});
  if (typeof out === "string") return out;
  let s = ""; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(s);`;
}

// bg_eval 식을 페이지 안 작업으로 돌림 · 명령 시간 제한(25초)을 넘는 식도 끝까지 받음
// 결과는 { u: true }(undefined) 또는 { v: 값 } JSON · 문자열과 JSON 값을 구분하려고 감쌈
export function bgEvalBody(expression) {
  return `const v = await (${expression}\n);
  return JSON.stringify(v === undefined ? { u: true } : { v }, (_k, x) => typeof x === "symbol" ? "mixed" : typeof x === "bigint" ? String(x) : x);`;
}

// 식 하나인지(문장 여러 개면 false) · 문장이면 작업으로 감쌀 수 없어 바로 실행
export function isSingleExpression(expression) {
  try { new vm.Script(`(async () => (${expression}\n))`); return true; } catch { return false; }
}

// 저장할 에셋 목록 · 이미지 채움 원본(해시별 하나), 디자이너 내보내기 지정 노드, 맨 위 에셋 노드(아이콘)
// 아이콘은 에셋 노드 안의 에셋만 뺌 · 화면 전체에 내보내기 지정이 걸린 파일이 있어 내보내기 지정은 안쪽 아이콘을 가리지 않음
// 숨긴 노드는 내보내면 빈 그림이라 노드 내보내기에서 뺌 · 이미지 원본은 숨긴 레이어 것도 담음
// 그려지는 영역이 없는 노드(absoluteRenderBounds null)는 Figma 가 내보내기를 거부함 → skipped 로 남김
export function figmaAssetListBody(nodeId) {
  return `
  const f = window.figma;
  ${FIGMA_SCOPE_JS}
  const node = await f.getNodeByIdAsync(${JSON.stringify(nodeId)});
  if (!node) throw new Error("노드 ${nodeId} 를 찾지 못했습니다.");
  await loadPageOf(node);
  const hashes = new Set(), items = [], skipped = [];
  const drawn = (n) => { try { return n.absoluteRenderBounds !== null; } catch (e) { return true; } };
  const imageOnlyLeaf = (n) => !("children" in n) && Array.isArray(n.fills) && n.fills.some((p) => p.type === "IMAGE");
  const walk = (n, hidden, covered) => {
    const h = hidden || n.visible === false;
    for (const key of ["fills", "strokes"]) {
      const ps = n[key];
      if (Array.isArray(ps)) for (const p of ps) if (p && p.type === "IMAGE" && p.imageHash) hashes.add(p.imageHash);
    }
    let cov = covered;
    const exported = !h && Array.isArray(n.exportSettings) && n.exportSettings.length > 0;
    if (exported) {
      if (drawn(n)) n.exportSettings.forEach((setting, index) => items.push({ kind: "export", id: n.id, name: n.name, index, setting }));
      else skipped.push({ kind: "export", id: n.id, name: n.name, reason: "그려지는 레이어가 없음" });
    }
    if (!h && !covered && n.isAsset && n.type !== "PAGE") {
      if (!exported && !imageOnlyLeaf(n)) {
        if (drawn(n)) items.push({ kind: "icon", id: n.id, name: n.name });
        else skipped.push({ kind: "icon", id: n.id, name: n.name, reason: "그려지는 레이어가 없음" });
      }
      cov = true;
    }
    job.progress++;
    if ("children" in n) for (const c of n.children) walk(c, h, cov);
  };
  walk(node, false, false);
  for (const o of sectionOverlap(node)) walk(o.node, false, false);
  for (const hash of hashes) items.unshift({ kind: "image", hash });
  return { items, skipped };`;
}

// 에셋 한 묶음을 base64 로 · 하나가 실패해도 나머지는 계속, 실패는 error 로 남김
// 묶음 크기가 maxChars 를 넘으면 거기서 멈추고 next 로 다음 시작 위치를 알림(페이지 메모리)
export function figmaAssetBatchBody(items, maxChars) {
  return `
  const f = window.figma;
  const items = ${JSON.stringify(items)};
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const out = []; let chars = 0, next = null;
  for (let i = 0; i < items.length; i++) {
    if (chars > ${maxChars} && out.length) { next = i; break; }
    const it = items[i];
    try {
      let bytes;
      if (it.kind === "image") {
        const img = f.getImageByHash(it.hash);
        if (!img) throw new Error("이미지를 찾지 못했습니다.");
        bytes = await img.getBytesAsync();
      } else {
        const n = await f.getNodeByIdAsync(it.id);
        if (!n) throw new Error("노드를 찾지 못했습니다.");
        bytes = await n.exportAsync(it.kind === "export" ? it.setting : { format: "SVG" });
      }
      const data = b64(bytes);
      chars += data.length;
      out.push({ i, data });
    } catch (e) { out.push({ i, error: String((e && e.message) || e) }); }
    job.progress++;
  }
  return { out, next };`;
}

// 이미지 원본 형식 · 내보내기는 지정 형식을 따름
export function imageExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "bin";
}

// 에셋 파일 이름 · 노드 id 의 : ; 는 파일 이름에 못 써서 바꿈
export function assetFileName(item, ext) {
  const id = String(item.id || "").replace(/[^A-Za-z0-9]+/g, "-");
  if (item.kind === "image") return `images/${item.hash}.${ext}`;
  if (item.kind === "icon") return `icons/${id}.svg`;
  const st = item.setting || {};
  const c = st.constraint || {};
  const size = c.type === "SCALE" ? `@${c.value}x` : c.type === "WIDTH" ? `-w${c.value}` : c.type === "HEIGHT" ? `-h${c.value}` : "";
  const suffix = st.suffix ? `-${String(st.suffix).replace(/[^A-Za-z0-9가-힣_.-]+/g, "-")}` : "";
  return `exports/${id}${suffix || size || `-${item.index}`}.${String(st.format || "png").toLowerCase()}`;
}

// 에셋 저장 한도 · 사용자 기준 덤프 하나 10GB · 넘으면 나머지는 저장하지 않고 errors 에 남김
const ASSET_MAX_BYTES = 10 * 1024 ** 3;
const ASSET_BATCH = 25;
const ASSET_BATCH_CHARS = 48 * 1024 * 1024;

// open({url, profile}) → target · evalOn(target, expression) → 값 · save({tabId, jobId, file, base64}) → {path, bytes} · 실패는 throw
// 막 연 탭이나 주소 이동 중에는 페이지 실행 문맥이 아직 없음 · 잠시 뒤 다시 하면 됨
const CONTEXT_RETRY_MS = 10000;
export function isContextNotReady(error) {
  return /execution context|context was destroyed/i.test(String((error && error.message) || error));
}

export function createBgCommands({ open, evalOn: evalRaw, save, outDir, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  randomId = () => Math.random().toString(36).slice(2, 10) }) {
  async function evalOn(target, expression) {
    const end = now() + CONTEXT_RETRY_MS;
    for (;;) {
      try { return await evalRaw(target, expression); }
      catch (error) { if (!isContextNotReady(error) || now() >= end) throw error; }
      await sleep(200);
    }
  }
  const stamp = () => new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const challengeError = () => Object.assign(new Error("사람 확인(Cloudflare 등) 화면이 떠 숨은 탭에서 진행할 수 없습니다. "
    + "같은 profile 로 browser_new_tab 을 열어 사람이 통과한 뒤 다시 요청하세요."), { code: "CHALLENGE" });

  // 실패해도 요청은 계속 · 정리는 다음 요청 때 다시 시도
  async function pruneOutDir() {
    try {
      const names = await fs.promises.readdir(outDir);
      const entries = [];
      for (const name of names) { try { entries.push({ name, mtimeMs: (await fs.promises.stat(path.join(outDir, name))).mtimeMs }); } catch {} }
      for (const name of expiredOutFiles(entries, now())) { try { await fs.promises.unlink(path.join(outDir, name)); } catch {} }
    } catch {}
  }

  // 같은 노드를 다시 읽어 내용이 같으면 새 파일을 지우고 이전 파일 경로를 돌려줌 · 같은 덤프가 여러 벌 쌓이지 않게
  async function reuseSame(out) {
    try {
      const dir = path.dirname(out.path);
      const fresh = await fs.promises.readFile(out.path);
      for (const name of sameLabelFiles(await fs.promises.readdir(dir), out.path)) {
        const prev = path.join(dir, name);
        try {
          if ((await fs.promises.stat(prev)).size !== fresh.length) continue;
          if (!fresh.equals(await fs.promises.readFile(prev))) continue;
          await fs.promises.unlink(out.path);
          return { ...out, path: prev, reused: true };
        } catch {}
      }
    } catch {}
    return out;
  }

  async function openChecked(args) {
    const target = await open(args);
    if (target?.challenge) throw challengeError();
    return target;
  }

  // 시간 초과면 diagnose(target) 가 돌려준 문구로 실패
  async function waitFor(args, expression, timeoutMs, diagnose) {
    const end = now() + timeoutMs;
    for (;;) {
      const target = await open(args);
      if (await evalOn(target, expression)) return target;
      if (target?.challenge) throw challengeError();
      if (now() >= end) throw new Error(`${await diagnose(target)} (${Math.round(timeoutMs / 1000)}초 기다림)`);
      await sleep(POLL_MS);
    }
  }

  // 페이지 안 작업을 끝까지 기다린 뒤 메인이 결과를 파일로 씀 · 실패하면 페이지 작업을 지움
  async function runJobToFile(args, body, file, base64 = false) {
    return runJob(args, body, async (id) => {
      const target = await openChecked(args);
      return save({ tabId: target.tabId, jobId: id, file, base64 });
    });
  }

  // 페이지 안 작업을 시작해 끝까지 기다린 뒤 take(id) 로 결과를 가져감 · 가져가기 전에 실패하면 페이지 작업을 지움
  async function runJob(args, body, take) {
    const id = "j" + randomId();
    let saved = false, status = null;
    try {
      await evalOn(await openChecked(args), jobStartExpression(id, body));
      const end = now() + JOB_TIMEOUT_MS;
      let failingSince = null;
      for (;;) {
        try {
          status = await evalOn(await openChecked(args), jobPollExpression(id));
          failingSince = null;
        } catch (error) {
          if (error?.code === "CHALLENGE") throw error;
          failingSince ??= now();
          if (now() - failingSince >= POLL_FAIL_MS) {
            throw new Error(`페이지가 ${POLL_FAIL_MS / 1000}초 동안 응답하지 않습니다(처리 ${status?.progress ?? 0}개). 노드가 너무 크면 하위 노드로 나눠 요청하세요. 마지막 오류: ${error?.message || error}`);
          }
          await sleep(POLL_MS);
          continue;
        }
        if (status?.state !== "running") break;
        if (now() >= end) throw new Error(`페이지 작업이 ${JOB_TIMEOUT_MS / 60000}분 안에 끝나지 않았습니다(처리 ${status.progress}개).`);
        await sleep(POLL_MS);
      }
      if (status?.state === "missing") throw new Error("페이지가 다시 로드되어 작업이 사라졌습니다. 다시 요청하세요.");
      if (status?.state === "error") throw new Error(status.error || "페이지 작업 실패");
      const out = await take(id, status);
      saved = true;
      return { ...out, meta: status.meta };
    } finally {
      if (!saved) { try { await evalOn(await open(args), jobDropExpression(id)); } catch {} }
    }
  }

  // Figma 주소면 figma_dump 와 같은 탭(주소 정규화)을 쓰고 Figma 가 준비될 때까지 기다림
  // 그 밖의 주소는 문서 로드가 끝날 때까지 기다림 · 끝내 안 끝나는 페이지도 있어 시간이 지나면 그대로 실행
  async function bgTab(args) {
    let url = String(args.url), isFigma = false;
    try { url = figmaFileUrl(url); isFigma = true; } catch {}
    const tab = { url, profile: args.profile };
    if (isFigma) {
      await waitFor(tab, FIGMA_READY_EXPRESSION, READY_TIMEOUT_MS,
        async (target) => figmaNotReadyReason(await evalOn(target, FIGMA_DIAG_EXPRESSION).catch(() => null)));
      return tab;
    }
    const end = now() + READY_TIMEOUT_MS;
    for (;;) {
      const target = await openChecked(tab);
      // 확인 eval 자체가 실패하면 기다리지 않음 · 실제 실행이 그 오류를 알림
      let ready;
      try { ready = await evalOn(target, "document.readyState === 'complete'"); } catch { return tab; }
      if (ready) return tab;
      if (now() >= end) return tab;
      await sleep(POLL_MS);
    }
  }

  async function bgEval(args) {
    if (!args.expression) throw new Error("expression 이 필요합니다.");
    // 상대 경로는 worker 배포 폴더 기준이 되어 다음 배포 때 지워짐
    if (args.out && !path.isAbsolute(String(args.out))) throw new Error("out 은 절대 경로여야 합니다.");
    const expression = String(args.expression);
    const tab = await bgTab(args);
    // out 을 주면 그 경로 그대로 · 아니면 문자열은 .txt, 그 밖은 .json
    const file = (isString) => args.out ? path.resolve(String(args.out))
      : path.join(outDir, outFileName(stamp(), randomId(), "bg-eval", isString ? "txt" : "json"));
    if (!isSingleExpression(expression)) {
      // 문장 여러 개는 작업으로 감쌀 수 없어 바로 실행(명령 시간 제한 25초 안)
      const value = await evalOn(await openChecked(tab), expression);
      return writeEvalResult(args, value, file);
    }
    const out = await runJob(tab, bgEvalBody(expression), async (id, status) => {
      if (!args.out && status.length <= INLINE_MAX + 16) {
        const text = await evalOn(await openChecked(tab), `(() => { const j = (window.__irisJobs || {})[${JSON.stringify(id)}]; const t = j ? j.text : null; if (j) delete window.__irisJobs[${JSON.stringify(id)}]; return t; })()`);
        if (typeof text !== "string") throw new Error("페이지가 다시 로드되어 결과가 사라졌습니다. 다시 요청하세요.");
        const parsed = JSON.parse(text);
        return { inline: parsed.u ? undefined : parsed.v };
      }
      // 큰 결과는 페이지에서 감싼 것을 풀어 메인이 파일로 씀
      const kind = await evalOn(await openChecked(tab), `(() => { const j = (window.__irisJobs || {})[${JSON.stringify(id)}]; if (!j) return null;
        const o = JSON.parse(j.text); j.text = o.u ? "" : typeof o.v === "string" ? o.v : JSON.stringify(o.v); return o.u ? "undefined" : typeof o.v; })()`);
      if (kind == null) throw new Error("페이지가 다시 로드되어 결과가 사라졌습니다. 다시 요청하세요.");
      if (!args.out) await pruneOutDir();
      const target = file(kind === "string");
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const target2 = await openChecked(tab);
      const saved = await save({ tabId: target2.tabId, jobId: id, file: target, base64: false });
      return { file: saved };
    });
    if (out.file) return { path: out.file.path, bytes: out.file.bytes };
    return writeEvalResult(args, out.inline, file);
  }

  async function writeEvalResult(args, value, file) {
    const text = (typeof value === "string" ? value : JSON.stringify(value)) ?? "";
    if (!args.out && text.length <= INLINE_MAX) return value === undefined ? {} : { value };
    if (!args.out) await pruneOutDir();
    const target = file(typeof value === "string");
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, text, { flag: "wx" });
    return { path: target, bytes: Buffer.byteLength(text) };
  }

  // 에셋을 dir 에 저장하고 목록(assets.json)을 씀 · 항목 실패는 errors 에 남기고 계속
  async function saveAssets(tab, nodeId, dir) {
    await fs.promises.mkdir(dir, { recursive: true });
    const listFile = path.join(dir, ".list.json");
    let items, skipped;
    try {
      await runJobToFile(tab, figmaAssetListBody(nodeId), listFile);
      ({ items = [], skipped = [] } = JSON.parse(await fs.promises.readFile(listFile, "utf8")));
    } finally { await fs.promises.rm(listFile, { force: true }).catch(() => {}); }
    const manifest = { images: {}, exports: {}, icons: {}, skipped, errors: [], bytes: 0 };
    const used = new Set();
    const where = (it) => it.kind === "image" ? { kind: it.kind, hash: it.hash } : { kind: it.kind, id: it.id, name: it.name };
    let i = 0;
    while (i < items.length) {
      if (manifest.bytes >= ASSET_MAX_BYTES) {
        for (const it of items.slice(i)) manifest.errors.push({ ...where(it), error: "에셋 합계가 10GB 를 넘어 저장하지 않았습니다." });
        break;
      }
      const batch = items.slice(i, i + ASSET_BATCH);
      const tmp = path.join(dir, `.batch-${i}.json`);
      let res;
      try {
        await runJobToFile(tab, figmaAssetBatchBody(batch, ASSET_BATCH_CHARS), tmp);
        res = JSON.parse(await fs.promises.readFile(tmp, "utf8"));
      } catch (error) {
        if (error?.code === "CHALLENGE") throw error;
        for (const it of batch) manifest.errors.push({ ...where(it), error: String(error?.message || error) });
        i += batch.length;
        continue;
      } finally { await fs.promises.rm(tmp, { force: true }).catch(() => {}); }
      for (const r of res.out || []) {
        const it = batch[r.i];
        if (r.error) { manifest.errors.push({ ...where(it), error: r.error }); continue; }
        const buf = Buffer.from(r.data, "base64");
        let name = assetFileName(it, it.kind === "image" ? imageExt(buf) : null);
        for (let k = 2; used.has(name); k++) name = name.replace(/(\.[a-z0-9]+)$/, `-${k}$1`);
        used.add(name);
        await fs.promises.mkdir(path.join(dir, path.dirname(name)), { recursive: true });
        await fs.promises.writeFile(path.join(dir, name), buf);
        manifest.bytes += buf.length;
        const entry = { file: name, bytes: buf.length, sha1: crypto.createHash("sha1").update(buf).digest("hex") };
        if (it.kind === "image") manifest.images[it.hash] = entry;
        else if (it.kind === "icon") manifest.icons[it.id] = { name: it.name, ...entry };
        else (manifest.exports[it.id] ||= { name: it.name, files: [] }).files.push({ ...entry, setting: it.setting });
      }
      i += res.next == null ? batch.length : res.next;
    }
    await fs.promises.writeFile(path.join(dir, "assets.json"), JSON.stringify(manifest, null, 1));
    return manifest;
  }

  // 덤프를 이전 파일로 바꿨으면 에셋 폴더도 그 이름으로 · 이전 폴더가 있고 목록이 같으면 새 폴더를 지움
  // 목록이 다르면(같은 속성에 그림만 바뀐 경우) 새 폴더를 그대로 둠
  async function reuseSameAssets(dir, prevDir) {
    try {
      if (dir === prevDir) return dir;
      if (!fs.existsSync(prevDir)) { await fs.promises.rename(dir, prevDir); return prevDir; }
      const [a, b] = await Promise.all([fs.promises.readFile(path.join(dir, "assets.json")), fs.promises.readFile(path.join(prevDir, "assets.json"))]);
      if (!a.equals(b)) return dir;
      await fs.promises.rm(dir, { recursive: true, force: true });
      return prevDir;
    } catch { return dir; }
  }

  async function figmaDump(args) {
    const fileUrl = figmaFileUrl(args.url);
    const nodeId = figmaNodeId(args.url, args.node);
    if (!nodeId) throw new Error("노드를 정하지 못했습니다 — url 에 node-id 가 있거나 node(예: 163:17)를 주세요.");
    const format = args.export == null ? null : String(args.export).toLowerCase();
    if (format && format !== "png" && format !== "svg") throw new Error("export 는 png 또는 svg 입니다.");
    const tab = { url: fileUrl, profile: args.profile };
    await pruneOutDir();
    await waitFor(tab, FIGMA_READY_EXPRESSION, READY_TIMEOUT_MS,
      async (target) => figmaNotReadyReason(await evalOn(target, FIGMA_DIAG_EXPRESSION).catch(() => null)));
    const fileKey = new URL(fileUrl).pathname.split("/")[2];
    const s = stamp(), unique = randomId(), label = `figma-${fileKey}-${nodeId}`;
    const dump = await runJobToFile(tab, figmaDumpBody(nodeId), path.join(outDir, outFileName(s, unique, label, "json")));
    const kept = await reuseSame(dump);
    const result = { path: kept.path, bytes: dump.bytes, nodeCount: dump.meta?.nodeCount, page: dump.meta?.page, name: dump.meta?.name };
    if (format) {
      const image = await runJobToFile(tab, figmaExportBody(nodeId, format), path.join(outDir, outFileName(s, unique, label, format)), format === "png");
      result.exportPath = (await reuseSame(image)).path;
      if (format === "png" && image.meta) result.exportScale = Number(image.meta.scale.toFixed(3));
    }
    // 에셋은 덤프와 별개로 실패해도 덤프 결과는 그대로 돌려줌
    if (args.assets !== false) {
      const dir = assetDirFor(dump.path);
      try {
        const m = await saveAssets(tab, nodeId, dir);
        result.assetsPath = kept.reused ? await reuseSameAssets(dir, assetDirFor(kept.path)) : dir;
        result.assets = { images: Object.keys(m.images).length, exports: Object.values(m.exports).reduce((n, e) => n + e.files.length, 0),
          icons: Object.keys(m.icons).length, skipped: m.skipped.length, errors: m.errors.length, bytes: m.bytes };
        if (m.errors.length) result.assetErrors = m.errors.slice(0, 5);
      } catch (error) {
        result.assetsPath = dir;
        result.assetsError = String(error?.message || error);
      }
    }
    return result;
  }

  return { bgEval, figmaDump };
}
