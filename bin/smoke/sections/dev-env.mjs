// 소유 범위: server/herdr-session.cjs · native/electron/user-data-home.cjs · bin/dev-seed.mjs.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이며,
//   분리 과정에서 검사 본문을 수정하지 않았다. 인구조사 해시가 이를 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 확인한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/dev-env.mjs
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
  console.log("[개발 갈래의 자기 자리 — herdr 세션·쿠키 폴더·상태 씨앗]");
  check("개발 갈래는 자기 herdr 세션에 붙는다 — 진짜 채팅과 소켓까지 갈린다", () => {
    const { herdrSession } = require_("../server/herdr-session.cjs");
    const home = homedir();
    const at = (dir) => {
      const prevDir = process.env.IRIS_STATE_DIR, prevName = process.env.IRIS_HERDR_SESSION;
      delete process.env.IRIS_HERDR_SESSION;
      if (dir === null) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = dir;
      try { return herdrSession(); }
      finally {
        if (prevDir === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = prevDir;
        if (prevName !== undefined) process.env.IRIS_HERDR_SESSION = prevName;
      }
    };
    const installed = at(null);
    if (installed.name !== "default") throw new Error("설치본이 default 가 아니다");
    if (installed.socket !== path.join(home, ".config/herdr/herdr.sock")) throw new Error("설치본 소켓이 옮겨졌다");
    const dev = at(path.join(home, ".iris-dev"));
    if (dev.name !== "dev") throw new Error(`개발 세션 이름이 ${dev.name}`);
    // herdr 는 이름 있는 세션마다 소켓을 따로 만든다(확인 결과). 크기만이 아니라
    // 사이드바·에이전트 목록까지 분리된다.
    if (dev.socket !== path.join(home, ".config/herdr/sessions/dev/herdr.sock")) throw new Error("개발 소켓이 갈리지 않았다");
    if (dev.socket === installed.socket) throw new Error("두 소켓이 같다");
    // 상태 폴더가 다르면 세션도 반드시 다르다. 이것이 이 의존 관계의 요지다.
    for (const dir of ["/private/tmp/iris-smoke", path.join(home, ".iris-lab"), "/var/folders/x/iris-t2"]) {
      const s = at(dir);
      if (s.name === "default" || s.socket === installed.socket) throw new Error(`${dir} 가 진짜 채팅에 붙는다`);
    }
    // 이름은 파일 경로가 되므로 폴더 밖을 가리키면 안 된다. 경로 조각은 basename 이 이미
    // 제거하므로, 실제 위험은 basename 자체가 `..` 인 경우다. 그대로 쓰면 소켓 경로가
    // sessions/../herdr.sock 으로 정규화되어 **실제 채팅 소켓**을 가리킨다.
    for (const nastyDir of ["/x/.iris-../../evil", "/x/y/..", path.join(home, ".iris-.."), "/x/."]) {
      const nasty = at(nastyDir);
      if (nasty.socket === installed.socket) throw new Error(`${nastyDir} 가 진짜 채팅 소켓을 가리킨다`);
      if (!nasty.socket.startsWith(path.join(home, ".config/herdr/sessions/"))) throw new Error(`${nastyDir} 의 소켓이 폴더 밖을 가리킨다`);
    }
    return true;
  });

  check("herdr 세션을 정하는 자리는 하나다", () => {
    const owner = "server/herdr-session.cjs";
    const others = sourceFiles("server").filter((rel) => rel !== owner);
    const offenders = others.filter((rel) => {
      const src = read(rel);
      // 소켓 경로를 다시 만들거나 세션 이름을 직접 지정한 곳. 둘이 달라지면 사이드바는 이쪽을 보고
      // 터미널은 다른 쪽에 붙는다.
      return /["']herdr\.sock["']/.test(src)
        || /session["']?\s*,\s*["']attach["']\s*,\s*["']default["']/.test(src)
        || /\[\s*["']session["']\s*,\s*["']attach["']\s*,\s*["']default["']\s*\]/.test(src);
    });
    if (offenders.length) throw new Error(`herdr 세션을 따로 정하는 자리: ${offenders.join(", ")}`);
    // 두 소비자가 실제로 그 한 곳에서 값을 받아 쓰는가.
    if (!/herdrSession\(\)\.socket/.test(read("server/herdr.js"))) throw new Error("herdr.js 가 소켓을 안 받아 쓴다");
    if (!/herdrSession\(\)\.name/.test(read("server/pty.js"))) throw new Error("pty.js 가 세션 이름을 안 받아 쓴다");
    return true;
  });


  // ── 개발 환경을 자유롭게 써도 되는 상태로 ───────────────────────────────────
  // 쿠키·로그인 세션이 분리돼 있던 것은 지금까지 우연이었다. 설치본은 productName 이 Iris 라
  // Application Support/Iris 를 쓰고, 개발은 npx electron 이라 Application Support/Electron 을
  // 썼을 뿐이다. 실행 방법이 바뀌면 둘이 같은 폴더를 쓰게 되고, 그때 잃는 것은 탭이 아니라
  // 로그인 전체다. 상태 폴더에 연결해 그 조합이 만들어지지 않게 한다.
  check("쿠키 폴더도 상태 폴더에 매달린다 — 개발과 설치본이 같은 자리를 쓸 수 없다", () => {
    const { pinUserDataHome, userDataHomeFor } = require_("../native/electron/user-data-home.cjs");
    const home = homedir(), base = path.join(home, "Library/Application Support");
    if (userDataHomeFor(path.join(home, ".iris"), base) !== path.join(base, "Iris")) throw new Error("설치본 자리가 옮겨졌다");
    if (userDataHomeFor(path.join(home, ".iris-dev"), base) !== path.join(base, "Iris-dev")) throw new Error("개발 자리가 다르다");
    const installed = userDataHomeFor(path.join(home, ".iris"), base);
    for (const dir of [path.join(home, ".iris-dev"), "/private/tmp/iris-smoke", "/x/y/.."]) {
      if (userDataHomeFor(dir, base) === installed) throw new Error(`${dir} 가 설치본 쿠키 폴더를 쓴다`);
    }
    // 설치본에서는 아무것도 옮기지 않는다. 여기서 한 글자만 달라져도 로그인이 사라진 것처럼 보인다.
    const calls = [];
    const fakeApp = {
      getPath: () => path.join(base, "Iris"),
      setPath: (key, value) => calls.push([key, value]),
    };
    if (pinUserDataHome(fakeApp, path.join(home, ".iris")) !== null || calls.length) throw new Error("설치본 자리를 옮겼다");
    const moved = pinUserDataHome(fakeApp, path.join(home, ".iris-dev"));
    if (moved !== path.join(base, "Iris-dev")) throw new Error("개발 자리를 안 옮겼다");
    if (calls.length !== 1 || calls[0][0] !== "userData") throw new Error("setPath 를 userData 로 안 불렀다");
    return true;
  });

  await checkAsync("개발 씨앗은 원본을 건드리지 않고, 살아 있는 서버 위에 덮지 않는다", async () => {
    const seed = await import(new URL("../../dev-seed.mjs", import.meta.url).href);
    const home = homedir();
    const installed = path.join(home, ".iris");

    // 복사할 것과 두고 갈 것을 나눈다. 자물쇠·로그·Chromium 자물쇠는 두고 가고, 비밀과 쿠키는 복사한다
    // (사용자가 알고 선택한 것이다. 여기서 임의로 제외하면 로그인 재현이 되지 않는다).
    for (const skip of ["server.lock", "server.log", "a.tmp", "SingletonLock", "SingletonCookie", ".DS_Store"])
      if (!seed.shouldSkip(skip)) throw new Error(`${skip} 를 베낀다`);
    for (const keep of ["creds.enc", "ui-state.json", "Partitions/acbrowser/Cookies", "recordings/x.webm"])
      if (seed.shouldSkip(keep)) throw new Error(`${keep} 를 두고 간다`);

    // 되돌릴 수 없는 대상은 중단한다.
    const ok = seed.seedPlan(path.join(home, ".iris-dev"));
    if (seed.guardPlan(ok).length) throw new Error("멀쩡한 대상을 막았다");
    if (ok.length !== 2) throw new Error("상태와 쿠키 두 벌이 아니다");
    for (const bad of [installed, path.join(installed, "inner"), "/", home, path.dirname(installed)]) {
      const problems = seed.guardPlan(seed.seedPlan(bad));
      if (!problems.length) throw new Error(`${bad} 를 대상으로 통과시켰다`);
    }

    // 대상을 점유한 서버가 살아 있으면 복사하지 않는다. 그 서버가 다음 저장에서 덮어쓴다.
    // pid 는 재사용되므로 번호가 있다는 것만으로는 부족하고 그 번호가 서버여야 한다.
    if (seed.holderOf("/nowhere", { readPid: () => 4242, isServerPid: () => true }) !== 4242) throw new Error("산 서버를 못 봤다");
    if (seed.holderOf("/nowhere", { readPid: () => 4242, isServerPid: () => false }) !== 0) throw new Error("죽은 자물쇠를 산 것으로 봤다");
    if (seed.holderOf("/nowhere", { readPid: () => 0, isServerPid: () => true }) !== 0) throw new Error("자물쇠가 없는데 산 것으로 봤다");
    return true;
  });
}
