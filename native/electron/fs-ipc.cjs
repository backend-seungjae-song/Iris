// 파일 트리가 파일 시스템을 다루는 세 동작: 위치 보기·휴지통·동일성 확인.
//
// 소유 범위
//   ac-reveal-in-finder · ac-trash-item · ac-trash-items · ac-path-identity 네 IPC 의 판정과
//   응답 모양.
//
// 제공 API
//   createFsIpc(deps) 가 네 핸들러를 등록한다. 등록 외에는 아무것도 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. ipcMain·shell 과 fs·path·os·발신자 판정을 주입받는다.
//
// 유지 조건
//   신뢰하지 않는 발신자는 거절한다. 렌더러가 임의 경로를 전달할 수 있는 경계다.
//   존재하는 절대 경로만 받는다. 상대 경로는 기준이 호출자마다 달라진다.
//   휴지통 이동은 삭제가 아니다. trashItem 을 써야 사용자가 복원할 수 있다.
//   identity 는 내용이 아니라 경로와 stat 만 돌려주고, dev·ino 는 문자열로 반환한다.
//   숫자로 주면 큰 ino 가 렌더러에서 정밀도를 잃어 서로 다른 파일이 같게 판정된다.
//   identity 가 실패하면 missing 으로 표시한다. 파일이 사라진 경우와 판정이 실패한 경우
//   (권한 오류·I/O 오류)를 구분하지 않고 둘 다 missing 으로 돌려준다.
//   구분하려면 응답 키를 늘려야 하고, 그 변경은 삭제 확인창 쪽 소비자까지
//   함께 바꿔야 한다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron ipcMain·shell 과 isTrustedSender 다.
//   양방향 소비자는 web/js 의 파일 트리 컨텍스트 메뉴와 삭제 확인창이다.
//   응답 키 이름(ok·error·missing·lexicalPath·canonicalPath·dev·ino)이 그쪽에 고정돼 있다.
//   현재 목록 확인: node bin/importers.mjs native/electron/fs-ipc.cjs

function createFsIpc({ ipcMain, shell, fs, path, os, isTrustedSender }) {
  // 파일 트리 컨텍스트 메뉴에서 Finder로 파일 위치 보기. 신뢰 렌더러와 존재하는 절대 경로만 받는다.
  ipcMain.on("ac-reveal-in-finder", (e, p) => {
    try {
      if (!isTrustedSender(e) || typeof p !== "string" || !p) return;
      // 창은 서버가 준 홈 경로로 `~`를 이미 확장해 보내지만, 그 값이 아직 도착하지 않았거나
      // 다른 경로로 들어온 토큰이 있을 수 있다. 여기서도 홈을 알 수 있으므로 한 번 더 확장한다.
      const abs = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
      if (path.isAbsolute(abs) && fs.existsSync(abs)) shell.showItemInFolder(abs);
    } catch {}
  });
  // 파일/폴더를 macOS 휴지통으로(되돌릴 수 있음). 신뢰 렌더러 + 존재하는 절대 경로만. 결과 { ok, error }.
  ipcMain.handle("ac-trash-item", async (e, p) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      if (typeof p !== "string" || !p || !path.isAbsolute(p) || !fs.existsSync(p)) return { ok: false, error: "경로 없음" };
      await shell.trashItem(p);
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
  });
  // 여러 항목을 한 번에 휴지통으로 보낸다. 판정은 한 개짜리와 같고 IPC 왕복만 한 번이다.
  // 수천 개를 하나씩 호출하면 창이 그 왕복에 묶인다. 하나가 실패해도 나머지는 계속 처리하고,
  // 실패한 항목을 그대로 돌려준다. 결과 { ok, moved, failed:[{ path, error }] }.
  ipcMain.handle("ac-trash-items", async (e, list) => {
    if (!isTrustedSender(e)) return { ok: false, moved: 0, failed: [], error: "신뢰되지 않은 발신자" };
    if (!Array.isArray(list)) return { ok: false, moved: 0, failed: [], error: "목록이 아닙니다" };
    let moved = 0;
    const failed = [];
    for (const p of list) {
      if (typeof p !== "string" || !p || !path.isAbsolute(p) || !fs.existsSync(p)) { failed.push({ path: String(p), error: "경로 없음" }); continue; }
      try { await shell.trashItem(p); moved += 1; }
      catch (e2) { failed.push({ path: p, error: String(e2 && e2.message || e2) }); }
    }
    return { ok: failed.length === 0, moved, failed };
  });
  // 삭제 확인창이 열린 동안 대상이 바뀌었는지, 심링크 별칭이 같은 대상을 가리키는지 확인한다.
  // 렌더러에는 내용이 아니라 경로·stat identity만 돌려준다.
  ipcMain.handle("ac-path-identity", async (e, p) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      if (typeof p !== "string" || !p || !path.isAbsolute(p)) return { ok: false, error: "잘못된 경로" };
      const lexicalPath = path.resolve(p);
      const lst = fs.lstatSync(lexicalPath);
      const st = fs.statSync(lexicalPath);
      const canonicalPath = fs.realpathSync(lexicalPath);
      return {
        ok: true, lexicalPath, canonicalPath,
        isSymlink: lst.isSymbolicLink(), isDirectory: st.isDirectory(),
        dev: String(st.dev), ino: String(st.ino), mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size,
      };
    } catch (e2) { return { ok: false, missing: true, error: String(e2 && e2.message || e2) }; }
  });
}

module.exports = { createFsIpc };
