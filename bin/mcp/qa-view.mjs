// iris-qa 결과 중 모델에게 보낼 칸만 남김. 전체 기록은 서버 장부와 보고서에 그대로 있음.
// 남기는 것: 다음 호출이 받는 값(반응 id·판정 seq·장면 사진 경로), 효과별 판정, 안내 문구
// 빼는 것: 장부 해시·내부 서명·시각 원값·이미 받은 입력을 되돌린 영수증 본문·관찰 원자료

const HEX64 = /^[0-9a-f]{64}$/;
const DROP = new Set(["_signature", "signature", "rawId", "rawCount", "catalogKey", "expectedDigest", "captureTarget",
  "stability", "firstAt", "lastAt", "signalAt", "capturedAt", "backendNodeId", "markCount", "periodicityMs"]);

const isReceipt = (value) => value && typeof value === "object" && !Array.isArray(value)
  && Number.isInteger(value.seq) && typeof value.head === "string" && HEX64.test(value.head) && value.event && typeof value.event === "object";

function dropKey(key, value, parent) {
  if (DROP.has(key) || value === null) return true;
  if (key === "at" && typeof value === "number" && value > 1e12) return true;
  if (key === "head" && typeof value === "string" && HEX64.test(value)) return true;
  if (key === "absoluteId" && value === parent.id) return true;
  if (key === "selector" && value === parent.sel) return true;
  if (key === "description" && value === parent.text) return true;
  if (key === "path" && typeof parent.shot === "string") return true;
  if (key === "caption" && value === parent.claim?.description) return true;
  return false;
}

// 관찰 원자료(events)는 효과 대상을 찾았는지와 그때 글만 남김. 기대가 왜 안 맞았는지 볼 때 씀
function viewEvent(event) {
  if (!event || typeof event !== "object") return event;
  const out = {};
  if (event.kind) out.kind = event.kind;
  const effects = (event.effects || []).map((e) => ({ id: e.id, found: e.found, ...(e.text != null ? { text: e.text } : {}) }));
  if (effects.length) out.effects = effects;
  for (const key of ["changes", "unchangedViolated", "candidates"]) if (Array.isArray(event[key]) && event[key].length) out[key] = view(event[key]);
  return out;
}

// 영수증은 seq·종류와, 입력에 없던 서버 계산 값 중 짧은 것만(다시 돌릴 항목·연결한 실패·판단 상태 등)
function viewReceipt(receipt, args) {
  const extra = Object.entries(receipt.event.detail || {}).filter(([key, value]) => !Object.hasOwn(args, key)
    && value != null && !(typeof value === "string" && HEX64.test(value)) && JSON.stringify(value).length <= 300);
  return { seq: receipt.seq, ...(receipt.event.kind ? { kind: receipt.event.kind } : {}), ...(extra.length ? { detail: view(Object.fromEntries(extra), args) } : {}) };
}

export function view(value, args = {}) {
  if (Array.isArray(value)) return value.map((item) => view(item, args));
  // 좌표·크기는 소수 첫째 자리까지. 누를 위치를 정하는 데 그 이상은 쓰지 않음
  if (typeof value === "number" && !Number.isInteger(value)) return Math.round(value * 10) / 10;
  if (!value || typeof value !== "object") return value;
  if (isReceipt(value)) return viewReceipt(value, args);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (dropKey(key, child, value)) continue;
    out[key] = key === "events" && Array.isArray(child) ? child.map(viewEvent) : view(child, args);
  }
  return out;
}

// qa_row 결과의 항목 정의는 선언 때 모델이 쓴 글. 매 호출 되돌리지 않고 상태(경로별 판정·state)만 보냄
const ROW_AUTHORED = ["what", "given", "basisNote", "oracle", "mustNotChange", "consumers", "rerun", "risk"];
function viewRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = Object.fromEntries(Object.entries(row).filter(([key]) => !ROW_AUTHORED.includes(key)));
  if (out.walked) out.walked = Object.fromEntries(Object.entries(out.walked).map(([path, walk]) =>
    [path, walk && !walk.automatic ? Object.fromEntries(Object.entries(walk).filter(([key]) => key !== "sceneJudgment")) : walk]));
  return out;
}

// 수정 목록은 qa_play마다 붙음. 다섯 건이 넘으면 상태별 수와 기다리는 결함만 보냄
function viewRemediation(remediation) {
  const defects = remediation?.defects;
  if (!Array.isArray(defects) || defects.length <= 5) return remediation;
  const byStatus = {};
  for (const defect of defects) byStatus[defect.status] = (byStatus[defect.status] || 0) + 1;
  const waiting = defects.filter((defect) => defect.waiting?.length).slice(0, 5);
  const { defects: _, ...rest } = remediation;
  return { ...rest, defectCount: defects.length, byStatus, waiting,
    ...(defects.filter((defect) => defect.waiting?.length).length > 5 ? { more: "나머지는 qa_list_review remediation" } : {}) };
}

// 반응 목록 항목은 맞은 반응 ID·회차 목록 대신 개수만. key는 qa_catalog_revise가 받으므로 남김
function viewCatalogItem(item) {
  if (!item || typeof item !== "object") return item;
  const { ids, runs, firstRun, firstPhoto, sourceHash, ...rest } = item;
  return { ...rest, ...(Array.isArray(ids) ? { idCount: ids.length } : {}), ...(Array.isArray(runs) ? { runCount: runs.length } : {}) };
}

// 실패 결과는 오류 문구를 그대로 보냄
export function qaView(result, args = {}, cmd = "") {
  if (!result || !result.ok) return result;
  const out = view(result, args && typeof args === "object" ? args : {});
  if (out.data && typeof out.data === "object") {
    if (cmd === "row") {
      if (out.data.row) out.data.row = viewRow(out.data.row);
      if (out.data.original) out.data.original = { receipt: out.data.original.receipt, why: out.data.original.why, pass: out.data.original.pass };
    }
    if (cmd === "catalog" && Array.isArray(out.data.items)) out.data.items = out.data.items.map(viewCatalogItem);
    if (cmd === "play" && out.data.remediation) out.data.remediation = viewRemediation(out.data.remediation);
  }
  return out;
}
