const text = (description) => ({ type: "string", minLength: 1, pattern: "\\S", description });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const QA_STOP_CRITERIA = Object.freeze([
  "questions_answered",
  "time_or_user_stop",
  "serious_defect",
  "too_many_defects",
  "flatline",
  "blocked",
  "low_value",
]);

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
}

const charterBase = object({
  question: text("이번 QA가 답할 질문과 변경으로 영향을 받는 사용자 역할"),
  scope: text("확인할 범위"),
  exclusions: text("제외할 범위. 없으면 없다고 적는다"),
  environment: text("사용할 환경, 계정과 데이터. 비밀 값은 적지 않는다"),
  sharedEnvironment: { type: "boolean", description: "다른 사람도 쓰는 환경인지" },
  timebox: text("주어진 시간"),
  people: text("물어볼 사람. 없으면 없다고 적는다"),
  documents: text("참고할 문서. 없으면 없다고 적는다"),
});
export const QA_CHARTER_SCHEMA = freeze({ ...charterBase, properties: { ...charterBase.properties,
  unattended: { type: "boolean", description: "시작 승인 뒤 사람을 기다리지 않고 진행" },
  approvals: object({ logins: { type: "array", items: text("미리 승인할 계정 이름") }, bulkFill: { type: "boolean" } }),
  investigationLimitMin: { type: "number", minimum: 0.001, description: "한 항목 실패 조사 상한(분), 기본 10" },
} });

export const QA_SESSION_SCHEMA = freeze(object({
  work: text("한 일"),
  curios: text("결함인지 아직 모르는 이상한 동작. 없으면 없다고 적는다"),
  checked: text("확인한 것"),
  unverified: object({
    items: text("확인하지 않은 것. 없으면 없다고 적는다"),
    reason: text("확인하지 않은 이유. 미확인 항목이 없으면 해당 없음이라고 적는다"),
  }),
  blockers: text("진행을 막은 문제와 시도한 다른 경로 또는 물어본 사람. 없으면 없다고 적는다"),
  outOfScope: text("charter 밖에서 본 것. 없으면 없다고 적는다"),
  risks: text("남은 위험과 멈추면 생길 위험. 없으면 없다고 적는다"),
  stopCriterion: {
    type: "string", enum: QA_STOP_CRITERIA,
    description: "질문에 답함 / 시간 종료 또는 사용자 중단 / 심각한 결함 / 결함이 많음 / 같은 결과 반복 / 막힘 / 남은 질문의 가치가 비용보다 작음",
  },
  remainingQuestions: text("남은 질문. 없으면 없다고 적는다"),
}));

export const QA_ORACLES = Object.freeze([
  "이전 버전", "명세나 대화에서 정한 내용", "같은 제품의 비슷한 기능", "비교할 만한 다른 제품",
  "사용자가 원할 만한 동작", "기능의 용도", "회사가 내세우는 이미지", "법규와 표준",
  "현실에서 알거나 볼 수 있는 사실", "동작을 설명할 수 없음",
]);
const DEFECT_REQUIRED = object({
  problem: text("관찰한 문제"),
  oracle: { type: "string", enum: QA_ORACLES, description: "문제로 판단한 기준" },
  oracleNote: text("판단 기준과 관찰 결과가 어긋난 이유"),
  importance: text("누가 어떤 영향을 받는지"),
  tried: text("재현과 원인 확인을 위해 시도한 것"),
});
// 연결할 실패 판정은 기본으로 같은 항목의 마지막 실패. failureSeq 로 직접 고르거나 noFailure 로 연결하지 않음
export const QA_DEFECT_SCHEMA = freeze({ ...DEFECT_REQUIRED, properties: { ...DEFECT_REQUIRED.properties,
  // 생략하면 같은 기대의 실패·통과 판정 수로 계산
  reproducible: { type: "string", enum: ["재현됨", "가끔 재현됨", "재현 안 됨"], description: "생략하면 기록의 같은 기대 실패·통과 판정 수로 계산" },
  failureSeq: { type: "number", minimum: 1, description: "연결할 실패 판정 seq" },
  noFailure: { type: "boolean", description: "실패 판정 없이 관찰·비교로 찾은 결함" } } });
export const QA_NOTE_SCHEMA = freeze(object({
  kind: { type: "string", enum: ["관찰", "아이디어", "막힘", "질문"] },
  text: text("세션 중 기록할 내용"),
}));
export const QA_CHARTER_CHANGE_SCHEMA = freeze(object({ charter: QA_CHARTER_SCHEMA, reason: text("charter를 바꾸는 이유") }));
export const QA_STORED_SESSION_SCHEMA = freeze(object({
  ...QA_SESSION_SCHEMA.properties,
  defects: text("장부의 결함 기록에서 서버가 만든 요약"),
}));

function validate(schema, value, field) {
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error(`${field}: 객체가 필요합니다`);
    for (const key of Object.keys(value))
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${field}: 허용되지 않은 항목`);
    const out = {};
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key)) throw new Error(`${field}.${key}: 필수 항목`);
    for (const key of Object.keys(value)) out[key] = validate(schema.properties[key], value[key], `${field}.${key}`);
    return out;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${field}: 배열이 필요합니다`);
    return value.map((item, i) => validate(schema.items, item, `${field}[${i}]`));
  }
  if (schema.type === "number") {
    if (!Number.isFinite(value) || value < schema.minimum) throw new Error(`${field}: 유효한 숫자가 필요합니다`);
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${field}: boolean 값이 필요합니다`);
    return value;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}: 비어 있지 않은 문자열이 필요합니다`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${field}: 허용된 값이 필요합니다`);
  return value;
}

export function validateQaCharter(value) {
  return validate(QA_CHARTER_SCHEMA, value, "charter");
}

export function validateQaSession(value) {
  return validate(QA_SESSION_SCHEMA, value, "session");
}

export function validateQaStoredSession(value) {
  return validate(QA_STORED_SESSION_SCHEMA, value, "sessionRecord");
}

export function validateQaDefect(value) {
  return validate(QA_DEFECT_SCHEMA, value, "defect");
}

export function validateQaNote(value) {
  return validate(QA_NOTE_SCHEMA, value, "note");
}

export function validateQaCharterChange(value) {
  return validate(QA_CHARTER_CHANGE_SCHEMA, value, "charterChange");
}
