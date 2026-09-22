// 창 전환 설정 화면의 한 줄 목록·권한 안내·문자열 경계를 DOM 없이 검증한다.
//
// 소유 범위
//   settingsMarkup의 C5 창 행 마크업과 안전한 아이콘·제목 표시 계약.
//
// 제공 API
//   node --test test/settings-view.mjs 한 명령으로 C5 화면 계약을 판정한다.
//
// 의존 대상
//   DOM에 기대지 않는 settings-view.js의 순수 settingsMarkup 함수만 부른다.
//
// 유지 조건
//   창 수와 행 수는 같고 순번 범위는 appKey이며 남이 만든 이름·제목은 escape한다.
//
// 영향 범위
//   공급자는 switcher-host media 응답이고 소비자는 설정 화면과 keymap-page의 기존 체크 배선이다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs test/settings-view.mjs

import assert from "node:assert/strict";
import test from "node:test";

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ exists: true, revision: 0, hidden: [], local: true }));
const { settingsMarkup } = await import("../web/js/devtool/settings-view.js");
globalThis.fetch = previousFetch;

function window(overrides = {}) {
  return {
    id: 1, appKey: "com.example.One", displayApp: "같은 앱", displayTitle: "첫 창",
    bounds: [0, 0, 500, 400], ordinal: 1, visible: true, minimized: false, picked: false,
    ...overrides,
  };
}

function markup(windows, media = { permission: "granted", icons: {}, thumbs: {}, missing: [] }) {
  return settingsMarkup({
    section: "windows", items: [], screens: [], toggles: [],
    switcher: { windows, picked: windows.filter((item) => item.picked), status: { permission: true }, media },
  });
}

function rowMarkup(html, title) {
  const titleAt = html.indexOf(`>${title}</div>`);
  const start = html.lastIndexOf('<article class="km-sw-row', titleAt);
  const end = html.indexOf("</article>", titleAt);
  return html.slice(start, end + "</article>".length);
}

test("앱 수와 관계없이 창 여덟 개를 앱 이름과 제목이 있는 여덟 행으로 세운다", () => {
  const windows = Array.from({ length: 8 }, (_, index) => window({
    id: index + 1,
    appKey: `com.example.${index % 3}`,
    displayApp: `앱 ${index % 3}`,
    displayTitle: `창 ${index + 1}`,
    bounds: [index * 20, 0, 500, 400],
  }));
  const html = markup(windows);

  assert.equal((html.match(/class="km-sw-row"/g) || []).length, 8);
  assert.equal((html.match(/class="km-sw-app"/g) || []).length, 8);
  assert.equal((html.match(/class="km-sw-title"/g) || []).length, 8);
  assert.doesNotMatch(html, /km-sw-group-h|km-sw-group-note/);
  for (const item of windows) {
    assert.match(html, new RegExp(`>${item.displayApp}<`));
    assert.match(html, new RegExp(`>${item.displayTitle}<`));
  }
});

test("화면 기록 권한 상태마다 사용자가 할 일이 다른 문구를 낸다", () => {
  const denied = markup([window()], { permission: "denied", icons: {}, thumbs: {}, missing: [] });
  const restricted = markup([window()], { permission: "restricted", icons: {}, thumbs: {}, missing: [] });
  const undecided = markup([window()], { permission: "not-determined", icons: {}, thumbs: {}, missing: [] });

  assert.match(denied, /꺼져|허용/);
  assert.match(restricted, /정책|관리자/);
  assert.match(undecided, /필요|허용/);
  assert.notEqual(denied, restricted);
  assert.notEqual(restricted, undecided);
  assert.equal([denied, restricted, undecided].every((html) => html.includes("sw-open-perm")), true);
});

test("아이콘이 없는 앱도 깨진 img 대신 빈 그림 자리를 유지한다", () => {
  const html = markup([window()]);

  assert.match(html, /class="km-sw-visual/);
  assert.doesNotMatch(html, /<img[^>]+src=""/);
  assert.match(html, /km-sw-icon-fallback/);
});

test("창 제목과 앱 이름의 꺾쇠·앰퍼샌드를 escape한다", () => {
  const html = markup([window({ displayApp: "<앱&>", displayTitle: "<창&>" })]);

  assert.match(html, /&lt;앱&amp;&gt;/);
  assert.match(html, /&lt;창&amp;&gt;/);
  assert.doesNotMatch(html, /<앱&>|<창&>/);
});

test("PNG data URI가 아닌 아이콘 값은 img로 그리지 않는다", () => {
  const unsafe = markup([window()], {
    permission: "granted", icons: { "com.example.One": "https://example.test/icon.png" }, thumbs: {}, missing: [],
  });
  const safe = markup([window()], {
    permission: "granted", icons: { "com.example.One": "data:image/png;base64,AQID" }, thumbs: {}, missing: [],
  });

  assert.doesNotMatch(unsafe, /src="https:\/\/example\.test/);
  assert.match(safe, /src="data:image\/png;base64,AQID"/);
});

test("앱 이름순 뒤 같은 앱의 bounds 사전순으로 세우고 체크 배선 이름은 그대로다", () => {
  const html = markup([
    window({ id: 1, appKey: "com.example.Zulu", displayApp: "Zulu", displayTitle: "나중 앱" }),
    window({ id: 3, appKey: "com.example.Alpha", displayApp: "Alpha", displayTitle: "오른쪽",
      bounds: [600, 0, 500, 400] }),
    window({ id: 2, appKey: "com.example.Alpha", displayApp: "Alpha", displayTitle: "왼쪽",
      bounds: [0, 0, 500, 400] }),
  ]);

  assert.equal(html.indexOf("왼쪽") < html.indexOf("오른쪽"), true);
  assert.equal(html.indexOf("오른쪽") < html.indexOf("나중 앱"), true);
  assert.match(html, /data-sw-pick="1"/);
  assert.match(html, /data-sw-pick="2"/);
  assert.match(html, /data-sw-pick="3"/);
  assert.match(html, /role="switch" aria-checked="false" aria-label="Alpha — 오른쪽"/);
});

test("고른 창은 picked 순서대로 위 덩이에 서고 나머지는 아래 덩이에 선다", () => {
  const first = window({ id: 1, displayTitle: "먼저 고른 창", picked: true });
  const second = window({ id: null, pickKey: "숨은 창 키", displayTitle: "나중에 고른 창",
    picked: true, visible: false, bounds: [600, 0, 500, 400] });
  const rest = window({ id: 3, displayTitle: "고르지 않은 창", bounds: [1200, 0, 500, 400] });
  const html = settingsMarkup({
    section: "windows", items: [], screens: [], toggles: [],
    switcher: {
      windows: [first, second, rest], picked: [{ pickKey: "숨은 창 키" }, { id: 1 }],
      status: { permission: true },
      media: { permission: "granted", icons: {}, thumbs: {}, missing: [] },
    },
  });

  assert.equal(html.indexOf("⌥Tab 이 도는 순서") < html.indexOf("나중에 고른 창"), true);
  assert.equal(html.indexOf("나중에 고른 창") < html.indexOf("먼저 고른 창"), true);
  assert.equal(html.indexOf("먼저 고른 창") < html.indexOf("고르지 않은 창"), true);
  assert.match(html, /class="km-sw-list km-sw-picked-list"/);
  assert.match(html, /class="km-sw-list km-sw-rest-list"/);
});

test("고른 창이 없으면 위 덩이와 순서 안내를 그리지 않는다", () => {
  const html = markup([window({ picked: false })]);

  assert.doesNotMatch(html, /km-sw-picked-list|⌥Tab 이 도는 순서/);
  assert.match(html, /class="km-sw-list km-sw-rest-list"/);
});

test("고른 첫 줄의 위로와 마지막 줄의 아래로 단추는 비활성이다", () => {
  const html = markup([
    window({ id: 1, displayTitle: "첫 고른 창", picked: true }),
    window({ id: 2, displayTitle: "가운데 고른 창", picked: true, bounds: [600, 0, 500, 400] }),
    window({ id: 3, displayTitle: "마지막 고른 창", picked: true, bounds: [1200, 0, 500, 400] }),
  ]);

  assert.match(rowMarkup(html, "첫 고른 창"), /data-sw-move="-1"[^>]*disabled/);
  assert.match(rowMarkup(html, "첫 고른 창"), /aria-label="앞으로 옮기기 — 같은 앱 — 첫 고른 창"/);
  assert.doesNotMatch(rowMarkup(html, "첫 고른 창"), /data-sw-move="1"[^>]*disabled/);
  assert.doesNotMatch(rowMarkup(html, "가운데 고른 창"), /data-sw-move="(?:-1|1)"[^>]*disabled/);
  assert.match(rowMarkup(html, "마지막 고른 창"), /data-sw-move="1"[^>]*disabled/);
  assert.match(rowMarkup(html, "마지막 고른 창"), /aria-label="뒤로 옮기기 — 같은 앱 — 마지막 고른 창"/);
});

test("순서 단추는 아래 덩이의 줄에는 없다", () => {
  const html = markup([
    window({ id: 1, displayTitle: "고른 창", picked: true }),
    window({ id: 2, displayTitle: "아래 창", bounds: [600, 0, 500, 400] }),
  ]);

  assert.equal((rowMarkup(html, "고른 창").match(/data-sw-move=/g) || []).length, 2);
  assert.doesNotMatch(rowMarkup(html, "아래 창"), /data-sw-move=/);
});

test("모든 행의 대체 사유가 같으면 목록 위에 한 번만 적는다", () => {
  const html = markup([
    window({ id: 1, displayTitle: "하나" }),
    window({ id: 2, displayTitle: "둘", bounds: [500, 0, 500, 400] }),
  ], {
    permission: "granted",
    icons: { "com.example.One": "data:image/png;base64,AQID" },
    thumbs: {},
    missing: [{ id: 1, reason: "not-found" }, { id: 2, reason: "not-found" }],
  });

  assert.equal((html.match(/class="km-note km-sw-list-note"/g) || []).length, 1);
  assert.equal((html.match(/창 그림 없음/g) || []).length, 1);
  assert.equal((html.match(/class="km-sw-reason"/g) || []).length, 0);
});

test("화면 기록 안내와 모든 행의 같은 대체 사유를 한 안내로 합친다", () => {
  const html = markup([
    window({ id: 1, displayTitle: "하나" }),
    window({ id: 2, displayTitle: "둘", bounds: [500, 0, 500, 400] }),
  ], {
    permission: "denied",
    icons: { "com.example.One": "data:image/png;base64,AQID" },
    thumbs: {},
    missing: [{ id: 1, reason: "permission" }, { id: 2, reason: "permission" }],
  });

  assert.equal((html.match(/화면 기록 권한/g) || []).length, 1);
  assert.equal((html.match(/앱 아이콘으로 표시합니다/g) || []).length, 1);
  assert.equal((html.match(/class="km-sw-reason"/g) || []).length, 0);
  assert.equal((html.match(/id="sw-open-perm"/g) || []).length, 1);
});

test("행마다 대체 사유가 다르면 해당 행에만 짧게 붙인다", () => {
  const html = markup([
    window({ id: 1, displayTitle: "최소 창", minimized: true }),
    window({ id: 2, displayTitle: "큰 창", bounds: [500, 0, 500, 400] }),
  ], {
    permission: "granted",
    icons: { "com.example.One": "data:image/png;base64,AQID" },
    thumbs: {},
    missing: [{ id: 2, reason: "too-large" }],
  });

  assert.doesNotMatch(html, /km-sw-list-note/);
  assert.equal((html.match(/class="km-sw-reason"/g) || []).length, 2);
  assert.match(html, /class="km-sw-reason">최소화<\/div>/);
  assert.match(html, /class="km-sw-reason">창 그림이 너무 큼<\/div>/);
});

test("최소화·안 보임·같은 제목 둘째 창의 배지와 전체 title을 남긴다", () => {
  const html = markup([
    window({ id: 1, displayTitle: "긴 <제목&>", minimized: true }),
    window({ id: null, pickKey: "숨은&키", displayTitle: "긴 <제목&>", ordinal: 2,
      bounds: [500, 0, 500, 400], visible: false, picked: true }),
  ], {
    permission: "granted",
    icons: { "com.example.One": "data:image/png;base64,AQID" },
    thumbs: {},
    missing: [{ id: 1, reason: "not-found" }, { appKey: "com.example.One", reason: "not-found" }],
  });

  assert.match(html, />최소화<\/span>/);
  assert.match(html, />안 보임<\/span>/);
  assert.match(html, />#2<\/span>/);
  assert.match(html, /title="긴 &lt;제목&amp;&gt;"/);
  assert.match(html, /data-sw-key="숨은&amp;키"/);
});

test("다른 데스크톱 창은 흐리지 않고 전용 배지로 고를 수 있게 둔다", () => {
  const html = markup([window({ reachable: "cg", onScreen: false })]);

  assert.match(html, />다른 데스크톱<\/span>/);
  assert.doesNotMatch(html, />안 보임<\/span>/);
  assert.doesNotMatch(html, /class="km-sw-row dim"/);
  assert.match(html, /data-sw-pick="1"/);
});

test("전환이 막힌 행은 흐리지 않고 전환 안 됨 배지와 안내를 그린다", () => {
  const html = markup([window({ switchBlocked: true })]);

  assert.match(html, />전환 안 됨<\/span>/);
  assert.match(html, /macOS 가 그 데스크톱으로 안 넘어감/);
  assert.match(html, /그 앱이 이 데스크톱에도 창을 갖고 있으면 그렇게 됨/);
  assert.doesNotMatch(html, /class="km-sw-row dim"/);
});

test("다른 데스크톱에서 전환이 막힌 행은 두 배지를 함께 그린다", () => {
  const html = markup([window({ reachable: "cg", onScreen: false, switchBlocked: true })]);

  assert.match(html, />다른 데스크톱<\/span>/);
  assert.match(html, />전환 안 됨<\/span>/);
});

test("전환이 막히지 않은 행에는 전환 안 됨 배지를 그리지 않는다", () => {
  const html = markup([
    window({ id: 1, switchBlocked: true }),
    window({ id: 2, bounds: [600, 0, 500, 400] }),
  ]);

  assert.equal((html.match(/>전환 안 됨<\/span>/g) || []).length, 1);
});

test("다섯 배지 종류를 행 안에 모두 남긴다", () => {
  const html = markup([
    window({ id: 1, displayTitle: "겹친 창", minimized: true, reachable: "cg",
      switchBlocked: true, visible: false }),
    window({ id: 2, displayTitle: "겹친 창", ordinal: 2, bounds: [600, 0, 500, 400] }),
  ]);

  for (const badge of ["최소화", "다른 데스크톱", "전환 안 됨", "안 보임", "#2"]) {
    assert.match(html, new RegExp(`class="km-sw-badge">${badge}</span>`));
  }
});

test("같은 제목의 순번은 같은 앱 안에서만 붙인다", () => {
  const html = markup([
    window({ id: 1, appKey: "com.example.One", displayApp: "첫 앱", displayTitle: "같은 제목", ordinal: 1 }),
    window({ id: 2, appKey: "com.example.Two", displayApp: "둘째 앱", displayTitle: "같은 제목", ordinal: 2 }),
    window({ id: 3, appKey: "com.example.One", displayApp: "첫 앱", displayTitle: "같은 제목", ordinal: 2,
      bounds: [600, 0, 500, 400] }),
  ]);

  assert.equal((html.match(/class="km-sw-badge">#2<\/span>/g) || []).length, 1);
});

test("제목이 빈 창은 지어내지 않고 회색 제목 없음으로 표시한다", () => {
  const html = markup([window({ displayTitle: "", matchTitle: "" })]);

  assert.match(html, /class="km-sw-title empty"[^>]*>제목 없음<\/div>/);
  assert.doesNotMatch(html, /같은 앱 — 같은 앱/);
});

test("창 그림이 있으면 행에는 앱 아이콘 대신 그림을 표시한다", () => {
  const html = markup([window()], {
    permission: "granted",
    icons: { "com.example.One": "data:image/png;base64,SUCONA==" },
    thumbs: { 1: "data:image/png;base64,VEhVTUI=" },
    missing: [],
    elapsedMs: 12,
  });

  assert.match(html, /class="km-sw-thumb" src="data:image\/png;base64,VEhVTUI="/);
  assert.doesNotMatch(html, /data:image\/png;base64,SUCONA==/);
  assert.doesNotMatch(html, /창 그림 없음/);
});

test("화면 기록 권한이 granted면 권한 안내를 그리지 않는다", () => {
  const html = markup([window()], {
    permission: "granted", icons: {}, thumbs: {}, missing: [{ id: 1, reason: "not-found" }],
  });

  assert.doesNotMatch(html, /id="sw-open-perm"/);
});

test("마지막 전환이 실패했으면 그 사실을 화면에 적는다", () => {
  const base = { windows: [], picked: [], status: { permission: true }, media: null };
  const failed = settingsMarkup({ section: "windows", items: [], toggles: [], screens: [], conflicts: [], changed: 0,
    switcher: { ...base, status: { permission: true, lastStep: { at: "x", how: "osascript", failed: "window-out-of-reach" } } } });
  assert.match(failed, /마지막 전환 실패/);
  assert.match(failed, /데스크톱은 넘어갔는데 그 창이 안 뜸/);
  assert.ok(!/window-out-of-reach/.test(failed), "사유를 그대로 보여주면 사람이 못 읽는다");

  const okOne = settingsMarkup({ section: "windows", items: [], toggles: [], screens: [], conflicts: [], changed: 0,
    switcher: { ...base, status: { permission: true, lastStep: { at: "x", how: "own-window" } } } });
  assert.ok(!/마지막 전환 실패/.test(okOne), "잘 됐을 때는 적지 않는다");
});
