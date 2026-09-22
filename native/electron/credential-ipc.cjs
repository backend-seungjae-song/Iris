// 렌더러가 자격증명 저장소에 접근하는 여섯 경로: 목록·비밀번호 한 개·한 건 저장·요약·비우기·파티션 지우기.
//
// 소유 범위
//   ac-get-creds · ac-creds-password · ac-cred-save · ac-creds-summary · ac-clear-creds · ac-purge-partition
//   의 발신자·파티션·origin 판정과 응답 모양.
//
// 제공 API
//   createCredentialIpc(deps) 가 여섯 핸들러를 등록하고 setCreds 를 돌려준다.
//   저장소 자체나 그 원시 값은 내주지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. ipcMain 과 자격증명 서비스·파티션 판정·발신자 판정·
//   파티션 지우기를 주입받는다. 읽기·쓰기 판정은 cred-store.cjs 가 갖는다.
//   읽지 못한 저장소 위에 덮어쓰지 않는 판정이 거기 있으므로 그 경로를 우회하지 않는다.
//
// 유지 조건
//   비신뢰 발신자는 거절한다. webview 게스트가 직접 부르면 비밀번호가 그대로 노출된다.
//   목록과 요약에는 비밀번호를 싣지 않는다. 목록 응답이 비밀번호를 담으면 렌더러 객체에
//   캐시로 남아, 한 번 로그인 칸을 누른 탭은 종료될 때까지 비밀번호를 메모리에 들고 있게 된다.
//   비밀번호는 정확한 파티션·origin·아이디 한 건에만 준다. 없으면 빈 문자열이다.
//   로그인 편의 기능이 꺼져 있으면 목록·비밀번호·저장 세 경로가 모두 닫힌다. 끄는 사람이 기대하는 것은
//   화면에서 보이지 않는 것이 아니라 이 기기에서 그 값이 나가지 않는 것이다. 지우는 경로(요약·비우기·
//   파티션 삭제)는 막지 않는다. 꺼 놓고도 이미 있는 것을 지울 수 있어야 한다.
//   ac-purge-partition 은 지우기가 끝난 뒤에 응답한다. 먼저 성공을 돌려주면 사용자가
//   지워진 것으로 보고 곧바로 다시 로그인하는데 그 사이에 옛 저장소가 복원된다.
//   기본 파티션은 지울 수 없다. 그것은 프로필이 아니라 브라우저 자신이다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron ipcMain 과 credential-service·profile-session-policy 다.
//   setCreds 의 소비자는 chrome-handoff-ipc 의 비밀번호 임포트다. 여기서 이름을 바꾸면 그쪽이 끊긴다.
//   응답 소비자는 webview-preload 의 자동완성과 web/js 의 계정 페이지다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/credential-ipc.cjs

function createCredentialIpc({ ipcMain, credentialService, isTrustedSender, isProfilePartition, purgePartition, basePartition,
  loginConvenienceOn = () => true }) {
  function setCreds(partition, logins) {
    credentialService.set(partition, logins);
  }
  // webview-preload → 호스트 렌더러 경유로 현재 파티션·origin의 자격증명 요청. 렌더러가 partition을 안다.
  // 로컬 앱 렌더러(신뢰)만 호출. origin 정확 일치 자격증명만 반환.
  ipcMain.handle("ac-get-creds", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return []; // 비신뢰 webview 게스트의 직접 호출 차단(비번 유출 방지)
      if (!loginConvenienceOn()) return []; // 편의 기능을 끈 사람에게는 목록도 주지 않는다
      const partition = String((arg && arg.partition) || "");
      const origin = String((arg && arg.origin) || "");
      if (!isProfilePartition(partition) || !/^https?:\/\//.test(origin)) return [];
      // 목록에는 비밀번호를 싣지 않는다. 이 응답이 비밀번호를 담으면 렌더러 객체에 캐시로 남아,
      // 한 번 로그인 칸을 누른 탭은 종료될 때까지 비밀번호를 렌더러 메모리에 들고 있게 된다.
      // 채울 때 필요한 한 개만 ac-creds-password로 그 순간에 꺼낸다.
      return credentialService.listForOrigin(partition, origin);
    } catch { return []; }
  });
  // 이 브라우저에서 새로 로그인한 것을 저장소에 넣는다. 사용자가 저장을 누른 뒤에만 여기까지 온다.
  // 게스트는 이 채널을 직접 부를 수 없고(비신뢰 발신자 차단), 신뢰 렌더러가 동의를 받고 부른다.
  // Chrome 의 비밀번호 저장소는 건드리지 않는다. 그쪽은 사용자의 실제 저장소이고, Chrome 이 실행
  // 중일 때 쓰면 손상 위험이 있다.
  ipcMain.handle("ac-cred-save", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      if (!loginConvenienceOn()) return { ok: false, error: "로그인 편의 기능이 꺼져 있습니다" };
      const partition = String((arg && arg.partition) || "");
      const origin = String((arg && arg.origin) || "");
      const username = String((arg && arg.username) ?? "");
      const password = String((arg && arg.password) ?? "");
      if (!isProfilePartition(partition)) return { ok: false, error: "알 수 없는 프로필" };
      if (!/^https?:\/\//.test(origin)) return { ok: false, error: "알 수 없는 사이트" };
      if (!username || !password) return { ok: false, error: "아이디나 비밀번호가 비어 있습니다" };
      const saved = credentialService.add(partition, {
        origin, username, password,
        url: typeof (arg && arg.url) === "string" && /^https?:\/\//.test(arg.url) ? arg.url : origin,
      });
      return saved ? { ok: true } : { ok: false, error: "금고에 쓰지 못했습니다" };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // 채우는 순간에 비번 하나만 꺼낸다. 파티션·origin·아이디를 다시 확인하고, 아니면 빈 문자열.
  ipcMain.handle("ac-creds-password", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return "";
      if (!loginConvenienceOn()) return "";  // 꺼져 있으면 비번은 어떤 경로로도 나가지 않는다
      const partition = String((arg && arg.partition) || "");
      const origin = String((arg && arg.origin) || "");
      const username = String((arg && arg.username) ?? "");
      if (!isProfilePartition(partition) || !/^https?:\/\//.test(origin)) return "";
      const password = credentialService.passwordFor(partition, origin, username);
      return password != null ? String(password) : "";
    } catch { return ""; }
  });
  // 렌더러 계정 페이지용: 파티션별 저장된 자격증명 요약(비밀번호 제외, 개수·계정만).
  ipcMain.handle("ac-creds-summary", (e, partition) => {
    try {
      if (!isTrustedSender(e)) return { count: 0, accounts: [] };
      const key = String(partition || ""); if (!isProfilePartition(key)) return { count: 0, accounts: [] };
      return credentialService.summary(key);
    } catch { return { count: 0, accounts: [] }; }
  });
  ipcMain.handle("ac-clear-creds", (e, partition) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      const key = String(partition || ""); if (!isProfilePartition(key)) return { ok: false, error: "잘못된 파티션" };
      credentialService.clear(key); return { ok: true };
    }
    catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
  });
  // 프로필 삭제의 나머지 절반. 그 파티션의 저장소를 실제로 비운다.
  ipcMain.handle("ac-purge-partition", async (e, partition) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      const key = String(partition || "");
      if (!isProfilePartition(key) || key === basePartition) return { ok: false, error: "잘못된 파티션" };
      await purgePartition(key);
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
  });
  return { setCreds };
}

module.exports = { createCredentialIpc };
