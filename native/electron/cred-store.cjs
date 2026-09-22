// 저장된 로그인(아이디/비번)을 파일 하나에 담는 자리. safeStorage로 암호화되어 있다.
//
// 여기서 주의할 것은 읽기 실패가 아니라 그다음 쓰기다. 파일은 있는데 읽지 못했을 때 그 위에
// 덮어쓰면 안에 든 다른 프로필의 로그인까지 사라지고, 암호화되어 있어 복원할 수 없다.
// 읽지 못하는 흔한 이유는 파일 손상이 아니라 일시적인 것이다. 로그인 직후에는
// Keychain이 아직 잠겨 있어 몇 초 동안 복호화가 실패한다.
//
// 그래서 두 가지를 한다. 실패한 읽기는 캐시하지 않아 다음 호출에서 다시 시도하고(그 사이
// Keychain이 풀리면 정상으로 돌아온다), 그래도 읽지 못한 채 써야 하는 순간이 오면
// 옛 파일을 `creds.enc.unreadable-<시각>`으로 옮겨 둔 뒤에만 새 파일을 쓴다. 바이트는
// 어느 경로로도 사라지지 않는다.
//
// electron을 부르지 않는 별도 파일인 이유는 이 판정만 따로 시험하기 위해서다.
// 자격증명이 사라지는 종류의 결함은 사라진 뒤에야 드러난다.
const path = require("node:path");

function two(n) { return String(n).padStart(2, "0"); }
function stampOf(d) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function createCredStore({ filePath, fs, safeStorage, now = () => new Date(), log = () => {} }) {
  let cache = null;        // 성공적으로 읽어낸 것만 여기 남는다
  let unreadable = false;  // 파일은 있는데 지금 쓸 수 없는 상태

  function load() {
    if (cache) return cache;
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch (e) {
      if (e && e.code === "ENOENT") { unreadable = false; cache = {}; return cache; } // 아직 없음 = 빈 저장소
      unreadable = true;
      log(`[creds] 자격증명 파일을 읽지 못했습니다 — 덮어쓰지 않습니다: ${e && e.message || e}`);
      return {};
    }
    if (!safeStorage.isEncryptionAvailable()) {
      unreadable = true;
      log("[creds] 지금은 복호화할 수 없습니다(Keychain 잠김 등) — 덮어쓰지 않습니다");
      return {};
    }
    try {
      const obj = JSON.parse(safeStorage.decryptString(buf));
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("저장된 값이 객체가 아닙니다");
      unreadable = false;
      cache = obj;
      return cache;
    } catch (e) {
      unreadable = true;
      log(`[creds] 자격증명 파일을 해독하지 못했습니다 — 덮어쓰지 않습니다: ${e && e.message || e}`);
      return {};
    }
  }

  // 읽지 못한 파일은 지우지 않고 옮겨 둔다. 여기서 실패하면 아무것도 쓰지 않는다.
  function quarantine() {
    const dest = `${filePath}.unreadable-${stampOf(now())}`;
    try {
      fs.renameSync(filePath, dest);
      log(`[creds] 읽지 못한 자격증명 파일을 보존했습니다: ${path.basename(dest)}`);
      return { ok: true, path: dest };
    } catch (e) {
      if (e && e.code === "ENOENT") return { ok: true, path: null }; // 그새 사라졌다 = 보존할 것 없음
      log(`[creds] 자격증명 파일을 밀어 두지 못해 쓰기를 중단합니다: ${e && e.message || e}`);
      return { ok: false, path: null };
    }
  }

  function persist(store) {
    const data = store && typeof store === "object" ? store : {};
    if (!safeStorage.isEncryptionAvailable()) return { written: false, reason: "no-encryption" }; // 평문으로 남기지 않는다
    if (unreadable) {
      const moved = quarantine();
      if (!moved.ok) return { written: false, reason: "quarantine-failed" };
      unreadable = false;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const enc = safeStorage.encryptString(JSON.stringify(data));
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, enc, { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      try { fs.chmodSync(filePath, 0o600); } catch {}
      cache = data;
      return { written: true };
    } catch (e) {
      log(`[creds] 자격증명을 저장하지 못했습니다: ${e && e.message || e}`);
      return { written: false, reason: "write-failed" };
    }
  }

  function state() { return { cached: cache !== null, unreadable }; }

  return { load, persist, state };
}

module.exports = { createCredStore };
