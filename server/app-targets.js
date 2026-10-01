import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateHome } from "./state-home.cjs";

// pane별 앱 기본 대상 목록의 유일한 파일 소유자다. 옛 문자열 값은 한 대 배열로 읽고 모든 쓰기는 원자적으로 교체한다.

export const MAX_APP_TARGETS = 4;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function appDeviceTargetId({ udid, persistentId } = {}) {
  if (!ID_RE.test(String(udid || ""))) throw new Error("기기 식별자가 올바르지 않습니다");
  if (!/^emulator-\d+$/.test(udid)) return udid;
  const target = persistentId && !/^emulator-\d+$/.test(persistentId) ? `avd:${persistentId}` : null;
  if (!target || !ID_RE.test(target)) throw new Error("Android 기기의 AVD 이름을 확인하지 못했습니다. 기기 목록을 새로 고침한 뒤 다시 지목하세요.");
  return target;
}

// Android 포트는 다른 AVD가 재사용할 수 있어 등록된 serial만으로 기기를 선택하지 않는다.
export function resolveAppDeviceTarget(target, devices) {
  if (/^emulator-\d+$/.test(target || "")) return null;
  const matches = (devices || []).filter(device => String(target || "").startsWith("avd:")
    ? /^emulator-\d+$/.test(device.udid || "") && device.persistentId === target.slice(4)
    : device.udid === target);
  return matches.length === 1 ? matches[0] : null;
}

function directory(options) {
  return options?.stateDir || stateHome();
}

function normalizeDevices(value) {
  const source = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const devices = [];
  for (const item of source) {
    const device = String(item || "").trim();
    if (!ID_RE.test(device) || devices.includes(device)) continue;
    devices.push(device);
    if (devices.length >= MAX_APP_TARGETS) break;
  }
  return devices;
}

export function readAppTargets(options = {}) {
  const file = path.join(directory(options), "app-targets.json");
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("기기 등록 저장 파일이 올바르지 않습니다");
  const out = {};
  for (const [pane, value] of Object.entries(raw)) {
    const source = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
    if (!ID_RE.test(pane) || !source || source.some(device => typeof device !== "string" || !ID_RE.test(device.trim()))) {
      throw new Error("저장된 기기 등록이 올바르지 않습니다");
    }
    const devices = normalizeDevices(value);
    if (devices.length) out[pane] = devices;
  }
  return out;
}

export function appTargetsFor(pane, options = {}) {
  return pane ? readAppTargets(options)[String(pane)] || [] : [];
}

export function setAppTargets(pane, devices, options = {}) {
  const owner = String(pane || "");
  if (!ID_RE.test(owner)) throw new Error("세션 식별자가 올바르지 않습니다");
  const stateDir = directory(options);
  const file = path.join(stateDir, "app-targets.json");
  const all = readAppTargets({ stateDir });
  const next = normalizeDevices(devices);
  // 사용자 지목은 기기를 새 세션으로 넘긴다. 작업이 끝난 이전 세션이 같은 기기를 계속 대상으로 잡지 않게 한다.
  if (options.exclusive) {
    for (const [pane, list] of Object.entries(all)) {
      if (pane === owner) continue;
      const rest = list.filter((device) => !next.includes(device));
      if (rest.length) all[pane] = rest; else delete all[pane];
    }
  }
  if (next.length) all[owner] = next; else delete all[owner];
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
  return next;
}
