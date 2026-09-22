// 실제 Chrome 인증 넘겨주기·프로필 가져오기 IPC를 한곳에서 맡는다.
//
// 소유 범위
//   인증 창 bounds 선택과 ac-chrome-auth·ac-open-in-chrome·프로필 보장/목록/가져오기 IPC 등록.
//
// 제공 API
//   createChromeHandoffIpc(deps) 함수 하나만 내준다. Electron 객체나 Chrome 가져오기 장부를 내주지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. app·BrowserWindow·screen·ipcMain·shell·session과 신뢰/partition
//   판정, chrome-auth·cookie/password import·가져오기 장부·profile session policy를 main.cjs에서 받는다.
//
// 유지 조건
//   신뢰 발신자와 알려진 partition만 받는다. 연결된 실제 Chrome 프로필은 chrome-auth가 일반 창으로만
//   열며 인증 성공 뒤에만 UA를 파티션에 적용하고 앱으로 focus를 돌린다. 명시적 가져오기는 쿠키가
//   성공한 뒤에만 비밀번호·가져오기 장부를 갱신하며, 외부 열기는 http(s)만 허용한다.
//
// 영향 범위
//   공급자는 main.cjs의 Electron API·ipc-trust·profile-session-policy, chrome-auth·cookie-import·
//   password-import·chrome-import-registry·credential-service다. 양방향 소비자는 preload와 렌더러의
//   handoff/profiles/autofill 화면, startup의 파티션 UA 복원이다. 일치하지 않으면 인증·쿠키·비밀번호·UA가 함께 어긋난다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/chrome-handoff-ipc.cjs

const { baseDomain, inScope } = require("./chrome-auth.cjs");

function createChromeHandoffIpc({
  app, BrowserWindow, screen, ipcMain, shell, session, isTrustedSender, isProfilePartition,
  runChromeAuth, cookieImport, chromeProfileCid, chromeImportRegistry, profileSessionPolicy,
  passwordImport, setCreds, noteChromeImport,
}) {
  // 내장 인증기가 지원하지 않는 흐름은 연결된 Chrome 프로필에서 사람이 마치고 쿠키를 돌려받는다.
  // Chrome 세션 자체에 연결하는 경로는 별도 capability다. docs/chrome-auth-handoff.md
  // 인증 창 위치: 요청한 앱 창이 있는 화면의 가운데. 그 화면을 찾지 못하면 주 모니터.
  function authWindowBounds(sender) {
    try {
      const ow = BrowserWindow.fromWebContents(sender);
      const d = ow && !ow.isDestroyed() ? screen.getDisplayMatching(ow.getBounds()) : screen.getPrimaryDisplay();
      const wa = (d || screen.getPrimaryDisplay()).workArea;
      const w = Math.min(1180, Math.max(900, Math.round(wa.width * 0.62)));
      const h = Math.min(880, Math.max(700, Math.round(wa.height * 0.82)));
      return { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h };
    } catch { return null; }
  }
  ipcMain.handle("ac-chrome-auth", async (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰할 수 없는 요청입니다." };
      const partition = String((arg && arg.partition) || "");
      if (!isProfilePartition(partition)) return { ok: false, error: "알 수 없는 프로필입니다." };
      // 렌더러가 준 표시값보다 실제 가져오기 장부를 우선한다. 같은 Iris 파티션에 여러 기록이
      // 있으면 가장 최근에 연결한 Chrome 계정 프로필만 인증 창의 소유자로 쓴다.
      const recorded = chromeImportRegistry.latestForPartition(partition);
      const rawSource = String((recorded && recorded.cid) || (arg && arg.chromeSource) || "");
      const chromeSource = /^(chrome|brave|edge):(?:Default|Profile \d+)$/.test(rawSource) ? rawSource : "";
      const sourceBrowser = chromeSource.split(":", 1)[0] || "chrome";
      return await runChromeAuth({
        url: String((arg && arg.url) || ""),
        partition,
        chromeSource,
        isCurrent: () => chromeImportRegistry.latestForPartition(partition) === recorded,
        // 사람이 원래 창에 이미 쳐 넣은 값. 형태 검사는 chrome-auth의 sanitizeFields가 한다.
        fields: Array.isArray(arg && arg.fields) ? arg.fields : [],
        cookieImport,
        chromeCid: chromeProfileCid,
        // 인증 창은 사용자가 지금 보고 있는 화면에 떠야 한다. Chrome은 자기가 마지막에 쓰던 화면에
        // 창을 여는데, 그 화면이 다른 모니터면 사용자는 창이 뜨지 않았다고 인식한다.
        bounds: authWindowBounds(e.sender),

        session: session.fromPartition(partition),
        onStage: (s) => { try { if (!e.sender.isDestroyed()) e.sender.send("ac-chrome-auth-stage", s); } catch {} },
      }).then((r) => {
        // 끝나면 원래 화면으로 되돌린다. Chrome을 닫아도 앱이 뒤에 있으면 사용자가 직접 찾아와야 한다.
        if (r && r.ok) {
          // 쿠키를 만든 실제 Chrome과 Iris의 UA·Client Hints가 다르면 서버가 CookieMismatch로
          // 방금 가져온 세션을 폐기한다. 프로필 가져오기와 같은 파티션 계약을 적용한다.
          cookieImport.applyBrowserUserAgentToPartition(partition, sourceBrowser);
          try {
            app.focus({ steal: true });
            const ow = BrowserWindow.fromWebContents(e.sender);
            if (ow && !ow.isDestroyed()) { ow.show(); ow.focus(); }
          } catch {}
        }
        return r;
      });
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // 패스키 로그인 등 이 창에서 끝낼 수 없는 흐름을 기본 브라우저로 넘긴다. http(s)만 허용한다.
  // 아직 이 채널을 부르는 버튼은 없다. 하드닝(신뢰 발신자·http(s) 한정)과 전용 회귀 검사가
  // 붙어 있어 의도적으로 남긴 통로로 읽히므로 유지한다.
  // 버튼을 달지, 통로째 제거할지는 아직 정하지 않았다.
  // file:·커스텀 스킴을 그대로 넘기면 임의 앱 실행 통로가 된다. 창 생성 함수가 아니라 모듈 최상위에
  // 두어야 창 수만큼 중복 등록되지 않는다.
  ipcMain.on("ac-open-in-chrome", (e, url) => {
    try {
      if (!isTrustedSender(e)) return;
      const u = new URL(String(url || ""));
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      shell.openExternal(u.href);
    } catch {}
  });
  ipcMain.on("ac-ensure-profile", (e, partition) => {
    try {
      const p = String(partition || "");
      // 안정 id charset 정확 매칭 + 신뢰 renderer만 허용. 임의 사이트가 세션 생성을 트리거하지 못한다.
      if (!isTrustedSender(e) || !isProfilePartition(p)) return;
      profileSessionPolicy.ensureHardened(p);
    } catch {}
  });
  // 설치된 Chrome/Brave/Edge 프로필 목록. id(browser id + profileDir)는 이름변경에도 불변인 정체성이고
  // label은 표시 전용이다. 신뢰 renderer에 직렬화 가능한 필드만 노출한다.
  ipcMain.handle("ac-list-chrome-profiles", (e) => {
    try { if (!isTrustedSender(e)) return []; return cookieImport.listChromeProfiles().map((entry) => ({ id: chromeProfileCid(entry), label: entry.label })); }
    catch { return []; }
  });
  // 지정 Chrome 프로필의 쿠키를 지정 탭 파티션으로 가져온다(그 로그인 세션 그대로). 파티션은 하드닝도 보장.
  // 쿠키에 더해 저장된 로그인(아이디/비번)도 임포트해 자체 자동완성에 쓴다(credStore).
  ipcMain.handle("ac-import-chrome-profile", async (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { error: "신뢰되지 않은 발신자" }; // webview 게스트의 Keychain 트리거 차단
      const id = String((arg && arg.id) || ""); const partition = String((arg && arg.partition) || "");
      if (!isProfilePartition(partition)) return { error: "허용되지 않은 파티션" };
      const entry = cookieImport.listChromeProfiles().find((x) => chromeProfileCid(x) === id);
      if (!entry) return { error: "프로필을 찾을 수 없습니다: " + id };
      profileSessionPolicy.ensureHardened(partition);
      const res = await cookieImport.importCookiesFromChrome(entry, partition);
      // 쿠키가 실패하면 여기서 끝낸다. 실패한 뒤에도 비밀번호를 저장하고 가져왔다고 기록하면,
      // 화면에는 실패로 보이는데 비밀번호만 남는 상태가 된다. 쿠키·비밀번호·기록 셋은
      // 함께 성공하거나 함께 실패한다.
      if (res && res.error) return res;
      // 비밀번호는 쿠키에 딸려오지 않고, 호출자가 명시적으로 요청할 때만 가져온다(기본 꺼짐).
      // 한 번의 프로필 가져오기가 저장된 로그인 전체를 조용히 복호화하지 않도록 사용자 선택으로 옮겼다.
      if (arg && arg.withPasswords === true) {
        try {
          const lg = passwordImport.listLoginsFromChrome(entry);
          if (lg && Array.isArray(lg.logins)) { setCreds(partition, lg.logins); res.logins = lg.logins.length; }
          else if (lg && lg.error) { res.loginError = lg.error; }
        } catch (e) { res.loginError = String(e && e.message || e); }
      } else {
        res.logins = 0;
        res.loginsSkipped = true;   // 안 가져왔다는 사실을 화면이 말할 수 있게 남긴다
      }
      noteChromeImport(entry, partition);   // 무엇을 가져왔는지는 넘겨짚지 않고 여기서 적는다
      res.account = entry.account || "";
      return res;
    } catch (e) { return { error: String(e && e.message || e) }; }
  });

  // 같은 파티션·도메인의 점검은 합친다. 로그인 화면 복구는 일반 탐색 TTL과 따로 처리한다.
  const refreshes = new Map();
  const checkedAt = new Map();
  const REFRESH_TTL_MS = 60 * 1000;
  ipcMain.handle("ac-refresh-chrome-cookies", async (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, skipped: "untrusted" };
      const partition = String((arg && arg.partition) || "");
      if (!isProfilePartition(partition)) return { ok: false, skipped: "partition" };
      let url;
      try {
        url = new URL(String((arg && arg.url) || ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, skipped: "scheme" };
      } catch { return { ok: false, skipped: "url" }; }
      if (url.hostname === "accounts.google.com" && /\/signin\/rejected(?:\/|$)/.test(url.pathname)) {
        return { ok: true, skipped: "unsupported-browser", changed: 0 };
      }
      const base = baseDomain(url.hostname);
      const recovering = url.hostname === "accounts.google.com" && /\/(ServiceLogin|(?:v\d+\/)?signin)(?:\/|$)/.test(url.pathname);
      const key = partition + "\n" + base + "\n" + recovering;
      if (refreshes.has(key)) return await refreshes.get(key);
      if (Date.now() - (checkedAt.get(key) || 0) < REFRESH_TTL_MS) return { ok: true, skipped: "recent", changed: 0 };
      const recorded = chromeImportRegistry.latestForPartition(partition);
      if (!recorded || !recorded.cid) return { ok: true, skipped: "no-link", changed: 0 };
      checkedAt.set(key, Date.now());
      const operation = (async () => {
        const entry = cookieImport.listChromeProfiles().find(x => chromeProfileCid(x) === recorded.cid);
        if (!entry) return { ok: true, skipped: "no-profile", changed: 0 };
        const result = await cookieImport.refreshFromChrome(entry, partition, d => inScope(d, base), { base, recovering,
          isCurrent: () => chromeImportRegistry.latestForPartition(partition)?.cid === recorded.cid,
        });
        return { ...result, ok: !result.error, base };
      })();
      refreshes.set(key, operation);
      try { return await operation; } finally { refreshes.delete(key); }
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
}

module.exports = { createChromeHandoffIpc };
