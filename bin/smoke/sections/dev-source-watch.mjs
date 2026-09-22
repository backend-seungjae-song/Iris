// 소유 범위: native/electron/dev-source-watch.cjs 의 변경 감지 트리거, 반영 시각 기록, 반영이 늦으면 알리는 출력.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이며,
//   분리 과정에서 검사 본문을 수정하지 않았다. 인구조사 해시가 이를 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 확인한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/dev-source-watch.mjs
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
  console.log("[서버 소스 감시 — 개발 갈래의 T2 재적재]");
  // ── 서버 소스 감시 (개발 환경 전용) ─────────────────────────────────────────
  // "매번 전체가 껐다 켜지는가"의 T2 층. 부품(자식 재기동·backoff·WS 재연결)은 이미 모두 있었고
  // 없던 것은 변경 감지 트리거 하나였다. 트리거만 만들면 이 저장소가 반복한 실패 형태가 된다.
  // 생성하는 코드는 있는데 호출하는 곳이 없어 아무 동작도 하지 않는 상태다. 그래서 셋을 함께 확인한다:
  // 트리거 · 반영 시각 기록 · 그 시각이 오래되면 알리는 출력.
  await checkAsync("서버 소스 감시는 개발에서만 서고, 자기 산출물에 반응하지 않는다", async () => {
    const { createDevSourceWatch } = require_("../native/electron/dev-source-watch.cjs");
    const pathMod = require_("node:path");
    const watch = createDevSourceWatch({
      fs: { watch: () => ({ on() {}, close() {}, unref() {} }) },
      path: pathMod, root: "/nowhere", log: () => {}, reload: () => {},
    });
    // 서버가 실제로 읽는 파일만 재기동 대상이다.
    for (const yes of ["index.js", "browser-runtime.js", "env.cjs", "handlers/x.mjs", "data/x.json"])
      if (!watch.shouldReact(yes)) throw new Error(`${yes} 를 무시했다`);
    // 자기 산출물에 반응하면 재기동이 재기동을 유발한다.
    for (const no of ["server.log", "server.lock", "index.js.tmp", ".DS_Store", ".git/HEAD",
                      "node_modules/x/index.js", "README.md", "web/index.html.bak", ""])
      if (watch.shouldReact(no)) throw new Error(`${no} 에 반응했다`);
    return true;
  });

  await checkAsync("몰아치는 저장은 한 번의 재기동으로 묶인다", async () => {
    const { createDevSourceWatch } = require_("../native/electron/dev-source-watch.cjs");
    const pathMod = require_("node:path");
    let handler = null;
    const reloaded = [];
    const watch = createDevSourceWatch({
      fs: { watch: (_dir, _opts, fn) => { handler = fn; return { on() {}, close() {}, unref() {} }; } },
      path: pathMod, root: "/nowhere",
      log: () => {}, reload: (rel) => reloaded.push(rel),
      debounceMs: 5,
    });
    if (!watch.start()) throw new Error("감시를 걸지 못했다");
    if (typeof handler !== "function") throw new Error("변경 콜백을 안 걸었다");
    // 파일 하나를 저장해도 fs.watch 는 여러 번 호출된다. 그때마다 재기동하면 재시도 예산이 소진된다.
    for (let i = 0; i < 8; i++) handler("change", "index.js");
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (reloaded.length !== 1) throw new Error(`여덟 번의 저장이 ${reloaded.length}번의 재기동이 됐다`);
    watch.stop();
    return true;
  });

  await checkAsync("변경을 봤는데 반영이 없으면 화면이 말한다", async () => {
    const { createDevSourceWatch } = require_("../native/electron/dev-source-watch.cjs");
    const pathMod = require_("node:path");
    let handler = null, clock = 1000;
    const said = [];
    const watch = createDevSourceWatch({
      fs: { watch: (_dir, _opts, fn) => { handler = fn; return { on() {}, close() {}, unref() {} }; } },
      path: pathMod, root: "/nowhere",
      log: (line) => said.push(line), reload: () => {},
      now: () => clock, debounceMs: 1, graceMs: 100,
    });
    watch.start();
    said.length = 0;
    watch.tick();
    if (said.length) throw new Error("아무 일도 없는데 말했다");
    handler("change", "index.js");
    clock += 50;
    watch.tick();
    if (said.length) throw new Error("아직 유예 안인데 말했다");
    clock += 100;
    watch.tick();
    if (said.length !== 1) throw new Error("변경이 반영 안 됐는데 말하지 않았다");
    // 같은 내용을 반복해서 알리지 않는다.
    clock += 1000;
    watch.tick();
    if (said.length !== 1) throw new Error("같은 말을 되풀이한다");
    // 반영되면 다시 알리지 않고, 다음 변경부터 새로 집계한다.
    watch.noteReloaded();
    handler("change", "index.js");
    clock += 1000;
    watch.tick();
    if (said.length !== 2) throw new Error("반영 뒤의 새 변경을 다시 세지 않는다");
    // 같은 밀리초에 들어온 저장도 집계해야 한다. 시각으로 비교하면 그 변경이 누락된다.
    watch.noteReloaded();
    handler("change", "index.js");   // 시계를 움직이지 않는다
    clock += 1000;
    watch.tick();
    if (said.length !== 3) throw new Error("반영과 같은 순간의 변경을 놓친다");
    watch.stop();
    return true;
  });

  await checkAsync("설치본에서는 서지 않고, 의도된 재기동은 재시도 예산을 쓰지 않는다", async () => {
    const { ServerHost } = require_("../native/electron/server-host.cjs");
    const make = (isPackaged) => new ServerHost({
      app: { isPackaged }, port: 4999, stateDir: pathJoinTmp(), onLog: () => {},
    });
    // 설치본에서 감시를 걸면 사용자가 쓰는 도구가 저장 한 번에 끊긴다.
    // 소스 루트를 정해 둔다. 그러지 않으면 금지선을 지웠을 때 resolveServerRoot 가 먼저 예외를 던져,
    // 검사는 실패하지만 확인하려던 것과 다른 이유로 실패한다.
    const prevRoot = process.env.IRIS_SERVER_ROOT;
    process.env.IRIS_SERVER_ROOT = tmpdir();
    try {
      if (make(true).watchSource() !== null) throw new Error("설치본에서 감시를 걸었다");
    } finally {
      if (prevRoot === undefined) delete process.env.IRIS_SERVER_ROOT;
      else process.env.IRIS_SERVER_ROOT = prevRoot;
    }
    const prev = process.env.IRIS_DEV_WATCH;
    process.env.IRIS_DEV_WATCH = "0";
    try {
      if (make(false).watchSource() !== null) throw new Error("IRIS_DEV_WATCH=0 인데 감시를 걸었다");
    } finally {
      if (prev === undefined) delete process.env.IRIS_DEV_WATCH; else process.env.IRIS_DEV_WATCH = prev;
    }
    // 재시도 예산은 왜 반복해서 죽는지를 집계하는 것이지 몇 번 재기동했는지를 집계하는 것이 아니다.
    // 예산을 소진하면 다섯 번 저장한 뒤로 서버가 다시 뜨지 않는다.
    const host = make(false);
    host.owned = true;
    host.reloading = true;
    host.child = {};
    host.onChildExit(0, "SIGTERM");
    if (host.restarts.length) throw new Error("의도된 재기동이 예산을 썼다");
    // 죽어서 내려간 것은 그대로 집계한다.
    let spawned = 0;
    host.spawnOnce = () => { spawned++; };
    host.reloading = false;
    host.child = {};
    host.onChildExit(1, null);
    if (host.restarts.length !== 1) throw new Error("진짜 죽음을 예산에서 세지 않는다");
    host.stopping = true;
    return true;
  });


  // ── 개발 채팅은 실제 채팅에 붙지 않는다 ─────────────────────────────────────
  // herdr 는 붙은 클라이언트 크기로 공유 세션의 PTY 를 리플로우한다. 개발 앱이 같은 `default`
  // 세션에 붙으면, 창 크기가 다른 그 순간 사용자가 쓰던 채팅 전체가 흐트러진다.
  // 세션 이름을 사용자가 지정하지 않고 상태 폴더에서 도출하므로, 개발 환경이 실제 채팅에 붙는
  // 조합 자체가 만들어지지 않는다. 그 의존이 실제로 유지되는지 확인한다.
}
