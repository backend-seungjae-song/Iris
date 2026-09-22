// Iris 가 생성한 파일이 저장되는 위치를 정하는 단일 지점.
//
// 설계 이유: 상태 폴더에는 성격이 다른 파일이 섞인다. 탭·계정·금고처럼 잃으면 복원할 수 없는
// 상태와, 캡처·녹화·QA 회차처럼 다시 만들 수 있는 부산물이다. 섞여 있으면 정리할 때
// 무엇을 지워도 되는지 화면에서 구분할 수 없다. 그래서 부산물만 `artifacts/` 아래로 모은다.
//
// 부산물이 아닌 것: 앱이 다시 읽어 판정에 쓰는 영수증(agent-context·agent-lineage)과
// 되돌리기용 이전본(memolab-history)은 상태 폴더 루트에 그대로 둔다. 지우면 복원할 수 없거나
// 진행 중인 작업이 깨진다. 정리 화면에도 표시하지 않는다.
//
// .cjs 인 이유는 state-home.cjs 와 같다. server/*.js·bin/*.mjs 는 ESM, native/electron/*.cjs 는
// CJS 이고, CJS 로 두면 양쪽에서 모두 읽을 수 있다.
const fs = require("node:fs");
const path = require("node:path");

const { stateHome } = require("./state-home.cjs");

const DIR_NAME = "artifacts";

// 종류 표가 정본이다. id 는 폴더 이름이자 정리 화면의 키이고, label·desc 는 그 화면의 표시 문구다.
// 여기 없는 이름으로 폴더를 만들면 정리 화면에 나타나지 않아, 지웠다고 생각해도 남는다.
const ARTIFACT_KINDS = [
  { id: "shots", label: "화면 캡처", desc: "브라우저·앱 화면을 찍은 png 와 비교용 임시본" },
  { id: "sketches", label: "스케치", desc: "화면 위에 그려 넘긴 그림" },
  { id: "recordings", label: "녹화", desc: "조작을 다시 재현하려고 남긴 기록" },
  { id: "qa", label: "QA 회차", desc: "회차 일지와 그때 찍은 장면" },
  { id: "agent-run", label: "에이전트 실행", desc: "자식 팬에 넘긴 입력과 출력 로그" },
];

const KIND_IDS = ARTIFACT_KINDS.map((k) => k.id);

function artifactsHome(stateDir) {
  return path.join(stateDir || stateHome(), DIR_NAME);
}

function artifactDir(kind, stateDir) {
  if (!KIND_IDS.includes(kind)) throw new Error(`부산물 종류가 표에 없습니다 — ${kind}`);
  return path.join(artifactsHome(stateDir), kind);
}

// 루트에 생성된 캡처를 담을 이름. inspect 가 폴더 없이 `shot-<시각>.png` 를 루트에 만든다.
const STRAY_SHOT = /^shot-\d+\.png$/;

// 이전 경로에서 새 경로로 옮긴다. 삭제하지 않는다. rename 만 쓰므로 실패해도 이전 파일이 남고,
// 이름이 겹치면 새 경로의 파일을 유지하고 이전 파일은 건드리지 않는다.
// 여러 번 호출해도 결과가 같다. 실패는 무시하고 옮긴 항목만 반환한다. 이전에 실패했다고
// 앱이 시작하지 못하면 더 큰 문제다.
function migrateArtifacts(stateDir) {
  const home = stateDir || stateHome();
  const next = artifactsHome(home);
  const moved = [];
  const kept = [];
  const move = (from, to) => {
    if (fs.existsSync(to)) { kept.push(from); return false; }
    fs.renameSync(from, to);
    moved.push(to);
    return true;
  };
  for (const kind of KIND_IDS) {
    const old = path.join(home, kind);
    try {
      if (!fs.existsSync(old) || !fs.statSync(old).isDirectory()) continue;
      fs.mkdirSync(next, { recursive: true });
      const dest = path.join(next, kind);
      if (move(old, dest)) continue;
      // 새 경로가 이미 있으면 통째로 옮길 수 없다. 항목을 하나씩 옮기고, 비면 이전 폴더를 제거한다.
      for (const entry of fs.readdirSync(old)) {
        try { move(path.join(old, entry), path.join(dest, entry)); } catch {}
      }
      try { fs.rmdirSync(old); } catch {}
    } catch {}
  }
  try {
    const shots = path.join(next, "shots");
    for (const entry of fs.readdirSync(home)) {
      if (!STRAY_SHOT.test(entry)) continue;
      try {
        fs.mkdirSync(shots, { recursive: true });
        move(path.join(home, entry), path.join(shots, entry));
      } catch {}
    }
  } catch {}
  return { moved, kept };
}

module.exports = { ARTIFACT_KINDS, DIR_NAME, artifactsHome, artifactDir, migrateArtifacts };
