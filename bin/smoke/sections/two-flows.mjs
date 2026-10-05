// 소유 범위: 개발·설치 갈래의 포트·상태 폴더·스크립트·문서, 그리고 앱을 만드는 순서.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 개발 명령의 실제 환경값을 검사하고 문서의 개발·설치 칸을 각각 대조한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/two-flows.mjs
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
import { devCommand } from "../../../scripts/run-dev.mjs";

const pathJoinTmp = () => path.join(tmpdir(), "iris-server-host-probe");

export function developmentCommands(scripts, { command = devCommand, home = homedir() } = {}) {
  const modes = { dev: "server", "dev:app": "app", app: "app", "dev:seed": "seed" };
  const commands = [];
  for (const platform of ["darwin", "win32"]) for (const [name, mode] of Object.entries(modes)) {
    const declared = /^node\s+scripts\/run-dev\.mjs\s+(server|app|seed)$/.exec(scripts[name] || "");
    if (declared?.[1] !== mode) throw new Error(`${name}: 개발 실행기 연결이 다릅니다`);
    const env = command(mode, { platform, home, electronPath: path.join(home, "electron"),
      env: { IRIS_PORT: "4271", PORT: "4271", IRIS_STATE_DIR: path.join(home, ".iris"), ELECTRON_RUN_AS_NODE: "1" } }).env;
    if (env.IRIS_STATE_DIR !== path.join(home, ".iris-dev")) throw new Error(`${platform} ${name}: 개발 상태 폴더가 다릅니다`);
    const expectedPort = mode === "seed" && platform === "darwin" ? "4271" : "4291";
    if (env.IRIS_PORT !== expectedPort) throw new Error(`${platform} ${name}: 개발 포트가 다릅니다`);
    if (mode === "server" && env.PORT !== "4291") throw new Error(`${platform} ${name}: 서버 포트가 다릅니다`);
    if (mode === "app" && (platform === "win32" ? env.ELECTRON_RUN_AS_NODE !== undefined : env.ELECTRON_RUN_AS_NODE !== "1")) {
      throw new Error(`${platform} ${name}: 앱 실행 환경이 다릅니다`);
    }
    commands.push({ platform, name, mode, env });
  }
  return commands;
}

export function documentMatchesEnvironment(doc, { devPort, devState, appPort, appState }) {
  const cells = (label) => {
    const row = doc.split("\n").find((line) => line.startsWith(`| ${label} `));
    if (!row) cannotMeasure(`문서에서 ${label} 표 행을 찾지 못했습니다`);
    return row.split("|").slice(2, 4).map((cell) => cell.trim().replaceAll("`", ""));
  };
  const ports = cells("포트"), states = cells("상태·증거");
  if (ports[0] !== String(devPort) || ports[1] !== String(appPort)) throw new Error("문서의 개발·설치 포트가 코드와 다릅니다");
  if (states[0] !== `~/${devState}/` || states[1] !== `~/${appState}/`) throw new Error("문서의 개발·설치 상태 폴더가 코드와 다릅니다");
  return true;
}

export default async function run() {
  console.log("[두 갈래 — 개발과 설치본은 서로를 건드리지 않는다]");
  {
    const pkg = JSON.parse(read("package.json"));
    check("개발 스크립트가 설치된 앱의 포트·폴더에 닿지 않는다", () => developmentCommands(pkg.scripts).length === 8);
    check("소스를 앱으로 만드는 길이 한 줄로 있다", () =>
      /install:app/.test(JSON.stringify(pkg.scripts))
      && existsSync(path.join(ROOT, "scripts/install-app.sh")));
    check("두 갈래가 문서로 남아 있다", () =>
      existsSync(path.join(ROOT, "docs/two-flows.md")));

    // 파일이 있다는 것만으로는 부족하다. 이 문서는 "무엇이 어느 포트·어느 폴더로 도는가"를
    // 정하는 정본이고, 사용자는 그 표를 보고 개발 환경에 연결한다. 표가 코드와 달라지면 사용자가 설치
    // 앱의 포트에 연결해 자기 탭·계정을 개발 회차로 덮어쓴다. 이 문서가 막으려는 사고다.
    // 그래서 값은 문서에서 읽지 않고 코드에서 떼어 와서 문서가 그것을 담고 있는지 본다.
    check("두 갈래 문서가 대는 포트·상태 폴더가 코드와 같다", () => {
      const doc = read("docs/two-flows.md");
      const one = (re, src, what) => {
        const m = re.exec(src);
        if (!m) cannotMeasure(`${what} 를 코드에서 못 떼었다 — 세는 방식이 깨졌다`);
        return m[1];
      };
      const dev = developmentCommands(pkg.scripts).find((item) => item.name === "dev");
      const devPort = dev.env.IRIS_PORT;
      const devState = path.basename(dev.env.IRIS_STATE_DIR);
      const appPort = one(/const DEFAULT_PORT = (\d+);/, read("server/env.cjs"), "기본 포트");
      const appState = one(/const DIR_NAME = "([^"]+)";/, read("server/state-home.cjs"), "기본 상태 폴더");
      return documentMatchesEnvironment(doc, { devPort, devState, appPort, appState });
    });

    // 문서가 "이렇게 찍힌다"고 보여주는 줄은 실제로 찍히는 줄이어야 한다. 사람은 그 문구로
    // 로그를 검색한다. 문구가 바뀌면 찾지 못해 연결 실패로 판단한다.
    check("두 갈래 문서가 보여주는 로그 문구가 실제 문구다", () => {
      const doc = read("docs/two-flows.md");
      const rt = read("server/browser-runtime.js");
      const bad = [];
      for (const line of doc.split("\n")) {
        const m = /^\[cdp\] ([^—]+—)/.exec(line.trim());
        if (!m) continue;
        const head = `[cdp] ${m[1]}`.trim();
        if (!rt.includes(head)) bad.push(head);
      }
      if (!bad.length && !/\[cdp\]/.test(doc)) cannotMeasure("문서에서 로그 줄을 못 찾았다 — 세는 방식이 깨졌다");
      if (bad.length) throw new Error(`코드에 없는 문구: ${bad.join(" / ")}`);
      return true;
    });
    // 문서는 찾아 읽어야 보이고, CLAUDE.md는 이 저장소에서 일하면 그냥 읽힌다. 두 규칙(다운타임
    // 최소·환경 분리)은 모르고 어기면 사용자 데이터가 지워지므로 자동으로 읽히는 위치에 둔다.
    check("두 규칙이 자동으로 읽히는 자리에 있다", () => {
      const p = path.join(ROOT, "CLAUDE.md");
      if (!existsSync(p)) return false;
      const c = read("CLAUDE.md");
      return /중단 시간 최소화/.test(c) && /개발 환경과 설치 앱의 분리/.test(c)
        && /IRIS_STATE_DIR/.test(c) && /launchctl bootout/.test(c);
    });

    // 설치된 앱은 사용자가 현재 쓰는 도구다. 개발 편의로 오래 중단하지 않는다.
    // 아래 넷은 중단 시간을 실제로 줄이므로 문장이 아니라 검사로 강제한다.
    const inst = read("scripts/install-app.sh");
    check("빌드를 먼저 끝내고 그 다음에 끈다", () => {
      const build = inst.indexOf("electron-builder");
      const quit = inst.indexOf("to quit");
      return build > 0 && quit > 0 && build < quit;   // 끄고 나서 빌드하면 빌드 내내 꺼져 있다
    });
    check("빌드가 실패하면 앱을 끄지도 않는다", () => {
      const guard = inst.indexOf('[ -d "$BUILT" ]');
      return guard > 0 && guard < inst.indexOf("to quit");
    });
    check("교체가 중간에 죽어도 되돌릴 앱이 남는다", () =>
      // 옛 앱을 먼저 지우면 복사 중 실패했을 때 /Applications에 반쪽만 남아 아무것도 실행할 수 없다.
      /mv "\$APP" "\$OLD"/.test(inst) && /mv "\$OLD" "\$APP"/.test(inst)
      && !/rm -rf "\$APP"\n\s*ditto/.test(inst));
    check("뜨는 것은 고정 시간이 아니라 조건으로 기다린다", () =>
      !/^\s*sleep 5\s*$/m.test(inst)
      && /^running\(\) \{\n(?:.*\n)*?\s*procs=\$\(pgrep -fl "\$APP\/Contents\/MacOS\/Iris" \|\| true\)\n(?:.*\n)*?.*grep -v "\/server\/remote\/channel\/iris-channel\.mjs"(?:.*\n)*?\}$/m.test(inst)
      && /for _ in \$\(seq 1 10\); do running && break; sleep 1; done/.test(inst));

    // 상태 폴더의 소유자는 하나다. 포트가 겹쳐도 바인딩이 항상 충돌하지는 않아(0.0.0.0 vs 127.0.0.1)
    // 서버 둘이 같은 파일을 서로 덮어쓴다(확인 결과: 계정·검색 기록·탭 유실).
  }
}
