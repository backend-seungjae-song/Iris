import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateHome } from "../state-home.cjs";
import { createWorkerActivity } from "./activity.js";
import { createWorkerBrowserService } from "./browser-service.js";
import { createHostApiClient } from "./host-api-client.js";
import { createWorkerHostTaskService } from "./host-task-service.js";
import { createIpcClient } from "./ipc-client.js";
import { createWorkerQaService } from "./qa-service.js";
import { createWorkerRuntime } from "./runtime.js";
import { createWorkerLock } from "./worker-lock.js";

export function startWorkerProcess({ processRef = process, env = process.env, exit = code => processRef.exit(code) } = {}) {
  if (typeof processRef.send !== "function" || processRef.connected !== true) return null;
  const token = env.IRIS_MCP_WORKER_TOKEN;
  const deployId = env.IRIS_MCP_WORKER_DEPLOY_ID;
  const workerGeneration = env.IRIS_MCP_WORKER_GENERATION;
  delete env.IRIS_MCP_WORKER_TOKEN;
  if (!token || !deployId || !workerGeneration) return null;
  const activity = createWorkerActivity();
  const ipc = createIpcClient({ workerGeneration, send: message => processRef.send(message), events: processRef });
  const hostApi = createHostApiClient({ ipc, activity });
  const qaService = createWorkerQaService({ hostApi, activity, workerGeneration });
  const browserService = createWorkerBrowserService({ hostApi, activity });
  const hostTaskService = createWorkerHostTaskService({ hostApi });
  const service = {
    stopObservations: reason => qaService.stopObservations(reason),
    dispatch: request => request.channel === "browser" ? browserService.dispatch(request) : qaService.dispatch(request),
    hostTask: request => hostTaskService.dispatch(request),
  };
  let runtime;
  const lock = createWorkerLock({
    file: path.join(stateHome(), "mcp-worker", "worker.lock"),
    workerGeneration,
    pid: processRef.pid,
    onLost: () => runtime?.lockLost(),
  });
  runtime = createWorkerRuntime({ deployId, workerGeneration, token, transport: processRef, lock, service, activity, exit });
  processRef.once?.("SIGTERM", () => { runtime.terminate("SIGTERM"); });
  return runtime;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = startWorkerProcess();
  if (!runtime) process.exitCode = 1;
}
