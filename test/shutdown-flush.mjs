// 내려갈 때 밀린 쓰기를 끝낸다.
//
// 탭·북마크(200ms)·스페이스 열쇠(200ms)·보관(120ms)은 잦은 변경을 한 번으로 합치려고 지연을
// 둔다. 앱이 서버를 소유해서 앱을 끌 때마다 SIGTERM 이 오므로, 이 지연 창을 지나는 일이
// 일상적으로 일어난다.
//
// 이 검사는 "지연 창 안에서 종료되면 실제로 잃는다"를 먼저 보이고, 그 다음 flush가 그것을
// 막는 것을 본다. 잃는 경우를 보이지 않으면 이 검사는 아무것도 보장하지 않는다.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sliceBetween, sliceFrom } from "../bin/slice-anchor.mjs";

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ac-flush-"));

// 모듈이 로드 시점의 IRIS_STATE_DIR를 붙잡으므로 import마다 폴더를 갈아 끼운다.
async function loadWithStateDir(spec, dir) {
  process.env.IRIS_STATE_DIR = dir;
  return import(`${spec}?dir=${encodeURIComponent(dir)}`);
}

test("탭·북마크 — 지연 창에서 잃고, flush로 지킨다", async () => {
  const lost = freshDir();
  const bs1 = await loadWithStateDir("../server/browser-state.js", lost);
  bs1.load();
  bs1.mutate({ op: "bookmark.add", space: "w1", url: "https://example.com", title: "예시" });
  // flush 없이 지금 종료하면 파일은 아직 없다.
  assert.equal(fs.existsSync(path.join(lost, "browser-state.json")), false,
    "지연 창 안에서는 아직 디스크에 없다 — 여기서 죽으면 잃는다는 뜻");

  const kept = freshDir();
  const bs2 = await loadWithStateDir("../server/browser-state.js", kept);
  bs2.load();
  bs2.mutate({ op: "bookmark.add", space: "w1", url: "https://example.com", title: "예시" });
  assert.equal(bs2.flushNow(), true, "밀린 쓰기가 있으면 flush는 그것을 썼다고 답해야 한다");
  const saved = JSON.parse(fs.readFileSync(path.join(kept, "browser-state.json"), "utf8"));
  assert.ok(JSON.stringify(saved).includes("https://example.com"), "flush 뒤에는 디스크에 있어야 한다");
  assert.equal(bs2.flushNow(), false, "밀린 것이 없으면 아무것도 하지 않는다");

  fs.rmSync(lost, { recursive: true, force: true });
  fs.rmSync(kept, { recursive: true, force: true });
});

test("보관 — 접은 세션이 지연 창에서 사라지지 않는다", async () => {
  const dir = freshDir();
  const archive = await loadWithStateDir("../server/archive.js", dir);
  archive.load();
  archive.add({ id: "a1", kind: "agent", label: "세션 하나", space: "w1", tail: "마지막 화면" });
  assert.equal(archive.flushNow(), true);
  const file = path.join(dir, "archives.json");
  assert.ok(fs.existsSync(file), "보관은 되돌릴 수 없는 쪽이다 — 접자마자 잃으면 되살릴 길이 없다");
  assert.ok(fs.readFileSync(file, "utf8").includes("세션 하나"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("서버는 종료 신호에서 여섯 축을 모두 민다", () => {
  // 실제 신호 경로는 프로세스를 종료해야 보이므로, 여기서는 종료 처리기가 각 owner의 flush port를
  // 부르고 browser-runtime port가 핸들·지목 두 축을 함께 반영하는지 본다. 하나라도 빠지면 그 축의
  // 마지막 변경이 조용히 사라진다.
  const src = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const fn = sliceBetween(src, "function flushPendingState()", "for (const sig of", "종료 시 상태 비우기");
  for (const mod of ["flushBrowserStateNow()", "spaceKey.flushNow()", "archive.flushNow()",
                     "flushBrowserRuntimeNow()", "flushMemoNow()"]) {
    assert.ok(fn.includes(mod), `종료 처리기가 ${mod}를 부르지 않는다`);
  }
  const runtime = fs.readFileSync(new URL("../server/browser-runtime.js", import.meta.url), "utf8");
  const runtimeFlush = sliceBetween(runtime, "function flushNow()", "export {", "런타임 즉시 비우기");
  for (const owned of ["flushHandlesNow()", "flushGrantsNow()"]) {
    assert.ok(runtimeFlush.includes(owned), `browser-runtime flush port가 ${owned}를 부르지 않는다`);
  }
  assert.ok(/process\.on\(sig, \(\) => \{\s*flushPendingState\(\);/.test(src),
    "flush가 자물쇠 해제·exit보다 먼저 와야 한다 — 뒤에 두면 exit(0)이 먼저 끝낸다");
});
