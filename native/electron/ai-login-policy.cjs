// AI 자동완성 로그인 허용 목록·목록 IPC·로그인 제공자를 한곳에서 맡는다.
//
// 소유 범위
//   ai-login.json 경로와 정확한 origin+username 허용 Set, 로드·저장·목록·로그인 판정.
//
// 제공 API
//   createAiLoginPolicy(deps) 함수 하나만 내준다. 허용 Set·저장 배열·비밀번호를 내주지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. fs·path·상태 폴더, ipcMain·신뢰/partition 판정·session→partition 조회,
//   credential-service·cookie-import·chrome-import-registry와 CDP login/notify port를 main.cjs에서 받는다.
//
// 유지 조건
//   기본은 전부 거절하고 목록에 오른 정확한 origin·username 조합만 채운다. 목록·출처 IPC에는 비밀번호를
//   싣지 않고, 비밀번호는 선택한 계정 하나를 채우는 순간에만 guest로 보낸다. 저장/삭제는 같은 JSON 형태로
//   왕복하며 로그인 결과의 secret은 CDP 결과 안전 계층이 즉시 가릴 수 있게 그 경로에만 돌려준다.
//
// 영향 범위
//   공급자는 main.cjs의 IPC·state home, credential-service·cookie-import·chrome-import-registry와
//   cdp-control login provider다. 양방향 소비자는 preload/webview 자동완성, accounts 허용 목록 화면,
//   CDP login handler·result safety와 서버 ai-login-note다. 일치하지 않으면 권한·비밀번호 비노출·사용자 알림이 함께 깨진다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/ai-login-policy.cjs

function createAiLoginPolicy({
  fs, path, stateDir, ipcMain, isTrustedSender, credentialService, cookieImport,
  chromeImportRegistry, chromeProfileCid, isProfilePartition, setLoginProvider, ctlSend,
  partitionForSession = () => null,
  localLoginFor = () => null,
}) {
  // ── AI 자동완성 로그인 허용 목록 ─────────────────────────────────────────────
  // 특정 사이트의 특정 계정만 AI 가 자동 완성으로 로그인할 수 있다. 기본은 전부 잠금이고,
  // 사용자가 이 목록에 올린 (사이트, 아이디) 조합만 AI가 채울 수 있다. 이 목록에는 허용 여부만
  // 있고 비밀번호 값은 없다. 실제 비밀번호는 credStore(Keychain 암호화)에서 그때 꺼내 쓴다.
  const AI_LOGIN_PATH = path.join(stateDir, "ai-login.json");
  let aiLoginAllow = null; // Set<"origin\nusername">
  function loadAiLogin() {
    if (aiLoginAllow) return aiLoginAllow;
    aiLoginAllow = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(AI_LOGIN_PATH, "utf8"));
      for (const x of (Array.isArray(raw) ? raw : [])) if (x && x.origin && x.username != null) aiLoginAllow.add(x.origin + "\n" + x.username);
    } catch {}
    return aiLoginAllow;
  }
  function persistAiLogin() {
    try {
      fs.mkdirSync(path.dirname(AI_LOGIN_PATH), { recursive: true });
      const list = [...loadAiLogin()].map((k) => { const i = k.indexOf("\n"); return { origin: k.slice(0, i), username: k.slice(i + 1) }; });
      fs.writeFileSync(AI_LOGIN_PATH, JSON.stringify(list, null, 2), { mode: 0o600 });
    } catch {}
  }
  function aiLoginAllowed(origin, username) { return loadAiLogin().has(String(origin) + "\n" + String(username)); }
  // 저장된 로그인 전체(사이트·아이디만) + 허용 여부. 비번은 절대 나가지 않는다.
  function aiLoginInventory() {
    loadAiLogin();
    const out = credentialService.listAccounts().map((l) => {
      const k = l.origin + "\n" + l.username;
      return { origin: l.origin, username: l.username, allowed: aiLoginAllow.has(k) };
    });
    out.sort((a, b) => a.origin.localeCompare(b.origin) || String(a.username).localeCompare(String(b.username)));
    return out;
  }
  ipcMain.handle("ac-ai-login-list", (e) => { try { return isTrustedSender(e) ? aiLoginInventory() : []; } catch { return []; } });
  // 저장된 계정만 보여주면 목록이 왜 적은지 알 수 없으므로 가져오지 않은 것도 함께 보여준다.
  // 가져온 프로필과 그 안의 계정 수, 아직 가져오지 않은 Chrome 프로필을 함께 돌려준다.
  ipcMain.handle("ac-ai-login-sources", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { imported: [], missing: [], total: 0 };
      const imported = credentialService.partitionCounts()
        .filter((x) => x.count > 0);
      let list = [];
      try { list = cookieImport.listChromeProfiles(); } catch {}
      // 기록이 생기기 전에 가져온 것 보정: 창이 들고 있는 (우리 프로필 → Chrome cid) 연결을 받아
      // 한 번 적어 둔다. 이 경로는 "이미 가져왔다"는 표시만 만들고 임포트를 일으키지 않는다.
      const link = (arg && arg.sources && typeof arg.sources === "object") ? arg.sources : null;
      if (link) {
        const rows = [];
        for (const [ourId, cid] of Object.entries(link)) {
          const entry = list.find((x) => chromeProfileCid(x) === cid); if (!entry) continue;
          const partition = "persist:acprof:" + ourId;
          if (!isProfilePartition(partition)) continue;
          rows.push({ entry, partition });
        }
        chromeImportRegistry.backfill(rows);
      }
      // 가져왔는지는 계정으로 판정한다. 프로필 이름은 언제든 바뀌므로 판정 근거가 못 된다.
      const profiles = list.map((x) => ({ id: chromeProfileCid(x), label: x.label, account: x.account || "",
        imported: chromeImportRegistry.has(x) }));
      const missing = profiles.filter((p) => !p.imported);
      return { imported, missing, profiles: profiles.length, list: profiles, total: aiLoginInventory().length };
    } catch { return { imported: [], missing: [], total: 0 }; }
  });
  ipcMain.handle("ac-ai-login-set", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      const origin = String((arg && arg.origin) || ""), username = String((arg && arg.username) ?? "");
      if (!/^https?:\/\//.test(origin)) return { ok: false, error: "잘못된 사이트" };
      loadAiLogin();
      const k = origin + "\n" + username;
      if (arg && arg.allowed) aiLoginAllow.add(k); else aiLoginAllow.delete(k);
      persistAiLogin();
      return { ok: true, allowed: aiLoginAllow.has(k) };
    } catch (e2) { return { ok: false, error: String((e2 && e2.message) || e2) }; }
  });
  // AI가 요청한 로그인. 비밀번호는 이 경로에서만 다루고 게스트 preload로 곧장 전달하며,
  // cdp 층에도 명령 결과에도 싣지 않는다. 허용 목록에 없으면 채우지 않고 사용자에게 알린다.
  setLoginProvider(async (wc, opts) => {
    let origin = "";
    try { origin = new URL(wc.getURL()).origin; } catch {}
    if (!/^https?:\/\//.test(origin)) return { error: "http(s) 페이지가 아닙니다." };
    // 자격증명은 프로필 partition 별로 저장된다. 요청한 탭의 session 이 어느 프로필인지 모르면
    // 다른 프로필의 비밀번호를 고를 수 있으므로 저장된 로그인이 없는 것으로 본다.
    let partition = null;
    try { partition = partitionForSession(wc.session); } catch {}
    const saved = partition ? credentialService.listForOrigin(partition, origin) : [];
    const allowed = saved.filter((l) => aiLoginAllowed(origin, l.username));
    const notify = (kind, extra) => ctlSend({ type: "ai-login-note", kind, wc: wc.id, origin, ...(extra || {}) });
    // 로컬은 프로젝트가 심어 둔 개발 계정으로 자동 로그인한다. 이 계정 하나 때문에 사용자를
    // 부르면 확인할 때마다 사람이 붙어야 한다. 이 경로는 로컬에서만 열리며, 판정은
    // server/local-origin.cjs가 하고 선언이 원격을 가리키면 local-login이 먼저 거절한다.
    // 비밀번호는 여기서도 게스트 preload로만 가고 호출자에게는 secret 자리로만 돌아간다(cdp가 가린다).
    if (!allowed.length) {
      let dev = null;
      try { dev = localLoginFor(origin); } catch {}
      const want0 = opts && opts.username;
      if (dev && (!want0 || want0 === dev.username)) {
        try { wc.send("ac-ai-login", { origin, username: dev.username, password: dev.password }); }
        catch (e2) { return { error: "채우기 실패: " + String((e2 && e2.message) || e2) }; }
        notify("filled", { username: dev.username, local: true });
        return { ok: true, origin, username: dev.username, secret: dev.password, local: true, from: dev.from,
          note: `로컬이라 프로젝트가 심어 둔 개발 계정으로 채웠습니다(${dev.from}). 비밀번호 값은 이 경로로 돌아오지 않고 이 탭의 명령 결과에서도 가려집니다. 제출은 로그인 버튼을 눌러 진행하세요.` };
      }
    }
    if (!saved.length) {
      notify("none");
      return { ok: false, needUser: true, origin, reason: "no-saved",
        note: `${origin}에 저장된 로그인이 없습니다 — 사용자에게 알렸습니다. 사람이 직접 로그인해야 합니다.` };
    }
    if (!allowed.length) {
      notify("blocked", { accounts: saved.map((l) => l.username) });
      return { ok: false, needUser: true, origin, reason: "not-allowed", accounts: saved.map((l) => l.username),
        note: `${origin}에 저장된 로그인은 있지만 AI 사용이 허용된 계정이 없습니다 — 사용자에게 알렸습니다. 앱의 [🔑 로그인]에서 허용해 주셔야 합니다.` };
    }
    const want = opts && opts.username;
    const pick = want ? allowed.find((l) => l.username === want) : (allowed.length === 1 ? allowed[0] : null);
    if (!pick) {
      return { ok: false, choose: true, origin, accounts: allowed.map((l) => l.username),
        note: "허용된 계정이 여럿입니다 — `iris-browser login <아이디>`로 고르세요." };
    }
    const password = credentialService.passwordFor(partition, origin, pick.username);
    try { wc.send("ac-ai-login", { origin, username: pick.username, password }); }
    catch (e2) { return { error: "채우기 실패: " + String((e2 && e2.message) || e2) }; }
    notify("filled", { username: pick.username });
    // secret은 cdp-control이 받아 이 탭의 결과에서 지우는 데만 쓰고 호출자에게는 돌려주지 않는다.
    return { ok: true, origin, username: pick.username, secret: password,
      note: "아이디·비밀번호를 채웠습니다. 비밀번호 값은 이 경로로 돌아오지 않고, 이 탭의 명령 결과에서도 가려집니다. 제출은 로그인 버튼을 눌러 진행하세요." };
  });
}

module.exports = { createAiLoginPolicy };
