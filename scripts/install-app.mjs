#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../server/windows-powershell.cjs";
import path from "node:path";
import { deployWorkerPlan, fullInstallRefusal, planAppInstall, recoverWorkerPlan } from "./mcp-worker/install.mjs";

const windows = process.platform === "win32";
const script = fileURLToPath(new URL(windows ? "./setup-win.ps1" : "./install-app.sh", import.meta.url));
const sourceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);

async function main() {
  const plan = await planAppInstall({ sourceRoot, forceFull: args.includes("--full"), forceRecover: args.includes("--recover") });
  if (plan.action === "none") {
    console.log("설치 앱과 작업 프로세스가 현재 소스와 같습니다.");
    return;
  }
  if (plan.action === "worker-replace") {
    const deployed = await deployWorkerPlan(plan, { sourceRoot, stopObservations: args.includes("--stop-observations") });
    const after = deployed.result.worker || {};
    console.log(`MCP 작업 프로세스 교체 완료 — deploy ${deployed.manifest.deployId}`);
    const main = deployed.continuity.mainPid, server = deployed.continuity.serverPid;
    console.log(`Electron 메인 pid ${main.before} → ${main.after} (${main.unchanged ? "유지" : "변경"})`);
    console.log(`공용 서버 pid ${server.before} → ${server.after} (${server.unchanged ? "유지" : "변경"}) · worker pid ${after.pid || "확인 필요"}`);
    if (plan.reconnectRequired) console.log("MCP 도구 정의가 바뀌었습니다. /mcp reconnect를 실행하세요.");
    return;
  }
  if (plan.action === "worker-recover") {
    const recovered = await recoverWorkerPlan(plan);
    const worker = recovered.result.worker || {};
    console.log(`MCP 작업 프로세스 복구 완료 — deploy ${worker.deployId || "확인 필요"}`);
    const main = recovered.continuity.mainPid, server = recovered.continuity.serverPid;
    console.log(`Electron 메인 pid ${main.before} → ${main.after} (${main.unchanged ? "유지" : "변경"})`);
    console.log(`공용 서버 pid ${server.before} → ${server.after} (${server.unchanged ? "유지" : "변경"}) · worker pid ${worker.pid || "확인 필요"}`);
    return;
  }
  const refusal = fullInstallRefusal(plan, { full: args.includes("--full") });
  if (refusal) {
    console.error(refusal);
    process.exitCode = 2;
    return;
  }
  console.log(`전체 설치 필요 — ${plan.reason || plan.reasons?.map(item => item.why).join(" / ") || "공용 파일 변경"}`);
  const result = spawnSync(windows ? "powershell.exe" : "bash", windows
    ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--yes", "--app-only"]
    : [script, ...args], { stdio: "inherit", env: windows ? windowsPowerShellEnv()
      : { ...process.env, ...(plan.target?.stateDir ? { IRIS_DEPLOY_STATE_DIR: plan.target.stateDir } : {}) } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (plan.reconnectRequired) console.log("MCP 도구 정의가 바뀌었습니다. /mcp reconnect를 실행하세요.");
}

// details: 교체 실패 때 반환하지 못한 자원(leftovers)·관찰 등 원인을 찾는 데 필요한 값
main().catch(error => {
  console.error(error.message);
  if (error.details && Object.keys(error.details).length) console.error(`세부: ${JSON.stringify(error.details)}`);
  process.exitCode = 1;
});
