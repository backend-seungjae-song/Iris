// 소유 범위: 부산물이 저장되는 위치(server/artifacts-home.cjs)와 그 정본을 거치지 않는 생산자,
//   이전 위치에서 옮겨 오는 이전 처리, 그리고 설정의 「부산물」 분류가 무엇을 내고 무엇을 안 내는지.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, Node 파일·경로·프로세스 API.
// 유지 조건: 삭제하는 검사를 여기에 두지 않는다. 이 절은 임시 폴더 안에서만 파일을 만든다.
// 영향 범위: 러너가 동적 import 로 이 run 을 호출한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/artifacts-home.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { cannotMeasure, check, checkAsync, read, require_, ROOT } from "../core.mjs";

const artifacts = require_("../server/artifacts-home.cjs");

function tracked() {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  if (files.length < 50) cannotMeasure(`git 이 아는 파일이 ${files.length}개뿐 — 이 목록으로는 아무것도 못 지킨다`);
  return files;
}

// 상태 폴더 루트에 종류 이름을 바로 이어 붙이는 위치를 찾는다. 정본을 거치지 않으면 한 곳만
// 어긋나도 이전 위치에 쌓이는 파일을 화면에서 확인할 수 없다.
const KIND_NAMES = artifacts.ARTIFACT_KINDS.map((k) => k.id);
const HAND_WRITTEN = new RegExp(
  String.raw`path\.join\(\s*(?:stateHome\(\)|IRIS_HOME|stateDir|home)\s*,\s*"(?:${KIND_NAMES.join("|")})"`,
);

export default async function run() {
  console.log("[부산물 — 한 자리에 모으고 사람이 정리한다]");

  check("계측기가 손으로 짠 자리를 실제로 집어낸다", () => {
    // 0건이 나왔을 때 위반이 없는 것인지 집계하지 못한 것인지 구분하는 것이 이 한 줄이다.
    if (!HAND_WRITTEN.test('const d = path.join(IRIS_HOME, "shots");')) throw new Error("아는 위반을 못 잡는다");
    if (HAND_WRITTEN.test('const d = path.join(IRIS_HOME, "browser-session");')) throw new Error("상태 폴더까지 잡는다");
    return true;
  });

  check("부산물 자리를 손으로 짜는 파일이 없다", () => {
    // 정본 자신과 위반 패턴을 문자열로 담고 있는 이 파일은 제외한다. 그러지 않으면 검사가 자기 표본에 걸린다.
    const owners = new Set(["server/artifacts-home.cjs", "bin/smoke/sections/artifacts-home.mjs"]);
    const bad = tracked().filter((f) => {
      if (owners.has(f) || !/\.(js|mjs|cjs)$/.test(f)) return false;
      let text; try { text = read(f); } catch { return false; }
      return HAND_WRITTEN.test(text);
    });
    if (bad.length) throw new Error("정본을 안 거친 자리: " + bad.join(", "));
    return true;
  });

  check("종류 표에 없는 이름으로는 자리를 못 받는다", () => {
    for (const id of KIND_NAMES) {
      const dir = artifacts.artifactDir(id, "/x");
      if (dir !== path.join("/x", "artifacts", id)) throw new Error(`${id} 자리가 다르다: ${dir}`);
    }
    let threw = false;
    try { artifacts.artifactDir("browser-session", "/x"); } catch { threw = true; }
    if (!threw) throw new Error("표에 없는 이름을 그냥 받아 준다");
    return true;
  });

  // 상태·영수증·이전본은 부산물이 아니다. 지우면 복원할 수 없거나 진행 중인 작업이 중단된다.
  check("영수증과 이전본은 부산물로 옮기지 않는다", () => {
    for (const name of ["agent-context", "agent-lineage", "memolab-history", "backup", "browser-session"]) {
      if (KIND_NAMES.includes(name)) throw new Error(`${name} 이 정리 대상에 들어갔다`);
    }
    if (!/artifactDir\("agent-run"\)/.test(read("bin/agent-run.mjs"))) throw new Error("실행 기록이 정본을 안 거친다");
    if (/artifacts-home/.test(read("server/memolab-store.js"))) throw new Error("이전본이 부산물로 갔다");
    if (/artifacts-home/.test(read("server/agent-lineage.js"))) throw new Error("계보 영수증이 부산물로 갔다");
    return true;
  });

  check("이전은 옛 자리의 것을 새 자리로 옮기고 나머지는 안 건드린다", () => {
    const home = mkdtempSync(path.join(tmpdir(), "iris-artifacts-"));
    try {
      const put = (rel, body) => {
        const file = path.join(home, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, body);
      };
      put("shots/a.png", "A");
      put("qa/run1/journal.jsonl", "{}\n");
      put("shot-1757400000000.png", "STRAY");
      put("browser-state.json", "{}");
      put("memolab-history/old.json", "{}");

      artifacts.migrateArtifacts(home);

      const at = (rel) => path.join(home, rel);
      if (readFileSync(at("artifacts/shots/a.png"), "utf8") !== "A") throw new Error("캡처가 안 옮겨졌다");
      if (!existsSync(at("artifacts/qa/run1/journal.jsonl"))) throw new Error("회차가 안 옮겨졌다");
      if (!existsSync(at("artifacts/shots/shot-1757400000000.png"))) throw new Error("뿌리에 흘린 캡처가 그대로다");
      if (existsSync(at("shots")) || existsSync(at("qa"))) throw new Error("옛 폴더가 남았다");
      if (!existsSync(at("browser-state.json"))) throw new Error("상태 파일을 건드렸다");
      if (!existsSync(at("memolab-history/old.json"))) throw new Error("이전본을 옮겼다");

      // 앱이 시작할 때마다 호출하므로 두 번 실행해도 결과가 같아야 한다.
      artifacts.migrateArtifacts(home);
      if (readFileSync(at("artifacts/shots/a.png"), "utf8") !== "A") throw new Error("두 번째 이전이 망가뜨렸다");
      return true;
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  check("이름이 겹치면 새 자리의 것이 이기고 옛 것을 안 지운다", () => {
    const home = mkdtempSync(path.join(tmpdir(), "iris-artifacts-"));
    try {
      // 이전 위치와 새 위치를 함수로 지정한다. 여기에 문자열로 적으면 위의 「손으로 짜는 자리」
      // 검사가 이 픽스처를 위반으로 판정한다.
      const was = (...rest) => path.join(home, "shots", ...rest);
      const now = (...rest) => path.join(artifacts.artifactDir("shots", home), ...rest);
      mkdirSync(was(), { recursive: true });
      mkdirSync(now(), { recursive: true });
      writeFileSync(was("a.png"), "OLD");
      writeFileSync(was("b.png"), "MOVED");
      writeFileSync(now("a.png"), "NEW");

      artifacts.migrateArtifacts(home);

      if (readFileSync(now("a.png"), "utf8") !== "NEW") throw new Error("새 자리의 것을 덮었다");
      if (readFileSync(was("a.png"), "utf8") !== "OLD") throw new Error("못 옮긴 것을 지웠다");
      if (readFileSync(now("b.png"), "utf8") !== "MOVED") throw new Error("안 겹치는 것도 안 옮겼다");
      return true;
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  await checkAsync("정리 화면은 종류마다 이름·크기와 비우는 버튼을 낸다", async () => {
    const view = await import(new URL("../../../web/js/devtool/artifacts-view.js", import.meta.url).href);
    const model = {
      kinds: [
        { id: "shots", label: "화면 캡처", desc: "찍은 것", dir: "/x/artifacts/shots", count: 3, bytes: 2048 },
        { id: "qa", label: "QA 회차", desc: "회차 기록", dir: "/x/artifacts/qa", count: 0, bytes: 0 },
      ],
      total: { count: 3, bytes: 2048 },
      open: "shots",
      days: { kind: "shots", dir: "/x/artifacts/shots", days: [{ date: "2026-09-09", count: 1, bytes: 1024, items: 1 }] },
      openDay: "2026-09-09",
      day: { kind: "shots", date: "2026-09-09", dir: "/x/artifacts/shots", more: 0, paths: [],
        entries: [{ name: "a.png", path: "/x/artifacts/shots/a.png", dir: false, count: 1, bytes: 1024, mtime: 1757400000000 }] },
      canTrash: true,
    };
    const html = view.artifactsPane(model);
    for (const want of ["화면 캡처", "2.0 KB", 'data-art-kind="shots"', 'data-art-empty="shots"',
      'data-art-del="/x/artifacts/shots/a.png"', "art-empty-all", "휴지통"]) {
      if (!html.includes(want)) throw new Error(`정리 화면에 ${want} 가 없다`);
    }
    // 비어 있는 종류에는 비우기 버튼을 표시하지 않는다. 눌러도 아무 일이 없으면 사용자는 고장으로 판단한다.
    if (html.includes('data-art-empty="qa"')) throw new Error("빈 종류에도 비우기를 냈다");
    // 휴지통 경로가 없는 창에서는 삭제 조작 자체를 표시하지 않는다.
    const readOnly = view.artifactsPane({ ...model, canTrash: false });
    for (const gone of ["data-art-empty=", "data-art-del=", "data-art-day-empty=", "art-empty-all"]) {
      if (readOnly.includes(gone)) throw new Error(`휴지통이 없는 창에 ${gone} 를 그렸다`);
    }
    if (!readOnly.includes('data-art-kind="shots"')) throw new Error("목록까지 사라졌다");
    return true;
  });

  await checkAsync("부산물 배선이 붙잡는 이름이 그림에 다 있다", async () => {
    const view = await import(new URL("../../../web/js/devtool/artifacts-view.js", import.meta.url).href);
    const wiring = read("web/js/devtool/artifacts-page.js")
      .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const names = [...wiring.matchAll(/closest\("\[([a-z-]+)\]"\)/g)].map((m) => m[1] + "=");
    const ids = [...wiring.matchAll(/closest\("#([a-z-]+)"\)/g)].map((m) => `id="${m[1]}"`);
    if (names.length + ids.length < 5) throw new Error(`배선에서 이름을 ${names.length + ids.length}개밖에 못 뽑았다`);
    const html = view.artifactsPane({
      kinds: [{ id: "shots", label: "화면 캡처", desc: "찍은 것", dir: "/x/artifacts/shots", count: 1, bytes: 10 }],
      total: { count: 1, bytes: 10 },
      open: "shots",
      days: { kind: "shots", dir: "/x/artifacts/shots", days: [{ date: "2026-09-09", count: 1, bytes: 10, items: 1 }] },
      openDay: "2026-09-09",
      day: { kind: "shots", date: "2026-09-09", dir: "/x/artifacts/shots", more: 0, paths: [],
        entries: [{ name: "a.png", path: "/x/artifacts/shots/a.png", dir: false, count: 1, bytes: 10, mtime: 1 }] },
      preview: { path: "/x/artifacts/shots/a.png", what: "text", name: "a.png", text: "안" },
      canTrash: true,
    });
    const missing = [...names, ...ids].filter((n) => !html.includes(n));
    if (missing.length) throw new Error("그림에 없는 이름: " + missing.join(", "));
    return true;
  });

  // 삭제 경로는 휴지통 하나뿐이다. 서버가 직접 지우면 복원할 수 없고, 화면이 직접 지우면
  // 사용자가 고른 범위 밖까지 삭제될 수 있다.
  check("정리는 지우지 않고 휴지통으로 보낸다", () => {
    const page = read("web/js/devtool/artifacts-page.js");
    if (!/acHost\.trashItem/.test(page)) throw new Error("휴지통 통로를 안 쓴다");
    for (const gone of ["rmSync", "unlinkSync", "fs.rm(", "rmdirSync"]) {
      if (page.includes(gone)) throw new Error(`화면이 ${gone} 로 직접 지운다`);
    }
    const server = read("server/artifacts-handlers.js");
    for (const gone of ["rmSync", "unlinkSync", "rmdirSync", "renameSync"]) {
      if (server.includes(gone)) throw new Error(`서버가 ${gone} 로 부산물을 건드린다`);
    }
    return true;
  });

  await checkAsync("종류를 펼치면 날짜가 서고 날짜마다 비울 수 있다", async () => {
    const view = await import(new URL("../../../web/js/devtool/artifacts-view.js", import.meta.url).href);
    const html = view.artifactsPane({
      kinds: [{ id: "shots", label: "화면 캡처", desc: "찍은 것", dir: "/x/artifacts/shots", count: 4, bytes: 40 }],
      total: { count: 4, bytes: 40 },
      open: "shots",
      days: {
        kind: "shots", dir: "/x/artifacts/shots",
        days: [{ date: "2026-09-09", count: 1, bytes: 10, items: 1 }, { date: "2026-09-02", count: 3, bytes: 30, items: 3 }],
      },
      openDay: "2026-09-09",
      day: { kind: "shots", date: "2026-09-09", dir: "/x/artifacts/shots", more: 0, paths: [],
        entries: [{ name: "a.png", path: "/x/artifacts/shots/a.png", dir: false, count: 1, bytes: 10, mtime: 1757400000000 }] },
      canTrash: true,
    });
    for (const want of ["2026-09-09", "2026-09-02", 'data-art-day="2026-09-02"',
      'data-art-day-empty="2026-09-02"', 'data-art-open="/x/artifacts/shots/a.png"']) {
      if (!html.includes(want)) throw new Error(`날짜 목록에 ${want} 가 없다`);
    }
    // 펼친 날짜의 항목만 표시한다. 다른 날짜까지 펼치면 수천 줄이 한꺼번에 그려진다.
    const only = html.split('data-art-day="2026-09-02"')[1] || "";
    if (only.includes("data-art-del=")) throw new Error("안 펼친 날짜의 항목까지 그렸다");
    return true;
  });

  await checkAsync("미리보기는 종류마다 그에 맞는 지면을 낸다", async () => {
    const view = await import(new URL("../../../web/js/devtool/artifacts-view.js", import.meta.url).href);
    const base = {
      kinds: [{ id: "shots", label: "화면 캡처", desc: "", dir: "/x/artifacts/shots", count: 1, bytes: 10 }],
      total: { count: 1, bytes: 10 },
      open: "shots",
      days: { kind: "shots", dir: "/x/artifacts/shots", days: [{ date: "2026-09-09", count: 1, bytes: 10, items: 1 }] },
      openDay: "2026-09-09",
      day: { kind: "shots", date: "2026-09-09", dir: "/x/artifacts/shots", more: 0, paths: [],
        entries: [{ name: "a.png", path: "/p/a.png", dir: false, count: 1, bytes: 10, mtime: 1 }] },
      canTrash: true,
    };
    const pane = (preview) => view.artifactsPane({ ...base, preview });
    const img = pane({ path: "/p/a.png", what: "image", name: "a.png", mime: "image/png", data: "QUJD", bytes: 10 });
    // 이미지는 바이트로 표시한다. file:// 을 지정하면 이 창에서는 빈 영역으로 남는다.
    if (!img.includes("data:image/png;base64,QUJD")) throw new Error("그림을 바이트로 안 띄운다");
    if (/src="file:/.test(img)) throw new Error("그림을 file:// 로 띄운다");
    const txt = pane({ path: "/p/a.png", what: "text", name: "a.png", text: "<b>날것</b>", bytes: 10 });
    if (!txt.includes("&lt;b&gt;")) throw new Error("글을 escape 하지 않는다");
    const dir = pane({ path: "/p/a.png", what: "dir", name: "run1", more: 0,
      entries: [{ name: "journal.jsonl", path: "/p/run1/journal.jsonl", dir: false, bytes: 4, mtime: 1 }] });
    if (!dir.includes('data-art-open="/p/run1/journal.jsonl"')) throw new Error("폴더 안을 못 연다");
    const big = pane({ path: "/p/a.png", what: "too-big", name: "a.png", bytes: 20 * 1024 * 1024 });
    if (!big.includes("너무 큽니다")) throw new Error("너무 큰 것을 그대로 실으려 한다");
    const bad = pane({ path: "/p/a.png", error: "부산물 폴더 안의 파일이 아닙니다" });
    if (!bad.includes("부산물 폴더 안의 파일이 아닙니다")) throw new Error("거절 사유를 안 보여 준다");
    return true;
  });

  await checkAsync("폴더 안의 파일을 열어도 그 폴더 줄 아래에 표시된다", async () => {
    const view = await import(new URL("../../../web/js/devtool/artifacts-view.js", import.meta.url).href);
    const dirRow = { name: "run1", path: "/p/run1", dir: true, count: 2, bytes: 20, mtime: 1 };
    const html = view.artifactsPane({
      kinds: [{ id: "qa", label: "QA 회차", desc: "", dir: "/x/artifacts/qa", count: 2, bytes: 20 }],
      total: { count: 2, bytes: 20 },
      open: "qa",
      days: { kind: "qa", dir: "/x/artifacts/qa", days: [{ date: "2026-09-02", count: 2, bytes: 20, items: 1 }] },
      openDay: "2026-09-02",
      day: { kind: "qa", date: "2026-09-02", dir: "/x/artifacts/qa", more: 0, paths: [], entries: [dirRow] },
      dirPreview: { path: "/p/run1", what: "dir", name: "run1", more: 0,
        entries: [{ name: "journal.jsonl", path: "/p/run1/journal.jsonl", dir: false, bytes: 4, mtime: 1 }] },
      preview: { path: "/p/run1/journal.jsonl", what: "text", name: "journal.jsonl", text: "{}", bytes: 4 },
      canTrash: true,
    });
    // 목록이 남은 채로 고른 파일이 표시된다. 목록이 사라지면 다른 파일로 이동할 방법이 없다.
    if (!html.includes('data-art-open="/p/run1/journal.jsonl"')) throw new Error("폴더 목록이 사라졌다");
    if (!html.includes("art-pv-txt")) throw new Error("고른 파일이 표시되지 않는다");
    return true;
  });

  await checkAsync("서버는 날짜 비우기 목록을 상한 없이 주고 부산물 밖은 안 연다", async () => {
    const { handleArtifacts } = await import(new URL("../../../server/artifacts-handlers.js", import.meta.url).href);
    const tmp = mkdtempSync(path.join(tmpdir(), "iris-artifacts-day-"));
    const before = process.env.IRIS_STATE_DIR;
    try {
      process.env.IRIS_STATE_DIR = tmp;
      const shots = path.join(tmp, "artifacts", "shots");
      mkdirSync(shots, { recursive: true });
      // 화면 상한(300)을 넘겨야 목록 상한이 삭제 상한까지 제한하는지 구분된다.
      for (let i = 0; i < 320; i++) writeFileSync(path.join(shots, `shot-${i}.png`), "x");
      const sent = [];
      const ws = { _local: true, send: (s) => sent.push(JSON.parse(s)) };
      handleArtifacts(ws, { type: "artifacts.entries", kind: "shots" });
      const days = sent.pop();
      if (!days.days.length) throw new Error("날짜 요약이 비었다");
      const date = days.days[0].date;
      handleArtifacts(ws, { type: "artifacts.day", kind: "shots", date });
      const day = sent.pop();
      if (day.entries.length !== 300) throw new Error(`화면 목록이 ${day.entries.length}줄 — 상한 300 이 아니다`);
      if (day.paths.length !== 320) throw new Error(`비우기 목록이 ${day.paths.length}개 — 안 보이는 것이 빠졌다`);
      if (day.more !== 20) throw new Error(`남은 수를 ${day.more} 로 셌다`);
      // 부산물 폴더 밖은 열지 않는다. 심링크로 우회하는 경로도 막혔는지 함께 확인한다.
      handleArtifacts(ws, { type: "artifacts.preview", path: "/etc/hosts" });
      const outside = sent.pop();
      if (!outside.error) throw new Error("부산물 폴더 밖을 열어 줬다");
      const link = path.join(shots, "밖으로.png");
      symlinkSync("/etc/hosts", link);
      handleArtifacts(ws, { type: "artifacts.preview", path: link });
      const viaLink = sent.pop();
      if (!viaLink.error) throw new Error("심링크로 밖이 열린다");
      // 원격 연결에는 아무것도 안 보낸다.
      const remote = { _local: false, send: () => { throw new Error("원격에 답했다"); } };
      handleArtifacts(remote, { type: "artifacts.day", kind: "shots", date });
      return true;
    } finally {
      if (before === undefined) delete process.env.IRIS_STATE_DIR;
      else process.env.IRIS_STATE_DIR = before;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
