// 소유 범위: native/electron/server-host.cjs 의 자물쇠 이어받기·자식 수명·재시도.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이고,
//   분리하면서 검사 본문을 바꾸지 않았고, 인구조사 해시로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/server-host.mjs
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  browserRuntime, browserWindowManagerSource, cdpTransportSource, main, mainWindowSource,
  memoWindowManagerSource, nativeAx, pick, record, web, webview,
} from "../sources.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

const pathJoinTmp = () => path.join(tmpdir(), "iris-server-host-probe");

export default async function run() {
  console.log("[서버 주인 — 자물쇠와 자식 수명]");
  {
    const srvLock = read("server/index.js");
    check("상태 폴더를 이미 쓰는 서버가 있으면 두 번째는 뜨지 않는다", () =>
      /server\.lock/.test(srvLock)
      && /이미 다른 Iris 서버가 이 상태 폴더를 쓰고 있습니다/.test(srvLock)
      // 여기서 exit(1)로 끝내면 launchd가 KeepAlive로 10초마다 다시 실행해 같은 거절이
      // 무한히 반복되고, 그동안 관리되는 서버는 기동하지 못한다. 그래서 종료하지 않고
      // 대기했다가 자물쇠를 이어받는다. "두 번째는 뜨지 않는다"는 계약은 유지되고,
      // 기동하지 않는 방식만 달라졌다.
      && /while \(lockHolder\)/.test(srvLock) && /IRIS_LOCK_WAIT_MS/.test(srvLock));
    check("기다리는 쪽은 앞 서버가 내려가면 사람 손 없이 이어받는다", () =>
      // 정적 검사로는 여기까지다. 실제 인계는 test/state-lock-handover.mjs가 서버 둘을 띄워 확인한다.
      /자리를 이어받았습니다/.test(srvLock)
      && existsSync(path.join(ROOT, "test/state-lock-handover.mjs")));
    check("죽은 서버의 자물쇠는 물려받는다", () =>
      // pid만 보면 재사용된 번호에 막혀 기동하지 못하고, launchd가 KeepAlive로 무한히 재실행한다.
      /command=/.test(srvLock) && /cmd\.includes\("server\/index\.js"\)/.test(srvLock)
      && /function pidIsThisServer\(pid\)/.test(srvLock));
    // 죽은 자물쇠를 치우는 unlink는 한 번에 하나만 해야 한다. 둘이 같은 죽은 자물쇠를 읽으면
    // 늦은 쪽의 unlink가 이미 획득한 쪽의 유효한 자물쇠를 지우고, 그 결과 서버 둘이
    // 같은 상태 파일을 쓴다(확인 결과). 실제 동작은 test/lock-handover-freshness.mjs가 확인한다.
    check("죽은 자물쇠 치우기는 배타 표로 직렬화된다", () =>
      /function reapDeadLock\(deadPid\)/.test(srvLock)
      && /fs\.openSync\(reap, "wx"\)/.test(srvLock)
      && /if \(now !== deadPid\) return false;/.test(srvLock)
      // 자물쇠를 지우는 위치는 둘뿐이어야 한다. 잠금을 확보하고 만료를 재확인한 위치와, 종료할 때
      // 자기 자물쇠를 해제하는 위치다. 그 밖에 조건 없는 unlink가 하나라도 있으면 경합이 다시 생긴다.
      && srvLock.split("\n").filter((l) => l.includes("fs.unlinkSync(LOCK_PATH)"))
          .every((l) => l.includes("=== process.pid") || /^\s*try \{ fs\.unlinkSync\(LOCK_PATH\); \} catch \{ return false; \}$/.test(l)));

    // 서버 프로세스는 앱이 관리한다(native/electron/server-host.cjs). 이 계약이 깨지면 두 가지로 고장난다.
    // 앱만 설치한 사용자는 서버가 없어 아무것도 실행하지 못하고, 앱이 서버를 남기고 종료하면 다음에 켠 앱이
    // 이전 서버에 연결돼 수정이 반영되지 않는다. 실제 기동·인계·종료는 test/server-host-lifecycle.mjs가 확인한다.
    const hostSrc = read("native/electron/server-host.cjs");
    const mainHost = read("native/electron/main.cjs");
    check("앱이 서버를 자식으로 띄운다", () =>
      /new ServerHost\(\{ app, port: APP_PORT, stateDir: IRIS_HOME \}\)/.test(mainHost)
      && /await serverHost\.start\(\)/.test(mainHost)
      && existsSync(path.join(ROOT, "native/electron/server-host.cjs")));
    check("서버는 창보다 먼저 뜬다", () => {
      // 창이 먼저 뜨면 첫 loadURL이 반드시 실패하고, 사용자에게는 재시도가 채우기 전 빈 화면이 보인다.
      const ready = sliceBetween(mainHost, "await serverHost.start()", "setupCdpControl", "서버는 창보다 먼저 뜬다");
      return /mainWindow\.createWindow\(\)/.test(ready);
    });
    check("앱이 나가면 자기가 띄운 서버도 데려간다", () =>
      /app\.on\("will-quit", \(\) => \{ try \{ serverHost\.stop\(\); \}/.test(mainHost)
      && /if \(!child \|\| !this\.owned\) return;/.test(hostSrc));
    check("이미 떠 있는 서버는 죽이지 않고 붙는다", () =>
      // 서버는 사용자의 탭·계정·기록을 들고 있다. 앱을 켰다는 이유로 교체하면 그 상태가 사라진다.
      /const existing = await probe\(this\.port\)/.test(hostSrc)
      && /return \{ attached: true/.test(hostSrc)
      && /healthz/.test(readAll("server")));
    check("재시도는 유한하다", () =>
      // launchd KeepAlive는 같은 실패를 무한히 반복한다. 앱은 재시도 횟수 상한을 둔다.
      /RESTART_BACKOFF_MS/.test(hostSrc) && /다시 띄우지 않습니다/.test(hostSrc));
    const mainRetry = read("native/electron/main-window.cjs");
    check("닫힌 창에 로드를 거는 재시도가 남지 않는다", () =>
      /win\.isDestroyed\(\)\) return cancelLoadRetry/.test(mainRetry)
      && /win\.on\("closed", cancelLoadRetry\)/.test(mainRetry)
      // loadURL은 파괴된 창에서 예외를 동기적으로 던지므로 .catch만으로는 잡히지 않는다.
      && /try \{ win\.loadURL\(APP_URL\)/.test(mainRetry));
  }
}
