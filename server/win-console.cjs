// Windows 전용: 서버가 실행하는 자식 프로세스의 콘솔 창 숨김
// 서버는 콘솔 없이 실행되므로 git 같은 콘솔 프로그램을 부를 때마다 새 콘솔 창이 잠깐 뜸
// 호출부마다 windowsHide 를 넣는 대신 서버 시작 시 child_process 기본값으로 한 번 지정
// macOS·Linux: 아무것도 바꾸지 않음
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

if (process.platform === "win32") {
  // spawn·exec·execFile·fork: 모두 ChildProcess.prototype.spawn 을 거침
  const spawnAsync = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function spawn(options) {
    if (options && typeof options === "object") options.windowsHide = true;
    return spawnAsync.call(this, options);
  };

  // 동기 실행: 옵션 객체가 없으면 마지막 인자로 추가
  const isOptions = (v) => v && typeof v === "object" && !Array.isArray(v);
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const original = childProcess[name];
    childProcess[name] = function hidden(...args) {
      const at = args.findLastIndex(isOptions);
      if (at > 0) args[at] = { ...args[at], windowsHide: true };
      else args.push({ windowsHide: true });
      return original.apply(this, args);
    };
  }
  // ESM 의 `import { execFileSync } from "node:child_process"` 에도 반영
  syncBuiltinESMExports();
}
