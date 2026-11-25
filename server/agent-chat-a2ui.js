// 대화 모드 A2UI 선언형 UI 메시지 파싱·상태 적용·액션 포맷
// - 공식 Google A2UI v0.9 Basic Catalog 와 간편 중첩 단축 형식을 모두 지원
// - 외부 입력(마크다운 블록·HTTP)은 경계에서 크기·깊이·URL 스킴·타입을 제한해 정제

export const A2UI_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";
export const A2UI_BASIC_CATALOG = Object.freeze([
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Modal",
  "Divider",
  "Text",
  "Image",
  "Icon",
  "Button",
  "TextField",
  "CheckBox",
  "ChoicePicker",
  "Slider",
  "DateTimeInput",
  "Badge",
  "KeyValue",
  "Table",
  "Progress",
]);

const MAX_COMPONENTS = 200;
const MAX_DEPTH = 8;
const MAX_STRING = 8000;
const MAX_SURFACES = 12;
const MAX_BLOCKS = 64;
const MAX_BLOCK_BYTES = 256 * 1024;
const FENCE_RE = /```a2ui[ \t]*\r?\n([\s\S]*?)```/g;

const TYPE_ALIASES = {
  Checkbox: "CheckBox",
  checkbox: "CheckBox",
  Select: "ChoicePicker",
  MultipleChoice: "ChoicePicker",
};

function clip(value, max = MAX_STRING) {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeId(value, fallback) {
  const s = clip(String(value || ""), 120).trim();
  return s || fallback;
}

// A2UI JSON Pointer({ "@path": "/a/b" } | { path: "/a/b" }) 와 "@a.b" 를 "@a.b" 문자열로 통일
function normalizeBindable(value) {
  if (plainObject(value)) {
    const raw = typeof value["@path"] === "string" ? value["@path"]
      : typeof value.path === "string" ? value.path
        : typeof value.literalString === "string" ? value.literalString
          : null;
    if (raw === null) return undefined;
    if (typeof value.literalString === "string") return clip(value.literalString, MAX_STRING);
    const clean = clip(raw, 200).trim().replace(/^@/, "").replace(/^\/+/, "").replace(/\//g, ".");
    return clean ? `@${clean}` : "";
  }
  if (typeof value === "string") return clip(value, MAX_STRING);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

function safeHttpUrl(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = clip(raw, 2048).trim();
  if (!/^https?:\/\//i.test(trimmed)) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function safeJsonValue(value, depth = 0) {
  if (value == null || typeof value === "boolean") return value ?? null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return clip(value, MAX_STRING);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeJsonValue(item, depth + 1));
  if (plainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) {
      out[clip(k, 120)] = safeJsonValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

function normalizeOptions(rawList) {
  return rawList.slice(0, 60).map((o) => (
    typeof o === "string" ? { value: clip(o, 200), label: clip(o, 400) }
      : plainObject(o) ? {
        value: clip(String(o.value ?? o.label ?? ""), 200),
        label: clip(String(o.label ?? o.value ?? ""), 400),
        ...(typeof o.description === "string" ? { description: clip(o.description, 400) } : {}),
      } : null
  )).filter((o) => o && (o.value || o.label));
}

function collectRefs(raw, refs) {
  if (!plainObject(raw)) return;
  if (typeof raw.child === "string" && raw.child.trim()) refs.add(raw.child.trim());
  if (Array.isArray(raw.children)) {
    for (const c of raw.children) if (typeof c === "string" && c.trim()) refs.add(c.trim());
  }
  const tabList = Array.isArray(raw.tabs) ? raw.tabs : Array.isArray(raw.tabItems) ? raw.tabItems : null;
  if (tabList) {
    for (const t of tabList) if (plainObject(t) && typeof t.child === "string" && t.child.trim()) refs.add(t.child.trim());
  }
  if (typeof raw.entryPointChild === "string" && raw.entryPointChild.trim()) refs.add(raw.entryPointChild.trim());
  if (typeof raw.contentChild === "string" && raw.contentChild.trim()) refs.add(raw.contentChild.trim());
}

function resolveChildRef(ref, counter, depth, ctx, ancestors) {
  if (typeof ref === "string") {
    const id = ref.trim();
    const target = id && ctx?.byId?.get(id);
    if (!target || ancestors.has(id)) return null;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);
    return normalizeComponent(target, counter, depth, ctx, nextAncestors);
  }
  if (plainObject(ref)) return normalizeComponent(ref, counter, depth, ctx, ancestors);
  return null;
}

function normalizeComponent(raw, counter, depth = 0, ctx = null, ancestors = new Set()) {
  if (!plainObject(raw) || depth >= MAX_DEPTH || counter.n >= MAX_COMPONENTS) return null;
  const rawType = clip(String(raw.component ?? raw.type ?? ""), 60).trim();
  if (!rawType) return null;
  const type = TYPE_ALIASES[rawType] || rawType;
  counter.n++;
  const out = { type };
  if (typeof raw.id === "string" && raw.id.trim()) out.id = clip(raw.id.trim(), 120);

  for (const key of ["text", "label", "variant", "tone", "bind", "placeholder", "value", "title", "description", "unit", "alt", "fit"]) {
    const val = normalizeBindable(raw[key]);
    if (val !== undefined) out[key] = val;
  }

  if (!out.variant && typeof raw.usageHint === "string") {
    const hint = clip(raw.usageHint.trim(), 40);
    if (hint === "longText") out.multiline = true;
    else out.variant = hint;
  }
  if (!out.variant && raw.primary === true && type === "Button") out.variant = "primary";

  if (typeof raw.action === "string") {
    out.action = clip(raw.action, 200);
  } else if (plainObject(raw.action)) {
    const name = raw.action.name ?? raw.action.event?.action ?? raw.action.action ?? "submit";
    out.action = clip(String(name), 200);
    const extra = raw.action.context ?? raw.action.event?.context;
    if (extra !== undefined && raw.payload === undefined) out.payload = safeJsonValue(extra);
  }
  if (raw.payload !== undefined) out.payload = safeJsonValue(raw.payload);

  for (const key of ["min", "max", "step", "gap", "maxAllowedSelections"]) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) out[key] = raw[key];
  }
  for (const key of ["multiline", "disabled", "closeOnAction", "checked", "multiple", "enableDate", "enableTime"]) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }

  if (type === "Image") {
    const url = safeHttpUrl(raw.url ?? raw.src);
    if (url) out.url = url;
  }
  if (type === "Icon") {
    const name = clip(String(raw.name ?? raw.icon ?? ""), 40).trim();
    if (name) out.name = name;
  }

  const rawOpts = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.selections) ? raw.selections : null;
  if (rawOpts) out.options = normalizeOptions(rawOpts);

  if (Array.isArray(raw.items)) {
    out.items = raw.items.slice(0, 60).map((item) => (
      typeof item === "string" ? { label: clip(item, 400), value: "" }
        : plainObject(item) ? {
          label: clip(String(item.label ?? ""), 200),
          value: normalizeBindable(item.value) ?? "",
          ...(typeof item.tone === "string" ? { tone: clip(item.tone, 40) } : {}),
        } : null
    )).filter(Boolean);
  }
  if (Array.isArray(raw.columns)) {
    out.columns = raw.columns.slice(0, 20).map((c) => (
      typeof c === "string" ? { key: clip(c, 120), label: clip(c, 200) }
        : plainObject(c) ? { key: clip(String(c.key ?? c.label ?? ""), 120), label: clip(String(c.label ?? c.key ?? ""), 200) }
          : null
    )).filter((c) => c && c.key);
  }
  if (Array.isArray(raw.rows)) {
    out.rows = raw.rows.slice(0, 100).map((row) => safeJsonValue(row)).filter((r) => r !== null);
  }

  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : Array.isArray(raw.tabItems) ? raw.tabItems : null;
  if (rawTabs) {
    out.tabs = rawTabs.slice(0, 20).map((tab) => {
      if (!plainObject(tab)) return null;
      const children = [];
      if (Array.isArray(tab.children)) {
        for (const c of tab.children) {
          const n = resolveChildRef(c, counter, depth + 1, ctx, ancestors);
          if (n) children.push(n);
        }
      } else if (tab.child !== undefined) {
        const n = resolveChildRef(tab.child, counter, depth + 1, ctx, ancestors);
        if (n) children.push(n);
      }
      return {
        title: clip(String(tab.title ?? tab.label ?? "탭"), 120),
        children,
      };
    }).filter(Boolean);
  }

  if (raw.entryPointChild !== undefined) {
    const entry = resolveChildRef(raw.entryPointChild, counter, depth + 1, ctx, ancestors);
    if (entry) out.entryPointChild = entry;
  }
  if (raw.contentChild !== undefined) {
    const content = resolveChildRef(raw.contentChild, counter, depth + 1, ctx, ancestors);
    if (content) out.contentChild = content;
  }

  if (Array.isArray(raw.children)) {
    out.children = raw.children.map((c) => resolveChildRef(c, counter, depth + 1, ctx, ancestors)).filter(Boolean);
  } else if (raw.child !== undefined) {
    const single = resolveChildRef(raw.child, counter, depth + 1, ctx, ancestors);
    if (single) out.children = [single];
  }

  return out;
}

function normalizeComponents(list) {
  if (!Array.isArray(list)) return [];
  const counter = { n: 0 };
  const byId = new Map();
  const refs = new Set();
  for (const item of list) {
    if (!plainObject(item)) continue;
    if (typeof item.id === "string" && item.id.trim()) byId.set(item.id.trim(), item);
    collectRefs(item, refs);
  }

  // flat adjacency list(v0.9) 이면 root 또는 참조되지 않은 최상위 노드부터 트리로 조립
  const isFlat = byId.size > 0 && (refs.size > 0 || byId.has("root"));
  if (!isFlat) {
    return list.map((c) => normalizeComponent(c, counter, 0)).filter(Boolean);
  }

  const ctx = { byId };
  let roots = [];
  if (byId.has("root")) {
    roots = [byId.get("root")];
  } else {
    roots = list.filter((item) => plainObject(item) && (!item.id || !refs.has(item.id.trim())));
    if (!roots.length && list[0]) roots = [list[0]];
  }
  return roots.map((r) => {
    const anc = new Set();
    if (typeof r.id === "string" && r.id.trim()) anc.add(r.id.trim());
    return normalizeComponent(r, counter, 0, ctx, anc);
  }).filter(Boolean);
}

// 마크다운 안의 ```a2ui ... ``` 블록을 JSON 파싱
export function extractA2uiBlocks(text) {
  if (typeof text !== "string" || !text.includes("```a2ui")) return [];
  const out = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while (out.length < MAX_BLOCKS && (m = FENCE_RE.exec(text))) {
    if (Buffer.byteLength(m[1], "utf8") > MAX_BLOCK_BYTES) continue;
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) { for (const item of parsed) if (plainObject(item)) out.push(item); }
      else if (plainObject(parsed)) out.push(parsed);
    } catch { /* 깨진 JSON 블록은 무시 */ }
  }
  return out;
}

// A2UI v0.9(평면·래퍼 형식)과 간편 단축 형식을 표준 4종 메시지로 정규화
export function normalizeA2uiMessage(raw) {
  if (!plainObject(raw)) return null;
  let type = typeof raw.type === "string" ? raw.type : "";
  let body = raw;
  if (!type) {
    for (const kind of ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"]) {
      if (plainObject(raw[kind])) { type = kind; body = raw[kind]; break; }
    }
  }
  if (!type && Array.isArray(raw.components)) type = "createSurface";
  const surfaceId = safeId(body.surfaceId ?? raw.surfaceId, "default");
  const layout = (body.layout ?? raw.layout) === "center" ? "center" : "dock";
  const title = typeof (body.title ?? raw.title) === "string" ? clip((body.title ?? raw.title).trim(), 200) : "";
  const catalogId = safeId(body.catalogId ?? raw.catalogId, A2UI_CATALOG_ID);

  if (type === "createSurface") {
    return {
      type,
      surfaceId,
      catalogId,
      ...(title ? { title } : {}),
      layout,
      components: normalizeComponents(body.components),
      dataModel: plainObject(body.dataModel ?? body.data) ? safeJsonValue(body.dataModel ?? body.data) : {},
    };
  }
  if (type === "updateComponents") {
    return {
      type,
      surfaceId,
      ...(title ? { title } : {}),
      ...(body.layout === "center" || body.layout === "dock" ? { layout: body.layout } : {}),
      components: normalizeComponents(body.components),
    };
  }
  if (type === "updateDataModel") {
    const data = body.dataModel ?? body.data ?? body.value;
    return {
      type,
      surfaceId,
      path: typeof body.path === "string" ? clip(body.path, 200) : "",
      data: plainObject(data) ? safeJsonValue(data) : {},
    };
  }
  if (type === "deleteSurface") return { type, surfaceId };
  return null;
}

export function applyA2uiMessages(surfaces, rawMessages) {
  if (!(surfaces instanceof Map) || !Array.isArray(rawMessages) || !rawMessages.length) return false;
  let changed = false;
  for (const raw of rawMessages) {
    const msg = normalizeA2uiMessage(raw);
    if (!msg) continue;
    if (msg.type === "createSurface") {
      if (!surfaces.has(msg.surfaceId) && surfaces.size >= MAX_SURFACES) {
        surfaces.delete(surfaces.keys().next().value);
      }
      surfaces.set(msg.surfaceId, {
        surfaceId: msg.surfaceId,
        catalogId: msg.catalogId || A2UI_CATALOG_ID,
        title: msg.title || msg.surfaceId,
        layout: msg.layout,
        components: msg.components,
        dataModel: msg.dataModel,
        updatedAt: Date.now(),
      });
      changed = true;
    } else if (msg.type === "updateComponents") {
      const cur = surfaces.get(msg.surfaceId) || {
        surfaceId: msg.surfaceId, catalogId: A2UI_CATALOG_ID, title: msg.title || msg.surfaceId, layout: "dock", components: [], dataModel: {},
      };
      surfaces.set(msg.surfaceId, {
        ...cur,
        ...(msg.title ? { title: msg.title } : {}),
        ...(msg.layout ? { layout: msg.layout } : {}),
        components: msg.components,
        updatedAt: Date.now(),
      });
      changed = true;
    } else if (msg.type === "updateDataModel") {
      const cur = surfaces.get(msg.surfaceId);
      if (!cur) continue;
      cur.dataModel = { ...cur.dataModel, ...msg.data };
      cur.updatedAt = Date.now();
      changed = true;
    } else if (msg.type === "deleteSurface") {
      if (surfaces.delete(msg.surfaceId)) changed = true;
    }
  }
  return changed;
}

export function extractSurfacesFromMessages(irisMessages) {
  const surfaces = new Map();
  for (const m of Array.isArray(irisMessages) ? irisMessages : []) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.blocks)) continue;
    for (const b of m.blocks) {
      if (b?.type !== "text" || typeof b.text !== "string") continue;
      const blocks = extractA2uiBlocks(b.text);
      if (blocks.length) applyA2uiMessages(surfaces, blocks);
    }
  }
  return [...surfaces.values()];
}

// 유효한 ```a2ui``` 블록만 말풍선 표시 글에서 제거해 생 JSON 노출을 막고 깨진 블록은 그대로 둔다
export function stripA2uiBlocks(text) {
  if (typeof text !== "string" || !text.includes("```a2ui")) return text;
  const labels = [];
  let stripped = false;
  let blockCount = 0;
  FENCE_RE.lastIndex = 0;
  const out = text.replace(FENCE_RE, (full, inner) => {
    if (blockCount++ >= MAX_BLOCKS) return full;
    if (Buffer.byteLength(inner, "utf8") > MAX_BLOCK_BYTES) return full;
    let parsed;
    try { parsed = JSON.parse(inner.trim()); } catch { return full; }
    const items = Array.isArray(parsed) ? parsed.filter(plainObject) : (plainObject(parsed) ? [parsed] : []);
    const valid = items.map(normalizeA2uiMessage).filter(Boolean);
    if (!valid.length) return full;
    stripped = true;
    for (const msg of valid) {
      const label = msg.title || msg.surfaceId;
      if (label && !labels.includes(label)) labels.push(label);
    }
    return "";
  });
  if (!stripped) return text;
  const cleaned = out.replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned) return cleaned;
  return labels.length ? `[A2UI: ${labels.join(", ")}]` : "[A2UI]";
}

export function stripA2uiFromMessages(irisMessages) {
  if (!Array.isArray(irisMessages)) return irisMessages;
  return irisMessages.map((m) => {
    if (!m || m.role !== "assistant" || !Array.isArray(m.blocks)) return m;
    if (!m.blocks.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.includes("```a2ui"))) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) => (b?.type === "text" && typeof b.text === "string" && b.text.includes("```a2ui")
        ? { ...b, text: stripA2uiBlocks(b.text) }
        : b)),
    };
  });
}

// 버튼·폼 제출을 현재 세션 에이전트가 읽을 수 있는 짧은 입력 문장으로 바꿈
export function formatA2uiAction({ surfaceId, title, action, payload, dataModel }) {
  const label = title || surfaceId || "UI";
  const parts = [`[A2UI:${label}] ${action || "submit"}`];
  if (payload !== undefined && payload !== null && !(plainObject(payload) && !Object.keys(payload).length)) {
    parts.push(`payload=${JSON.stringify(payload)}`);
  }
  if (plainObject(dataModel) && Object.keys(dataModel).length) {
    parts.push(`data=${JSON.stringify(dataModel)}`);
  }
  return parts.join(" ");
}
