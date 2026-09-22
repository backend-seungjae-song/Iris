import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { bootCapabilities } from "../web/js/core/capability-boot.js";

test("WS 중복 거절은 실제 main 배선에서 실패로 올라가고 다음 기능은 계속 부팅한다", async () => {
  const main = fs.readFileSync(new URL("../web/js/main.js", import.meta.url), "utf8");
  const match = main.match(/onWs: (\(type, fn, id\) => \{[\s\S]*?\n    \}),\n    onError:/);
  assert.ok(match, "main의 WS 등록 콜백");
  const first = () => "first";
  const dispatch = { shared: first };
  const onWs = vm.runInNewContext(`(${match[1]})`, { WS_DISPATCH: dispatch, dispatchWs: (fn) => fn, console: { error() {} } });
  const errors = [];
  const loaded = await bootCapabilities({
    items: [
      { id: "duplicate", load: async () => ({ initCapability: () => ({ ws: { shared() {} } }) }) },
      { id: "next", load: async () => ({ initCapability: () => ({ ws: { own() {} } }) }) },
    ],
    onWs, onError: (id, error) => errors.push([id, error.message]),
  });
  assert.deepEqual(loaded, ["next"]);
  assert.equal(errors[0][0], "duplicate");
  assert.match(errors[0][1], /WS 중복 등록 shared/);
  assert.equal(dispatch.shared, first);
  assert.equal(typeof dispatch.own, "function");
});
