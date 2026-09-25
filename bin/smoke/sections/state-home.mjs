// 소유 범위: server/state-home.cjs 와 그것을 부르는 모든 자리, 그리고 사람이 타이핑하는 환경변수 이름.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이고,
//   분리하면서 검사 본문을 바꾸지 않았고, 인구조사 해시로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/state-home.mjs
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  cannotMeasure, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  browserRuntime, browserWindowManagerSource, cdpTransportSource, main, mainWindowSource,
  memoWindowManagerSource, nativeAx, pick, record, web, webview,
} from "../sources.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

const pathJoinTmp = () => path.join(tmpdir(), "iris-server-host-probe");

// 이 절의 세 검사는 추적 파일 전부를 훑어 위반 위치를 찾는다. 그 목록이 비면 검사 대상이
// 없어 전부 통과하므로, 아무것도 검사하지 않으면서 통과하는 상태가 된다.
//
// 확인 결과: 공개본을 낸 폴더에서 `git init` 만 하고 `git add` 를 하지 않은 채 검사를 돌리면
// 「상태 경로를 손으로 다시 짜는 파일이 없다」가 파일 0개로 통과한다. zip 으로 받은
// 트리에서도 같은 일이 생긴다. 그래서 목록을 한 곳에서 만들고 그 곳에 최소 개수를 둔다.
function tracked() {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  if (files.length < 50) cannotMeasure(`git 이 아는 파일이 ${files.length}개뿐 — 이 목록으로는 아무것도 못 지킨다`);
  return files;
}

export default async function run() {
  console.log("[상태 폴더 — 정하는 자리가 하나인가]");
  {
    const srvF = read("server/index.js");
    const mainF = read("native/electron/main.cjs");
    const cdpF = read("native/electron/cdp-control.cjs");
    check("사람이 타이핑하는 환경변수 이름을 손으로 다시 짜지 않는다", () => {
      // 이름을 읽는 위치가 흩어지면 그중 하나가 빠지고, 설정이 적용되지 않는다.
      // 상태 폴더 경로에서 실제로 그렇게 누락됐다(확인 결과). 이름을 AC_* 에서
      // IRIS_* 로 옮길 때도 흩어진 위치가 있었다면 그만큼 빠졌을 것이다.
      const files = tracked();
      const hand = files.filter((f) => {
        if (f === "server/env.cjs" || !/\.(js|mjs|cjs)$/.test(f)) return false;
        if (f.startsWith("test/") || f === "bin/smoke.mjs" || f.startsWith("bin/smoke/")) return false; // 검사는 값을 심어야 한다
        let text; try { text = read(f); } catch { return false; }
        return /process\.env\.(IRIS_(STATE_DIR|PORT|ALLOWED_ORIGIN_HOSTS)|REMOTE|HOST)\b/.test(text);
      });
      if (hand.length) console.log("       손으로 짠 자리: " + hand.join(", "));
      return hand.length === 0;
    });

    check("상태 폴더를 정하는 자리가 하나다", () => {
      const home = read("server/state-home.cjs");
      return /function stateHome\(\)/.test(home)
        && /stateDirOverride\(\)/.test(home)
        && /"\.iris"/.test(home)
        && /const IRIS_HOME = stateHome\(\);/.test(srvF)
        && /stateHome\(\)/.test(mainF)
        // cdp-control 은 상태 폴더가 아니라 그 안의 산출물 위치를 쓴다. 정본은 artifacts-home.cjs 이고,
        // 그 파일이 다시 state-home.cjs 에서 값을 받는다. 이 연결이 끊기면 여기서 실패한다.
        && /artifacts-home\.cjs/.test(cdpF)
        && /state-home\.cjs/.test(read("server/artifacts-home.cjs"));
    });
    check("풀리지 않은 ~·$HOME을 상태 폴더로 쓰지 않는다", () => {
      // 셸을 거치지 않고 전달된 `$HOME/.iris-dev`는 글자 그대로 남는다. 그대로 폴더를 만들면
      // 앱은 탭도 계정도 없는 빈 화면으로 뜨고, 사용자에게는 데이터가 사라진 것으로 보인다
      // (확인 결과: 설치된 앱이 그 문자열을 그대로 사용해 실행됐다).
      const home = new URL("../../../server/state-home.cjs", import.meta.url).pathname;
      const out = execFileSync(process.execPath, ["-e", `
        const { stateHome } = require(${JSON.stringify(home)});
        const os = require("node:os");
        const want = os.homedir() + "/.iris-dev";
        const got = [];
        for (const v of ["$HOME/.iris-dev", "~/.iris-dev"]) { process.env.IRIS_STATE_DIR = v; got.push(stateHome() === want); }
        process.env.IRIS_STATE_DIR = "relative/x";
        let rejected = false;
        try { stateHome(); } catch { rejected = true; }
        console.log(JSON.stringify({ got, rejected }));
      `], { encoding: "utf8" });
      const r = JSON.parse(out);
      return r.got.every(Boolean) && r.rejected;
    });
    check("설치된 앱은 개발 셸의 설정을 물려받지 않는다", () => {
      // `open`은 현재 셸의 환경을 앱에 그대로 넘긴다. pnpm 안에서 이 경로를 실행하면 설치된 앱이
      // 개발 포트·개발 상태 폴더로 실행된다. 실제로 전달된 REMOTE=1 때문에 설치된 앱이
      // 0.0.0.0에 바인딩됐다(확인 결과, 수정 후 127.0.0.1로 복구).
      // 앱을 여는 줄과 새 앱의 서버 준비를 보는 줄은 모두 installed_env 를 거친다. 준비 확인이 개발
      // 포트·상태 폴더를 보면 개발 서버를 설치 앱의 서버로 여긴다.
      const sh = read("scripts/install-app.sh");
      const fn = sh.match(/^installed_env\(\) \{ env((?:\s+-u\s+\w+)+) "\$@"; \}$/m);
      if (!fn || !["IRIS_STATE_DIR", "IRIS_PORT", "PORT", "REMOTE", "HOST"].every((v) => fn[1].includes("-u " + v))) return false;
      const opens = sh.split("\n").filter((line) => !/^\s*#/.test(line) && /\bopen -a\b/.test(line));
      return opens.length > 0 && opens.every((line) => /\binstalled_env open -a\b/.test(line))
        && /installed_env node scripts\/wait-installed-server\.cjs/.test(sh);
    });
    check("상태 경로를 손으로 다시 짜는 파일이 없다", () => {
      // 검사할 파일 목록을 직접 관리하면 목록에 없는 파일이 빠진다. browser-state.js·
      // space-key.js 가 경로를 직접 지정했고, 개발 서버가 설치 앱의 폴더를 그대로 썼다
      // (확인 결과: 그 결과로 계정·검색 기록·탭이 유실됐다). 이제 추적 파일 전부를 검사하므로
      // 새로 생긴 파일도 대상이 되고, 목록 갱신을 잊어 검사가 우회되지 않는다.
      const files = tracked();
      const hand = files.filter((f) => {
        if (f === "server/state-home.cjs" || !/\.(js|mjs|cjs)$/.test(f)) return false;
        let text; try { text = read(f); } catch { return false; }
        return /homedir\(\)\s*,\s*"\.iris"/.test(text);
      });
      if (hand.length) console.log("       손으로 짠 자리: " + hand.join(", "));
      return hand.length === 0;
    });
    check("stateHome을 부르는 파일은 모두 정본에서 받아 온다", () => {
      // 파일 14개를 직접 나열하면 모듈을 분리하는 순간 목록이 오래되고, 새로 생긴
      // 상태 소비자는 목록에 없어 검사 대상에서 빠진다. 직접 나열하는 검사는 이렇게 무효가 된다.
      // 그래서 호출자 전부를 코드에서 추출하고, 각자 정본에서 값을 받는지만 검사한다.
      // "상태를 쓰면서 아예 안 부르는 파일"은 바로 위 검사(경로를 손으로 다시 짜는 파일)가 맡는다.
      const files = tracked();
      const callers = [], bad = [];
      for (const f of files) {
        if (f === "server/state-home.cjs" || !/\.(js|mjs|cjs)$/.test(f)) continue;
        let text; try { text = read(f); } catch { continue; }
        if (!/\bstateHome\(\)/.test(text)) continue;
        callers.push(f);
        if (!/state-home\.cjs/.test(text)) bad.push(f);
      }
      if (bad.length) throw new Error(`stateHome을 부르면서 정본을 안 받아 옴: ${bad.join(", ")}`);
      if (callers.length < 10) cannotMeasure(`부르는 파일이 ${callers.length}개뿐 — 뽑는 방식을 확인하라`);
      return true;
    });
    // 실행 파일 경로도 상태 폴더와 같은 규칙이다. 특정 사용자의 홈 경로를 고정하면 그 기기 밖에서는
    // 그 기능이 동작하지 않는다. herdr 터미널에서 실제로 발생했다(server/pty.js 의 /Users/<이름>/.local/bin).
    check("실행 파일 자리를 사람 홈에 박지 않는다", () => {
      const ptyF = read("server/pty.js");
      return !/\/Users\/[a-z]/i.test(ptyF)
        && /process\.env\.HERDR_BIN/.test(ptyF)
        && /process\.env\.PATH/.test(ptyF);
    });
    check("지정한 herdr가 없으면 PATH에서 실제로 찾는다", () => {
      // 탐색이 실제로 동작하는지 확인한다. 상수를 지운 자리에 찾지 못하는 함수가 들어오면 터미널이 동작하지 않는다.
      const bin = execFileSync(process.execPath, ["-e",
        'import("./server/pty.js").then((m) => console.log(m.findHerdrBin()))'],
        { cwd: ROOT, encoding: "utf8" }).trim();
      return bin.endsWith("/herdr") && existsSync(bin);
    });
  }
}
