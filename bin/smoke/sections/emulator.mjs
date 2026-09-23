import { check, cannotMeasure, filesUnder, read, WEB_SHUTTLE_EXCLUDES } from "../core.mjs";

// 에뮬레이터 분리 창의 검사.
//
// 소유 범위
//   web/emulator-window 세 파일에 대한 판정. 셔틀 제외와의 일치, 화면 모듈을 그대로 쓰는가,
//   창을 닫을 때 세션을 끄지 않는가.
//
// 설계 이유
//   분리 창은 web 셔틀에서 제외된다(core.mjs 의 WEB_SHUTTLE_EXCLUDES). 제외만 하면 아무도
//   검사하지 않는 영역이 되므로, 제외한 만큼을 이 절에서 검사한다.

export default async function run() {
  console.log("[에뮬레이터] 분리 창");
  const PAGE = "web/emulator-window";
  const pageFiles = filesUnder(PAGE, (rel) => /\.(?:html|js|css|mjs)$/.test(rel));
  if (pageFiles.length < 2) cannotMeasure(`지면 파일을 ${pageFiles.length} 개만 셌다 — 세는 방식이 깨졌다`);

  check("셔틀에서 뺀 분리 창은 이 절이 그대로 받는다", () => {
    const missing = pageFiles.filter((f) => !WEB_SHUTTLE_EXCLUDES.has(f));
    if (missing.length) throw new Error(`셔틀 제외에 없는 지면 파일: ${missing.join(", ")}`);
    const ghost = [...WEB_SHUTTLE_EXCLUDES].filter((f) => f.startsWith(`${PAGE}/`) && !pageFiles.includes(f));
    if (ghost.length) throw new Error(`없는 파일이 제외에 남아 있다: ${ghost.join(", ")}`);
    return true;
  });

  // 창이 자기 화면을 따로 만들면 탭과 창의 동작이 갈린다. 탭이 쓰는 모듈 하나만 가져온다.
  check("분리 창은 탭과 같은 화면 모듈만 가져온다", () => {
    const imports = pageFiles.filter((f) => f.endsWith(".js"))
      .flatMap((f) => [...read(f).matchAll(/\bimport\s*(?:[^"'()]*?from\s*)?\(?\s*["']([^"']+)["']/g)].map((m) => m[1]));
    if (!imports.length) throw new Error("분리 창이 아무 모듈도 가져오지 않는다");
    const other = imports.filter((p) => p !== "/js/emulator/pane.js");
    if (other.length) throw new Error(`화면 모듈 밖을 가져온다: ${other.join(", ")}`);
    return true;
  });

  // 창을 닫는 것은 탭으로 되돌리는 것이다. close() 를 부르면 기기와 헬퍼가 꺼져 탭이 처음부터 다시 켠다.
  check("분리 창을 닫아도 세션을 끄지 않는다", () => {
    const src = read(`${PAGE}/window.js`);
    if (!/addEventListener\(\s*"pagehide"[^\n]*\.dispose\(\)/.test(src)) throw new Error("pagehide 에서 dispose() 를 안 부른다");
    if (/\.close\(\)/.test(src)) throw new Error("close() 를 부른다 — 창을 닫으면 기기가 꺼진다");
    return true;
  });

  // `void a.stop && a.stop()` 은 `(void a.stop) && …` 로 읽혀 오른쪽이 실행되지 않는다. Orca 의 `a.stop?.()` 를
  // 옮기며 이 모양이 되어 화면 스트림을 한 번도 멈추지 않았다(탭을 다시 볼 때마다 연결이 쌓여 화면이 깜빡였다).
  check("에뮬레이터 화면은 스트림 멈춤을 실제로 부른다", () => {
    const files = filesUnder("web/js/emulator", (rel) => rel.endsWith(".js")).concat(pageFiles.filter((f) => f.endsWith(".js")));
    const bad = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/void\s+([A-Za-z_$][\w$.]*)\s*&&\s*\1\s*\(/g)) bad.push(`${f}: ${m[0]}`);
    }
    if (bad.length) throw new Error(`실행되지 않는 호출: ${bad.join(" / ")}`);
    if (!/void host\.stopFrameStream\?\.\(/.test(read("web/js/emulator/pane.js"))) throw new Error("pane.js 가 프레임 스트림을 멈추지 않는다");
    return true;
  });

  // 프레임마다 <img> 를 새로 만들면 새 이미지가 디코딩되기 전까지 화면이 비어 검게 깜빡인다.
  check("에뮬레이터 화면은 프레임마다 같은 이미지 요소의 src 만 바꾼다", () => {
    const src = read("web/js/emulator/pane.js");
    const m = /if \(([^\n]*)\) \{\s*const img = document\.createElement\("img"\)/.exec(src);
    if (!m) throw new Error("pane.js 에서 이미지 요소를 만드는 조건을 못 찾았다");
    if (/frameUrl|\.src\b/.test(m[1])) throw new Error(`프레임이 바뀔 때마다 요소를 새로 만든다: if (${m[1]})`);
    if (!/mediaEl\.src = frameStreamState\.frameUrl/.test(src)) throw new Error("기존 이미지 요소의 src 를 바꾸지 않는다");
    return true;
  });

  // serve-sim 이 부르는 `open -a Simulator` 를 가로채는 셸 스크립트. 여기서 open 을 부르면 Iris 와 별도로
  // Simulator.app 이 켜지고, 그 앱을 끄면 기기도 꺼진다.
  check("iOS 기기를 켤 때 Simulator.app 을 따로 띄우지 않는다", () => {
    const m = /if \[ "\$has_simulator_target" = "1" \]; then\n([\s\S]*?)\nfi/.exec(read("native/electron/emulator/orca-emulator.cjs"));
    if (!m) throw new Error("orca-emulator.cjs 에서 Simulator 요청 분기를 못 찾았다");
    if (/\bopen\b/.test(m[1])) throw new Error(`Simulator 요청 분기가 앱을 연다: ${m[1].trim()}`);
    return true;
  });

  // 스페이스 브라우저의 탭 분리와 같이, 분리한 에뮬레이터는 가운데 탭 띠에 남지 않고 창이 닫히면 되돌아온다.
  const bootBody = (name) => {
    const src = read("web/js/emulator/boot.js");
    const m = new RegExp(`\\n(?:async )?function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(src);
    if (!m) throw new Error(`boot.js 에 ${name} 이 없다`);
    return m[1];
  };

  check("분리한 에뮬레이터 탭은 가운데 탭 띠에서 빠지고 창이 닫히면 되돌아온다", () => {
    if (!/removeTab\(entry\.space, entry\.tab\)/.test(bootBody("takeOutOfStrip"))) throw new Error("takeOutOfStrip 이 탭을 탭 저장소에서 빼지 않는다");
    if (!/list\.splice\([^\n]*entry\.tab\)/.test(bootBody("putBackInStrip"))) throw new Error("putBackInStrip 이 탭을 되돌려 넣지 않는다");
    if (!/takeOutOfStrip\(entry\)/.test(bootBody("detach"))) throw new Error("detach 가 탭을 탭 띠에서 빼지 않는다");
    if (!/putBackInStrip\(entry\)/.test(bootBody("reattach"))) throw new Error("reattach 가 탭을 되돌려 넣지 않는다");
    if (!/if \(entry\.detached\) continue;/.test(bootBody("sweep"))) throw new Error("sweep 이 분리한 탭을 닫힌 탭으로 보고 끈다");
    return true;
  });

  // 세로 열로 보낸 탭도 탭 저장소에 없다. sweep 이 그것을 닫힌 탭으로 보면 기기와 헬퍼를 끈다.
  check("세로 열로 보낸 에뮬레이터 탭은 탭 띠에서 빠지고, 열은 배치 영역으로 등록된다", () => {
    if (!/takeOutOfStrip\(entry\)/.test(bootBody("toColumn"))) throw new Error("toColumn 이 탭을 탭 띠에서 빼지 않는다");
    if (!/putBackInStrip\(entry\)/.test(bootBody("toTab"))) throw new Error("toTab 이 탭을 되돌려 넣지 않는다");
    if (!/if \(entry\.inColumn\) \{[^\n]*continue; \}/.test(bootBody("sweep"))) throw new Error("sweep 이 세로 열의 탭을 닫힌 탭으로 보고 끈다");
    if (!/registerLayoutRegion\(\{ id: "emulator"[^\n]*visible: \(\) => !!columnEntry/.test(bootBody("mountColumn"))) throw new Error("세로 열이 배치 영역으로 등록되지 않는다");
    return true;
  });

  check("분리 창이 여는 주소에 지면이 있다", () => {
    const m = /getAppUrl\(\) \+ "\/([^"/]+)\/\?"/.exec(read("native/electron/emulator/emulator-host.cjs"));
    if (!m) throw new Error("emulator-host.cjs 에서 분리 창 주소를 못 읽었다");
    if (`web/${m[1]}` !== PAGE || !pageFiles.includes(`${PAGE}/index.html`)) throw new Error(`/${m[1]}/ 에 index.html 이 없다`);
    return true;
  });
}
