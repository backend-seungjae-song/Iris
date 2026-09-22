// 사용자가 바꾼 단축키의 단일 소유자.
//
// 소유 범위
//   id → 바인딩 표(overrides) 하나와 그것을 담는 파일(stateHome()/keymap.json).
//
// 제공 API
//   initKeymapStore() · keymapWire() · setKeymapOverride(id, binding) · resetKeymap(id).
//
// 의존 대상
//   state-home 의 stateHome() 만. 경로를 직접 조합하지 않는다. 한 파일이라도 경로를 직접
//   지정하면 개발 환경과 설치 앱의 분리가 전부 깨진다.
//
// 유지 조건
//   무엇이 바꿀 수 있는 키인지는 여기서 판정하지 않는다. 그 표(KEYMAP·lock)는 창이 가지고 있고,
//   창의 setOverrides 가 잠긴 항목과 형식이 맞지 않는 항목을 걸러 낸다. 여기서 같은 판정을
//   중복하면 두 판정이 갈라질 때 저장된 값과 적용되는 값이 달라진다. 여기는 형식만 확인한다.
//   파일이 깨져 있으면 빈 표로 시작한다. 단축키 하나 때문에 앱이 실행되지 않으면 안 된다.
//
// 영향 범위
//   server/index 의 연결 시 push 와 keymap-set·keymap-reset 수신, web/js/core/keymap 의 setOverrides.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs server/keymap-store.js

import fs from "node:fs";
import path from "node:path";

import { stateHome } from "./state-home.cjs";

const MAX_ENTRIES = 200;   // 표에 있는 항목 수보다 넉넉하되 무한하지 않게

let overrides = {};
let filePath = null;

function fileOf() {
  if (!filePath) filePath = path.join(stateHome(), "keymap.json");
  return filePath;
}

// 형식만 확인한다. 무엇이 바꿀 수 있는 키인지는 창이 판정한다(위 계약).
function normalize(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [id, b] of Object.entries(raw)) {
    if (n >= MAX_ENTRIES) break;
    if (!id || typeof id !== "string" || !b || typeof b !== "object") continue;
    const item = { mod: !!b.mod, alt: !!b.alt, shift: !!b.shift };
    if (typeof b.code === "string" && b.code) item.code = b.code.slice(0, 24);
    else if (typeof b.key === "string" && b.key) item.key = b.key.slice(0, 24);
    else continue;
    out[id] = item; n++;
  }
  return out;
}

function persist() {
  const p = fileOf();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(overrides), "utf8");
    fs.renameSync(tmp, p);
  } catch {}
}

export function initKeymapStore() {
  try {
    overrides = normalize(JSON.parse(fs.readFileSync(fileOf(), "utf8")));
  } catch { overrides = {}; }
  return overrides;
}

export function keymapWire() {
  return { type: "keymap", overrides: { ...overrides } };
}

export function setKeymapOverride(id, binding) {
  if (!id || typeof id !== "string") return false;
  const one = normalize({ [id]: binding });
  if (!one[id]) return false;
  overrides[id] = one[id];
  persist();
  return true;
}

// id 를 주면 그것만, 안 주면 전부 기본값으로 돌린다.
export function resetKeymap(id) {
  if (id) {
    if (!Object.prototype.hasOwnProperty.call(overrides, id)) return false;
    delete overrides[id];
  } else {
    if (!Object.keys(overrides).length) return false;
    overrides = {};
  }
  persist();
  return true;
}
