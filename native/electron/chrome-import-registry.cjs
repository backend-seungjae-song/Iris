// Chrome/Brave/Edge 프로필을 Iris partition에 가져온 사실의 장부.
//
// 소유 범위
//   chrome-imports.json의 계정·partition별 기록, 최초 복원, 임시 파일 저장·원자적 교체.
//
// 제공 API
//   createChromeImportRegistry(...)가 profileCid·note·backfill 명령과 latestForPartition·has·list 조회를
//   준다. 원시 장부 객체는 내주지 않는다.
//
// 의존 대상
//   조립부가 넘기는 stateDir, fs/path port와 현재 시각. import 실행 모듈에는 기대지 않는다.
//
// 유지 조건
//   cid는 browser.id + ":" + profile이고, 계정 key는 gaia→email→browser/profile 순이다. 같은 key는
//   각 partition 안에서 한 항목이며, backfill은 기존 연결을 덮지 않는다. 파일은 tmp 완성 뒤 rename한다.
//
// 영향 범위
//   공급자는 main.cjs의 cookie-import 프로필·성공한 import·기존 UI 연결 backfill과 IRIS_HOME이고,
//   양방향 소비자는 main.cjs의 Chrome auth 최신 연결·계정 관리 missing 판정·startup UA 복원이다.
//   기록 시점은 쿠키·선택적 비밀번호 import의 all-or-nothing 순서와 화면의 가져옴 표시에도 영향을 준다.

function createChromeImportRegistry({ stateDir, fs, path, now = Date.now }) {
  const filePath = path.join(stateDir, "chrome-imports.json");
  let chromeImports = {};
  try { chromeImports = JSON.parse(fs.readFileSync(filePath, "utf8")) || {}; } catch { chromeImports = {}; }

  // 옛 계정 단일 key도 읽되 같은 계정을 가져온 다른 partition을 덮지 않는다.
  chromeImports = Object.fromEntries(Object.entries(chromeImports).filter(([, row]) => row && typeof row === "object")
    .map(([key, row]) => {
      const accountKey = row.accountKey || key;
      return [JSON.stringify([accountKey, row.partition || ""]), { ...row, accountKey }];
    }));

  function profileCid(entry) {
    return entry.browser.id + ":" + entry.profile;
  }

  function chromeProfileKey(entry) {
    if (!entry) return "";
    if (entry.gaia) return "gaia:" + entry.gaia;
    if (entry.account) return "acct:" + String(entry.account).toLowerCase();
    return "dir:" + entry.browser.id + ":" + entry.profile;
  }

  function saveChromeImports() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath + ".tmp", JSON.stringify(chromeImports), { mode: 0o600 });
      fs.renameSync(filePath + ".tmp", filePath);
    } catch {}
  }

  function note(entry, partition) {
    const key = chromeProfileKey(entry); if (!key) return;
    // 파티션의 현재 source는 하나다. 같은 ms 안의 재연결도 옛 항목과 timestamp 동률이 되지 않는다.
    for (const [oldKey, row] of Object.entries(chromeImports)) {
      if (row.partition === String(partition || "")) delete chromeImports[oldKey];
    }
    chromeImports[JSON.stringify([key, String(partition || "")])] = { accountKey: key, partition: String(partition || ""), cid: profileCid(entry), profile: entry.profile,
      browser: entry.browser.id, label: entry.label, account: entry.account || "", at: now() };
    saveChromeImports();
  }

  function backfill(rows) {
    let dirty = false;
    for (const row of (rows || [])) {
      const entry = row && row.entry;
      const key = chromeProfileKey(entry);
      if (!key || latestForPartition(String(row.partition || ""))) continue;
      chromeImports[JSON.stringify([key, String(row.partition || "")])] = { accountKey: key, partition: String(row.partition || ""), cid: profileCid(entry), profile: entry.profile,
        browser: entry.browser.id, label: entry.label, account: entry.account || "", at: now(), backfilled: true };
      dirty = true;
    }
    if (dirty) saveChromeImports();
  }

  function latestForPartition(partition) {
    return Object.values(chromeImports || {}).filter((item) => item && item.partition === partition)
      .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0];
  }

  function has(entry) {
    const key = chromeProfileKey(entry);
    return !!key && Object.values(chromeImports).some((row) => row.accountKey === key);
  }

  function list() {
    return Object.values(chromeImports);
  }

  return { profileCid, note, backfill, latestForPartition, has, list };
}

module.exports = { createChromeImportRegistry };
