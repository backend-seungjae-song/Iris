// 보고서 스레드 진입점. qa-report-worker.js 가 이 파일로 스레드를 띄움(같은 파일을 진입점으로 쓰면 그 파일을 import 하는 모듈과 순환해 멈춤)
import { parentPort, workerData } from "node:worker_threads";

try {
  const module = await import(workerData.module);
  parentPort.postMessage({ result: await module[workerData.name](...workerData.args) });
} catch (error) { parentPort.postMessage({ error: String(error?.message || error) }); }
