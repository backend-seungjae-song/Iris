// 스크립트가 끝나면 그 실행이 찍었던 주소는 더 이상 열리지 않으므로 칩으로 남기지 않는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-run-url-"));
process.env.IRIS_STATE_DIR = path.join(root, "state");
const { RunManager } = await import("../server/run.js");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("실행이 끝나면 상태의 주소를 비운다", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, "proj-")));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "p", private: true,
    scripts: { url: "node -e \"console.log('ready at https://example.com/x')\"" } }));
  const events = [];
  const exited = new Promise((resolve) => {
    const runs = new RunManager((m) => { events.push(m); if (m.type === "run-exit") resolve(runs); });
    assert.equal(runs.start(cwd, "url").ok, true);
  });
  const runs = await exited;
  assert.ok(events.some((m) => m.type === "run-url" && m.url === "https://example.com/x"), JSON.stringify(events));
  assert.equal(runs.status(cwd).url, null, "끝난 실행의 주소가 다시 연결한 창에 칩으로 돌아온다");
});

test("창은 종료 알림을 받으면 주소 칩을 지운다", () => {
  const src = fs.readFileSync(new URL("../web/js/devtool/run.js", import.meta.url), "utf8");
  assert.match(src, /m\.type === "run-exit"\) \{\s*const r = runRec\(m\.cwd\); r\.running = false; r\.url = null;/);
});
