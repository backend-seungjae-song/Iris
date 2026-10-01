import { check, cannotMeasure, filesUnder, read, WEB_SHUTTLE_EXCLUDES } from "../core.mjs";

// 에뮬레이터 분리 창의 검사.
//
// 소유 범위
//   web/emulator-window 세 파일에 대한 판정. 셔틀 제외와의 일치, 화면·지목 통과 규칙 모듈을 그대로 쓰는가,
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

  // 창이 자기 화면이나 지목 통과 규칙을 따로 만들면 탭과 창의 동작이 갈린다. 탭이 쓰는 두 모듈만 가져온다.
  check("분리 창은 탭과 같은 화면·지목 통과 규칙 모듈만 가져온다", () => {
    const imports = pageFiles.filter((f) => f.endsWith(".js"))
      .flatMap((f) => [...read(f).matchAll(/\bimport\s*(?:[^"'()]*?from\s*)?\(?\s*["']([^"']+)["']/g)].map((m) => m[1]));
    if (!imports.length) throw new Error("분리 창이 아무 모듈도 가져오지 않는다");
    const allowed = new Set(["/js/emulator/pane.js", "/js/emulator/controls.js"]);
    const other = imports.filter((p) => !allowed.has(p));
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

  check("세로 열 분리와 원래 자리 복귀는 열 상태를 정리한다", () => {
    const boot = read("web/js/emulator/boot.js");
    const detach = bootBody("detach");
    const valid = (source) => /detachable: true/.test(source)
      && /entry\.inStage = false; entry\.inColumn = false;/.test(detach)
      && /renderGroups\(\)/.test(detach)
      && /entry\.detachHome = home/.test(detach)
      && /returnPlace\(entry\.detachHome, layoutOn\(\)\)/.test(bootBody("reattach"));
    if (!valid(boot)) throw new Error("세로 열 분리 또는 원래 자리 복귀 경로가 빠졌다");
    if (valid(boot.replace("detachable: true", "detachable: false"))) throw new Error("분리 제한 위반을 검출하지 못한다");
    return true;
  });

  check("Iris 제어와 플랫폼별 폰 조작은 서로 다른 줄에 있다", () => {
    const pane = read("web/js/emulator/pane.js");
    const valid = (source) => /root\.append\(toolbar, errorBar, frameWrap, phoneBar\)/.test(source)
      && /phoneButtons\.set\(name, button\);\s*phoneBar\.append\(button\)/.test(source)
      && /phoneControls\(platform\)/.test(source)
      && /button\.setAttribute\("aria-pressed"/.test(source);
    if (!valid(pane)) throw new Error("두 줄 구성·플랫폼 판정·상태 표시가 빠졌다");
    if (valid(pane.replace("phoneBar.append(button)", "toolbar.append(button)"))) throw new Error("폰 조작 위치 위반을 검출하지 못한다");
    return true;
  });

  check("에뮬레이터 지목은 UI 전용 대기 구분자를 채팅 입력에 넣는다", () => {
    const native = read("native/electron/emulator/emulator-host.cjs");
    const preload = read("native/electron/preload.cjs");
    const boot = read("web/js/emulator/boot.js");
    const server = read("server/emulator-targets.js");
    const valid = (serverSource) => /ws\._local \|\| !ws\._ui/.test(serverSource)
      && /issuePromptTarget\(\{ pane, kind: "device"/.test(serverSource)
      && /ref: `@device:\$\{udid\}`/.test(serverSource)
      && /type: "emulator\.target-pending-result"/.test(serverSource)
      && /type: "emulator\.target-pending"/.test(boot)
      && /등록 구분자: \$\{message\.delimiter\}/.test(boot)
      && /"emulator\.target-pending-result": finishDeviceDesignation/.test(boot)
      && !/ac-emulator-target-pin|app-targets\.json/.test(native)
      && !/pinTarget/.test(preload);
    if (!valid(server)) throw new Error("기기 대기 지정·채팅 블록 또는 native 쓰기 제거가 빠졌다");
    if (valid(server.replace("!ws._local || !ws._ui", "false"))) throw new Error("UI 전용 경계 위반을 검출하지 못한다");
    return true;
  });

  check("요소 선택과 기록은 기능 훅과 분리 창 IPC로 이어진다", () => {
    const boot = read("web/js/emulator/boot.js");
    const pick = read("web/js/browser/pick-host.js");
    const window = read(`${PAGE}/window.js`);
    const server = read("server/browser-message-handlers.js");
    const valid = (source) => /hasHook\("pick\.toggle"\)/.test(source)
      && /hasHook\("record\.set"\)/.test(source)
      && /provide\("emulator\.pickTarget", pickTarget\)/.test(source)
      && /provide\("emulator\.designate"/.test(source);
    if (!valid(boot) || !/callHook\("emulator\.pickTarget", target\)/.test(pick)
      || !/callHook\("emulator\.designate", emulator\)/.test(pick)
      || !/host\.requestControl\(\{ action: "target"/.test(window)
      || !/action: "device", tab: params\.get\("tab"\), device/.test(window)
      || !/entry\.tab\.deviceId = m\.device \|\| null/.test(boot)
      || !/host\.closeWindow\(\{ tab: params\.get\("tab"\) \}\)/.test(window)
      || !/!msg\.hasEmulatorContext/.test(server)) throw new Error("요소 선택·기록·분리 창 경로가 끊겼다");
    if (valid(boot.replace('provide("emulator.pickTarget", pickTarget)', 'provide("emulator.pickTargetX", pickTarget)'))) {
      throw new Error("훅 이름 위반을 검출하지 못한다");
    }
    return true;
  });

  // 세로 열로 보낸 탭도 탭 저장소에 없다. sweep 이 그것을 닫힌 탭으로 보면 기기와 헬퍼를 끈다.
  check("세로 열로 보낸 에뮬레이터 탭은 탭 띠에서 빠지고, 열은 배치 영역으로 등록된다", () => {
    if (!/takeOutOfStrip\(entry\)/.test(bootBody("toColumn"))) throw new Error("toColumn 이 탭을 탭 띠에서 빼지 않는다");
    if (!/putBackInStrip\(entry\)/.test(bootBody("toTab"))) throw new Error("toTab 이 탭을 되돌려 넣지 않는다");
    if (!/if \(entry\.inColumn\) \{[^\n]*continue; \}/.test(bootBody("sweep"))) throw new Error("sweep 이 세로 열의 탭을 닫힌 탭으로 보고 끈다");
    if (!/registerLayoutRegion\(\{ id,/.test(bootBody("ensureGroup")) || !/ensureGroup\("emulator"\)/.test(bootBody("mountColumn"))) throw new Error("세로 열이 배치 영역으로 등록되지 않는다");
    return true;
  });

  check("각 기기 화면을 닫으면 그 pane만 종료하고 열 목록을 다시 그린다", () => {
    if (!/closeEntry\(entry\.tab\.id\)/.test(bootBody("paneActions"))) throw new Error("기기 닫기 조작이 없다");
    if (!/entry\.pane\.close\(\)/.test(bootBody("closeEntry")) || !/renderGroups\(\)/.test(bootBody("closeEntry"))) throw new Error("종료 또는 열 갱신이 빠졌다");
    if (!/\bclose: TB_SVG\(/.test(read("web/js/emulator/pane.js"))) throw new Error("닫기 아이콘이 없다");
    return true;
  });

  check("내부 배치 변경은 pane을 유지하고 모든 무대 기기를 복귀시킨다", () => {
    const moving = ["toColumn", "toTab", "toStage", "fromStage"].map(bootBody).join("\n");
    const valid = source => !/\.dispose\(|\.close\(|emulator\.shutdown/.test(source);
    if (!valid(moving)) throw new Error("내부 이동이 pane을 종료한다");
    if (valid(moving + "entry.pane.dispose();")) throw new Error("이동 중 dispose 위반을 검출하지 못한다");
    if (!/if \(entry\.inStage\) \{[^\n]*continue; \}/.test(bootBody("sweep"))) throw new Error("무대 탭을 닫힌 탭으로 취급한다");
    if (!/visible: \(\) => !inRail/.test(bootBody("ensureGroup"))) throw new Error("무대에서도 열이 자리를 차지한다");
    if (!/for \(const entry of mounted.values\(\)\) if \(entry.inStage\) fromStage\(entry\)/.test(bootBody("leaveRail"))) throw new Error("모든 기기가 복귀하지 않는다");
    return true;
  });

  // 에이전트 경로(openForAgent)는 사용자 화면을 옮기지 않는다. 그래서 rail 기기 화면의 빈 무대가 같은 스페이스에
  // 붙은 화면을 알리고, 사람이 [여기서 보기]를 눌러야 무대로 옮긴다. 알리지 않으면 무대가 빈 채로 남는다.
  check("에이전트가 연 기기는 빈 무대가 알리고, 사람이 누를 때만 무대로 옮긴다", () => {
    const agent = bootBody("openForAgentRequest");
    for (const name of ["openForAgent", "openForAgentRequest", "openAllocatedForAgent", "openOwnedForAgent", "waitAgentDevice"]) {
      if (/toStage\(|setCenterSpace\(|setActiveTab\(/.test(bootBody(name))) throw new Error(`${name} 가 사용자 화면(무대·스페이스·활성 탭)을 바꾼다`);
    }
    if (!/renderStage\(\)/.test(bootBody("openOwnedForAgent"))) throw new Error("세션 소유 탭을 연 뒤 빈 무대 안내를 갱신하지 않는다");
    if (!/renderStage\(\)/.test(agent)) throw new Error("openForAgent 가 화면을 붙인 뒤 빈 무대 안내를 갱신하지 않는다");
    const stageBody = bootBody("renderStage");
    if (!/const waiting = !stageEntry && inRail && sp \? entryOfSpace\(sp\) : null;/.test(stageBody)) throw new Error("renderStage 가 같은 스페이스에 붙은 화면을 보지 않는다");
    if (!/show\.hidden = !waiting/.test(stageBody)) throw new Error("renderStage 가 [여기서 보기] 단추를 그 화면이 있을 때만 보이지 않는다");
    const mount = bootBody("mountStage");
    if (!/emu-stage-show[^\n]*>여기서 보기</.test(mount)) throw new Error("빈 무대에 [여기서 보기] 단추가 없다");
    if (!/addEventListener\("click"[\s\S]*?entryOfSpace\(sp\)[\s\S]*?toStage\(entry\)/.test(mount)) throw new Error("[여기서 보기] 가 기존 화면을 무대로 옮기지 않는다");
    return true;
  });

  check("창 폭에 밀려난 모든 기기가 넓어지면 각 열로 돌아간다", () => {
    const col = bootBody("mountColumn");
    if (!/!on && entry\.inColumn/.test(col) || !/entry\.narrowed = !byMode/.test(col)) throw new Error("좁아진 열의 기록이 없다");
    if (!/on && entry\.narrowed && !entry\.detached && !entry\.inStage/.test(col)) throw new Error("복귀 대상이 잘못됐다");
    if (!/browser-mode/.test(col) || !/memo-mode/.test(col)) throw new Error("모드 전환을 창 폭 변화와 구분하지 않는다");
    if (!/entry\.narrowed = false/.test(bootBody("detach"))) throw new Error("분리한 화면의 복귀 기록이 남는다");
    return true;
  });

  // 공용 드롭다운의 트리거 보조 글자는 켜는 곳에서만 보인다. 도구 막대(pane.js)는 runtime 을 따로 보여 주므로
  // 켜면 같은 글자가 두 번 보인다.
  check("드롭다운 트리거 보조 글자는 기본 기기 선택기에만 켠다", () => {
    const dd = read("web/js/core/dropdown.js");
    if (!/showSub = false \}/.test(dd)) throw new Error("dropdown.js 의 showSub 기본값이 끔이 아니다");
    if (!/if \(showSub\) \{\n\s*const sub = [^\n]*\n\s*subEl\.textContent = sub;/.test(dd)) throw new Error("renderValue 가 트리거 보조 글자를 고른 항목으로 갱신하지 않는다");
    if (!/ariaLabel: "기본 기기",\n\s*className: "emu-dp-dd",\n\s*showSub: true,/.test(read("web/js/emulator/devices-panel.js"))) throw new Error("기본 기기 선택기가 보조 글자를 켜지 않는다");
    if (/showSub/.test(read("web/js/emulator/pane.js"))) throw new Error("도구 막대 기기 선택기가 보조 글자를 켠다 — runtime 이 두 번 보인다");
    return true;
  });

  check("분리 창이 여는 주소에 지면이 있다", () => {
    const m = /getAppUrl\(\) \+ "\/([^"/]+)\/\?"/.exec(read("native/electron/emulator/emulator-host.cjs"));
    if (!m) throw new Error("emulator-host.cjs 에서 분리 창 주소를 못 읽었다");
    if (`web/${m[1]}` !== PAGE || !pageFiles.includes(`${PAGE}/index.html`)) throw new Error(`/${m[1]}/ 에 index.html 이 없다`);
    return true;
  });

  // 실행 단추는 오른쪽 머리에 끼워 넣는다. 기준 요소가 머리의 직계 자식이 아니면 insertBefore 가 던지고
  // 기능 초기화 전체가 멈춰 rail 화면이 비어 버린다(세션 점이 .sess 안으로 들어간 뒤 실제로 그랬다).
  check("에뮬레이터 실행 단추는 오른쪽 머리의 직계 자식 앞에 들어간다", () => {
    const launch = read("web/js/emulator/launch-button.js");
    const m = /head\.insertBefore\(btn, head\.querySelector\("([^"]+)"\)\)/.exec(launch);
    if (!m) throw new Error("실행 단추를 넣는 기준을 못 읽었다");
    if (!/^:scope > /.test(m[1])) throw new Error(`기준 ${m[1]} 이 직계 자식으로 한정되지 않는다`);
    const cls = m[1].replace(/^:scope > \./, "");
    const head = /<div class="right-head"[^>]*>([\s\S]*?)\n    <\/div>/.exec(read("web/index.html"));
    if (!head || !new RegExp(`\\n      <span class="${cls}">`).test(head[1])) throw new Error(`index.html 오른쪽 머리에 직계 .${cls} 가 없다`);
    return true;
  });
}
