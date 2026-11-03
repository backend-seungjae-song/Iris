import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export const qaCharter = () => ({
  question: "사용자가 변경된 기능을 평소 화면에서 끝까지 사용할 수 있는가?",
  scope: "변경된 기능과 저장 결과", exclusions: "없음", environment: "격리된 테스트 폴더",
  sharedEnvironment: false, timebox: "1분", people: "없음", documents: "없음",
});

export const qaSession = () => ({
  work: "변경된 기능을 실행했다", curios: "없음", checked: "변경된 기능의 결과",
  unverified: { items: "없음", reason: "해당 없음" }, blockers: "없음", outOfScope: "없음", risks: "없음",
  stopCriterion: "questions_answered", remainingQuestions: "없음",
});

export const qaPlan = (more = {}) => ({
  build: { repo: path.resolve(import.meta.dirname, "..") },
  risks: [{ id: "fixture-risk", risk: "실행 결과가 기대와 다를 수 있다", size: "mid", knowledge: "some", decision: "investigate", reason: "각 검사의 실행 결과를 조사한다" }],
  listRationale: "각 검사가 지정한 동작과 실패 조건을 확인한다",
  entries: [], ...more,
});

export const qaRowContract = () => ({
  risk: ["fixture-risk"], oracle: "기능의 용도: 각 검사의 단정문에 지정한 결과", basisNote: "검사의 단정문",
  dataChanging: false,
  mustNotChange: { notApplicable: true, reason: "실행기와 장부만 사용하는 검사로 제품 데이터를 변경하지 않는다" },
});

const state = path.join(fs.realpathSync(os.tmpdir()), "qa-fixtures-" + process.pid);
fs.mkdirSync(state, { recursive: true });
process.env.IRIS_STATE_DIR = state;
process.once("exit", () => fs.rmSync(state, { recursive: true, force: true }));
