import { spawnSync } from "node:child_process";
import { check } from "../core.mjs";
export default async function run() {
  check("QA 명령 허용 목록·소유권·판정 경계", () => {
    const result = spawnSync(process.execPath, ["--test", "test/qa-native3.test.mjs", "test/qa-migration3.test.mjs", "test/qa-mobile-extras.test.mjs", "test/qa-channel.mjs", "test/qa-protocol.mjs", "test/qa-ledger-routes.mjs", "test/qa-input.mjs", "test/qa-expect.mjs", "test/qa-placement.mjs", "test/qa-session-contract.test.mjs", "test/qa-ledger-anchor.test.mjs", "test/qa-rows.test.mjs", "test/qa-mobile.test.mjs", "test/qa-report-gates.test.mjs", "test/qa-route-inputs.test.mjs", "test/qa-convenience.test.mjs", "test/qa-report-html.test.mjs"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`exit=${result.status} signal=${result.signal} ${result.error?.message || ""}\n` + (result.stdout + result.stderr).split("\n").filter((line,i,lines)=>line.startsWith("not ok") || lines.slice(Math.max(0,i-12),i).some(l=>l.startsWith("not ok"))).join("\n").slice(0,3000));
    return true;
  });
}
