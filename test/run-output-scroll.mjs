import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// RUN_SRC: 고치기 전 판의 run.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ RUN_SRC: "/js/devtool/run.js" });

test("실행 출력은 위로 올려 읽는 동안 새 출력이 와도 그 위치, 맨 아래를 보던 때만 따라 내림", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const run = await import("/js/devtool/run.js");
    run.initRun({ $: (s) => document.querySelector(s), esc: (s) => String(s), wsSend() {}, spaceRootFor: () => "/p",
      getSelectedSpaceId: () => "s1", getSpaces: () => [{ id: "s1", folder: "/p" }] });
    const wait = () => new Promise((ok) => setTimeout(ok, 260));   // 출력 그리기는 200ms 로 묶음
    const lines = (from, n) => Array.from({ length: n }, (_, i) => `줄 ${from + i}`).join("\n");
    run.handleRunMessage({ type: "run-scripts", path: "/p", ok: true, scripts: { dev: "vite" } });
    run.handleRunMessage({ type: "run-started", cwd: "/p", script: "dev" });
    run.handleRunMessage({ type: "run-output", cwd: "/p", data: lines(0, 80) }); await wait();
    const out = () => document.getElementById("run-out");
    const bottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    const followed = bottom(out());
    out().scrollTop = 40;
    run.handleRunMessage({ type: "run-output", cwd: "/p", data: "새 줄" }); await wait();
    const kept = out().scrollTop;
    out().scrollTop = out().scrollHeight;
    run.handleRunMessage({ type: "run-output", cwd: "/p", data: "또 새 줄" }); await wait();
    return { followed, kept, followAgain: bottom(out()) };
  }), { body: `<link rel="stylesheet" href="/css/08-run.css"><div id="run-body" style="height:200px;display:flex"></div><div id="run-meta"></div>`, overrides });
  assert.equal(r.followed, true, "처음 출력은 맨 아래");
  assert.equal(r.kept, 40, "올려 읽던 위치 유지");
  assert.equal(r.followAgain, true, "맨 아래를 보던 때는 따라 내림");
});
