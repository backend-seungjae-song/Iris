const fs = require("node:fs");
const path = require("node:path");
const { stateHome } = require("./state-home.cjs");

// 서버와 네이티브가 같은 파손 판정을 쓴다. 읽기 실패로 기존 기능을 모두 끄지 않는다.
function readFeatureState(home = stateHome()) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, "features.json"), "utf8"));
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.hidden) || value.hidden.some((id) => typeof id !== "string")) throw new Error("bad state");
    return { exists: true, revision: value.revision, hidden: [...new Set(value.hidden)] };
  } catch { return { exists: false, revision: 0, hidden: [] }; }
}
function readHiddenSync(home = stateHome()) { return new Set(readFeatureState(home).hidden); }
// 상태 계약이 받는 기능 id. 세 표의 id 검사도 이 규칙을 쓴다.
const FEATURE_ID = /^[a-z][a-z0-9_-]{0,99}$/;
module.exports = { readFeatureState, readHiddenSync, FEATURE_ID };
