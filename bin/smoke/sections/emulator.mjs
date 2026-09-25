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

  // 세로 열의 화면은 탭 띠에 없어 탭의 닫기(×)로 닫을 수 없다. 열의 도구 막대에 닫기 단추를 두고,
  // 탭을 닫았을 때(sweep → closeEntry)와 같은 경로로 닫아 열이 사라지게 한다.
  check("세로 열의 에뮬레이터 화면은 열에서 닫을 수 있고, 탭 닫기와 같은 경로로 닫힌다", () => {
    if (!/entry\.inColumn\s*\?[\s\S]*?label: "세로 열 닫기"[^\n]*onClick: \(\) => closeColumn\(entry\)/.test(bootBody("paneActions"))) throw new Error("세로 열의 도구 막대에 [세로 열 닫기] 단추가 없다");
    if (!/closeEntry\(entry\.tab\.id\)/.test(bootBody("closeColumn"))) throw new Error("closeColumn 이 탭 닫기와 같은 closeEntry 로 닫지 않는다");
    if (!/if \(entry === columnEntry\) \{ columnEntry = null; notifyLayout\(\); \}/.test(bootBody("closeEntry"))) throw new Error("closeEntry 가 세로 열을 비우고 배치 엔진에 알리지 않는다");
    if (!/\bclose: TB_SVG\(/.test(read("web/js/emulator/pane.js"))) throw new Error("닫기 아이콘이 없어 글자를 뺀 도구 막대에서 단추가 비어 보인다");
    return true;
  });

  // rail 기기 화면의 무대에 옮긴 탭도 탭 저장소에 없다. sweep 이 그것을 닫힌 탭으로 보면 기기와 헬퍼를 끈다.
  // 같은 기기를 두 곳에 붙일 수 없으므로 그 화면에 있는 동안 세로 열은 자리를 차지하지 않고, 나오면 되돌린다.
  check("무대로 옮긴 에뮬레이터 탭은 닫힌 탭이 아니고, 그동안 세로 열은 비어 있다", () => {
    if (!/takeOutOfStrip\(entry\)/.test(bootBody("toStage"))) throw new Error("toStage 가 탭을 탭 띠에서 빼지 않는다");
    if (!/putBackInStrip\(entry\)/.test(bootBody("fromStage"))) throw new Error("fromStage 가 탭을 되돌려 넣지 않는다");
    if (!/if \(entry\.inStage\) \{[^\n]*continue; \}/.test(bootBody("sweep"))) throw new Error("sweep 이 무대의 탭을 닫힌 탭으로 보고 끈다");
    if (!/visible: \(\) => !!columnEntry && !inRail/.test(bootBody("mountColumn"))) throw new Error("rail 기기 화면에서도 세로 열이 자리를 차지한다");
    if (!/fromStage\(stageEntry\)/.test(bootBody("leaveRail"))) throw new Error("rail 기기 화면을 떠나도 무대의 화면이 제자리로 돌아가지 않는다");
    if (!/screen: \{ enter: enterRail, leave: leaveRail \}/.test(read("web/js/emulator/boot.js"))) throw new Error("rail 에 leave 를 등록하지 않았다");
    return true;
  });

  // 에이전트 경로(openForAgent)는 사용자 화면을 옮기지 않는다. 그래서 rail 기기 화면의 빈 무대가 같은 스페이스에
  // 붙은 화면을 알리고, 사람이 [여기서 보기]를 눌러야 무대로 옮긴다. 알리지 않으면 무대가 빈 채로 남는다.
  check("에이전트가 연 기기는 빈 무대가 알리고, 사람이 누를 때만 무대로 옮긴다", () => {
    const agent = bootBody("openForAgent");
    if (/toStage\(|setCenterSpace\(|setActiveTab\(/.test(agent)) throw new Error("openForAgent 가 사용자 화면(무대·스페이스·활성 탭)을 바꾼다");
    if (!/renderStage\(\)/.test(agent)) throw new Error("openForAgent 가 화면을 붙인 뒤 빈 무대 안내를 갱신하지 않는다");
    const stageBody = bootBody("renderStage");
    if (!/const waiting = !stageEntry && inRail && sp \? entryOfSpace\(sp\) : null;/.test(stageBody)) throw new Error("renderStage 가 같은 스페이스에 붙은 화면을 보지 않는다");
    if (!/show\.hidden = !waiting/.test(stageBody)) throw new Error("renderStage 가 [여기서 보기] 단추를 그 화면이 있을 때만 보이지 않는다");
    const mount = bootBody("mountStage");
    if (!/emu-stage-show[^\n]*>여기서 보기</.test(mount)) throw new Error("빈 무대에 [여기서 보기] 단추가 없다");
    if (!/addEventListener\("click"[\s\S]*?entryOfSpace\(sp\)[\s\S]*?toStage\(entry\)/.test(mount)) throw new Error("[여기서 보기] 가 기존 화면을 무대로 옮기지 않는다");
    return true;
  });

  // 배치 엔진이 꺼져 열에서 탭으로 밀려난 화면만 엔진이 다시 켜질 때 열로 돌아간다. home 만 보면 사람이 탭으로
  // 옮긴 화면이나 다른 기기에 열을 내준 화면까지 되돌린다.
  check("창이 넓어지면 폭 때문에 탭으로 밀려난 에뮬레이터만 세로 열로 돌아간다", () => {
    const col = bootBody("mountColumn");
    if (!/if \(!on\) \{[\s\S]{0,400}?if \(columnEntry\) \{[^\n]*toTab\(entry, true\); entry\.narrowed = !byMode;/.test(col)) throw new Error("엔진이 꺼질 때 밀려난 화면을 표시하지 않는다");
    // 분리 브라우저·메모 창 모드로 꺼진 것은 폭이 돌아와도 켜지지 않는다. 그때 표시하면 되돌릴 일이 없는 표시가 남는다.
    if (!/const byMode = document\.body\.classList\.contains\("browser-mode"\) \|\| document\.body\.classList\.contains\("memo-mode"\);/.test(col)) throw new Error("모드 전환으로 꺼진 것도 폭 때문으로 표시한다");
    if (!/if \(entry\.narrowed && !entry\.inColumn && !entry\.inStage && !entry\.detached\) \{[^\n]*toColumn\(entry\)/.test(col)) throw new Error("엔진이 켜질 때 표시한 화면만 열로 되돌리지 않는다");
    if (/entry\.home === "column"/.test(col)) throw new Error("열 복귀를 home 으로 판정한다");
    const actions = bootBody("paneActions");
    if ((actions.match(/entry\.narrowed = false;/g) || []).length !== 2) throw new Error("[탭으로]·[세로 열로] 수동 이동이 표시를 지우지 않는다");
    if (!/other\.narrowed = false/.test(bootBody("toColumn"))) throw new Error("다른 화면이 열을 차지해도 밀려난 화면의 표시가 남는다");
    if (!/entry\.narrowed = false/.test(bootBody("detach"))) throw new Error("분리해도 표시가 남는다");
    if (!/entry\.narrowed = false/.test(bootBody("closeEntry"))) throw new Error("닫아도 표시가 남는다");
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
