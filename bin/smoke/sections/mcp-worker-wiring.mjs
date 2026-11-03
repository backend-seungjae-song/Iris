import { check, read } from "../core.mjs";

export default async function runMcpWorkerWiring() {
  console.log("[2d2] MCP 작업 프로세스 배선");
  const server = read("server/index.js");
  const http = read("server/http-handler.js");
  const installer = read("scripts/install-app.mjs");
  const shellInstaller = read("scripts/install-app.sh");
  const packageJson = JSON.parse(read("package.json"));

  check("공용 서버가 작업 프로세스 감독기와 Electron 세대 중계를 연결한다", () =>
    server.includes("createMcpWorkerSupervisor") && server.includes("requestWorkerGeneration")
      && server.includes("requestWorkerRelay"));
  check("일반 MCP HTTP 요청과 교체·상태 경로가 감독기를 지난다", () =>
    http.includes('workerSupervisor.request(') && http.includes('pathname === "/mcp-worker/activate"')
      && http.includes('pathname === "/mcp-worker/status"'));
  check("설치 명령이 worker 교체와 전체 설치를 분류한다", () =>
    installer.includes("planAppInstall") && installer.includes("deployWorkerPlan")
      && shellInstaller.includes("scripts/mcp-worker/deployment-lock.sh"));
  check("배포 결과에 worker와 배포 도구를 포함한다", () => {
    const files = packageJson.build?.files || [];
    const unpacked = packageJson.build?.asarUnpack || [];
    return files.includes("server/**/*") && files.includes("scripts/mcp-worker/**/*")
      && unpacked.includes("server/**") && unpacked.includes("scripts/mcp-worker/**/*");
  });
}
