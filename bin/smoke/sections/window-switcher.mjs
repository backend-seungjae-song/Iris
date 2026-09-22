// 소유 범위: 창 전환의 전역 단축키·상태 파일·osascript 인자·JXA 조회·렌더러 fallback 계약.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구와 창 전환 catalog·icon·host·신뢰 경계.
// 유지 조건: 다른 전역 단축키, 전용 상태 파일, 사용자 문자열 경계, 컬렉션 조회,
//   단일 순수 판정, ac-keymap 신뢰 경계.
// 영향 범위: 러너와 B5 단축키 표·중계·fallback 연결도 함께 이 계약의 대상이다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/window-switcher.mjs
import { check, checkAsync, read } from "../core.mjs";

const host = read("native/electron/switcher-host.cjs");
const catalog = read("native/electron/window-catalog.cjs");
const icons = read("native/electron/window-icons.cjs");
const jxa = read("native/electron/switcher-jxa.cjs");
const trust = read("native/electron/ipc-trust.cjs");
const keynav = read("web/js/core/keynav.js");
const dock = read("web/js/browser/dock.js");
const main = read("native/electron/main.cjs");

const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");

export default async function run() {
  console.log("[window-switcher] 고른 macOS 창 순환");

  await checkAsync("설정은 다섯 분류를 두고 각 분류에 자기 내용만 그린다", async () => {
    const mod = await import(new URL("../../../web/js/devtool/settings-view.js", import.meta.url).href);
    const sections = mod.SETTINGS_SECTIONS.map(({ id, label }) => ({ id, label }));
    const expected = [
      { id: "keys", label: "단축키" },
      { id: "features", label: "편의 기능" },
      { id: "windows", label: "창 전환" },
      { id: "artifacts", label: "부산물" },
      { id: "security", label: "보안" },
    ];
    if (JSON.stringify(sections) !== JSON.stringify(expected)) {
      throw new Error(`설정 분류가 다르다: ${JSON.stringify(sections)}`);
    }

    const model = {
      items: [{ id: "find", label: "찾기", where: "편집기", keys: "⌘F" }],
      screens: [{ id: "memo", label: "메모", on: true, lock: "" }],
      switcher: { windows: [{ id: 1, displayApp: "메모", displayTitle: "한 장", picked: true }], status: {} },
      toggles: [{ id: "login", name: "로그인", desc: "설명", on: false }],
      artifacts: { kinds: [{ id: "shots", label: "화면 캡처", desc: "찍은 것", dir: "/x/shots", count: 2, bytes: 20 }],
        total: { count: 2, bytes: 20 }, canTrash: true },
    };
    const panes = Object.fromEntries(expected.map(({ id }) => [id, mod.settingsMarkup({ ...model, section: id })]));
    const owned = {
      keys: "data-km-rec=",
      features: "data-set-screen=",
      windows: "km-switcher",
      artifacts: "data-art-kind=",
      security: "data-set-toggle=",
    };
    for (const [section, marker] of Object.entries(owned)) {
      if (!panes[section].includes(marker)) throw new Error(`${section} 분류에 자기 내용이 없다`);
      for (const [other, otherMarker] of Object.entries(owned)) {
        if (other !== section && panes[section].includes(otherMarker)) {
          throw new Error(`${section} 분류에 ${other} 내용이 섞였다`);
        }
      }
    }
    const windowsNav = /<button class="km-nav(?: on)?" data-km-sec="windows">[\s\S]*?<\/button>/
      .exec(panes.windows)?.[0] || "";
    if (!windowsNav || /km-nav-c/.test(windowsNav)) throw new Error("창 전환 분류 옆에 숫자가 남아 있다");
    return true;
  });

  check("창 전환 등록은 다른 전역 단축키를 해제하지 않는다", () =>
    !/\bunregisterAll\s*\(/.test(bare(host)));

  check("창 전환 상태는 stateHome의 전용 파일만 쓴다", () =>
    /path\.join\(stateHome\(\), "window-switcher\.json"\)/.test(bare(host))
    && !/ui-state\.json/.test(bare(host)));

  // 창 제목·앱 이름·번들 id 는 다른 앱이 만든 문자열이다. 셸을 거치면 그 문자열이 명령이 된다.
  // 이 검사가 `JSON.stringify(payload)` 처럼 변수 이름까지 리터럴로 고정하면,
  // 이름이 `nextPayload` 로 바뀔 때 동작은 같은데 검사만 실패한다(확인 결과).
  // 이름이 아니라 동작을 검사한다. 생산자는 osascript 하나이고, JXA 는 프로세스를 실행하지 않는다.
  check("사용자 문자열은 인자 배열로만 건넨다", () => {
    const producers = [["window-catalog.cjs", bare(catalog)], ["window-icons.cjs", bare(icons)]];
    const bad = [];
    for (const [name, src] of producers) {
      // 자식 프로세스를 셸로 띄우면 문자열이 명령이 된다
      if (/shell\s*:\s*true/.test(src)) bad.push(`${name} 이 shell:true 로 띄운다`);
      if (/\b(exec|execSync)\s*\(/.test(src)) bad.push(`${name} 이 셸 exec 를 쓴다`);
      if (/["'`]\s*-c\s*["'`]/.test(src)) bad.push(`${name} 이 sh -c 를 쓴다`);

      // osascript 는 반드시 배열 인자로, 페이로드는 JSON.stringify 로 마지막에
      const osa = [...src.matchAll(/\[\s*"-l"\s*,\s*"JavaScript"\s*,\s*"-e"\s*,\s*([^\]]*)\]/g)];
      if (!osa.length) bad.push(`${name} 에 osascript 인자 배열이 없다`);
      for (const m of osa) {
        if (!/JSON\.stringify\(/.test(m[1])) bad.push(`${name} 의 osascript 인자에 JSON.stringify 가 없다`);
        if (/\+/.test(m[1]) || /\$\{/.test(m[1])) bad.push(`${name} 이 osascript 인자를 이어 붙인다`);
      }
    }

    // JXA 는 프로세스를 실행하지 않는다. open 으로 앱을 전면에 가져오는 방식은
    // 창을 지정하지 못해 다른 창이 선택된다. 프로세스를 실행하지 않으면 앱 이름이 명령이 될 경로도 없다.
    const script = bare(jxa);
    for (const spawn of ["NSTask", "doShellScript", "/usr/bin/open", "NSAppleScript"]) {
      if (script.includes(spawn)) bad.push(`switcher-jxa.cjs 가 ${spawn} 로 프로세스를 띄운다`);
    }

    if (bad.length) throw new Error(bad.join(" · "));
    return true;
  });

  // 전환 실패 사유는 세 곳에 있다. JXA 가 만들고, 호스트가 차단된 창으로 표시하고, 설정 화면이
  // 사용자 문구로 변환한다. 셋이 어긋나면 오류 없이 잘못 동작한다(JXA 가 이름을
  // 바꿨는데 호스트 목록과 화면 문구는 이전 이름을 사용한 사례가 있다). 리터럴 대신 셋을 대조한다.
  check("전환 실패 사유는 만드는 곳·막는 곳·보여주는 곳이 같다", () => {
    const produced = [...bare(jxa).matchAll(/reason === "([a-z-]+)"/g)].map((m) => m[1]);
    const blocked = [...bare(host).matchAll(/SWITCH_BLOCK_REASONS = new Set\(\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([a-z-]+)"/g)].map((n) => n[1]));
    const view = read("web/js/devtool/settings-view.js");
    const shown = [...bare(view).matchAll(/reason === "([a-z-]+)"\)\s*return/g)].map((m) => m[1]);
    const bad = [];
    if (!produced.length) bad.push("JXA 에서 사유를 하나도 못 읽었다");
    if (!blocked.length) bad.push("호스트에서 막힌 사유 목록을 못 읽었다");
    const set = (list) => [...new Set(list)].sort().join(",");
    if (set(produced) !== set(blocked)) {
      bad.push(`만드는 곳 ${set(produced)} 과 막는 곳 ${set(blocked)} 이 다르다`);
    }
    for (const reason of new Set(produced)) {
      if (!shown.includes(reason)) bad.push(`${reason} 을 사람 말로 옮기는 자리가 없다`);
    }
    if (bad.length) throw new Error(bad.join(" · "));
    return true;
  });

  check("media는 요청 시점의 메인 webContents main frame만 통과한다", () =>
    /event\.sender !== allowedWebContents/.test(bare(trust))
    && /event\.senderFrame !== allowedWebContents\.mainFrame/.test(bare(trust))
    && /const window = getMainWindow\(\);[\s\S]{0,180}isTrustedMainFrame\(event, APP_URL, window\.webContents\)/.test(bare(main)));

  check("JXA 창 조회는 컬렉션 단위로 읽는다", () => {
    const source = bare(jxa);
    return /p\.windows\.name\(\)/.test(source)
      && /p\.windows\.subrole\(\)/.test(source)
      && /p\.windows\.position\(\)/.test(source)
      && /p\.windows\.size\(\)/.test(source)
      && !/applicationProcesses\(\)/.test(source);
  });

  const switcher = await import(new URL("../../../web/js/core/screen-switch.js", import.meta.url).href);
  await checkAsync("keynav와 dock은 같은 세 갈래 판정을 쓴다", async () => {
    const table = [
      [{ pickedMode: false, registered: {}, dir: 1 }, "legacy"],
      [{ pickedMode: false, registered: {}, dir: -1 }, "none"],
      [{ pickedMode: true, registered: { next: true }, dir: 1 }, "global"],
      [{ pickedMode: true, registered: { prev: true }, dir: -1 }, "global"],
      [{ pickedMode: true, registered: { next: false }, dir: 1 }, "step"],
      [{ pickedMode: true, registered: { prev: false }, dir: -1 }, "step"],
    ];
    for (const [input, want] of table) {
      const got = switcher.planSwitcherKey(input);
      if (got !== want) throw new Error(`${JSON.stringify(input)}: ${want} 여야 하는데 ${got}`);
    }
    const keynavSource = bare(keynav), dockSource = bare(dock);
    return /runSwitcherKey\(dir, getSwitcherState\(\)\)/.test(keynavSource)
      && /case "screen-toggle": runSwitcherKey\(1\);/.test(dockSource)
      && /case "screen-toggle-back": runSwitcherKey\(-1\);/.test(dockSource)
      && !/pickedMode|registered\s*\[/.test(keynavSource + "\n" + dockSource);
  });

  check("우리 창을 올릴 때 앱을 활성으로 만든다", () => {
    // 창을 key 로 만드는 것과 앱을 활성으로 만드는 것은 다르다. macOS 가 데스크톱을 전환하는 것은
    // 앱이 활성이 될 때다. focus 만 호출하면 다른 데스크톱의 창은 전환되지 않는데 예외도 나지 않아
    // 성공으로 기록된다. 그러면 다음 회차의 앞 창도 목록 밖이라 첫 창만 반복된다
    // (확인 결과: 선택한 창이 없는 데스크톱에서 두 번 실행해 둘 다 성공으로 기록되고 화면은 그대로였다).
    const source = bare(main);
    const at = source.indexOf("raiseOwnWindow:");
    if (at < 0) throw new Error("raiseOwnWindow 를 못 찾았다");
    const next = source.indexOf("isTrustedSender:", at);
    const body = source.slice(at, next < 0 ? source.length : next);
    return /app\.focus\(\{ steal: true \}\)/.test(body) && /win\.focus\(\)/.test(body);
  });

  check("ac-keymap은 신뢰 발신자의 작은 객체만 받는다", () => {
    const source = bare(main);
    const handler = /ipcMain\.on\("ac-keymap",\s*\(e, map\)\s*=>\s*\{([\s\S]{0,700}?)\n\}\);/.exec(source);
    if (!handler) throw new Error("ac-keymap 핸들러를 못 찾았다");
    return /if \(!isTrustedSender\(e\)\) return;/.test(handler[1])
      && /typeof map !== "object"/.test(handler[1])
      && /Array\.isArray\(map\)/.test(handler[1])
      && /Object\.keys\(map\)\.length > 200/.test(handler[1])
      && /setRelayKeymap\(map\);/.test(handler[1]);
  });
}
