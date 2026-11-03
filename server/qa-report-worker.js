// HTML 보고서 조립은 별도 스레드에서. 서버 안에서 만들면 문자열·이미지 버퍼가 남아 여섯 회차 묶음 뒤 서버가 1.8GB 로 남고, 동기 계산으로 서버가 13초 멈춘 사례
// 스레드가 끝나면 그 힙은 운영체제로 돌아감. 장부 검증(앵커 조회)은 서버 스레드에서 끝낸 뒤 결과만 넘김
import { Worker } from "node:worker_threads";
import crypto from "node:crypto";

// module 의 export name 을 새 스레드에서 args 로 부르고 결과를 받음. args·결과는 구조화 복제 가능한 값만
export function runQaReportTask(module, name, args, activity) {
  const execute = () => new Promise((resolve, reject) => {
    let settled = false, message, workerError;
    const worker = new Worker(new URL("./qa-report-thread.js", import.meta.url), { workerData: { module: String(module), name, args } });
    worker.once("message", (result) => {
      message = result;
    });
    worker.once("error", (error) => { workerError = error; });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (workerError) reject(workerError);
      else if (!message) reject(new Error(`보고서 스레드가 결과 없이 끝났습니다(code ${code}).`));
      else if (message.error) reject(new Error(message.error));
      else if (code !== 0) reject(new Error(`보고서 스레드가 실패했습니다(code ${code}).`));
      else resolve(message.result);
    });
  });
  return activity ? activity.run("reports", `${name}:${crypto.randomUUID()}`, execute, { detail: { name } }) : execute();
}

export const buildReportIsolated = (options, activity) => runQaReportTask(new URL("../bin/mcp/report.mjs", import.meta.url), "buildReport", [options], activity);
