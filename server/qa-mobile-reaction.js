import crypto from "node:crypto";
import { QA_ORACLES } from "./qa-session-contract.js";

// 첫 화면 반응 1초·로딩 표시 10초 후보 기준
const FIRST_RESPONSE_MS = 1000, BUSY_MS = 10000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nameOf = element => String(element.AXLabel || element.title || "").trim();
const valueOf = element => String(element.AXValue ?? nameOf(element));
const visible = element => element.frame?.width > 0 && element.frame?.height > 0 && element.type !== "Application";
const content = tree => tree.filter(visible);
const keyOf = element => String(element.type || "") + "\0" + (element.resourceId || element.AXIdentifier
  || ["x", "y", "width", "height"].map(key => Math.round(element.frame[key])).join(","));
const signature = element => JSON.stringify([element.type, nameOf(element), valueOf(element), element.enabled !== false, element.frame]);
// unchanged 는 내용(종류·이름·값·활성)이 그대로인지 봄. 식별자 없는 요소는 위치로 구분돼 조금만 움직여도 다른 요소가 되므로 위치는 비교하지 않음
const contentOf = element => JSON.stringify([element.type, nameOf(element), valueOf(element), element.enabled !== false]);
const sameContent = (before, after) => before.length > 0 && before.length === after.length && JSON.stringify(before.map(contentOf).sort()) === JSON.stringify(after.map(contentOf).sort());
const view = tree => new Map(content(tree).map(element => [keyOf(element), element]));
const fingerprint = tree => JSON.stringify([...view(tree)].map(([key, element]) => [key, signature(element)]).sort());
export const mobileRoleOf = element => {
  const type = String(element.type || "").toLowerCase();
  if (/android\..*textview|^textview$/.test(type)) return "statictext";
  if (/button/.test(type)) return "button";
  if (/link/.test(type)) return "link";
  if (/edittext|textfield|textview|textbox|securetext/.test(type)) return "textbox";
  if (/progress|activityindicator/.test(type)) return "progressbar";
  if (/dialog|alert|sheet/.test(type)) return "dialog";
  if (/checkbox|switch/.test(type)) return "checkbox";
  return type;
};
// snapshot 은 기기 타입(TextField)을, 판정은 정규화한 역할(textbox)을 쓰므로 둘 다 받음
export const mobileRoleMatches = (element, role) => {
  const want = String(role).toLowerCase(), type = String(element.type || "").toLowerCase();
  return mobileRoleOf(element) === want || type === want || mobileRoleOf(element) === mobileRoleOf({type:role});
};
const selectorTest = sel => {
  if (/^#[\w.:/-]+$/.test(sel)) return element => element.resourceId === sel.slice(1) || element.AXIdentifier === sel.slice(1);
  const attr = /^\[(resourceId|label|name|type)="([^"\n]+)"\]$/.exec(sel);
  if (attr) return element => (attr[1] === "resourceId" ? element.resourceId : attr[1] === "type" ? element.type : nameOf(element)) === attr[2];
  if (/^[\w.:/-]+$/.test(sel)) return element => element.resourceId === sel || element.AXIdentifier === sel || element.type === sel;
  throw new Error("모바일 sel은 기기 요소 식별자, #식별자, 요소 종류 또는 [label=\"이름\"]이어야 합니다.");
};
const matches = (element, effect) => (!effect.sel || selectorTest(effect.sel)(element))
  && (!effect.role || mobileRoleMatches(element, effect.role))
  && (!effect.name || nameOf(element) === effect.name)
  && (!effect.text || nameOf(element).includes(effect.text) || valueOf(element).includes(effect.text));
// 요소 표시 이름: 접근성 이름 첫 줄. 묶음 요소는 이름에 하위 글자가 줄바꿈으로 모두 들어 있어 첫 줄만
const shortName = element => String(nameOf(element) || valueOf(element) || "").split("\n")[0].trim().slice(0, 60) || element.type || "요소";
const marksOf = elements => elements.map(element => ({ x:element.frame.x, y:element.frame.y,
  w:element.frame.width, h:element.frame.height, label:shortName(element), color:"#FFB020" }));
const SHOWN_NAMES = 8;

// 조작 전 트리만으로 반드시 미관찰이 되는 기대. 판정(effectObserved)과 같은 조건을 조작 전에 확인해 입력을 보내지 않고 거부
// change 는 조작 뒤 조건에 맞는 요소의 조작 전 값과 비교하므로(이름이 바뀌는 요소) 조작 전 트리로 판단할 수 없어 제외
// 상한 시간 대기·무효 처리·재조작으로 이어진 기대 실수가 한 회차 실패의 절반이었던 사례
export function mobilePremiseErrors(effects, before) {
  const shown = content(before);
  const similar = label => {
    const words = String(label || "").split(/\s+/).filter(word => word.length >= 2);
    return [...new Set(shown.map(shortName).filter(name => name !== "요소" && words.some(word => name.includes(word) || word.includes(name))))].slice(0, 3);
  };
  return effects.flatMap(expected => {
    if (!["appear", "disappear", "unchanged"].includes(expected.type) || !(expected.sel || expected.text || expected.name || expected.role)) return [];
    const label = expected.name || expected.text || expected.sel || expected.role;
    const hits = shown.filter(element => matches(element, expected));
    if (expected.type === "appear" && hits.length)
      return [`appear ${label}: 조작 전부터 조건에 맞는 요소가 있음(${hits.slice(0, 3).map(shortName).join(", ")}). 값이 바뀌면 change, 남아 있어야 하면 unchanged, 새 요소면 role과 name 또는 sel로 정확히 지정`];
    if (expected.type !== "appear" && !hits.length) {
      const near = similar(label);
      return [`${expected.type} ${label}: 조작 전 화면에 조건에 맞는 요소 없음${near.length ? `. 비슷한 이름: ${near.join(", ")}` : ""}`];
    }
    return [];
  });
}
const changeDescription = elements => {
  const names = elements.map(shortName), rest = names.length - SHOWN_NAMES;
  return (`기대 밖 화면 변화: ${names.slice(0, SHOWN_NAMES).join(", ")}${rest > 0 ? ` 외 ${rest}개` : ""}`).slice(0, 300);
};
const labelOf = effect => effect.text || effect.name || effect.sel || effect.role || "화면";

export function validateMobileReaction(expect) {
  if (!expect || typeof expect !== "object" || Array.isArray(expect)
    || Object.keys(expect).some(key => !["effects", "within"].includes(key))) throw new Error("모바일 기대 선언이 올바르지 않습니다.");
  const within = expect.within ?? 5000;
  if (!Number.isSafeInteger(within) || within < 1 || within > 15000) throw new Error("within은 1~15000ms 정수여야 합니다.");
  if (!Array.isArray(expect.effects) || !expect.effects.length || expect.effects.length > 20) throw new Error("기대 효과는 1~20개 필요합니다.");
  for (const effect of expect.effects) {
    if (!effect || typeof effect !== "object" || Array.isArray(effect)) throw new Error("허용되지 않은 모바일 기대 효과입니다.");
    // catalogKey·needsReview 는 qa_play·조작 명령이 반응 목록의 연관 반응을 기대로 붙일 때 넣는 칸
    const extra = Object.keys(effect).filter(key => !["id", "type", "text", "role", "name", "sel", "from", "to", "oracle", "reason", "catalogKey", "needsReview"].includes(key));
    if (extra.length) throw new Error(`허용되지 않은 모바일 기대 효과입니다: 모르는 칸 ${extra.join(", ")}${effect.catalogKey ? ` (반응 목록 ${effect.catalogKey.slice(0, 12)})` : ""}`);
    if (!["appear", "disappear", "change", "unchanged", "absent", "none"].includes(effect.type)) throw new Error(`허용되지 않은 모바일 기대 효과입니다: type ${effect.type}. 모바일은 appear, disappear, change, unchanged, absent, none`);
    if (effect.catalogKey != null && (typeof effect.catalogKey !== "string" || !effect.catalogKey)) throw new Error("catalogKey: 빈 값이 아닌 문자열이 필요합니다.");
    if (effect.needsReview != null && typeof effect.needsReview !== "boolean") throw new Error("needsReview는 참 또는 거짓이어야 합니다.");
    if (!QA_ORACLES.includes(effect.oracle)) throw new Error("정해진 oracle이 필요합니다.");
    for (const key of ["id", "text", "role", "name", "sel"]) {
      if (effect[key] != null && (typeof effect[key] !== "string" || !effect[key].trim())) throw new Error(`${key}: 빈 값이 아닌 문자열이 필요합니다.`);
    }
    for (const key of ["from", "to", "reason"]) if (effect[key] != null && typeof effect[key] !== "string") throw new Error(`${key}: 문자열이 필요합니다.`);
    if (effect.type !== "none" && !effect.text && !effect.sel && !(effect.role && effect.name)) throw new Error("기대 효과의 text, sel 또는 role과 name이 필요합니다.");
    if (effect.type === "change" && effect.to == null) throw new Error("change 효과의 to가 필요합니다.");
    if (effect.type === "none" && Object.keys(effect).some(key => !["id", "type", "oracle", "catalogKey", "needsReview"].includes(key))) throw new Error("none 효과에는 대상이나 값을 지정할 수 없습니다.");
    if (effect.type !== "change" && (effect.from != null || effect.to != null)) throw new Error("from과 to는 change 효과에만 지정할 수 있습니다.");
    if (effect.sel) selectorTest(effect.sel);
  }
  const ids = expect.effects.map((effect, index) => effect.id || `e${index + 1}`);
  if (new Set(ids).size !== ids.length) throw new Error("기대 효과 ID는 서로 달라야 합니다.");
  if (expect.effects.length > 1 && expect.effects.some(effect => effect.type === "none")) throw new Error("none은 다른 기대 효과와 함께 선언할 수 없습니다.");
  return { effects: expect.effects.map((effect, index) => ({ ...structuredClone(effect), id:ids[index] })), within };
}

export function createMobileReaction({ before, expect, action, readTree, capture, identity,
  interval = 120, tailMs = 500, operationTimeoutMs = 5000, now = Date.now, wait = sleep, background = false, retainIdle = false }) {
  if (!Array.isArray(before)) throw new Error("반응 관찰 전 접근성 트리가 필요합니다.");
  const declared = background ? {effects:[],within:1000} : validateMobileReaction(expect), id = crypto.randomUUID();
  const effects = declared.effects.map(expected => ({ id:expected.id, expected, observed:false, sceneId:null }));
  const candidates = [], unexpected = [], scenes = [], seenCandidates = new Set(), seenUnexpected = new Map();
  const baseline = view(before), initial = fingerprint(before);
  let started = null, delivered = false, stop = false, paused = false, armResolve, doneResolve;
  let firstVisibleMs = null, completedMs = null, changed = false, error = null, idleError = null;
  let lastTree = before, lastView = baseline, busySince = content(before).some(element => mobileRoleOf(element) === "progressbar" || element.busy === true) ? 0 : null;
  let idleTimer = null, idleQueue = Promise.resolve(), idle = false;
  const armed = new Promise(resolve => { armResolve = resolve; });
  const deliveryReady = new Promise(resolve => { doneResolve = resolve; });
  const atMs = () => Math.max(0, now() - started);
  const bounded = async (fn, timeoutMs, label) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => fn({timeoutMs})), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 시간 초과`)), Math.max(1, timeoutMs));
      })]);
    } finally { clearTimeout(timer); }
  };
  const scene = async (kind, description, tree, fields = {}, elements = []) => {
    const capturedAt = new Date(now()).toISOString(), observedAt = started == null ? null : new Date(now()).toISOString();
    const result = { id:crypto.randomUUID(), claim:{kind, description, ...fields}, capturedAt, observedAt,
      marks:marksOf(elements), ...identity };
    try {
      const shot = await bounded(options => capture({...options, tree, marks:result.marks, description}), operationTimeoutMs, "모바일 촬영");
      Object.assign(result, shot, { shot:shot.path || shot.shot, capturedAt:new Date(now()).toISOString() });
      if (!result.shot) throw new Error("모바일 사진 경로 없음");
    } catch (failure) { result.shot = null; result.shotError = String(failure.message); result.noPhotoReason = result.shotError; }
    scenes.push(result);
    return result;
  };
  const candidate = async (code, description, tree, elements = [], extra = {}) => {
    const key = code + "\0" + description;
    if (seenCandidates.has(key)) {const prior=candidates.find(item=>item.key===key);prior.count++;prior.lastAtMs=atMs();prior.periodicityMs=(prior.lastAtMs-prior.atMs)/(prior.count-1);return;}
    seenCandidates.add(key);
    const item = { id:crypto.randomUUID(), key, code, description, atMs:atMs(),lastAtMs:atMs(),count:1,periodicityMs:null,sel:elements[0]?.resourceId||elements[0]?.AXIdentifier||null,text:elements.map(element=>nameOf(element)||valueOf(element)).join(" ")||description, ...extra };
    const shot = await scene("S4", description, tree, {candidateId:item.id, code}, elements);
    item.sceneId = shot.id; item.noPhotoReason = shot.noPhotoReason;
    candidates.push(item);
  };
  const effectObserved = (effect, tree) => {
    const expected = effect.expected;
    if (expected.type === "none") return !changed && atMs() >= declared.within;
    const original = content(before).filter(element => matches(element, expected));
    const current = content(tree).filter(element => matches(element, expected));
    if (expected.type === "appear") return !original.length && current.length > 0;
    if (expected.type === "disappear") return original.length > 0 && current.length === 0;
    if (expected.type === "unchanged") return !effect.violated && atMs() >= declared.within && sameContent(original, current);
    // absent 는 관찰이 끝날 때 대상이 없으면 성립(조작 전에 있었는지는 보지 않음)
    if (expected.type === "absent") return atMs() >= declared.within && current.length === 0;
    return current.some(element => {
      const prior = baseline.get(keyOf(element));
      return prior && (expected.from == null || valueOf(prior) === expected.from)
        && valueOf(element) === expected.to && valueOf(prior) !== valueOf(element);
    });
  };
  const summary = () => { return { ...identity,id,reactionId:id,background,idle, pass:(background || delivered) && !error && !stop && scenes.some(item => item.claim.kind === "S3" && item.shot) && effects.every(effect => effect.observed && scenes.find(item => item.id === effect.sceneId)?.shot),
        effects, candidates, unexpected, scenes, delivered, firstVisibleMs, firstReactionMs:firstVisibleMs, completedMs,
        unavailable:["K2", "K8", "K9"],
        limits:["접근성 트리 조회 사이에 나타났다 사라진 변화", "K2 기기 콘솔·네트워크 오류 미계측", "K6 이미지 색상·깨진 이미지 검사 미계측",
          "K8 접근성 트리로 가려짐·겹침 여부 판정 불가", "K9 같은 변경 요청의 반복 여부 미계측", "기기 화면의 반복 애니메이션 비교 미계측"],
        ...(error ? {error} : {}), ...(idleError ? {idleError} : {}) };
  };
  const watch = {
    id, effects, scenes, action, expect:declared, get idle(){return idle;}, get armed(){return started!=null;},
    async initial() {
      const target = action?.args || action;
      const elements = content(before).filter(element => target?.x != null && target?.y != null
        && target.x >= element.frame.x && target.x <= element.frame.x + element.frame.width
        && target.y >= element.frame.y && target.y <= element.frame.y + element.frame.height);
      const recordedAction = action?.command === "type" ? {command:"type",args:{length:action.args?.text?.length ?? 0}} : action;
      return scene("S1", background ? "모바일 배경 반응 관찰 시작" : "모바일 조작과 기대 효과 선언", before, { action:recordedAction, expect:declared }, elements);
    },
    premise() { return background ? [] : mobilePremiseErrors(effects.map(effect => effect.expected), before); },
    arm() {
      if (started != null) throw new Error("한 반응 관찰에는 조작 하나만 전달할 수 있습니다.");
      started = now(); armResolve();
    },
    delivered(value = true) { delivered = value === true; doneResolve(); },
    // iOS 붙여넣기 허용 창처럼 도구가 시스템 화면을 처리하는 동안은 앱 반응이 아님. 판정을 멈추고, 재개 시점부터 기대 시간을 셈
    pause() { paused = true; },
    resume() { if (started != null) started = now(); paused = false; },
    stop() { stop = true; clearTimeout(idleTimer); armResolve(); doneResolve(); return idleQueue; },
    // 판정 중 오류는 finish 가 이미 그 조작의 실패로 돌려줌. drain 이 다시 error 로 돌려주면 다음 조작·회차 종료가 매번 실패
    async drain() {if(idle&&!stop){idleQueue=idleQueue.then(idleRead);await idleQueue;}const result=summary();if(result.error){result.actionError=result.error;delete result.error;}return result;},
    async finish(value) {
      if (value != null) delivered = value === true;
      if (started == null) { started = now(); stop = true; armResolve(); }
      doneResolve();
      await watch.done;
      if(retainIdle&&!stop&&!idle){idle=true;scheduleIdle();}
      return summary();
    },
  };
  const inspectTree = async tree => {
        lastTree = tree;
        const current = view(tree), elapsed = atMs();
        const fresh = [...current].filter(([key, element]) => !lastView.has(key) || signature(lastView.get(key)) !== signature(element)).map(([, element]) => element);
        const removed = [...lastView].filter(([key]) => !current.has(key)).map(([, element]) => element);
        if (fingerprint(tree) !== initial) changed = true;
        if(!idle && elapsed<=declared.within)for(const effect of effects.filter(effect=>effect.expected.type==="unchanged")){
          const original=content(before).filter(element=>matches(element,effect.expected)), currentElements=content(tree).filter(element=>matches(element,effect.expected));
          // 처음 바뀐 순간과 모양을 남겨 실패 이유로 알림(새로고침처럼 잠깐 사라졌다 돌아오는 경우)
          if(!effect.violated&&!sameContent(original,currentElements))Object.assign(effect,{violated:true,violatedAtMs:elapsed,
            violation:!currentElements.length?"사라짐":currentElements.length!==original.length?`개수 ${original.length}→${currentElements.length}`:"내용 바뀜"});
        }
        if ((fresh.length || removed.length) && firstVisibleMs == null) {
          firstVisibleMs = elapsed;
          if (elapsed > FIRST_RESPONSE_MS) await candidate("K4", `첫 보이는 반응까지 ${elapsed}ms`, tree, fresh);
        }
        const satisfied = [];
        for (const effect of effects) {
          if (idle || effect.observed || (effect.expected.type !== "none" && elapsed > declared.within) || !effectObserved(effect, tree)) continue;
          const expected = effect.expected;
          const selected = content(expected.type === "disappear" ? before : tree).filter(element => matches(element, expected));
          const description = expected.type === "none" ? "기대 시간 동안 보이는 변화 없음" : expected.type === "unchanged" ? `${labelOf(expected)} 관찰 시간 동안 변경 없음` : expected.type === "absent" ? `${labelOf(expected)} 관찰 끝까지 없음` : `${labelOf(expected)} ${expected.type === "appear" ? "나타남" : expected.type === "disappear" ? "사라짐" : `값 변경: ${expected.from ?? "이전 값"} → ${expected.to}`}`;
          const shot = await scene("S2", description, tree, { effectId:effect.id }, selected);
          Object.assign(effect, {observed:true, atMs:elapsed, sceneId:shot.id, description, noPhotoReason:shot.noPhotoReason}); satisfied.push(...selected.map(keyOf));
        }
        for (const element of content(tree)) {
          const text = nameOf(element) + " " + valueOf(element);
          if ([nameOf(element), valueOf(element)].some(value => /\b(?:undefined|null|NaN|Invalid Date)\b|\[object Object\]|\{\{[^}]+\}\}|\$\{[^}]+\}|^[a-z]+(?:\.[a-z_]+){2,}$/.test(value))) {
            await candidate("K7", `화면에 표시된 미처리 값: ${text.trim()}`, tree, [element]);
          }
          if (["button", "link", "textbox", "dialog", "checkbox"].includes(mobileRoleOf(element)) && !nameOf(element)) {
            await candidate("K10", `이름 없는 ${element.type}`, tree, [element]);
          }
        }
        const busy = content(tree).filter(element => mobileRoleOf(element) === "progressbar" || element.busy === true
          || /^(?:loading|로딩|불러오는 중|처리 중)(?:\.{1,3}|…)?$/i.test(nameOf(element)));
        if (busy.length && busySince == null) busySince = elapsed;
        if (!busy.length) busySince = null;
        if (busySince != null && elapsed - busySince > BUSY_MS) await candidate("K5", "로딩 표시가 10초 넘게 남음", tree, busy);
        if (!content(tree).some(element => nameOf(element) || element.AXValue)) await candidate("K6", "화면에 읽을 수 있는 내용 없음", tree);
        if (fresh.length || removed.length) {
          const other = fresh.filter(element => !satisfied.includes(keyOf(element))
            && !effects.some(effect => effect.expected.type !== "none" && matches(element, effect.expected)));
          const otherRemoved = removed.filter(element => !effects.some(effect => effect.expected.type === "disappear" && matches(element, effect.expected)));
          if (other.length || otherRemoved.length) {
            const description = other.length ? changeDescription(other) : "기대 밖 요소 사라짐";
            const elements = other.length ? other : otherRemoved;
            const key = elements.map(keyOf).sort().join("\0") || description;
            const prior = seenUnexpected.get(key);
            if (prior) { prior.count = (prior.count || 1) + 1; prior.lastAtMs = elapsed; prior.periodicityMs = (prior.lastAtMs - prior.atMs)/(prior.count-1); }
            else {
              const item = {id:crypto.randomUUID(), description, atMs:elapsed, lastAtMs:elapsed, count:1, periodicityMs:null,
                sel:elements[0]?.resourceId || elements[0]?.AXIdentifier || null,selector:elements[0]?.resourceId || elements[0]?.AXIdentifier || null,
                text:elements.map(element => nameOf(element) || valueOf(element)).join(" ").slice(0,1000)};
              const shot = await scene("S4", description, tree, {candidateId:item.id}, elements);
              item.sceneId = shot.id; item.noPhotoReason = shot.noPhotoReason; unexpected.push(item); seenUnexpected.set(key,item);
            }
          }
        }
        lastView = current;
  };
  // 판정이 끝난 뒤의 대기 관찰. 조회 실패는 이 조작의 error 가 아닌 idleError. error 로 두면 다음 조작 전 drain 이 매번 실패함
  const idleRead = async () => {
    if (stop) return;
    try {
      const tree = await bounded(readTree, operationTimeoutMs, "모바일 접근성 조회");
      if (!Array.isArray(tree)) throw Error("접근성 트리를 확인하지 못했습니다.");
      await inspectTree(tree);
    } catch (failure) { idleError = String(failure.message); }
  };
  const scheduleIdle = () => {idleTimer=setTimeout(()=>{idleQueue=idleQueue.then(idleRead).finally(()=>{if(!stop)scheduleIdle();});},interval);idleTimer.unref?.();};
  watch.done = (async () => {
    await armed;
    if (stop) return;
    const tail = Math.max(0, Math.min(1000, tailMs));
    try {
      while (!stop) {
        if (paused) { await wait(interval); continue; }
        const deadlineBeforeRead = completedMs == null ? declared.within : completedMs + tail;
        if (atMs() >= deadlineBeforeRead) {
          for (const effect of effects) if (!effect.observed && ((effect.expected.type === "none" && !changed) || (["unchanged","absent"].includes(effect.expected.type) && effectObserved(effect,lastTree)))) {
            const description = effect.expected.type === "unchanged" ? "관찰 시간 동안 대상 변경 없음" : effect.expected.type === "absent" ? `${labelOf(effect.expected)} 관찰 끝까지 없음` : "기대 시간 동안 보이는 변화 없음";
            const proof = await scene("S2", description, lastTree, {effectId:effect.id});
            Object.assign(effect,{observed:true,atMs:atMs(),sceneId:proof.id,description,noPhotoReason:proof.noPhotoReason});
          }
          if (!background && completedMs == null && effects.every(effect => effect.observed)) { completedMs = atMs(); continue; }
          break;
        }
        // 기한 전에 시작한 조회는 끝까지 대기
        // 남은 시간만 주면 조회가 느린 기기(iOS idb 약 0.7초)의 마지막 조회가 매번 시간 초과
        const tree = await bounded(readTree, operationTimeoutMs, "모바일 접근성 조회");
        if (!Array.isArray(tree)) throw new Error("반응 관찰의 접근성 트리를 확인하지 못했습니다.");
        if (paused) continue;
        await inspectTree(tree);
        if (!background && completedMs == null && effects.every(effect => effect.observed)) completedMs = atMs();
        const deadline = completedMs == null ? declared.within : completedMs + tail;
        // 기한을 넘겨 끝난 조회도 맨 위 분기로 보내 unchanged·none·absent 를 판정. 바로 끝내면 iOS 조회(약 0.7초)가 기한을 넘길 때마다 미관찰
        if (atMs() >= deadline) continue;
        await wait(Math.max(0, Math.min(interval, deadline - atMs())));
      }
    } catch (failure) { error = String(failure.message); }
    await deliveryReady;
    const missing = effects.filter(effect => !effect.observed);
    const end = await scene("S3", error ? `모바일 반응 관찰 실패: ${error}` : !background && !delivered ? "모바일 조작 전달 미확인" : missing.length
      ? `기대 시간 종료: ${missing.map(effect => labelOf(effect.expected)).join(", ")} 미관찰` : "기대 효과 확인 뒤 반응 기록 종료", lastTree,
      { missingEffectIds:missing.map(effect => effect.id) });
    for (const effect of missing) {
      // appear 는 조작 전에 맞는 요소가 없어야 성립. text 는 부분 일치라 기존 글자에 포함되면 새 요소가 나타나도 미관찰
      const present = effect.expected.type === "appear" ? content(before).filter(element => matches(element, effect.expected)).map(element => nameOf(element) || valueOf(element)) : [];
      // disappear·unchanged·change 는 조작 전에 맞는 요소가 있어야 성립. 메뉴·시트가 덮으면 뒤 요소가 트리에서 빠짐
      const absentBefore = ["disappear", "unchanged", "change"].includes(effect.expected.type) && !content(before).some(element => matches(element, effect.expected));
      const reason = present.length ? ` (조작 전부터 조건에 맞는 요소 있음: ${present.slice(0, 3).join(", ")}. 정확한 이름은 role과 name 또는 sel [label="…"]로 지정)`
        : absentBefore ? " (조작 전 화면에 조건에 맞는 요소 없음. 메뉴·시트에 가려 접근성 트리에서 빠졌을 수 있으니 조작 전 화면에 보이는 요소로 지정)"
        : effect.expected.type === "absent" ? " (관찰이 끝날 때 대상이 화면에 있음)"
        : effect.expected.type === "none" ? " (관찰 중 화면이 바뀜. 당겨서 새로고침처럼 잠깐 바뀌었다 돌아오는 조작이면 남아 있어야 할 요소에 unchanged 를 적음)"
        : effect.violated ? ` (관찰 중 ${effect.violatedAtMs}ms에 대상 ${effect.violation}. 유지는 관찰 내내 그대로여야 함. 화면을 다시 그리는 조작이면 끝난 뒤 상태를 따로 확인)` : "";
      const item = {id:crypto.randomUUID(), code:"K1", description:`기대 효과 미관찰: ${labelOf(effect.expected)}${reason}`, effectId:effect.id,sel:effect.expected.sel||null,text:labelOf(effect.expected),periodicityMs:null,count:1,lastAtMs:atMs(), atMs:atMs()};
      const proof = { ...end, id:crypto.randomUUID(), sameSceneId:end.id, claim:{kind:"S4", description:item.description, candidateId:item.id, code:item.code} };
      scenes.push(proof); item.sceneId = proof.id; item.noPhotoReason = proof.noPhotoReason; candidates.push(item);
    }
    if (!background && delivered && !changed && effects.some(effect => !["none","unchanged","absent"].includes(effect.expected.type))) {
      const item = {id:crypto.randomUUID(), code:"K3", description:"전달된 조작의 보이는 반응 없음",sel:null,text:"전달된 조작의 보이는 반응 없음",periodicityMs:null,count:1,lastAtMs:atMs(), atMs:atMs()};
      const proof = {...end,id:crypto.randomUUID(),sameSceneId:end.id,claim:{kind:"S4",description:item.description,candidateId:item.id,code:item.code}};
      scenes.push(proof); item.sceneId = proof.id; item.noPhotoReason = proof.noPhotoReason; candidates.push(item);
    }
    if ((!background && !delivered) || error || scenes.some(item => item.shotError)) {
      const failures = [...new Set([!delivered && "모바일 조작 전달 미확인", error, ...scenes.map(item => item.shotError)].filter(Boolean))];
      scenes.push({...end,id:crypto.randomUUID(),sameSceneId:end.id,claim:{kind:"S6",description:failures.join("; ")},noPhotoReason:end.noPhotoReason});
    }
  })();
  return watch;
}
