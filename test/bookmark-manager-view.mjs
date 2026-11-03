import assert from "node:assert/strict";
import test from "node:test";
import { autoAccount, collectBookmarks, filterSections, managerSummary, rowKey, sectionsMarkup } from "../web/js/bookmarks/manager-view.js";

const input = () => ({
  common: [{ url: "https://notes.example/", title: "Notion", profile: "p_work" }],
  bySpace: {
    w1: [{ url: "https://github.com/acme", title: "Acme" }, { folder: "f", title: "디자인", items: [{ url: "https://figma.com/design/example", title: "예시 디자인", profile: "" }] }],
    gone: [{ url: "https://old.example/", title: "옛것" }],
    w2: [],
    __shared__: [{ url: "https://shared.example/", title: "X" }],
  },
  spaces: [{ id: "w2", label: "둘째" }, { id: "w1", label: "첫째" }],
});

test("구역 순서: 공통 → 스페이스 순서 → 공유 브라우저 → 지금 없는 스페이스. 빈 구역은 뺌, 폴더 안 북마크도 줄로", () => {
  const s = collectBookmarks(input());
  assert.deepEqual(s.map((x) => x.label), ["공통", "첫째", "공유 브라우저", "지금 없는 스페이스"]);
  const w1 = s[1].rows;
  assert.deepEqual(w1.map((r) => [r.title, r.folder && r.folder.title, r.profile]), [["Acme", null, undefined], ["예시 디자인", "디자인", ""]]);
  assert.equal(rowKey(w1[0]), "space|w1|https://github.com/acme");
});

test("검색은 이름·주소·폴더 이름, 거르기는 계정 지정(기본 계정 포함)·자동", () => {
  const s = collectBookmarks(input());
  assert.deepEqual(filterSections(s, "디자인").flatMap((x) => x.rows.map((r) => r.title)), ["예시 디자인"]);
  assert.deepEqual(filterSections(s, "GITHUB").flatMap((x) => x.rows.map((r) => r.title)), ["Acme"]);
  assert.deepEqual(filterSections(s, "", "set").flatMap((x) => x.rows.map((r) => r.title)), ["Notion", "예시 디자인"]);
  assert.deepEqual(filterSections(s, "", "auto").flatMap((x) => x.rows.map((r) => r.title)), ["Acme", "X", "옛것"]);
  assert.deepEqual(managerSummary(s), { total: 5, set: 2 });
});

test("자동 계정 설명: 규칙이 먼저, 없으면 스페이스 기본, 공통은 보고 있는 스페이스 기본", () => {
  const ctx = { rules: [{ pattern: "github.com", profile: "p_study" }], spaceDefaults: { w1: "p_play" }, profileName: (id) => ({ p_study: "Study", p_play: "Play", "": "기본" })[id] || id };
  const [common, w1] = collectBookmarks(input());
  assert.deepEqual(autoAccount(w1.rows[0], ctx), { profile: "p_study", name: "Study", why: "규칙 github.com" });
  assert.equal(autoAccount({ scope: "space", space: "w1", url: "https://other.example/" }, ctx).name, "Play");
  assert.equal(autoAccount({ scope: "space", space: "w9", url: "https://other.example/" }, ctx).name, "기본");
  assert.equal(autoAccount(common.rows[0], ctx).name, "스페이스 기본");
});

test("마크업: 이름·주소를 이스케이프하고, 고른 줄·이름 바꾸는 줄을 표시", () => {
  const s = collectBookmarks({ common: [{ url: "https://a.com/?q=<x>", title: "<b>위험</b>" }], bySpace: {}, spaces: [] });
  const k = rowKey(s[0].rows[0]);
  const html = sectionsMarkup(s, { selected: new Set([k]), editing: k });
  assert.ok(!html.includes("<b>위험</b>"));
  assert.ok(html.includes("&lt;b&gt;위험&lt;/b&gt;"));
  assert.ok(html.includes('class="bkm-row on'));
  assert.ok(html.includes("data-bkm-rename"));
});
