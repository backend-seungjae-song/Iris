// safeStorage vault를 감싼 프로필별 자격증명 명령·조회 서비스.
//
// 소유 범위
//   cred-store.cjs vault와 마지막으로 읽은 partition→login 저장 객체의 참조.
//
// 제공 API
//   createCredentialService(...)가 set·add·clear 명령, listForOrigin·passwordFor·summary·
//   listAccounts·partitionCounts 조회를 준다. vault·저장 객체·partition 배열은 내주지 않는다.
//   set 은 통째 교체(가져오기), add 는 한 건 병합(이 브라우저에서 새로 로그인)이다.
//
// 의존 대상
//   조립부가 넘기는 stateDir·safeStorage·partition 공유 설정과 Node fs/path, 기존 cred-store.cjs.
//
// 유지 조건
//   목록에는 password가 없고 passwordFor는 정확한 origin+username에만 값을 준다. partition 공유는
//   기본 꺼짐이며, 읽을 수 없는 vault는 cred-store의 격리 보존 없이 덮어쓰지 않는다.
//
// 영향 범위
//   공급자는 main.cjs의 Chrome password import·safeStorage·IRIS_HOME과 cred-store.cjs의 load/persist
//   판정이고, 양방향 소비자는 main.cjs의 credential IPC·AI 허용 목록·login provider·profile 삭제다.
//   반환값은 webview 자동완성 메모리·CDP secret 가림·Keychain vault 보존에도 영향을 준다.

const fsDefault = require("node:fs");
const path = require("node:path");
const { createCredStore } = require("./cred-store.cjs");

function createCredentialService({
  stateDir,
  safeStorage,
  fs = fsDefault,
  sharePartitions = false,
  now,
  log = () => {},
}) {
  const credVault = createCredStore({
    filePath: path.join(stateDir, "creds.enc"), fs, safeStorage, now, log,
  });
  let credStore = null;

  function loadCreds() {
    credStore = credVault.load();
    return credStore;
  }

  function persistCreds() {
    return credVault.persist(credStore || {});
  }

  function set(partition, logins) {
    loadCreds();
    const map = new Map();
    for (const l of (logins || [])) {
      if (l && l.origin && l.username != null) map.set(l.origin + "\n" + l.username, l);
    }
    credStore[partition] = [...map.values()];
    return persistCreds();
  }

  // 한 건만 추가한다. set 은 그 파티션 목록을 통째로 교체하므로 새 로그인 하나를 넣으려고
  // 부르면 나머지가 전부 사라진다. 가져오기 경로가 Chrome 것 전부를 넣는 자리라 그 형태였다.
  // 같은 origin+username 은 교체하고(비밀번호를 바꿨다는 뜻이다) 순서는 최근 것이 뒤로 간다.
  function add(partition, login) {
    if (!partition || !login || !login.origin || login.username == null) return false;
    if (typeof login.password !== "string" || !login.password) return false;
    loadCreds();
    // 읽지 못한 저장소 위에 한 건을 얹으면 그 파일은 그 한 건만 있는 저장소가 된다. 가져오기는
    // Chrome 것을 다시 넣으면 되지만 여기서 잃은 것은 복구할 수 없으므로, 읽히지 않으면 쓰지 않는다.
    if (credVault.state().unreadable) return false;
    const arr = Array.isArray(credStore[partition]) ? credStore[partition] : [];
    const key = login.origin + "\n" + login.username;
    const next = arr.filter((l) => !l || (l.origin + "\n" + l.username) !== key);
    next.push({ origin: String(login.origin), url: login.url ? String(login.url) : String(login.origin),
      username: String(login.username), password: login.password });
    credStore[partition] = next;
    return persistCreds().written === true;   // persist 는 객체를 준다. 그대로 쓰면 실패도 참이 된다
  }

  function credentialsFor(partition, origin) {
    loadCreds();
    const order = sharePartitions
      ? [partition, ...Object.keys(credStore || {}).filter((key) => key !== partition)]
      : [partition];
    const seen = new Set(), out = [];
    for (const key of order) {
      const arr = credStore[key]; if (!Array.isArray(arr)) continue;
      for (const l of arr) {
        if (!l || l.origin !== origin) continue;
        const username = l.username || "";
        if (seen.has(username)) continue;
        seen.add(username);
        out.push(l);
      }
    }
    return out;
  }

  function listForOrigin(partition, origin) {
    return credentialsFor(partition, origin)
      .map((l) => ({ origin: l.origin, url: l.url, username: l.username }));
  }

  function passwordFor(partition, origin, username) {
    const hit = credentialsFor(partition, origin)
      .find((l) => String(l.username ?? "") === String(username));
    return hit ? hit.password : undefined;
  }

  function summary(partition) {
    loadCreds();
    const arr = credStore[partition];
    if (!Array.isArray(arr)) return { count: 0, accounts: [] };
    const accounts = [...new Set(arr.map((l) => l.username).filter(Boolean))];
    return { count: arr.length, accounts: accounts.slice(0, 50) };
  }

  function listAccounts() {
    loadCreds();
    const seen = new Set(), out = [];
    for (const partition of Object.keys(credStore || {})) {
      for (const l of (credStore[partition] || [])) {
        if (!l || !l.origin || l.username == null) continue;
        const key = l.origin + "\n" + l.username;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ origin: l.origin, username: l.username });
      }
    }
    return out;
  }

  function partitionCounts() {
    loadCreds();
    return Object.keys(credStore || {})
      .map((partition) => ({ partition, count: (credStore[partition] || []).length }));
  }

  function clear(partition) {
    loadCreds();
    delete credStore[partition];
    return persistCreds();
  }

  return { set, add, clear, listForOrigin, passwordFor, summary, listAccounts, partitionCounts };
}

module.exports = { createCredentialService };
