import { QA_FIX_SCHEMA } from "./qa-fix.js";
import { QA_ROW_SCHEMA } from "./qa-rows.js";
import { QA_CHARTER_SCHEMA, QA_SESSION_SCHEMA, QA_DEFECT_SCHEMA, QA_NOTE_SCHEMA, QA_CHARTER_CHANGE_SCHEMA, QA_ORACLES } from "./qa-session-contract.js";
// QA 명령과 인자는 서버와 MCP가 같은 목록으로 검사한다.
const string = (min = 1) => ({ type: "string", minLength: min });
const number = { type: "number" };
const integer = { type: "integer", minimum: 1 };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const choice = (...values) => ({ type: "string", enum: values });
const effectTarget = { sel: string(), role: string(), name: string() };
const oracle = choice(...QA_ORACLES);
const effect = (type, properties = {}, required = []) => object({ id: string(), type: choice(type), ...properties, oracle }, ["type", "oracle", ...required]);
export const QA_EXPECT_SCHEMA = object({
  effects: { type: "array", minItems: 1, maxItems: 20, items: { anyOf: [
    effect("appear", { ...effectTarget, text: string() }),
    effect("disappear", { ...effectTarget, text: string() }),
    effect("unchanged", { ...effectTarget, text: string() }),
    effect("absent", { ...effectTarget, text: string() }),
    effect("change", { ...effectTarget, from: { type: "string" }, to: { type: "string" } }, ["to"]),
    effect("navigate", { url: string() }, ["url"]),
    effect("dialog", { kind: choice("alert", "confirm", "prompt", "beforeunload"), text: string() }),
    effect("request", { method: string(), path: string(), status: { type: "integer", minimum: 100, maximum: 599 } }, ["method", "path"]),
    effect("none"),
  ] } },
  within: { type: "integer", minimum: 1, maximum: 15000, default: 5000 },
}, ["effects"]);
const withExpectation = schema => object({ ...schema.properties, expect: QA_EXPECT_SCHEMA }, [...schema.required, "expect"]);
const coordinate = object({ x: number, y: number, selected: object({ role: string(), name: string() }, ["role", "name"]) }, ["x", "y"]);
const boolean = { type:"boolean" };
const rect = object({x:number,y:number,width:integer,height:integer},["x","y","width","height"]);
const mark = object({sel:string(),ref:string(),label:string(),color:string(),x:number,y:number,width:integer,height:integer,nth:{type:"integer",minimum:0}});
const shot = {crop:rect,element:string(),settle:{type:"integer",minimum:0},mark:{type:"array",items:{anyOf:[string(),mark]}},mask:{type:"array",items:{anyOf:[string(),mark]}},caption:string(),full:boolean,dpr:{type:"number",minimum:1}};
const lines = {anyOf:[string(),{type:"array",items:string()}]};
export const QA_CASE_KINDS = Object.freeze(["기능","CMS → 앱 반영","디자인","화면 크기","접근성","수정 확인"]);
const overview = object({scope:lines,
  features:{type:"array",items:object({name:string(),need:lines,understood:lines,built:lines,cases:{type:"array",items:string()},gaps:lines,why:string()},["name","cases"])},
  diagrams:{type:"array",items:object({title:string(),lanes:{type:"array",items:string()},steps:{type:"array",items:object({id:string(),lane:{anyOf:[string(),{type:"integer",minimum:0}]},text:string(),col:{type:"integer",minimum:0},focal:boolean},["id","lane","text"])},links:{type:"array",items:object({from:string(),to:string(),focal:boolean,dashed:boolean},["from","to"])}},["lanes","steps","links"])},
  blocks:{type:"array",items:object({title:string(),flow:string(),lines:{type:"array",items:string()}})},
  // 케이스별 짧은 제목·흐름(화면 > 행동 > 결과)·결과. 끝난 회차의 항목 설명은 고칠 수 없어 보고서를 만들 때 받음
  // checks: 기기 효과로 남지 않는 확인(피그마 대조·정렬 측정·접근성 등)과 그 증거 사진. 기기 확인 줄의 종류는 기능
  // scenes·text: 끝난 회차의 사람용 사진 설명·확인자 글을 고치는 칸. 사진은 원본 파일 sha256, 글은 원문 일부로 가리킴
  cases:{type:"array",maxItems:500,items:object({id:string(),title:string(),flow:string(),result:string(),kind:{type:"array",maxItems:6,items:choice(...QA_CASE_KINDS)},
    checks:{type:"array",maxItems:50,items:object({kind:choice(...QA_CASE_KINDS),text:string(),pass:boolean,
      evidence:{type:"array",maxItems:20,items:object({file:string(),caption:string()},["file"])}},["kind","text"])},
    scenes:{type:"array",maxItems:300,items:object({sha256:string(),caption:string(),hide:boolean},["sha256"])},
    text:{type:"array",maxItems:300,items:object({from:string(),to:{type:"string"}},["from","to"])}},["id"])},
  // text: 보고서 전체(케이스 밖 결함·세션 메모·Charter 포함) 확인자 글 고치기. notes: 끝난 회차의 결정 카드 빼기
  text:{type:"array",maxItems:300,items:object({from:string(),to:{type:"string"}},["from","to"])},
  notes:{type:"array",maxItems:300,items:object({id:string(),hide:boolean},["id","hide"])}
});
const risk = object({id:string(),risk:string(),size:choice("high","mid","low"),knowledge:choice("lots","some","little","none"),decision:choice("test","investigate","accept","delegate"),reason:string()},["id","risk","size","knowledge","decision"]);
const target = object({role:string(),name:string(),text:string(),nth:{type:"integer",minimum:1}});
const step = object({target,action:choice("click","dblclick","type","key","select","scroll","drag","swipe","tap","app_tap","app_swipe","app_type","app_key"),device:string(),text:{type:"string"},key:string(),index:{type:"integer",minimum:0},value:{type:"string"},deltaX:number,deltaY:number,to:target,duration:number,setup:boolean,expect:QA_EXPECT_SCHEMA},["target","action","expect"]);
const handler = object({method:choice("click","escape","wait"),target,within:{type:"integer",minimum:1,maximum:15000},expect:QA_EXPECT_SCHEMA},["method","expect"]);
const condition = object({sel:string(),text:string(),role:string(),name:string(),code:string(),kind:string()});
const judgment = object({id:string(),class:choice("연관 반응","무관 반응","방해 화면","배경 반응","문제"),condition,action:object({kind:string(),target},["kind","target"]),handler,expect:QA_EXPECT_SCHEMA,source:string(),attempts:{type:"array",items:string()},cause:string(),defect:integer,remove:{type:"boolean"},undo:{type:"boolean"},ids:{type:"array",maxItems:300,items:string()}},["id","source","cause"]);
const listReview = object({information:{type:"array",items:object({row:string(),text:string(),sameAs:string(),decision:choice("merge","split"),reason:string()},["row","text"])},duplicates:{type:"array",items:object({rows:{type:"array",minItems:2,items:string()},decision:choice("merge","split"),reason:string()},["rows","decision","reason"])},distribution:string(),missingRisks:string()},["information","duplicates","distribution","missingRisks"]);
const plan = object({ risks:{type:"array",minItems:1,items:risk},listRationale:string(), build: object({repo:string(),related:{type:"array",maxItems:8,items:string()}},["repo"]), entries: { type: "array", items: { type: "string", format: "http-url" } }, name: string(), preconditions: { type: "array", items: string() }, surfaces: { type: "array", items: string(), minItems: 1 } }, ["entries", "risks", "listRationale", "build"]);

export const QA_COMMAND_SCHEMAS = Object.freeze({
  run_begin: object({ plan, charter: QA_CHARTER_SCHEMA }, ["plan", "charter"]),
  run_resume: object({}),
  tabs: object({}),
  tab: object({tab:string()},["tab"]),
  close_tab: object({tab:string()},["tab"]),
  run_end: object({ session: QA_SESSION_SCHEMA }, ["session"]),
  defect: QA_DEFECT_SCHEMA,
  fix: QA_FIX_SCHEMA,
  catalog: object({repo:string()},["repo"]),
  catalog_revise: object({repo:string(),key:string(),remove:{type:"boolean"},userApproved:{type:"boolean"},class:choice("연관 반응","무관 반응","방해 화면","배경 반응","문제"),condition,action:object({kind:string(),target},["kind","target"]),handler,expect:QA_EXPECT_SCHEMA,source:string(),attempts:{type:"array",items:string()},cause:string()},["repo","key","source","cause"]),
  summary: object({runJson:string(),runIds:{type:"array",minItems:1,items:string()},title:string(),overview,overviewFile:string(),replaces:{type:"array",maxItems:200,items:object({from:string(),to:string(),why:string()},["from","to","why"])}},["runIds"]),
  note: QA_NOTE_SCHEMA,
  charter: QA_CHARTER_CHANGE_SCHEMA,
  report: object({overview,overviewFile:string(),resume:object({from:string()},["from"])}),
  handoff: object({steps:{type:"array",minItems:1,items:object({name:string(),action:string(),expected:string(),shotSeq:integer},["name","action","expected","shotSeq"])}},["steps"]),
  diff: object({ before: integer, after: integer }, ["before", "after"]),
  shot_sizes: object({ sizes: { type: "array", minItems: 1, items: {anyOf:[string(),object({ width: integer, height: integer }, ["width", "height"])]} },dpr:{type:"number",minimum:1},caption:string(),settle:{type:"integer",minimum:0} }, ["sizes"]),
  bulk_fill: object({ action: choice("plan", "commit"), values: { type: "array", minItems: 1, items: {type:"string"} }, key: choice("Tab", "Enter", "ArrowDown", "ArrowRight"), token: string(), userApproved: {type:"boolean"} }, ["action"]),
  row: QA_ROW_SCHEMA,
  expect: object({ mode: choice("exists", "absent", "contains", "equals"), sel: string(), text: { type: "string" } }, ["mode"]),
  play: object({row:string(),path:string(),retestOf:object({run:string(),defect:integer},["run","defect"]),steps:{type:"array",minItems:1,maxItems:100,items:step}}),
  review: object({decisions:{type:"array",items:object({defect:integer,row:string(),reason:string()},["reason"])},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:500},full:{type:"boolean"}}),
  list_review: object({review:listReview}),
  unexpected: judgment,
  blocked: object({ reason: string() }, ["reason"]),
  route_save: object({ name: string(), fromSeq: integer, toSeq: integer }, ["name", "fromSeq", "toSeq"]),
  route_list: object({}),
  route_replay: object({ name: string(), params: {type:"object",additionalProperties:{type:"string"}} }, ["name"]),
  open_entry: object({ url: { type: "string", format: "http-url" },newTab:boolean }, ["url"]),
  snapshot: object({budget:integer,cursor:string(),role:string(),name:string(),region:string()}), screenshot: object(shot), text: object({}), url: object({}), observe: object({level:choice("error","warn","all"),limit:integer,...shot}),
  select: withExpectation(object({x:number,y:number,index:{type:"integer",minimum:0},text:string(),value:{type:"string"}},["x","y"])),
  click: withExpectation(coordinate), dblclick: withExpectation(coordinate), hover: coordinate,
  drag: withExpectation(object({ x: number, y: number, toX: number, toY: number }, ["x", "y", "toX", "toY"])),
  type: withExpectation(object({ text: { type: "string" }, param: string() }, ["text"])),
  key: withExpectation(object({ key: string() }, ["key"])),
  scroll: withExpectation(object({ x: number, y: number, deltaX: number, deltaY: number }, ["x", "y"])),
  history: withExpectation(object({ action: choice("back", "forward", "reload") }, ["action"])),
  viewport: object({ width: integer, height: integer,dpr:{type:"number",minimum:0},clear:boolean }),
  dialog: withExpectation(object({ answer: choice("ok", "cancel"), text: { type: "string" } }, ["answer"])),
  app_targets: object({}),
  app_picks: object({}),
  app_target: object({device:string(),clear:boolean,additional:boolean}),
  app_snapshot: object({device:string()}), app_screenshot: object({device:string()}), app_observe: object({device:string()}),
  app_tap: withExpectation(object({device:string(),x:number,y:number},["x","y"])),
  app_swipe: withExpectation(object({device:string(),x1:number,y1:number,x2:number,y2:number,duration:number},["x1","y1","x2","y2"])),
  app_type: withExpectation(object({device:string(),text:{type:"string"}},["text"])),
  app_key: withExpectation(object({device:string(),key:string(),keycode:integer})),
  app_expect: object({device:string(),mode:choice("exists","absent","contains","equals"),
    label:{...string(),description:"고를 요소의 접근성 이름(qa_app_snapshot 의 [type] 뒤 글자와 똑같이). 판정 설명 칸 아님"},type:string(),text:{type:"string"}},["mode"]),
  login: object({ account: string(), userApproved: {type:"boolean"}, fields: {type:"array",minItems:1,items:object({x:number,y:number,text:{type:"string"}},["x","y","text"])} }),
  ask_user: object({ reason: string() }, ["reason"]),
});

export const QA_COMMANDS = Object.freeze(Object.keys(QA_COMMAND_SCHEMAS));

function validate(schema, value, field) {
  if (schema.anyOf) {
    // 값 하나로 갈래가 정해지면(효과의 type 등) 그 갈래의 오류를 그대로 알림. MCP는 갈래를 합친 스키마만 보여 줌
    const picked = value && typeof value === "object" ? schema.anyOf.filter(option => option.type === "object"
      && Object.entries(option.properties || {}).some(([key, p]) => p.enum?.length === 1 && value[key] === p.enum[0])) : [];
    if (picked.length === 1) return validate(picked[0], value, field);
    for (const option of schema.anyOf) { try { return validate(option,value,field); } catch {} }
    throw new Error(`${field}: 허용된 형식이 필요합니다`);
  }
  if (schema.type === "object" && typeof schema.additionalProperties === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: 객체가 필요합니다`);
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,validate(schema.additionalProperties,v,`${field}.${k}`)]));
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: 객체가 필요합니다`);
    const out = {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${field}.${key}: 허용되지 않은 인자`);
      out[key] = validate(schema.properties[key], value[key], `${field}.${key}`);
    }
    for (const key of schema.required || []) if (!Object.hasOwn(out, key)) throw new Error(`${field}.${key}: 필수 인자`);
    return out;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || (schema.minItems && value.length < schema.minItems) || (schema.maxItems && value.length > schema.maxItems)) throw new Error(`${field}: 배열 길이가 맞지 않습니다`);
    return value.map((item, i) => validate(schema.items, item, `${field}[${i}]`));
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) || (schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum)) throw new Error(`${field}: 유효한 숫자가 필요합니다`);
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${field}: 불리언이 필요합니다`);
    return value;
  }
  if (typeof value !== "string" || (schema.minLength && !value.trim())) throw new Error(`${field}: 허용된 문자열이 필요합니다`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${field}: 허용된 값 중 하나가 필요합니다(${schema.enum.join(", ")})`);
  if (schema.format === "http-url") {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${field}: HTTP 주소가 필요합니다`); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error(`${field}: HTTP 주소가 필요합니다`);
  }
  return value;
}

// 앱 안의 네트워크 요청·콘솔은 모바일에서 계측하지 않아 화면 효과만 받음
const MOBILE_EFFECTS = ["appear", "disappear", "change", "unchanged", "absent", "none"];
const mobileEffectError = type => `모바일은 appear·disappear·change·unchanged·absent·none 효과만 지원합니다(${type}: 앱 안 요청·콘솔은 계측하지 않음)`;

export function validateQaCommand(cmd, args) {
  if (typeof cmd !== "string" || !Object.hasOwn(QA_COMMAND_SCHEMAS, cmd)) throw new Error(`허용되지 않은 QA 명령: ${String(cmd)}`);
  const normalized = validate(QA_COMMAND_SCHEMAS[cmd], args, "args");
  // 수정 재실행은 steps 를 빼면 원래 실패한 실행의 단계를 도구가 그대로 사용
  if (cmd === "play" && !normalized.steps && !normalized.retestOf) throw new Error("args.steps: 단계가 필요합니다(수정 재실행은 retestOf만 넣으면 원래 단계를 그대로 실행)");
  if (cmd === "play") for (const item of normalized.steps || []) {
    if (!(item.target.role && item.target.name) && !item.target.text) throw new Error("단계 대상은 role·name 또는 text가 필요합니다");
    if (["type","app_type"].includes(item.action) && typeof item.text !== "string") throw new Error("type.text가 필요합니다");
    if (["key","app_key"].includes(item.action) && !item.key) throw new Error("key.key가 필요합니다");
    if (["drag","swipe","app_swipe"].includes(item.action) && !item.to) throw new Error("끌기·스와이프 도착 대상이 필요합니다");
    if (item.action === "select" && ["index","text","value"].filter(key=>Object.hasOwn(item,key)).length !== 1) throw new Error("select 조건은 하나만 필요합니다");
    item.expect = validateQaCommand("click",{x:0,y:0,expect:item.expect}).expect;
    // qa_play 기대는 웹 클릭 기준으로 검사하므로 모바일 단계는 여기서 따로 거절(실행 도중 막힘 방지)
    const mobileStep = !!item.device || item.action.startsWith("app_") || ["tap","swipe"].includes(item.action);
    const unsupported = mobileStep && item.expect.effects.find(effect => !MOBILE_EFFECTS.includes(effect.type));
    if (unsupported) throw new Error(mobileEffectError(unsupported.type));
  }
  if (normalized.expect) {
    normalized.expect.within ??= 5000;
    const effects = normalized.expect.effects;
    if (effects.some(effect => effect.type === "none") && effects.length !== 1) throw new Error("expect.none은 다른 효과와 함께 쓸 수 없습니다");
    const ids = effects.filter(effect => effect.id).map(effect => effect.id);
    if (new Set(ids).size !== ids.length) throw new Error("expect.effects.id: 서로 다른 ID가 필요합니다");
    for (const effect of effects) {
      if (["appear", "disappear", "absent"].includes(effect.type) && !effect.text && !(effect.role && effect.name)) throw new Error("appear·disappear·absent에는 text 또는 role·name이 필요합니다");
      if (effect.type === "change" && !effect.sel && !(effect.role && effect.name)) throw new Error("change에는 sel 또는 role·name이 필요합니다");
      // 웹·모바일 판정 모두 text 로 unchanged 대상을 찾음
      if (effect.type === "unchanged" && !effect.sel && !effect.text && !(effect.role && effect.name)) throw new Error("unchanged에는 text, sel 또는 role·name이 필요합니다");
      if ((effect.role || effect.name) && !(effect.role && effect.name)) throw new Error("effect.role·name은 함께 필요합니다");
      if (cmd.startsWith("app_") && !MOBILE_EFFECTS.includes(effect.type)) throw new Error(mobileEffectError(effect.type));
      // canvas·video·WebGL 내부 상태는 DOM 감시로 관찰할 수 없는 대상
      const selector = String(effect.sel || "").trim().toLowerCase();
      const role = String(effect.role || "").trim().toLowerCase();
      if (/^(canvas|video)(?:[.#\[:]|$)/.test(selector) || role === "canvas" || role === "video" || /webgl/.test(selector))
        throw new Error("canvas·video·WebGL 내부 효과는 코드로 확인할 수 없습니다");
      if (["navigate", "dialog", "request"].includes(effect.type) && (effect.sel || effect.role || effect.name || (effect.text && effect.type !== "dialog")))
        throw new Error(`${effect.type} 효과에는 화면 대상 필드를 넣을 수 없습니다`);
      if (["appear", "disappear", "absent"].includes(effect.type) && effect.text && (effect.sel || effect.role || effect.name) && effect.text.trim() === "")
        throw new Error("화면 효과 text가 비어 있습니다");
    }
  }
  // overview 가 커서 호출 인자로 옮겨 적기 어려울 때 같은 내용의 JSON 파일. 서버가 읽어 overview 로 같은 검사를 거침
  if (normalized.overviewFile != null) {
    if (normalized.overview != null) throw new Error("args.overviewFile: overview와 함께 쓸 수 없습니다. 하나만 넣으세요");
    if (!normalized.overviewFile.startsWith("/") || !normalized.overviewFile.endsWith(".json")) throw new Error("args.overviewFile: .json 파일의 절대 경로가 필요합니다");
  }
  if (cmd === "row" && ["close", "end"].includes(normalized.action) && !normalized.sceneJudgment?.trim()) throw new Error("args.sceneJudgment: 장면 전체를 판단한 문장이 필요합니다");
  if (cmd === "route_save" && normalized.toSeq < normalized.fromSeq) throw new Error("args.toSeq: fromSeq보다 작습니다");
  if (["contains", "equals"].includes(normalized.mode) && !Object.hasOwn(normalized, "text")) throw new Error("args.text: 필수 인자");
  if (cmd === "select" && ["index","text","value"].filter(k=>Object.hasOwn(normalized,k)).length !== 1) throw new Error("선택 조건은 index·text·value 중 하나여야 합니다");
  if (cmd === "viewport" && !normalized.clear && (!normalized.width || !normalized.height)) throw new Error("viewport 크기가 필요합니다");
  if (normalized.dpr > 3 || normalized.settle > 10000 || normalized.sizes?.length > 20) throw new Error("촬영 옵션 범위 초과");
  return normalized;
}
