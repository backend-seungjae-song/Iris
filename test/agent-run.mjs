import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { paneScript, quote, envFile, runtimeOf, ENV_DENY, BANNER } from "../bin/agent-run.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("quote가 작은따옴표를 담은 값을 셸이 다시 해석하지 못하게 닫는다", () => {
  assert.equal(quote("plain"), "'plain'");
  // 닫고 이스케이프하고 다시 여는 형태. 이것이 깨지면 인자 하나가 명령으로 실행된다.
  assert.equal(quote("it's"), `'it'\\''s'`);
  assert.equal(quote("a; rm -rf /"), "'a; rm -rf /'");
  assert.equal(quote("$(whoami)"), "'$(whoami)'");
});

test("자식 팬 env에서 팬 정체성 변수를 뺀다", () => {
  const text = envFile({ SAFE: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/s", TERM: "xterm", PWD: "/tmp" });
  assert.match(text, /^SAFE='1'$/m);
  for (const key of ["HERDR_PANE_ID", "HERDR_SOCKET_PATH", "TERM", "PWD"]) {
    assert.ok(!text.includes(`${key}=`), `${key}를 자식에게 물려주면 자식이 부모 팬을 자기라고 읽는다`);
  }
});

test("env 이름이 셸 식별자가 아니면 싣지 않는다", () => {
  const text = envFile({ "BASH_FUNC_x%%": "() { :; }", "a-b": "1", OK: "2" });
  assert.match(text, /^OK='2'$/m);
  assert.ok(!text.includes("BASH_FUNC"));
  assert.ok(!text.includes("a-b"));
});

test("팬 스크립트가 stdout과 stderr를 갈라 남긴다", () => {
  const script = paneScript("/state/job", ["codex", "exec", "-m", "x"], "/repo");
  // 합치면 부르는 쪽이 둘을 갈라 판정하던 근거가 사라진다.
  assert.ok(!/2>&1/.test(script), "stdout·stderr를 합치면 안 된다");
  assert.match(script, /tee '\/state\/job\/out\.log'/);
  assert.match(script, /tee '\/state\/job\/err\.log' >&2/);
});

test("팬 스크립트가 tee를 기다린 뒤에 종료 코드를 공개한다", () => {
  const script = paneScript("/state/job", ["codex"], "/repo");
  const status = script.indexOf("status=$?");
  const wait = script.indexOf("\nwait");
  const publish = script.indexOf("status.txt'.tmp");
  assert.ok(status > 0 && wait > status, "종료 코드는 명령 직후에 잡는다");
  assert.ok(publish > wait, "wait보다 먼저 공개하면 기다리던 쪽이 잘린 출력을 완성본으로 읽는다");
  // 원자적 공개. 반쯤 쓰인 파일을 종료 코드로 읽는 회차가 없어야 한다.
  assert.match(script, /mv '\/state\/job\/status\.txt'\.tmp '\/state\/job\/status\.txt'/);
});

test("팬 스크립트가 무엇을 보는 창인지 먼저 밝힌다", () => {
  // 이 팬은 대화형 세션과 형태가 다르다. 이유를 적지 않으면 "왜 이 창만 평문인가"로 읽힌다.
  const script = paneScript("/state/job", ["codex"], "/repo");
  for (const line of BANNER) assert.ok(script.includes(quote(line)), `배너 줄이 빠졌다: ${line}`);
});

test("배너가 리다이렉트보다 앞에 선다", () => {
  // 뒤로 가면 tee 를 타고 기록 파일에 섞이고, 부르는 쪽의 마커·session id 파싱이 배너를
  // 산출로 읽는다. 화면에만 보이는 것이 이 줄들의 조건이다.
  const script = paneScript("/state/job", ["codex"], "/repo");
  const lastBanner = script.lastIndexOf(quote(BANNER[BANNER.length - 1]));
  const firstTee = script.indexOf("tee ");
  assert.ok(lastBanner > 0 && firstTee > 0, "둘 다 있어야 위치를 잴 수 있다");
  assert.ok(lastBanner < firstTee, "배너가 tee 뒤로 가면 기록 파일이 오염된다");
});

test("팬 스크립트가 stdin을 파일로 넘긴다", () => {
  const script = paneScript("/state/job", ["codex"], "/repo");
  assert.match(script, /< '\/state\/job\/in\.txt'/);
});

test("팬 스크립트가 재래핑을 막는 표식을 세운다", () => {
  const script = paneScript("/state/job", ["codex"], "/repo");
  assert.match(script, /export IRIS_AGENT_RUN_ACTIVE=1/);
  assert.ok(ENV_DENY.has("IRIS_AGENT_RUN_ACTIVE"), "표식을 부모 env로 덮으면 자식이 또 감싼다");
});

test("런타임은 명령 이름에서 읽고 모르는 것은 감싸지 않는다", () => {
  assert.equal(runtimeOf("/usr/local/bin/codex"), "codex");
  assert.equal(runtimeOf("claude"), "claude");
  assert.equal(runtimeOf("bash"), null);
  assert.equal(runtimeOf(""), null);
});

test("래퍼가 설치 앱에 실릴 자리마다 등록돼 있다", () => {
  // 목록 하나만 빠져도 설치된 앱에서 파일이 사라지고, 그때는 조용히 pass-through로 흘러
  // 아무것도 잡히지 않는다.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("bin/agent-run.mjs"), "build.files");
  assert.ok(pkg.build.asarUnpack.includes("bin/agent-run.mjs"), "asarUnpack");
  const installer = fs.readFileSync(path.join(ROOT, "scripts", "install-agent-context.mjs"), "utf8");
  assert.ok(installer.includes('"bin/agent-run.mjs"'), "install preflight");
});
