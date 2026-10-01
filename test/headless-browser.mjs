import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { headlessLaunchOptions, headlessShellCandidates } from "../bin/headless-browser.cjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-headless-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executable = (relative) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return file;
  };
  return { home, executable };
}

test("자동 검사는 설치된 headless shell을 선택한다", (t) => {
  const { home, executable } = fixture(t);
  const old = executable(".cache/puppeteer/chrome-headless-shell/mac_arm-1/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  fs.utimesSync(old, 1, 1);
  const latest = executable("Library/Caches/ms-playwright/chromium_headless_shell-2/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  executable("Library/Caches/ms-playwright/chromium-3/chrome-mac-arm64/Google Chrome for Testing");
  assert.deepEqual(headlessShellCandidates(home), [latest, old]);
  assert.deepEqual(headlessLaunchOptions({ home, env: {} }), { executablePath: latest, headless: "shell" });
});

test("설치가 없으면 일반 Chrome으로 넘어가지 않는다", (t) => {
  const { home, executable } = fixture(t);
  executable("Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.throws(() => headlessLaunchOptions({ home, env: {} }), /chrome-headless-shell/);
});

test("환경변수로 일반 Chrome을 지정해도 실행하지 않는다", (t) => {
  const { home, executable } = fixture(t);
  const chrome = executable("Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  for (const key of ["CHROME_BIN", "IRIS_HEADLESS_SHELL"]) {
    assert.throws(() => headlessLaunchOptions({ home, env: { [key]: chrome } }), /chrome-headless-shell/);
  }
  const shell = executable("shell/chrome-headless-shell");
  assert.equal(headlessLaunchOptions({ home, env: { IRIS_HEADLESS_SHELL: shell } }).executablePath, shell);
});

test("일반 Chrome을 가리키는 별칭과 실행 불가 파일을 거절한다", (t) => {
  const { home, executable } = fixture(t);
  const chrome = executable("Google Chrome");
  const alias = path.join(home, "chrome-headless-shell");
  fs.symlinkSync(chrome, alias);
  assert.throws(() => headlessLaunchOptions({ home, env: { IRIS_HEADLESS_SHELL: alias } }), /chrome-headless-shell/);
  fs.unlinkSync(alias);
  fs.writeFileSync(alias, "not executable", { mode: 0o600 });
  assert.throws(() => headlessLaunchOptions({ home, env: { IRIS_HEADLESS_SHELL: alias } }), /chrome-headless-shell/);
});
