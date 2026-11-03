import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { privatePathAsync } from "./windows-private.cjs";
import { stateHome } from "../state-home.cjs";

const VERSION = 1;
const MAX_ENTRIES = 64;
const WRITE_DELAY_MS = 2_000;

function validEntry(key, value) {
  return /^[0-9a-f]{64}$/.test(key) && value && typeof value === "object"
    && /^[0-9a-f]{32}$/.test(value.deviceId || "") && Number.isSafeInteger(value.lastActivityAt);
}

// 재접속 토큰의 해시·기기·마지막 행동 시각을 상태 폴더에 저장해 서버 재시작 뒤에도 유휴 만료 안이면 PIN 없이 이어지게 한다
// 토큰 원문은 저장하지 않고, 재접속에는 기기 키 서명도 필요하다
export function createResumeStore(options = {}) {
  const remoteDir = path.join(options.stateDir || stateHome(), "remote");
  const file = path.join(remoteDir, "resume-tokens.json");
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let timer = null;
  let pending = null;
  let writing = Promise.resolve();
  let sequence = 0;
  // 쓰기 순서 번호: 더 새 저장이 시작되면 아직 반영되지 않은 이전 비동기 쓰기는 버린다
  let generation = 0;
  let closed = false;

  function load(maxAgeMs, timestamp = Date.now()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed?.version !== VERSION || !Array.isArray(parsed.tokens)) return [];
      return parsed.tokens
        .filter(([key, value]) => validEntry(key, value)
          && timestamp - value.lastActivityAt >= 0 && timestamp - value.lastActivityAt < maxAgeMs)
        .slice(0, MAX_ENTRIES)
        .map(([key, value]) => [key, { deviceId: value.deviceId, lastActivityAt: value.lastActivityAt }]);
    } catch {
      return [];
    }
  }

  async function durableWrite(entries, mine) {
    await fsp.mkdir(remoteDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(remoteDir, 0o700);
    if (process.platform === "win32") await privatePathAsync(remoteDir);
    const temporary = `${file}.${process.pid}.${++sequence}.tmp`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify({ version: VERSION, tokens: entries.slice(-MAX_ENTRIES) })}\n`, { mode: 0o600 });
      await fsp.chmod(temporary, 0o600);
      if (mine !== generation) {
        await fsp.unlink(temporary);
        return;
      }
      await fsp.rename(temporary, file);
    } catch (error) {
      try { await fsp.unlink(temporary); } catch {}
      throw error;
    }
  }

  function flush() {
    if (timer) { clearTimer(timer); timer = null; }
    const entries = pending?.();
    pending = null;
    if (!entries) return writing;
    const mine = ++generation;
    writing = writing.then(() => durableWrite(entries, mine)).catch(() => {});
    return writing;
  }

  // 대기 중인 마지막 상태를 바로 쓴다. final 이면 이후 저장 요청을 받지 않는다(서버 종료)
  // 이미 쓰는 중인 비동기 저장은 번호가 밀려 반영되지 않는다
  function flushSync({ final = false } = {}) {
    if (timer) { clearTimer(timer); timer = null; }
    const entries = pending?.();
    pending = null;
    if (final) closed = true;
    if (!entries) return;
    ++generation;
    try {
      fs.mkdirSync(remoteDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(remoteDir, 0o700);
      const temporary = `${file}.${process.pid}.${++sequence}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({ version: VERSION, tokens: entries.slice(-MAX_ENTRIES) })}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {}
  }

  // 변경이 잦아서 마지막 상태만 2초 뒤에 한 번 저장
  function save(getEntries) {
    if (closed) return;
    pending = getEntries;
    if (timer) return;
    timer = setTimer(() => { timer = null; void flush(); }, WRITE_DELAY_MS);
    timer?.unref?.();
  }

  return { file, load, save, flush, flushSync };
}
