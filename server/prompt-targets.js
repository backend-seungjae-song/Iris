import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateHome } from "./state-home.cjs";

// UI가 만든 1회용 대기 지정의 수명과 nonce 검증을 소유한다. 호출자는 검증 뒤 실행할 동작만 넘긴다.
// 대기 지정은 pane에 묶이고, 다른 pane·변조·재사용·24시간 만료 구분자는 상태를 바꾸지 않는다.
// 그 pane에서 메시지를 보내면 메시지에 없던 대기 지정은 폐기된다.

export const PROMPT_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PROMPT_TARGET_MARKERS = 256;

const KINDS = new Set(["tab", "group", "element", "device"]);
const MAX_PENDING = 2048;
const MAX_PENDING_PER_PANE = MAX_PROMPT_TARGET_MARKERS;

function validRef(kind, ref) {
  if (kind === "device") return /^@device:[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref);
  const suffix = kind === "group" ? "group" : "tab";
  return new RegExp(`^@[A-Za-z0-9._-]+-${suffix}-[A-Za-z][0-9A-Fa-f]{5}$`).test(ref);
}


function nonceOf(marker) {
  const match = /~([A-Za-z0-9_-]{8,128})$/.exec(String(marker || ""));
  return match ? match[1] : null;
}

function dedupeTargets(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = JSON.stringify(record.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 설치 앱의 재시작은 아직 보내지 않은 지목의 만료 사유가 아니다.
export function createPromptTargetStore({ file = null } = {}) {
  const pendingByNonce = new Map();
  if (file && fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.pending) || data.pending.length > MAX_PENDING) {
      throw new Error("대기 지정 저장 파일이 올바르지 않습니다");
    }
    for (const record of data.pending) {
      const nonce = nonceOf(record?.delimiter);
      if (!nonce || !record.pane || !KINDS.has(record.kind) || !validRef(record.kind, record.ref)
        || record.delimiter !== `${record.ref}~${nonce}` || !Number.isFinite(record.createdAt)
        || !record.target || typeof record.target !== "object") throw new Error("저장된 대기 지정이 올바르지 않습니다");
      pendingByNonce.set(nonce, record);
    }
  }
  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, pending: [...pendingByNonce.values()] }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function pruneExpired(now) {
    for (const [nonce, record] of pendingByNonce) {
      if (now - record.createdAt > PROMPT_TARGET_TTL_MS) pendingByNonce.delete(nonce);
    }
  }

  function issuePromptTarget({ pane, kind, ref, target, label = "", platform = "", createdAt = Date.now() }) {
    const owner = String(pane || "");
    const targetKind = String(kind || "");
    const marker = String(ref || "");
    if (!owner || !KINDS.has(targetKind) || !validRef(targetKind, marker) || !target || typeof target !== "object") {
      throw new Error("대기 지정 정보가 올바르지 않습니다");
    }
    pruneExpired(createdAt);
    let mine = 0;
    for (const record of pendingByNonce.values()) if (record.pane === owner) mine++;
    if (pendingByNonce.size >= MAX_PENDING || mine >= MAX_PENDING_PER_PANE) throw new Error("대기 지정이 너무 많습니다");
    let nonce;
    do nonce = crypto.randomBytes(16).toString("hex"); while (pendingByNonce.has(nonce));
    const delimiter = `${marker}~${nonce}`;
    pendingByNonce.set(nonce, {
      pane: owner, kind: targetKind, ref: marker, delimiter, target: structuredClone(target),
      label: String(label || "").slice(0, 200), platform: String(platform || "").slice(0, 40), createdAt,
    });
    try { persist(); }
    catch (error) { pendingByNonce.delete(nonce); throw error; }
    return { delimiter, nonce, expiresAt: createdAt + PROMPT_TARGET_TTL_MS };
  }

  function activatePromptTargets({ pane, markers, actions, now = Date.now() }) {
    const before = new Map(pendingByNonce);
    const owner = String(pane || "");
    const unique = [...new Set((Array.isArray(markers) ? markers : []).map(String).filter(Boolean))];
    const accepted = [];
    const rejected = [];
    for (const marker of unique) {
      const nonce = nonceOf(marker);
      const record = nonce ? pendingByNonce.get(nonce) : null;
      if (!record) {
        rejected.push({ marker, reason: "대기 지정이 없거나 이미 사용됨" });
        continue;
      }
      if (record.pane !== owner) {
        rejected.push({ marker, reason: "다른 세션의 대기 지정" });
        continue;
      }
      if (record.delimiter !== marker) {
        rejected.push({ marker, reason: "대기 지정과 구분자가 일치하지 않음" });
        continue;
      }
      if (now - record.createdAt > PROMPT_TARGET_TTL_MS) {
        pendingByNonce.delete(nonce);
        rejected.push({ marker, reason: "대기 지정 만료(24시간)" });
        continue;
      }
      pendingByNonce.delete(nonce);
      accepted.push(record);
    }
    // 보낸 메시지에 없는 대기 지정은 폐기. 붙였다 지운 구분자가 나중에 활성화되지 않게
    for (const [nonce, record] of pendingByNonce) if (record.pane === owner) pendingByNonce.delete(nonce);

    try { persist(); }
    catch (error) {
      pendingByNonce.clear();
      for (const [nonce, record] of before) pendingByNonce.set(nonce, record);
      throw error;
    }

    const groups = dedupeTargets(accepted.filter((record) => record.kind === "group"));
    const tabs = dedupeTargets(accepted.filter((record) => record.kind === "tab"));
    const elements = dedupeTargets(accepted.filter((record) => record.kind === "element"));
    let devices = dedupeTargets(accepted.filter((record) => record.kind === "device"));
    const maxDevices = Number.isInteger(actions.maxDevices) && actions.maxDevices > 0 ? actions.maxDevices : devices.length;
    const deviceOverflow = devices.slice(maxDevices);
    devices = devices.slice(0, maxDevices);
    for (const record of deviceOverflow) rejected.push({ marker: record.delimiter, reason: `기기 등록 상한(${maxDevices}대)` });
    if (groups.length) actions.replaceGroups(groups);
    if (tabs.length) actions.replaceTabs(tabs);
    if (elements.length) actions.addElements(elements);
    if (devices.length) actions.replaceDevices(devices);
    const applied = new Set([...groups, ...tabs, ...elements, ...devices]);
    return {
      activated: accepted.filter((record) => applied.has(record))
        .map(({ pane: _pane, createdAt: _createdAt, ...record }) => record),
      rejected,
    };
  }
  return { issuePromptTarget, activatePromptTargets };
}

let defaultStore;
function currentStore() {
  return defaultStore ||= createPromptTargetStore({ file: path.join(stateHome(), "prompt-targets.json") });
}
export function issuePromptTarget(options) { return currentStore().issuePromptTarget(options); }
export function activatePromptTargets(options) { return currentStore().activatePromptTargets(options); }
export function resetPromptTargetsForTest() { defaultStore = createPromptTargetStore(); }
