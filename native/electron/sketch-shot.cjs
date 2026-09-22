// 화면 스케치의 네이티브 쪽 구현. 전체 페이지를 캡처해 바이트로 전달하고, 그린 결과를 파일로 저장한다.
//
// 소유 범위
//   IPC 두 개: ac-sketch-shot(캡처) · ac-sketch-save(저장). 그 밖의 상태는 갖지 않는다.
//
// 제공 API
//   initCapability(ctx). 네이티브 기능 표(capabilities.cjs)가 호출하는 진입점이다.
//
// 의존 대상
//   ctx 로 받는 앱 셸의 공용 요소: ipcMain · isTrustedSender · webContents · runCdp · stateDir.
//   상태 폴더 경로를 여기서 직접 조합하지 않는다. 그 판정은 앱 셸이 소유하고 여기는 주입받는다.
//
// 유지 조건
//   캡처 결과를 경로가 아니라 바이트로 돌려준다. 창은 http://localhost 이고 webSecurity 가 켜져
//   있어 file:// 이미지를 읽지 못하므로, 경로를 주면 창에서 빈 이미지가 된다.
//   저장은 신뢰된 발신자만. 임의의 바이트를 임의의 경로에 쓰는 통로가 되면 안 되므로 파일
//   이름은 여기서 정하고 밖에서 받지 않는다.
//
// 영향 범위
//   preload 의 sketchShot·sketchSave, 렌더러의 web/js/browser/sketch.js.
//   현재 목록 확인: node bin/importers.mjs native/electron/sketch-shot.cjs
const fs = require("fs");
const path = require("path");

const { artifactDir } = require("../../server/artifacts-home.cjs");

function initCapability(ctx) {
  const { ipcMain, isTrustedSender, webContents, runCdp, stateDir } = ctx;

  // 전체 페이지를 이어 붙여 캡처한다. 실패해도 창이 종료되면 안 되므로 사유를 담아 돌려준다.
  ipcMain.handle("ac-sketch-shot", async (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      const wcId = Number(arg && arg.wc);
      if (!wcId) return { ok: false, error: "찍을 탭을 알 수 없습니다." };
      const r = await runCdp(webContents, wcId, "screenshot", { full: true });
      if (!r || !r.ok || !r.path) return { ok: false, error: (r && r.error) || "이 탭을 찍지 못했습니다." };
      return { ok: true, bytes: fs.readFileSync(r.path), url: r.url || "", title: r.title || "" };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });

  // 그린 결과. 캡처 원본(shots)과 섞지 않는다. 원본은 60장·7일 기준으로 자동 삭제된다.
  ipcMain.handle("ac-sketch-save", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
      const bytes = arg && arg.bytes;
      if (!bytes || !bytes.length) return { ok: false, error: "빈 그림" };
      const dir = artifactDir("sketches", stateDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "sketch-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png");
      fs.writeFileSync(file, Buffer.from(bytes));
      return { ok: true, path: file };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
}

module.exports = { initCapability };
