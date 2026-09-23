// Orca 번들(orca-emulator.cjs)이 `electron` 대신 받는 모듈.
//
// 소유 범위
//   번들이 등록하는 IPC 처리기 앞의 발신자 검사.
//
// 제공 API
//   번들이 쓰는 electron 멤버(app · net · BrowserWindow · ipcMain)와 configure(ctx).
//
// 의존 대상
//   emulator-host.cjs 가 넘기는 앱 셸 ctx(app · BrowserWindow · ipcMain · isTrustedSender)와 electron.net.
//
// 유지 조건
//   Orca 의 ipcMain.handle 에는 발신자 검사가 없다. 프레임 스트림 처리기는 렌더러가 준 주소로 HTTP 연결을
//   열기 때문에, 신뢰되지 않은 발신자가 부르면 메인 프로세스가 임의 주소에 접속한다. 판정 함수가 없으면
//   거절한다.
//
// 영향 범위
//   orca-emulator.cjs 의 ipcMain.handle 전부(emulator:frameStream* · emulator:videoStream*).
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/emulator/electron-guard.cjs
// app · BrowserWindow · ipcMain 은 다른 기능과 같이 앱 셸의 ctx 에서 받는다. ctx 에 없는 net 만 electron 에서
// 꺼내며, 번들이 접근할 때 꺼내므로 이 파일을 불러오는 것만으로는 electron 을 요구하지 않는다.
let host = null;

function configure(ctx) { host = ctx; }

const ipcMain = {
  handle(channel, listener) {
    host.ipcMain.handle(channel, (event, ...args) => {
      if (!host.isTrustedSender || !host.isTrustedSender(event)) throw new Error("신뢰되지 않은 발신자");
      return listener(event, ...args);
    });
  },
};

// Orca 는 저장소 뿌리에서 main 을 실행해 개발 중에 app.getAppPath()/node_modules/serve-sim 을 찾는다. Iris 의
// main 은 native/electron 에 있어 그 경로가 비고, 번들은 PATH 의 serve-sim 을 시스템 Node 로 실행한다. 그
// Node 에는 WebSocket 이 없어 헬퍼에 붙는 명령(button · rotate)이 실패한다. 패키지된 앱은 resourcesPath 를
// 먼저 보므로 개발 중에만 뿌리를 알려 준다.
const REPO_ROOT = require("node:path").resolve(__dirname, "..", "..", "..");
const app = {
  getPath: (name) => host.app.getPath(name),
  getVersion: () => host.app.getVersion(),
  getAppPath: () => (host.app.isPackaged ? host.app.getAppPath() : REPO_ROOT),
};

module.exports = {
  app,
  get net() { return require("electron").net; },
  get BrowserWindow() { return host.BrowserWindow; },
  ipcMain,
  configure,
};
