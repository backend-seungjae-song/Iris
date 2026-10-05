// 로컬 창의 폴더 감시는 허용 루트에 묶이지 않는다. 원격 연결은 계속 허용 루트 안만 감시한다.
// 확인 결과: 서버가 막 떠 허용 루트가 비어 있을 때 온 fs.watch 가 버려져, 서버 재시작 뒤 열린 표 탭이
// 외부 변경을 반영하지 않았다. 워크스페이스 밖에서 연 파일도 같은 이유로 반영되지 않았다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleFsWatch, closeFsClient } from "../server/fs-handlers.js";
import { replace } from "../server/runtime-state.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iris-fs-watch-")));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const client = (local) => {
  const got = [];
  return { ws: { _local: local, readyState: 1, send: (raw) => got.push(JSON.parse(raw)) }, got };
};
const waitFor = async (fn, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("허용 루트가 비어 있어도 로컬 창은 변경 알림을 받는다", async () => {
  replace({ allowedRoots: [] });
  const local = client(true), remote = client(false);
  handleFsWatch(local.ws, { dirs: [dir] });
  handleFsWatch(remote.ws, { dirs: [dir] });
  fs.writeFileSync(path.join(dir, "a.csv"), "x\n");
  assert.ok(await waitFor(() => local.got.some((m) => m.type === "dir-changed" && m.dir === dir)), "로컬 창이 알림을 받아야 한다");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(remote.got.length, 0, "원격 연결은 허용 루트 밖을 감시하지 않는다");
  closeFsClient(local.ws); closeFsClient(remote.ws);
});
