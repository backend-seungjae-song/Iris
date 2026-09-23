const fs = require("node:fs");
const path = require("node:path");
const { stateHome } = require("./state-home.cjs");

const idList = (value) => Array.isArray(value) && value.every((id) => typeof id === "string");

// 서버와 네이티브가 같은 파손 판정을 쓴다. 읽기 실패로 기존 기능을 모두 끄지 않는다.
// shown 은 기본 꺼짐(optIn) 기능 가운데 사용자가 켠 것이다. 이 필드가 생기기 전 파일은 빈 목록으로 읽는다.
function readFeatureState(home = stateHome()) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, "features.json"), "utf8"));
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !idList(value.hidden) || (value.shown !== undefined && !idList(value.shown))) throw new Error("bad state");
    return { exists: true, revision: value.revision, hidden: [...new Set(value.hidden)], shown: [...new Set(value.shown || [])] };
  } catch { return { exists: false, revision: 0, hidden: [], shown: [] }; }
}
function readHiddenSync(home = stateHome()) { return new Set(readFeatureState(home).hidden); }
// 켜짐 판정은 이 식 하나다. 렌더러(web/js/core/features.js)는 ESM 이라 같은 식을 옮겨 쓰고 검사가 둘을 대조한다.
// optIn 기능은 사용자가 확인 창에서 켜야 shown 에 들어간다. 그 전에는 hidden 에 없어도 꺼져 있다.
function featureOn(state, id, optIn) {
  if ((state.hidden || []).includes(id)) return false;
  return !optIn || (state.shown || []).includes(id);
}
// 상태 계약이 받는 기능 id. 세 표의 id 검사도 이 규칙을 쓴다.
const FEATURE_ID = /^[a-z][a-z0-9_-]{0,99}$/;
module.exports = { readFeatureState, readHiddenSync, featureOn, FEATURE_ID };
