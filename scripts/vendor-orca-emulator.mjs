#!/usr/bin/env node
// Orca(stablyai/orca, MIT)의 모바일 에뮬레이터 구현을 고정 커밋에서 그대로 번들로 만든다.
//
// Orca 는 npm 패키지가 아니라서 의존성으로 받을 수 없다. 손으로 옮겨 적으면 어느 커밋의 어떤 줄인지
// 대조할 수 없으므로, 소스를 바꾸지 않고 esbuild 로 번들만 한다. Orca 가 바뀌면 커밋을 바꿔 다시 실행한다.
// 번들은 `electron` 을 electron-guard.cjs 로 바꿔 연결한다. Orca 의 ipcMain.handle 에는 발신자
// 검사가 없어서, Orca 코드를 고치지 않고 Iris 의 isTrustedSender 를 앞에 두려면 이 자리밖에 없다.
//
// 실행: node scripts/vendor-orca-emulator.mjs --orca ~/Projects/External/orca --commit 841d06a96
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_MAIN = path.join(ROOT, "native", "electron", "emulator", "orca-emulator.cjs");
const OUT_RENDERER = path.join(ROOT, "web", "vendor", "orca-emulator-pane.esm.js");
const OUT_RENDERER_NOTICE = path.join(ROOT, "web", "vendor", "orca-emulator-pane.NOTICE.md");
const esbuild = createRequire(import.meta.url)("esbuild");

// 렌더러 번들에 넣는 파일. React·Zustand·i18n·'@/' 앱 전용 alias 를 import 하지 않는 순수 로직만
// 고른다(직접 열어서 확인함, docs/renderer-port.md rev5 대응표 참고). emulator-pane-types.ts 는
// Task 의 14개 후보 목록에는 없지만, 그 후보들이 값(deviceLabel 등)을 가져오는 공용 의존 파일이라
// 함께 넣지 않으면 그 값들이 죽은 참조가 된다.
const RENDERER_ENTRIES = [
  [
    "src/renderer/src/components/emulator-pane/emulator-pane-types.ts",
    ["deviceLabel", "simulatorPreviewStreamUrl", "pickDefaultDevice"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-attach-target.ts",
    ["resolveEmulatorAttachTarget"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-device-frame-layout.ts",
    ["resolveDeviceFrameKind", "resolveVisualStreamGeometry", "fitDeviceFrameToPane"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-device-row-mapping.ts",
    ["toSimulatorDeviceRows"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-device-state.ts",
    ["markSimulatorDeviceBooted", "markSimulatorDeviceShutdown"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-keyboard-paste.ts",
    ["pasteTextIntoEmulatorKeyboard"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-pane-error-message.ts",
    ["emulatorPaneErrorMessage"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-pane-session-view.ts",
    ["buildEmulatorPaneSessionView"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-prelaunched-session.ts",
    ["buildPrelaunchedEmulatorSessionState"],
  ],
  [
    "src/renderer/src/components/emulator-pane/emulator-screen-gesture.ts",
    [
      "clampEmulatorScreenPoint",
      "resolveEmulatorHomeIndicatorEdge",
      "buildEmulatorGesturePoint",
      "mapClientPointToSimulatorScreen",
      "resolveEmulatorPointerAction",
      "resolveEmulatorWheelDelta",
      "buildWheelGesturePoints",
    ],
  ],
  ["src/shared/emulator-touch-frame.ts", ["encodeServeSimTouchFrame"]],
  [
    "src/shared/emulator-keyboard-frame.ts",
    ["encodeServeSimKeyboardFrame", "buildServeSimKeyboardFramesForKey"],
  ],
];

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`${name} 가 필요합니다`);
  return process.argv[i + 1];
};
const orca = path.resolve(arg("--orca").replace(/^~(?=\/)/, process.env.HOME));
const commit = execFileSync("git", ["-C", orca, "rev-parse", arg("--commit")], { encoding: "utf8" }).trim();

const work = mkdtempSync(path.join(tmpdir(), "orca-emulator-"));
try {
  const tarFile = path.join(work, "src.tar");
  execFileSync("git", ["-C", orca, "archive", "-o", tarFile, commit, "src", "LICENSE"]);
  execFileSync("tar", ["-xf", tarFile, "-C", work]);

  const entry = path.join(work, "iris-main-entry.ts");
  writeFileSync(entry, [
    "export { EmulatorBridge } from './src/main/emulator/emulator-bridge'",
    "export { RuntimeEmulatorCommands } from './src/main/runtime/orca-runtime-emulator'",
    "export { EMULATOR_METHODS } from './src/main/runtime/rpc/methods/emulator'",
    "export { registerEmulatorFrameStreamHandlers } from './src/main/ipc/emulator-frame-stream'",
    "export { registerEmulatorVideoStreamHandlers } from './src/main/ipc/emulator-video-stream'",
    "",
  ].join("\n"));

  const license = readFileSync(path.join(work, "LICENSE"), "utf8").trim();
  const banner = [
    `// 생성 파일. 직접 고치지 않는다. scripts/vendor-orca-emulator.mjs 로 다시 만든다.`,
    `// 원본: https://github.com/stablyai/orca @ ${commit}`,
    ...license.split("\n").map((l) => `// ${l}`.trimEnd()),
  ].join("\n");

  mkdirSync(path.dirname(OUT_MAIN), { recursive: true });
  await esbuild.build({
    entryPoints: [entry], absWorkingDir: work, outfile: OUT_MAIN,
    bundle: true, platform: "node", format: "cjs", target: "node22",
    // zod·ws 는 Iris 의존성(Orca 잠금 파일과 같은 버전)을 쓴다. zod 를 넣으면 번들의 80%가 zod 가 된다.
    external: ["ws", "zod"], keepNames: true, legalComments: "inline", logLevel: "warning",
    banner: { js: banner },
    plugins: [{
      name: "electron-guard",
      setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: "./electron-guard.cjs", external: true })); },
    }],
  });
  // serve-sim 0.1.40 은 Xcode 의 Developer/Library 만 찾는다. Xcode 27 의
  // Contents/SharedFrameworks 경로를 자식 프로세스 환경에 전달한다.
  let mainSource = readFileSync(OUT_MAIN, "utf8");
  const simulatorOpen = 'if [ "$has_simulator_target" = "1" ]; then\n  /usr/bin/open -gj -a Simulator 2>/dev/null || /usr/bin/open "$@"\n  exit 0';
  if (!mainSource.includes(simulatorOpen)) {
    throw new Error("Orca 의 Simulator 실행 처리 코드가 변경되었습니다");
  }
  mainSource = mainSource.replace(simulatorOpen,
    'if [ "$has_simulator_target" = "1" ]; then\n  exit 0');
  const envFunction = /function getServeSimEnv\(executable\) \{[\s\S]*?\n\}\n__name\(getServeSimEnv, "getServeSimEnv"\);/;
  const match = mainSource.match(envFunction);
  if (!match || !match[0].includes("  return env;")) {
    throw new Error("Orca 의 serve-sim 실행 환경 함수가 변경되었습니다");
  }
  mainSource = mainSource.replace(envFunction,
    match[0].replace("  return env;", '  return require("./serve-sim-framework-env.cjs").withSimulatorFrameworkPath(env);'));
  mainSource = mainSource.replace("var MAC_OPEN_SHIM = `#!/bin/sh", [
    "// Why(Iris): serve-sim 은 부팅 뒤 `open -ga Simulator` 를 부르고 실패는 무시한다. 화면 전송은",
    "// Simulator.app 없이 된다. Orca 는 숨겨서 띄웠지만 사용자에게는 별도 시뮬레이터가 켜진 것으로 보이고,",
    "// 그 앱을 종료하면 기기도 함께 꺼진다. 그래서 Simulator 를 여는 요청은 아무것도 하지 않는다.",
    "var MAC_OPEN_SHIM = `#!/bin/sh",
  ].join("\n"));
  writeFileSync(OUT_MAIN, mainSource);
  console.log(`  ${path.relative(ROOT, OUT_MAIN)} ← orca@${commit.slice(0, 9)}`);

  // 렌더러 번들: React 없는 순수 로직만. 대상 파일을 열어 React·store·i18n import 가 없는지
  // 확인한 뒤 고른 목록이 RENDERER_ENTRIES 다(스크립트 상단 주석 참고).
  const rendererEntry = path.join(work, "iris-renderer-entry.ts");
  writeFileSync(
    rendererEntry,
    RENDERER_ENTRIES.map(([file, names]) => `export { ${names.join(", ")} } from './${file.replace(/\.ts$/, "")}'`)
      .join("\n") + "\n"
  );

  const rendererBanner = [
    `// 생성 파일. 직접 고치지 않는다. scripts/vendor-orca-emulator.mjs 로 다시 만든다.`,
    `// 원본: https://github.com/stablyai/orca @ ${commit} (렌더러, React 없는 순수 로직만)`,
    ...license.split("\n").map((l) => `// ${l}`.trimEnd()),
  ].join("\n");

  mkdirSync(path.dirname(OUT_RENDERER), { recursive: true });
  await esbuild.build({
    entryPoints: [rendererEntry], absWorkingDir: work, outfile: OUT_RENDERER,
    bundle: true, platform: "browser", format: "esm", target: "es2022",
    keepNames: true, legalComments: "inline", logLevel: "warning",
    banner: { js: rendererBanner },
  });
  console.log(`  ${path.relative(ROOT, OUT_RENDERER)} ← orca@${commit.slice(0, 9)}`);

  writeFileSync(
    OUT_RENDERER_NOTICE,
    [
      "# orca-emulator-pane vendor notice",
      "",
      `\`orca-emulator-pane.esm.js\` 는 [stablyai/orca](https://github.com/stablyai/orca) 커밋` +
        ` \`${commit}\` 에서 React·Zustand·i18n 을 import 하지 않는 순수 로직 파일만 골라` +
        ` \`scripts/vendor-orca-emulator.mjs\` 로 esbuild 번들한 것이다. 직접 고치지 않는다.`,
      "",
      "## 포함 원본 파일",
      "",
      ...RENDERER_ENTRIES.map(([file]) => `- \`${file}\``),
      "",
      "## 라이선스 (MIT, 원문)",
      "",
      "```",
      license,
      "```",
      "",
    ].join("\n")
  );
  console.log(`  ${path.relative(ROOT, OUT_RENDERER_NOTICE)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
