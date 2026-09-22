#!/usr/bin/env node
// 개발 환경을 실제 상태의 사본으로 다시 만든다.
//
// 소유 범위
//   무엇을 베끼고 무엇을 두고 갈지의 판정, 원본·대상 짝, 그리고 덮기 전의 안전 판정.
//
// 제공 API
//   실행 파일이면서, 검사가 실물 없이 돌릴 수 있게 shouldSkip·seedPlan·guardPlan 을 export 한다.
//
// 의존 대상
//   state-home.cjs 가 정한 상태 폴더와 user-data-home.cjs 가 정한 쿠키 폴더 대응에 기댄다.
//   여기서 경로를 다시 정의하지 않는다. 한 곳만 어긋나도 개발 환경이 실제 폴더를 덮는다.
//
// 유지 조건
//   원본을 절대 쓰지 않는다. 대상이 원본과 같거나 그 안이면 아무것도 하지 않고 멈춘다.
//   기본 상태 폴더(`~/.iris`)를 대상으로 삼을 수 없다. 되돌릴 수 없는 실수이기 때문이다.
//   베끼는 것에 자격증명 금고와 쿠키가 포함된다. 사용자가 알고 택한 것이므로 막지 않되,
//   실행할 때마다 그 사실을 화면에 적는다. 조용히 비밀을 한 벌 더 만들지 않는다.
//   잠금 파일·로그·소켓은 두고 간다. 실행 중인 서버의 잠금 파일을 베끼면 새 서버가 못 뜬다.
//   대상 폴더를 점유한 서버가 실행 중이면 베끼지 않는다. 그 서버는 옛 상태를 메모리에 들고
//   있어서, 베껴 넣은 파일을 다음 저장에서 그대로 덮는다. 종료되지 않은 서버 프로세스가
// 이렇게 계정·검색 기록·탭을 지운 적이 있다.
//
// 영향 범위
//   공급자는 state-home.cjs · user-data-home.cjs 이고, 소비자는 사람과 package.json 의
//   `dev:seed` 다. 개발 앱이 어느 폴더를 보는지 바뀌면 여기도 함께 바뀐다.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs bin/dev-seed.mjs

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { stateHome, DIR_NAME } = require_("../server/state-home.cjs");
const { userDataHomeFor } = require_("../native/electron/user-data-home.cjs");

const INSTALLED_STATE = path.join(os.homedir(), DIR_NAME);
const APP_SUPPORT = path.join(os.homedir(), "Library", "Application Support");

// 실행 중인 서버의 흔적과 Chromium 의 잠금 파일. 베끼면 새 인스턴스가 이미 실행 중으로 판단한다.
const SKIP = [
  /(?:^|\/)server\.lock$/,
  /(?:^|\/)server\.log$/,
  /\.tmp$/,
  /(?:^|\/)Singleton(?:Lock|Socket|Cookie)$/,
  /(?:^|\/)\.DS_Store$/,
];

export function shouldSkip(rel) {
  const name = String(rel || "").split(path.sep).join("/");
  return SKIP.some((re) => re.test(name));
}

// 원본과 대상의 짝. 상태 폴더와 쿠키 폴더 두 벌이다.
export function seedPlan(targetStateDir, { installedState = INSTALLED_STATE, appSupport = APP_SUPPORT } = {}) {
  return [
    { what: "상태", from: installedState, to: targetStateDir },
    { what: "쿠키·로그인", from: userDataHomeFor(installedState, appSupport), to: userDataHomeFor(targetStateDir, appSupport) },
  ];
}

// 대상 폴더를 점유한 서버가 실행 중인지 본다. 잠금 파일의 pid 가 실제 서버일 때만 실행 중으로 본다.
// pid 는 재사용되므로 번호만 보면 정상 폴더를 쓸 수 없게 만든다.
export function holderOf(stateDir, { readPid, isServerPid } = {}) {
  const lock = path.join(stateDir, "server.lock");
  const read = readPid || (() => { try { return Number(String(readFileSync(lock, "utf8")).trim()); } catch { return 0; } });
  const alive = isServerPid || ((pid) => {
    try { return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes("server/index.js"); }
    catch { return false; }
  });
  const pid = read();
  return pid && alive(pid) ? pid : 0;
}

// 뿌리(`/`)는 접두 비교가 통하지 않는다. `"/" + sep` 는 `//` 라 어떤 경로도 그 안으로 잡히지 않는다.
// 그래서 대상이 `/` 이면 모든 경로가 그 안인데도 "원본이 대상 안" 판정을 빠져나간다.
// 뿌리·홈을 따로 막는 줄은 두지 않는다. 이 판정만 옳으면 둘 다 여기서 걸리고, 덧대 두면
// 이 판정이 동작하지 않아도 검사가 통과한다.
function isInside(child, parent) {
  if (child === parent) return false;
  return parent === path.sep ? child.startsWith(path.sep) : child.startsWith(parent + path.sep);
}

// 되돌릴 수 없는 실수를 먼저 막는다. 통과하면 빈 배열.
export function guardPlan(plan, { installedState = INSTALLED_STATE } = {}) {
  const problems = [];
  for (const step of plan) {
    const from = path.resolve(step.from), to = path.resolve(step.to);
    if (to === from) problems.push(`${step.what}: 원본과 대상이 같습니다 — ${to}`);
    else if (to === path.resolve(installedState)) problems.push(`${step.what}: 대상이 설치본 상태 폴더입니다 — ${to}`);
    else if (isInside(to, from)) problems.push(`${step.what}: 대상이 원본 안입니다 — ${to}`);
    else if (isInside(from, to)) problems.push(`${step.what}: 원본이 대상 안입니다 — ${to}`);
  }
  return problems;
}

function copyOne(step, { force }) {
  if (!existsSync(step.from)) return `${step.what}: 원본이 없습니다 — ${step.from} (건너뜀)`;
  if (existsSync(step.to)) {
    if (!force) return `${step.what}: 이미 있습니다 — ${step.to} (덮으려면 --force)`;
    const prev = `${step.to}.prev`;
    rmSync(prev, { recursive: true, force: true });
    renameSync(step.to, prev);
  }
  mkdirSync(path.dirname(step.to), { recursive: true });
  cpSync(step.from, step.to, {
    recursive: true,
    filter: (src) => !shouldSkip(path.relative(step.from, src)),
    // 원본의 심링크를 따라가면 사본이 실제 폴더를 가리켜 환경 분리가 깨진다.
    dereference: false,
  });
  const bytes = statSync(step.to).size;
  return `${step.what}: ${step.from} → ${step.to} (${bytes >= 0 ? "완료" : ""})`;
}

function main(argv) {
  const force = argv.includes("--force");
  const target = stateHome();
  if (path.resolve(target) === path.resolve(INSTALLED_STATE)) {
    console.error("대상이 설치본 상태 폴더입니다. IRIS_STATE_DIR 로 개발 폴더를 지정하세요 (예: ~/.iris-dev).");
    return 1;
  }
  const plan = seedPlan(target);
  const problems = guardPlan(plan);
  if (problems.length) {
    for (const line of problems) console.error(line);
    return 1;
  }
  const holder = holderOf(target);
  if (holder) {
    console.error(`대상 폴더를 서버 pid ${holder} 가 쥐고 있습니다 — ${target}`);
    console.error("  그 서버는 옛 상태를 메모리에 들고 있어, 베껴 넣은 것을 다음 저장에서 덮습니다.");
    console.error("  개발 앱과 `pnpm dev` 를 먼저 내린 뒤 다시 부르세요.");
    return 1;
  }
  console.log("실제 상태를 개발 갈래로 베낍니다.");
  console.log("  자격증명 금고와 쿠키가 함께 복제됩니다 — 비밀이 한 벌 더 생깁니다.");
  console.log(`  지울 때: rm -rf ${plan.map((s) => s.to).join(" ")}`);
  for (const step of plan) console.log("  " + copyOne(step, { force }));
  console.log("끝났습니다. 개발 앱: pnpm dev:app");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
