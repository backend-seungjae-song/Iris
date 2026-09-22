// 소유 범위: 설치본이 담는 서버 소스·화면과 node-pty spawn-helper 경로 패치.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이고,
//   분리하면서 검사 본문을 바꾸지 않았고, 인구조사 해시가 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/packaging.mjs
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
  console.log("[꾸리기 — 설치본이 무엇을 담는가]");
  {
    const pkg = JSON.parse(read("package.json"));
    check("설치본은 서버 소스와 화면을 함께 담는다", () => {
      const pkg = JSON.parse(read("package.json"));
      const files = pkg.build.files.join(" ");
      const unpack = (pkg.build.asarUnpack || []).join(" ");
      // asar 안의 파일은 자식 프로세스가 열 수 없다. server·web·node_modules가 함께 밖으로
      // 나와야 하며, 하나만 asar에 남으면 그 require에서 MODULE_NOT_FOUND로 서버가 뜨지 않는다.
      // 확인 결과: jszip만 밖으로 나가고 setimmediate는 asar에 남아 기동에 실패했다.
      return /server\/\*\*/.test(files) && /web\/\*\*/.test(files)
        && /server\/\*\*/.test(unpack) && /web\/\*\*/.test(unpack) && /node_modules\/\*\*/.test(unpack)
        && !pkg.build.files.some((f) => /^!node_modules\/node-pty/.test(f));
    });

    // 설치본에서 터미널 전체가 동작하지 않던 지점이다(채팅이 검은 화면만 나오고 `[오류]
    // posix_spawnp failed.`). node-pty는 helperPath에 무조건 `app.asar`→`app.asar.unpacked`
    // 치환을 걸지만, 이 앱은 node_modules 전체를 unpack하므로 경로가 이미 unpacked다.
    // 그 결과 `app.asar.unpacked.unpacked`라는 없는 경로가 되어 spawn이 ENOENT로 실패했다.
    // 개발에서는 경로에 `app.asar`가 없어 재현되지 않는다. 그래서 글자가 아니라 계산 결과를 본다.
    check("node-pty가 설치본 경로에서 spawn-helper를 제대로 찾는다", () => {
      const src = readFileSync(require_.resolve("node-pty/lib/unixTerminal.js"), "utf8");
      const seg = sliceBetween(src, "var helperPath =", "var DEFAULT_FILE", "node-pty가 설치본 경로에서 spawn-helper를 제대로 찾는다");
      if (!seg) return false;
      const resolveHelper = new Function("native", "path", "__dirname", seg + "\nreturn helperPath;");
      const at = (dir) => resolveHelper({ dir: "../build/Release/" }, path, dir);
      const R = "/Applications/Iris.app/Contents/Resources";
      // 1) 이미 unpack된 경로(설치본). 그대로 두어야 한다
      const unpacked = at(`${R}/app.asar.unpacked/node_modules/node-pty/lib`);
      // 2) asar 안에서 로드된 경우. 치환이 그대로 동작해야 한다(원 기능 보존)
      const inAsar = at(`${R}/app.asar/node_modules/node-pty/lib`);
      return unpacked === `${R}/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`
        && inAsar === `${R}/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`;
    });
    check("node-pty 경로 패치가 선언으로 남아 있다", () => {
      // node_modules는 커밋되지 않으므로, 패치가 유지되는 근거는 이 선언과 patch 파일뿐이다.
      const pkg = JSON.parse(read("package.json"));
      const rel = pkg.pnpm?.patchedDependencies?.["node-pty@1.1.0"];
      return !!rel && existsSync(path.join(ROOT, rel));
    });

    // 서버를 내리는 동안 앱 창이 닫혀도 메인 프로세스가 죽지 않는다(오류창 무한 반복 → 강제 종료).
  }
}
