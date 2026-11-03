import http from "node:http";
import path from "node:path";

const INSTALLED_PORT = 4271;

export function requestHealthJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error("healthz 응답이 너무 큽니다."));
      });
      response.on("end", () => {
        if (response.statusCode !== 200) { reject(new Error(`healthz 응답 상태가 ${response.statusCode}입니다.`)); return; }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`healthz JSON을 읽지 못했습니다: ${error.message}`)); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("healthz 응답 시간이 초과됐습니다.")));
    request.on("error", reject);
  });
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`healthz ${label}가 올바르지 않습니다: ${value}`);
  return number;
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`healthz ${label}가 절대경로가 아닙니다: ${value}`);
  return path.resolve(value);
}

function installedServerRoot(health, appPath) {
  if (health.serverRoot) return absolute(health.serverRoot, "serverRoot");
  if (appPath.endsWith(".app")) return path.join(appPath, "Contents", "Resources", "app.asar.unpacked");
  return path.join(path.dirname(appPath), "resources", "app.asar.unpacked");
}

function loopbackUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`배포 healthz는 루프백 HTTP 주소여야 합니다: ${value}`);
  }
  return parsed;
}

export async function resolveDeploymentTarget({
  mode = "installed",
  port,
  stateDir,
  serverRoot,
  healthUrl,
  requestHealth = requestHealthJson,
} = {}) {
  if (mode === "development") {
    if (!port || !stateDir || !serverRoot) throw new Error("개발 환경 대상은 port, stateDir, serverRoot를 명시해야 합니다.");
    const explicitPort = positiveInteger(port, "port");
    const url = healthUrl || `http://127.0.0.1:${explicitPort}/healthz`;
    loopbackUrl(url);
    const health = await requestHealth(url);
    if (!health?.ok) throw new Error("개발 환경 healthz가 준비되지 않았습니다.");
    if (positiveInteger(health.port, "port") !== explicitPort) throw new Error("명시한 개발 포트와 healthz 포트가 다릅니다.");
    if (absolute(health.stateDir, "stateDir") !== path.resolve(stateDir)) throw new Error("명시한 개발 상태 폴더와 healthz 상태 폴더가 다릅니다.");
    return {
      mode,
      healthUrl: url,
      appPath: health.appPath ? absolute(health.appPath, "appPath") : null,
      mainPid: health.mainPid ? positiveInteger(health.mainPid, "mainPid") : null,
      serverPid: positiveInteger(health.pid, "pid"),
      port: explicitPort,
      stateDir: path.resolve(stateDir),
      serverRoot: path.resolve(serverRoot),
    };
  }
  if (mode !== "installed") throw new Error(`알 수 없는 배포 대상 종류입니다: ${mode}`);
  const url = healthUrl || `http://127.0.0.1:${INSTALLED_PORT}/healthz`;
  const parsedUrl = loopbackUrl(url);
  const health = await requestHealth(url);
  if (!health?.ok) throw new Error("설치 앱 healthz가 준비되지 않았습니다.");
  const installedPort = positiveInteger(health.port, "port");
  const requestedPort = Number(parsedUrl.port || 80);
  if (installedPort !== requestedPort) throw new Error(`설치 앱 healthz 포트가 요청 포트와 다릅니다: ${installedPort}`);
  const appPath = absolute(health.appPath, "appPath");
  return {
    mode,
    healthUrl: url,
    appPath,
    mainPid: positiveInteger(health.mainPid, "mainPid"),
    serverPid: positiveInteger(health.pid, "pid"),
    port: installedPort,
    stateDir: absolute(health.stateDir, "stateDir"),
    serverRoot: installedServerRoot(health, appPath),
  };
}
