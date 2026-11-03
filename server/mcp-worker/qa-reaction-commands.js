// worker 사본 · 원본 cdp-qa-reaction.cjs 에서 반응 상태를 명령 단위 밖(worker)에 두도록 바꾼 것 (test/mcp-worker-qa-observe-route.mjs 가 대조)
// 원본은 ⑧에서 지움
// 같은 본문: reactionWatch · matchesPattern · ingest · 효과 판정 · qa-target-resolve · 시작 검사 · 종료 판정
// 다른 점: 메인의 observation.subscribeEvents 대신 io.subscribe(장기 구독) · 장면 촬영은 io.capture(별도 단위) · 진단은 io.diagSince(obs.since) · 정리는 최신 명령 단위의 send·io
// 원본에 없는 수정: 새로고침·이동으로 지워진 실행 환경을 끝 조회에서 뺌(test/qa-reaction-reload-context.test.mjs)
import { createHash, randomBytes } from "node:crypto";

const BINDING = "__irisQaReaction";
const WORLD = "iris-qa-reaction";
const LATE_MS = 1000; // 첫 보이는 반응의 지연 후보 기준
const LOADING_MS = 10000; // 남아 있는 로딩 표시의 후보 기준
const TAIL_MS = 200;
// 지우기 이벤트보다 먼저 끝 조회가 나간 이동 · 사라진 환경은 읽을 효과가 없음
const GONE_CONTEXT = /Cannot find context with specified id/;
const BACKGROUND_MS = 1000; // 화면을 처음 연 뒤 무조작으로 기록하는 시간
const ABANDONED_MS = 30000; // 대기 상한 뒤 이만큼 종료가 없으면 버려진 관찰(명령 제한 30초)


function matchesPattern(value, pattern) {
  if (typeof pattern !== "string" || !pattern) return false;
  const escaped = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(escaped).test(String(value || ""));
}

// 격리 영역의 읽기 전용 DOM 관찰과 짧은 표시의 생성 시점 통지
function reactionWatch(config) {
  const key = "__irisQaReactionState";
  if (globalThis[key]?.id === config.id) return globalThis[key].snapshot;
  globalThis[key]?.stop();
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const visible = element => {
    if (!element.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse" || Number(css.opacity) === 0) return false;
    }
    const b = element.getBoundingClientRect(); return b.width > 0 && b.height > 0;
  };
  const rect = element => { const b = element.getBoundingClientRect(); return { x:b.x,y:b.y,width:b.width,height:b.height }; };
  // qa_snapshot 의 접근성 이름과 같은 순서(aria-labelledby → aria-label → label → alt·title → 내용)로 계산해야 role·name 기대가 같은 요소를 찾음
  // label 안의 컨트롤은 그 컨트롤의 이름으로 읽음(이름을 구하는 요소 자신은 aria-label 만). Base UI Switch 가 감싼 label 로 이름을 얻는 사례
  const labelText = (node, self) => node.nodeType === 3 ? node.data || "" : node.nodeType !== 1 || node.getAttribute("aria-hidden") === "true" ? ""
    : node === self ? node.getAttribute("aria-label") || "" : node.getAttribute("aria-label") || (node.localName === "input" ? node.value || ""
    : Array.from(node.childNodes || []).map(child => labelText(child, self)).join(" "));
  const labelOf = (label, self) => label ? Array.from(label.childNodes || []).map(child => labelText(child, self)).join(" ") : "";
  const name = element => normalize((element.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => labelOf(document.getElementById(id), element)).join(" ") || element.getAttribute("aria-label") || labelOf(element.labels?.[0], element) || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") || element.textContent || (["button","submit","reset"].includes(element.type)?element.value:""));
  // qa_snapshot(접근성 트리)과 같은 role. input 은 type 마다 role 이 다름
  const inputRole = type => ({checkbox:"checkbox",radio:"radio",range:"slider",number:"spinbutton",search:"searchbox",button:"button",submit:"button",reset:"button",image:"button",hidden:""})[type] ?? "textbox";
  const role = element => element.getAttribute("role") || ({button:"button",a:element.hasAttribute("href")?"link":"",input:inputRole(element.type),textarea:"textbox",select:"combobox",dialog:"dialog",img:"img",h1:"heading",h2:"heading",h3:"heading",h4:"heading",h5:"heading",h6:"heading",progress:"progressbar",option:"option"}[element.localName] || "");
  // 선택 상자의 글자는 선택된 항목. 전체 항목 글자로 읽으면 값만 바뀌는 선택을 change 기대로 볼 수 없음
  // 입력 칸·textarea 의 글자는 입력한 값. textarea 의 innerText 는 처음 내용이라 입력 단계 기대가 미관찰이던 사례
  const control = element => ["input", "textarea", "select"].includes(element.localName);
  const text = element => element.localName === "input" ? element.type === "password" ? "" : normalize(element.value) : element.localName === "textarea" ? normalize(element.value) : element.localName === "select" ? normalize(element.selectedOptions?.[0]?.label) : normalize(element.innerText || element.textContent).slice(0,1000);
  const elements = () => Array.from(document.querySelectorAll("body *")).filter(visible).filter(e => !e.closest('[id^="__ac"]')).slice(0,3000);
  const targets = effect => {
    if(!["appear","disappear","change","unchanged","absent"].includes(effect.type))return [];
    // 기대 효과는 elements() 의 3000개 상한 없이 전체에서 찾음. 요소 5천 개 화면에서 body 끝에 붙는 알림이 상한 밖이라 기대 미관찰로 판정된 사례
    // 보이는지 계산은 비싸서 글자(textContent 는 innerText 를 포함)·role·name 으로 먼저 거름
    const want = effect.text == null ? null : normalize(effect.text);
    const selected = Array.from(document.querySelectorAll(effect.sel || "body *")).filter(e => !e.closest('[id^="__ac"]'));
    const hits = selected.filter(e => (want == null || normalize(control(e) ? text(e) : e.textContent).includes(want)) && (!effect.role || role(e) === (effect.role === "image" ? "img" : effect.role)) && (!effect.name || name(e) === effect.name))
      .filter(visible).filter(e => want == null || text(e).includes(want));
    return effect.text != null ? hits.filter(e=>!hits.some(child=>child!==e && e.contains(child))) : hits;
  };
  const sample = () => {
    const all = elements();
    return { url:location.href, bodyText:normalize(document.body?.innerText).slice(0,1000),
      // 새 문서 주입 직후에는 documentElement 생성 전
      horizontal:(document.documentElement?.scrollWidth || 0) > innerWidth+1,
      effects:config.effects.map(effect => { if(!["appear","disappear","change","unchanged","absent"].includes(effect.type))return {id:effect.id}; const hits = targets(effect); return { id:effect.id,found:hits.length > 0,text:hits[0] ? text(hits[0]) : null,rect:hits[0]?rect(hits[0]):null,signature:JSON.stringify(hits.map(e=>[text(e),role(e),name(e)])),unsupported:hits.some(e=>e.closest("canvas,video")) }; }),
      visibleElements:all.filter(e=>!["script","style","meta","link"].includes(e.localName)).length,
      target:(()=>{const e=Number.isFinite(config.target?.x)?document.elementFromPoint(config.target.x,config.target.y):document.activeElement;return e?{...rect(e),name:name(e),role:role(e)}:null;})(),
      busy:all.filter(e => e.getAttribute("aria-busy") === "true" || role(e) === "progressbar" || /(^|[-_ ])loading([-_ ]|$)/i.test(String(e.className))).map(e => ({text:text(e),rect:rect(e)})),
      broken:all.filter(e => e.localName === "img" && e.complete && e.currentSrc && e.naturalWidth === 0).map(e => ({text:e.currentSrc,rect:rect(e)})),
    };
  };
  const signatureOf = node => JSON.stringify([text(node),role(node),name(node),node.isConnected]);
  let prior = new Map(), unchangedTargets = new Map(), first = true, lastEffects = "", lastSnapshot = "", lastHorizontal = false, armed = false;
  const nodeKey = element => {
    if(!element)return "";
    if(element.id)return "#"+element.id;
    const parts=[];
    for(let node=element;node && node!==document.body;node=node.parentElement)parts.push(node.localName+":"+Array.from(node.parentElement?.children||[]).indexOf(node));
    return parts.reverse().join("/");
  };
  const emit = payload => { try { globalThis[config.binding](JSON.stringify({ id:config.id,at:Date.now(),...payload })); } catch {} };
  // 이벤트 리스너 호출은 Event 전달, MutationObserver 호출만 기록 배열 전달
  const inspect = (input) => {
    const records = Array.isArray(input) ? input : [];
    if (Date.now() > config.deadline) { state.stop(); return; }
    const snapshot = sample(), all = elements(), changed = [], candidates = [];
    const unchangedViolated=[];
    // 같은 값을 다시 쓴 변경은 사람이 보는 결과가 같으므로 위반 아님: 조작 전 값과 다를 때만
    if(armed)for(const effect of config.effects.filter(e=>e.type==="unchanged"))for(const {node,sig} of unchangedTargets.get(effect.id)||[])if(records.some(record=>{const target=record.target?.nodeType===3?record.target.parentElement:record.target;return target&&(target===node||node.contains(target));}) && signatureOf(node)!==sig)unchangedViolated.push(effect.id);
    const next = new Map();
    for (const element of all) {
      const b = rect(element), value = text(element), previous = prior.get(element), fingerprint = JSON.stringify([value,b.x,b.y,b.width,b.height]);
      next.set(element,{fingerprint,text:value,rect:b,selector:nodeKey(element)});
      if (first || previous?.fingerprint === fingerprint) continue;
      const changedText=previous?.text !== value, changedBox=!previous || JSON.stringify(previous.rect)!==JSON.stringify(b);
      if(!armed) continue;
      // 위치만 바뀐 요소는 아래 K8 위치 이동 후보 하나로 묶음
      if (changed.length < 25 && changedText && (!element.children.length || ["alert","status","dialog"].includes(role(element)))) changed.push({text:value,from:previous?.text || null,rect:b,born:!previous,role:role(element),selector:nodeKey(element),atMs:Date.now()});
      const add = (code,description) => { if (candidates.length < 40) candidates.push({code,description,rect:b,sel:nodeKey(element),text:value}); };
      if (value && /\b(?:undefined|null|NaN)\b|\[object Object\]|Invalid Date|\{\{[^}]+\}\}|\$\{[^}]+\}|\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*\b/.test(value) && !element.children.length) add("K7","표시된 값: "+value.slice(0,200));
      if (role(element) === "alert" && /error|fail|오류|실패|잘못|문제/i.test(value)) add("K2","오류 알림: "+value.slice(0,200));
      if (!previous && ["button","link","textbox","combobox","dialog"].includes(role(element)) && !name(element)) add("K10","접근성 이름 없는 "+role(element));
      const css = getComputedStyle(element);
      if (value && !element.children.length && element.scrollWidth > element.clientWidth+1 && ["hidden","clip"].includes(css.overflowX) && css.textOverflow !== "ellipsis") add("K8","말줄임 없이 잘린 글자");
      if (!previous && (b.x+b.width < 0 || b.y+b.height < 0 || b.x >= innerWidth || b.y >= innerHeight)) add("K8","화면 밖 새 요소");
      if (previous && (Math.abs(previous.rect.x-b.x)>3 || Math.abs(previous.rect.y-b.y)>3)) add("K8","변경 요소의 위치 이동");
      if (!previous && ["button","link","textbox","combobox"].includes(role(element))) {
        const x=Math.max(0,Math.min(innerWidth-1,b.x+b.width/2)),y=Math.max(0,Math.min(innerHeight-1,b.y+b.height/2));
        const top=document.elementFromPoint(x,y);
        if(top && top!==element && !element.contains(top) && ["button","link","textbox","combobox"].includes(role(top))) add("K8","클릭 대상의 겹침");
      }
    }
    if(!first && snapshot.horizontal && !lastHorizontal) candidates.push({code:"K8",description:"조작 뒤 가로 스크롤 발생"});
    const effectPrint = JSON.stringify(snapshot.effects), snapshotPrint=JSON.stringify([snapshot.url,snapshot.busy,snapshot.broken,snapshot.visibleElements]);
    if (armed && !first && (changed.length || candidates.length || effectPrint !== lastEffects || snapshotPrint !== lastSnapshot || records.length)) emit({unchangedViolated,kind:"dom",domChanged:records.length>0,effects:snapshot.effects,changes:changed,candidates,snapshot});
    if(armed)for(const [element,previous] of prior)if(!next.has(element)) {
      emit({kind:"dom",effects:snapshot.effects,changes:[{text:previous.text,from:previous.text,gone:true,selector:previous.selector,rect:previous.rect}],snapshot});
    }
    prior=next; lastEffects=effectPrint; lastSnapshot=snapshotPrint; lastHorizontal=snapshot.horizontal; first=false; state.snapshot=snapshot;
  };
  // 페이지 부담 제한: 직전 inspect 비용의 4배 휴식 뒤 다음 inspect, 그동안의 변경 기록은 모아서 전달. 요소 5천 개 화면에서 40ms마다 300ms씩 실행돼 페이지와 CDP 응답(snapshot 25초 초과)이 막힌 사례
  let nextAt = 0, queued = null, deferred = null;
  const throttled = (input) => {
    if (Array.isArray(input)) queued = (queued || []).concat(input);
    const wait = nextAt - Date.now();
    if (wait > 0) { if (deferred == null) deferred = setTimeout(() => { deferred = null; throttled(); }, wait); return; }
    const records = queued || []; queued = null;
    const started = Date.now(); inspect(records); nextAt = Date.now() + (Date.now() - started) * 4;
  };
  const observer = new MutationObserver(throttled);
  let timer, performanceObserver;
  const state = { id:config.id,snapshot:null,arm(){inspect();unchangedTargets=new Map(config.effects.filter(e=>e.type==="unchanged").map(e=>[e.id,targets(e).map(node=>({node,sig:signatureOf(node)}))]));armed=true;return state.snapshot;},refresh(){inspect();return state.snapshot;},stop(){observer.disconnect();clearInterval(timer);clearTimeout(deferred);deferred=null;performanceObserver?.disconnect();document.removeEventListener("input",throttled,true);document.removeEventListener("change",throttled,true);document.removeEventListener("load",throttled,true);} };
  globalThis[key]=state;
  armed=config.autoArm === true;
  inspect();
  if(armed)emit({kind:"dom",effects:state.snapshot.effects,snapshot:state.snapshot,changes:elements().filter(e=>!e.children.length).slice(0,25).map(e=>({text:text(e),rect:rect(e),born:true,role:role(e)}))});
  observer.observe(document,{subtree:true,childList:true,attributes:true,attributeOldValue:true,characterData:true,characterDataOldValue:true});
  document.addEventListener("input",throttled,true);
  document.addEventListener("change",throttled,true);
  // 보이는 상태·이미지 로딩의 DOM 이벤트 보완
  document.addEventListener("load",throttled,true);
  timer=setInterval(throttled,40);
  try { performanceObserver=new PerformanceObserver(list => { for(const entry of list.getEntries()) if(armed && entry.value>0) emit({kind:"candidate",candidates:[{code:"K8",description:"조작 뒤 레이아웃 이동",value:entry.value}]}); });performanceObserver.observe({type:"layout-shift",buffered:false}); } catch {}
  return state.snapshot;
}

// io(명령 단위마다 qa-observe-route.js 가 만듦): subscribe(listener) · unsubscribe(subscription) · diagSince(since) · capture(args)
// 반응 상태는 worker 에 있고 명령 단위(start · end)를 넘어 살아 있음 · 명령마다 최신 send·io 로 갱신
function createQaReactionCommands({ now=Date.now, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)) } = {}) {
  const active=new Map();
  const bounded=async(task,ms=3000)=>{let timer;try{return await Promise.race([task(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("반응 관찰 시간 상한")),ms);})]);}finally{clearTimeout(timer);}};
  const push=(list,item)=>{list.push(item);};
  const capture=(state,kind,description,{effectId,candidateId,rect}={})=>{
    const scene={id:state.id+"-s"+(state.scenes.length+1),...(rect?{marks:[{...rect,label:description}]}:{}),claim:{kind,description,...(effectId?{effectId}:{}),...(candidateId?{candidateId}:{})},signalAt:now()};
    push(state.scenes,scene);
    const task=bounded(()=>state.io.capture({stable:false,moment:kind==="S2"||kind==="S4",caption:description,...(rect?{mark:{...rect,label:description}}:{})})).then(result=>{
      if(!result?.path || result.ok===false)throw Error(result?.error||"반응 장면 파일 없음");
      Object.assign(scene,result,{shot:result.path,path:result.path,capturedAt:result.capturedAt || now()});
    }).catch(error=>{scene.shotError=String(error.message||error);});
    state.pending.add(task);task.finally(()=>state.pending.delete(task));
    return scene;
  };
  const candidate=(state,code,description,rect,extra={})=>{
    const print=code+":"+description,prior=state.candidates.find(item=>item.key===print);
    if(prior){prior.count++;prior.lastAt=now();prior.periodicityMs=(prior.lastAt-prior.at)/(prior.count-1);return;}
    const item={id:state.id+"-c"+(state.candidates.length+1),key:print,code,description,at:now(),atMs:now()-state.started,lastAt:now(),count:1,periodicityMs:null,sel:null,text:description,...extra};push(state.candidates,item);
    item.sceneId=capture(state,"S4",description,{candidateId:item.id,rect}).id;
  };
  const observeEffect=(state,effect,description,rect)=>{
    if(effect.observed)return;
    if(["appear","disappear","change"].includes(effect.type))noteVisible(state);
    effect.observed=true;effect.at=now();effect.elapsedMs=now()-state.started;
    effect.sceneId=capture(state,"S2",description,{effectId:effect.id,rect}).id;
    if(state.effects.every(item=>item.observed))state.completedAt=now();
  };
  const noteVisible=(state)=>{
    if(state.firstVisibleAt!=null)return;state.firstVisibleAt=now();
    if(state.firstVisibleAt-state.started>LATE_MS)candidate(state,"K4","첫 보이는 반응까지 "+(state.firstVisibleAt-state.started)+"ms");
  };
  const domEffects=(state,entries)=>{
    for(const effect of state.effects) {
      const entry=entries.find(item=>item.id===effect.id);if(!entry)continue;
      if(state.idle)continue;
      const before=state.beforeEffects.get(effect.id);
      if(effect.type==="appear" && entry.found && !before?.found)observeEffect(state,effect,"기대한 요소 나타남: "+(effect.text||effect.name||effect.sel),entry.rect);
      if(effect.type==="disappear" && !entry.found && before?.found)observeEffect(state,effect,"기대한 요소 사라짐: "+(effect.text||effect.name||effect.sel),before.rect);
      if(effect.type==="change" && entry.found && entry.text===String(effect.to) && before?.text!==entry.text && (effect.from==null || before?.text===String(effect.from)))observeEffect(state,effect,"표시 변경: "+before?.text+" → "+entry.text,entry.rect);
      if(effect.type==="absent")effect.lastFound=entry.found;
      if(effect.type==="unchanged" && (!before?.found || !entry.found || (before.signature!=null ? before.signature!==entry.signature : before.text!==entry.text)))effect.violated=true;
    }
  };
  function ingest(state,method,params={},sid="") {
    if(!state.armed || state.closed || (!state.idle && now()>state.deadline+TAIL_MS))return;
    let event={method,at:now()};
    if(method==="Runtime.bindingCalled" && params.name==="__irisMoment") {
      let payload;try{payload=JSON.parse(params.payload);}catch{return;}
      push(state.events,{...payload,method,at:now()});
      if(payload.kind==="gone")for(const scene of state.scenes)if(scene.claim.description.includes(payload.text))scene.lived=payload.lived;
      return;
    } else if(method==="Runtime.bindingCalled" && params.name===BINDING) {
      let payload;try{payload=JSON.parse(params.payload);}catch{return;}
      if(payload.id!==state.id)return;
      event={...payload,method,at:now()};
      if(params.executionContextId && !state.contexts.some(c=>c.sid === (sid || null) && c.contextId === params.executionContextId))state.contexts.push({sid:sid || null,contextId:params.executionContextId});
      if(payload.snapshot)state.snapshots.set((sid || null)+":"+params.executionContextId,payload.snapshot);
      if(payload.effects)domEffects(state,payload.effects);
      for(const id of payload.unchangedViolated||[]){const effect=state.effects.find(e=>e.id===id);if(effect)effect.violated=true;}
      if(payload.kind === "moment") {
        const match=state.events.find(e=>e.momentId===payload.momentId && e.kind==="moment");
        if(payload.gone && match) { match.lived=payload.lived; for(const scene of state.scenes)if(scene.claim.description.includes(payload.text))scene.lived=payload.lived; }
      }
      for(const c of payload.candidates||[])candidate(state,c.code,c.description,c.rect,{sel:c.sel||c.selector||null,text:c.text||c.description});
      const changes=payload.changes||[];
      if(payload.domChanged || changes.length)state.signalCount++;
      if(changes.length)noteVisible(state);
      // 기대 효과로 관찰한 요소 안의 변화는 그 효과의 일부. 사라짐은 사라지기 전 위치 기준
      const within=(inner,outer)=>Boolean(inner && outer) && inner.x>=outer.x-1 && inner.y>=outer.y-1 && inner.x+inner.width<=outer.x+outer.width+1 && inner.y+inner.height<=outer.y+outer.height+1;
      const fresh=[];
      for(const change of changes) {
        const expected=state.effects.some(e=>["appear","change","disappear"].includes(e.type) && ((e.text && change.text?.includes(e.text)) || (e.name && change.text?.includes(e.name)) || (payload.effects?.some(hit=>hit.id===e.id && hit.found && within(change.rect,hit.rect)) || e.type==="disappear" && change.gone && within(change.rect,state.beforeEffects.get(e.id)?.rect))));
        if(!expected) {
          const description="기대 밖 화면 변화: "+(change.text||"요소 표시").slice(0,180),key=change.selector||description;
          const prior=state.unexpected.find(item=>item.key===key);
          if(prior){prior.count=(prior.count||1)+1;prior.lastAt=now();prior.periodicityMs=(prior.lastAt-prior.at)/(prior.count-1);}
          else {const item={id:state.id+"-u"+(state.unexpected.length+1),description,key,count:1,at:now(),lastAt:now(),sel:change.selector||null,selector:change.selector||null,periodicityMs:null,text:change.text||null,rect:change.rect,atMs:now()-state.started};push(state.unexpected,item);fresh.push(item);}
        }
      }
      // 기대 밖 변화 사진은 묶음마다 한 장, 앞 장면을 찍는 중이면 그 장면을 함께 씀. 목록이 다시 그려지면 한 조작에 요소 수백 개가 바뀌어 사진마다 찍으면 시간 상한에 걸림
      if(fresh.length) {
        const open=state.unexpectedScene && !state.unexpectedScene.shot && !state.unexpectedScene.shotError ? state.unexpectedScene : null;
        const scene=open || capture(state,"S4",fresh.length>1?("기대 밖 화면 변화 "+fresh.length+"건: "+fresh.slice(0,5).map(item=>item.text||"요소 표시").join(", ")).slice(0,200):fresh[0].description,{candidateId:fresh[0].id,rect:fresh[0].rect});
        state.unexpectedScene=scene;
        for(const item of fresh)item.sceneId=scene.id;
      }
    } else if(method==="Runtime.consoleAPICalled" || method==="Runtime.exceptionThrown" || method==="Log.entryAdded") {
      const text=(params.args||[]).map(arg=>arg.value??arg.description??"").join(" ") || params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || params.entry?.text || "";
      if(/Electron Security Warning/i.test(text))return;
      const level=params.type||params.entry?.level;
      if(method==="Runtime.exceptionThrown" || ["error","assert"].includes(level))candidate(state,"K2","브라우저 오류: "+String(text).slice(0,300),null,{kind:"console",text:String(text),stack:params.stackTrace?.callFrames||params.exceptionDetails?.stackTrace?.callFrames||null,errorStack:params.stackTrace?.callFrames||params.exceptionDetails?.stackTrace?.callFrames||params.exceptionDetails?.exception?.stackTrace||null});
      event.text=String(text).slice(0,2000);event.level=level;event.stack=params.exceptionDetails?.stackTrace?.callFrames||params.exceptionDetails?.exception?.stackTrace||null;
    } else if(method==="Network.requestWillBeSent") {
      state.signalCount++;
      const r=params.request||{},key=JSON.stringify([sid,params.requestId]);
      const req={url:r.url||"",method:r.method||"GET",bodyHash:createHash("sha256").update(r.postData||"").digest("hex"),initiator:params.initiator||null,initiatorStack:params.initiator?.stack?.callFrames||null};
      state.requests.set(key,req);event={...event,...req,initiator:params.initiator?.url||params.initiator?.requestId||null,initiatorStack:params.initiator?.stack?.callFrames||null};
      let pathname=req.url;try{pathname=new URL(req.url).pathname;}catch{}
      if(["POST","PUT","PATCH","DELETE"].includes(req.method)) {
        const fingerprint=JSON.stringify([req.method,pathname,req.bodyHash]),count=(state.requestCounts.get(fingerprint)||0)+1;state.requestCounts.set(fingerprint,count);
        if(count>1)candidate(state,"K9","같은 변경 요청 반복: "+req.method+" "+pathname,null,{kind:"network",url:req.url,initiator:req.initiator,initiatorStack:req.initiatorStack});
      }
      for(const effect of state.effects)if(effect.type==="request" && effect.status==null && effect.method===req.method && matchesPattern(req.url,effect.path))observeEffect(state,effect,"기대한 요청: "+req.method+" "+pathname);
    } else if(method==="Network.responseReceived" || method==="Network.loadingFailed") {
      const key=JSON.stringify([sid,params.requestId]),req=state.requests.get(key)||{},response=params.response||{};
      event={...event,url:response.url||req.url,status:response.status,failed:params.errorText};
      if(response.status>=400 || params.errorText)candidate(state,"K2","요청 오류: "+(response.status||params.errorText)+" "+(event.url||""),null,{kind:"network",text:String(response.status||params.errorText)+" "+(event.url||""),url:event.url,initiator:req.initiator,initiatorStack:req.initiatorStack,errorStack:params.errorText||null});
      if(method==="Network.responseReceived")for(const effect of state.effects)if(effect.type==="request" && effect.method===req.method && matchesPattern(event.url,effect.path) && (effect.status==null || effect.status===response.status))observeEffect(state,effect,"기대한 요청 응답: "+req.method+" "+response.status);
    } else if(method==="Runtime.executionContextsCleared") {
      for(const key of state.snapshots.keys())if(key.startsWith((sid || null)+":") || key.startsWith(sid+":"))state.snapshots.delete(key);
      state.contexts=state.contexts.filter(c=>(c.sid ?? null)!==(sid || null));
    } else if(method==="Page.frameNavigated" || method==="Page.navigatedWithinDocument") {
      if(sid || params.frame?.parentId)return;state.signalCount++;noteVisible(state);event.url=params.frame?.url||params.url;
      for(const effect of state.effects)if(effect.type==="navigate" && matchesPattern(event.url,effect.url))observeEffect(state,effect,"기대한 주소 이동: "+event.url);
    } else if(method==="Page.javascriptDialogOpening") {
      state.signalCount++;noteVisible(state);event.kind=params.type;event.text=params.message;
      for(const effect of state.effects)if(effect.type==="dialog" && (!effect.kind || effect.kind===params.type) && (effect.text==null || String(params.message).includes(effect.text)))observeEffect(state,effect,"기대한 대화상자: "+params.message);
      if(!state.effects.some(e=>e.type==="dialog" && e.observed)){
        const key="dialog:"+params.type+":"+params.message,prior=state.unexpected.find(item=>item.key===key);
        if(prior){prior.count++;prior.lastAt=now();prior.periodicityMs=(prior.lastAt-prior.at)/(prior.count-1);}
        else{const item={id:state.id+"-u"+(state.unexpected.length+1),key,description:"기대 밖 대화상자: "+params.message,sel:null,text:params.message,role:"dialog",at:now(),atMs:now()-state.started,lastAt:now(),count:1,periodicityMs:null};push(state.unexpected,item);item.sceneId=capture(state,"S4",item.description,{candidateId:item.id}).id;}
      }
    } else return;
    push(state.events,event);
  }
  const attach=(state,send,io)=>{state.send=send;state.io=io;return state;};
  const lookup=(wc,args)=>{const state=active.get(args.id);if(!state || state.wc.id!==wc.id)throw Error("이 탭의 반응 관찰을 찾지 못했습니다");return state;};
  const install=async(state,send,sid=null)=>{
    const frameSend=sid==null?send:send.on(sid),config={id:state.id,effects:state.effects,binding:BINDING,deadline:Number.MAX_SAFE_INTEGER,target:state.target};
    await frameSend("Runtime.addBinding",{name:BINDING,executionContextName:WORLD});
    const source=`(${reactionWatch.toString()})(${JSON.stringify(config)})`;
    const script=await frameSend("Page.addScriptToEvaluateOnNewDocument",{source:`(${reactionWatch.toString()})(${JSON.stringify({...config,autoArm:true})})`,worldName:WORLD});
    state.scripts.push({sid,identifier:script.identifier});
    const tree=await frameSend("Page.getFrameTree"),frames=[];
    const visit=node=>{if(node?.frame?.id)frames.push(node.frame.id);for(const child of node?.childFrames||[])visit(child);};visit(tree.frameTree);
    for(const frameId of frames) {
      const world=await frameSend("Page.createIsolatedWorld",{frameId,worldName:WORLD});
      if(!world.executionContextId)throw Error("반응 관찰 격리 영역 없음");
      const result=await frameSend("Runtime.evaluate",{expression:source,contextId:world.executionContextId,returnByValue:true});
      if(result.exceptionDetails || !result.result?.value)throw Error("반응 관찰 DOM 조회 실패");
      const snapshot=result.result.value;state.snapshots.set(sid+":"+world.executionContextId,snapshot);
      for(const entry of snapshot.effects||[])if(!state.beforeEffects.has(entry.id) || entry.found)state.beforeEffects.set(entry.id,entry);
      state.contexts.push({sid,contextId:world.executionContextId});
    }
  };
  const stop=async(state)=>{
    state.closed=true;active.delete(state.id);
    if(state.subscription){const subscription=state.subscription;state.subscription=null;await state.io.unsubscribe(subscription);}
    await Promise.allSettled([...state.scripts.filter(s=>s.identifier).map(s=>(s.sid==null?state.send:state.send.on(s.sid))("Page.removeScriptToEvaluateOnNewDocument",{identifier:s.identifier})),
      ...state.contexts.map(c=>(c.sid==null?state.send:state.send.on(c.sid))("Runtime.evaluate",{expression:"globalThis.__irisQaReactionState?.stop()",contextId:c.contextId}))]);
    await Promise.all(state.pending);
  };
  // 판정 근거는 조작·기대 효과·종료 장면. 기대 밖 변화(S4) 사진은 한 조작에 수백 장 생겨 시간 상한에 걸릴 수 있고, 실패는 그 후보의 사진 없음으로만 남김(모바일과 같음)
  const result=state=>({ok:true,id:state.id,reactionId:state.id,background:state.background,idle:state.idle===true,pass:state.effects.every(e=>e.observed)&&!state.scenes.some(scene=>scene.shotError&&scene.claim?.kind!=="S4"),effects:state.effects.map(e=>({...e})),candidates:state.candidates,unexpected:state.unexpected,scenes:state.scenes,events:state.events,tailMs:TAIL_MS,limits:state.limits,firstVisibleMs:state.firstVisibleAt==null?null:state.firstVisibleAt-state.started,completedMs:state.completedAt==null?null:state.completedAt-state.started,within:state.within,elapsedMs:now()-state.started});
  const commands = {
    async "qa-reaction-drain"(_send,wc,args={},io){const state=args.id?lookup(wc,args):[...active.values()].find(s=>s.wc.id===wc.id&&s.idle);if(!state)return {ok:true,empty:true};attach(state,_send,io);await Promise.all(state.pending);return result(state);},
    async "qa-target-resolve"(send,_wc,args={}) {
      const target=args.target||{}, valid=typeof target.text==="string"&&target.text.trim() || typeof target.role==="string"&&target.role.trim()&&typeof target.name==="string"&&target.name.trim();
      if(!valid)throw Error("대상의 role과 name 또는 text가 필요합니다");
      const tree=await send("Accessibility.getFullAXTree"), nodes=(tree.nodes||[]).filter(n=>!n.ignored&&n.backendDOMNodeId);
      const value=(n,k)=>String(n[k]?.value||"");
      // 이미지 role 은 Chrome 버전에 따라 img·image 로 갈림. qa_snapshot 에 보인 어느 쪽이든 같은 대상
      const roleKey=r=>{const lower=String(r).toLowerCase();return lower==="image"?"img":lower;};
      let matches=nodes.filter(n=>target.text!=null?value(n,"name").includes(target.text):roleKey(value(n,"role"))===roleKey(target.role)&&value(n,"name")===target.name);
      if(target.text!=null){const ids=new Set(matches.map(n=>n.nodeId));matches=matches.filter(n=>!(n.childIds||[]).some(id=>ids.has(id)));}
      const shown=[];
      // 비활성·pointer-events:none 대상은 클릭 지점의 맨 위가 감싼 부모로 잡힘. 가림이 아니라 입력 단계가 비활성으로 멈춤
      // 맨 위가 문서 바닥이면 페이지가 포인터 입력을 막은 상태(닫히는 대화상자의 body pointer-events:none). 누르면 html 에 들어가므로 inert 로 알림
      for(const node of matches){
        const box=await send("DOM.getBoxModel",{backendNodeId:node.backendDOMNodeId}).catch(()=>null);let q=box?.model?.border;if(!q){const quads=await send("DOM.getContentQuads",{backendNodeId:node.backendDOMNodeId}).catch(()=>null);q=quads?.quads?.[0];}
        if(!q||q.length!==8)continue;
        const x=(q[0]+q[2]+q[4]+q[6])/4,y=(q[1]+q[3]+q[5]+q[7])/4;
        const resolved=await send("DOM.resolveNode",{backendNodeId:node.backendDOMNodeId}),objectId=resolved.object?.objectId;if(!objectId)continue;
        let inspected;
        try{const out=await send("Runtime.callFunctionOn",{objectId,returnByValue:true,arguments:[{value:x},{value:y}],functionDeclaration:"function(x,y){const element=this.nodeType===3?this.parentElement:this,d=element.ownerDocument,e=d.elementFromPoint(x,y),b=element.getBoundingClientRect(),s=getComputedStyle(element);const sel=n=>n?.id?'#'+CSS.escape(n.id):n?.localName||null;return {displayed:b.width>0&&b.height>0&&s.display!=='none'&&s.visibility!=='hidden',offscreen:y<0?'위':y>=innerHeight?'아래':x<0?'왼쪽':x>=innerWidth?'오른쪽':null,occluded:!e||!(e===element||element.contains(e)||e.contains(element)&&(element.disabled===true||s.pointerEvents==='none')),inert:s.pointerEvents==='none'&&element.disabled!==true&&(e===d.documentElement||e===d.body),sel:sel(element),blocker:e?{sel:sel(e),text:String(e.innerText||e.textContent||'').trim().slice(0,1000)}:null};}"});inspected=out.result?.value;}finally{await send("Runtime.releaseObject",{objectId});}
        if(inspected?.displayed)shown.push({node,x,y,...inspected});
      }
      // nth: 같은 대상이 여럿일 때 접근성 트리 순서로 1부터 센 순번(qa_snapshot 의 (Nth) 와 같은 순서). qa_snapshot 은 창 밖 요소도 세므로 순번도 창 밖까지 셈
      // 창 밖 대상은 사람처럼 먼저 스크롤해야 함. 찾을 수 없음과 구분해 방향을 알림
      const nth=Number.isInteger(target.nth)&&target.nth>=1?target.nth:null;
      const hits=shown.filter(h=>!h.offscreen);
      if(nth&&shown[nth-1]?.offscreen)return {found:false,offscreen:shown[nth-1].offscreen,count:shown.length};
      if(!nth&&!hits.length&&shown.length)return {found:false,offscreen:shown[0].offscreen,count:shown.length};
      if(nth?!shown[nth-1]:hits.length!==1)return {found:false,...(hits.length&&!nth?{ambiguous:true,count:hits.length}:{}),...(nth?{count:shown.length}:{})};
      const hit=nth?shown[nth-1]:hits[0];let blocker=null,topNode=null;
      {const located=await send("DOM.getNodeForLocation",{x:Math.round(hit.x),y:Math.round(hit.y),includeUserAgentShadowDOM:false}).catch(()=>null);if(located?.backendNodeId){const ax=await send("Accessibility.getPartialAXTree",{backendNodeId:located.backendNodeId,fetchRelatives:false}).catch(()=>null);topNode=ax?.nodes?.find(n=>n.backendDOMNodeId===located.backendNodeId)||ax?.nodes?.[0];}}
      if(hit.occluded)blocker={...hit.blocker,role:value(topNode||{},"role"),name:value(topNode||{},"name"),at:now()};
      return {found:true,x:hit.x,y:hit.y,occluded:hit.occluded,inert:hit.inert===true,blocker,target:{role:value(!hit.occluded&&topNode?topNode:hit.node,"role"),name:value(!hit.occluded&&topNode?topNode:hit.node,"name"),text:value(hit.node,"name")},selector:hit.sel};
    },
    async "qa-background-observe"(send,wc,args={},io) {
      const duration=BACKGROUND_MS;
      const started=await commands["qa-reaction-start"](send,wc,{background:true,expect:{effects:[],within:duration},action:"background",target:null},io);
      return {...await commands["qa-reaction-end"](send,wc,{id:started.id,delivered:false},io),backgroundMs:duration};
    },
    async "qa-reaction-start"(send,wc,args={},io) {
      // 대기 상한이 지나고도 명령 제한(30초)만큼 더 남은 관찰은 종료가 오지 않은 것(확인 창이 페이지를 멈춘 클릭 등). 정리하고 새로 시작
      for(const old of [...active.values()])if(old.wc.id===wc.id){if(!old.idle&&(old.deadline==null||now()<old.deadline+ABANDONED_MS))throw Error("이 탭에 끝나지 않은 반응 관찰이 있습니다");attach(old,send,io);await stop(old);}
      const expect=args.expect;
      if(!Array.isArray(expect?.effects) || (!expect.effects.length && !args.background) || expect.effects.length>20)throw Error("반응 관찰의 기대 효과가 필요합니다");
      const within=expect.within??5000;if(!Number.isInteger(within)||within<50||within>15000)throw Error("반응 대기는 50~15000ms 범위입니다");
      const effects=expect.effects.map((e,i)=>({...e,id:e.id||"e"+(i+1),observed:false}));
      for(const e of effects) {
        if(!["appear","disappear","change","unchanged","absent","navigate","dialog","request","none"].includes(e.type)||typeof e.oracle!=="string"||!e.oracle.trim())throw Error("기대 효과와 oracle이 올바르지 않습니다");
        if(["appear","disappear","unchanged","absent"].includes(e.type)&&!e.sel&&!e.text&&!(e.role&&e.name))throw Error("표시 기대 대상이 필요합니다");
        if(e.type==="change"&&((!e.sel&&!(e.role&&e.name))||typeof e.to!=="string"))throw Error("변경 대상과 to가 필요합니다");
        if(e.type==="navigate"&&typeof e.url!=="string")throw Error("이동 url이 필요합니다");
        if(e.type==="request"&&(!e.method||typeof e.path!=="string"))throw Error("요청 method와 path가 필요합니다");
      }
      if(new Set(effects.map(e=>e.id)).size!==effects.length)throw Error("기대 효과 id가 중복되었습니다");
      const id=randomBytes(12).toString("hex"),state={background:args.background===true,id,wc,send,effects,within,target:args.target,started:now(),deadline:now()+within+5000,armed:false,closed:false,scenes:[],events:[],candidates:[],unexpected:[],limits:[],beforeEffects:new Map(),snapshots:new Map(),scripts:[],contexts:[],pending:new Set(),requests:new Map(),requestCounts:new Map(),seenCandidates:new Set(),seenUnexpected:new Set(),signalCount:0,firstVisibleAt:null,completedAt:null};
      active.set(id,state);attach(state,send,io);
      try {
        state.subscription=await io.subscribe(event=>{if(event.error){state.limits.push({code:event.error.code,message:event.error.message});return;}ingest(state,event.method,event.params,event.childSessionId||"");});
        const sessions=typeof send.frames==="function"?send.frames():[null];
        for(const sid of sessions)await install(state,send,sid);
        state.beforeEffects.clear();
        for(const c of state.contexts) {
          const response=await (c.sid==null?send:send.on(c.sid))("Runtime.evaluate",{expression:"globalThis.__irisQaReactionState.arm()",contextId:c.contextId,returnByValue:true});
          const snapshot=response.result?.value;
          if(!snapshot || response.exceptionDetails)throw Error("조작 전 DOM 이력 조회 실패");
          state.snapshots.set(c.sid+":"+c.contextId,snapshot);
          for(const entry of snapshot.effects||[]) {
            if(entry.unsupported)throw Error("코드로 확인 불가: canvas·동영상·WebGL 내부 효과");
            if(!state.beforeEffects.has(entry.id) || entry.found)state.beforeEffects.set(entry.id,entry);
          }
          if(snapshot.target)state.target=snapshot.target;
        }
        // 판정(domEffects)에서 반드시 미관찰이 되는 기대는 조작 전에 거부. change 는 조작 전에 없던 요소가 그 값으로 나타나도 성립해 제외
        const premise=state.effects.flatMap(effect=>{
          const before=state.beforeEffects.get(effect.id),label=effect.text||effect.name||effect.sel;
          if(effect.type==="appear" && before?.found)return ["appear "+label+": 조작 전부터 조건에 맞는 요소 있음("+(before.text||"글자 없음").slice(0,60)+"). 값이 바뀌면 change, 남아 있어야 하면 unchanged, 새 요소면 role과 name 또는 sel로 지정"];
          if(["disappear","unchanged"].includes(effect.type) && before && !before.found)return [effect.type+" "+label+": 조작 전 화면에 조건에 맞는 요소 없음"];
          return [];
        });
        if(premise.length)throw Error("기대 전제 불성립(조작 안 보냄): "+premise.join(" / "));
        const target=state.target;
        const scene=capture(state,"S1",(target?.name ? "‘"+target.name+"’ "+target.role+" ":"")+String(args.action||"조작"),{rect:target && [target.x,target.y,target.width,target.height].every(Number.isFinite)?target:undefined});
        await Promise.all(state.pending);
        if(scene.shotError)throw Error(scene.shotError);
        state.started=now();state.deadline=state.started+within;state.armed=true;
        return {...result(state),sceneId:scene.id};
      }catch(error){await stop(state);throw error;}
    },
    async "qa-reaction-poll"(_send,wc,args={},io) {return result(attach(lookup(wc,args),_send,io));},
    async "qa-reaction-end"(_send,wc,args={},io) {
      const state=attach(lookup(wc,args),_send,io);
      try {
        while(now()<state.deadline && state.completedAt==null) {
          for(const snapshot of state.snapshots.values())if(snapshot.busy?.length && now()-state.started>LOADING_MS)candidate(state,"K5","로딩 표시가 10초 넘게 남음",snapshot.busy[0].rect);
          if(!state.background && state.effects.length && state.effects.every(e=>e.type==="none"))break;
          await sleep(Math.min(20,Math.max(0,state.deadline-now())));
        }
        for(const c of [...state.contexts]){const response=await (c.sid==null?state.send:state.send.on(c.sid))("Runtime.evaluate",{expression:"globalThis.__irisQaReactionState.refresh()",contextId:c.contextId,returnByValue:true}).catch(error=>{if(GONE_CONTEXT.test(String(error?.message||error)))return null;throw error;});if(response?.result?.value?.effects)domEffects(state,response.result.value.effects);}
        for(const e of state.effects)if(e.type==="unchanged"&&!e.violated&&state.beforeEffects.get(e.id)?.found)observeEffect(state,e,"관찰 시간 동안 변경 없음: "+(e.name||e.text||e.sel),state.beforeEffects.get(e.id)?.rect);
        // absent 는 관찰이 끝날 때 대상이 없으면 성립. 마지막 조회가 없으면 조작 전 상태로 판정
        for(const e of state.effects)if(e.type==="absent"&&(e.lastFound??state.beforeEffects.get(e.id)?.found)===false)observeEffect(state,e,"관찰 끝까지 없음: "+(e.name||e.text||e.sel));
        if(!state.background && (state.completedAt!=null || (!state.background && state.effects.length && state.effects.every(e=>e.type==="none"))))await sleep(TAIL_MS);
        for(const e of state.effects)if(e.type==="none") {
          const meaningful=state.events.some(event=>event.method==="Runtime.bindingCalled"&&event.changes?.length || event.method.startsWith("Page.") );
          if(!meaningful)observeEffect(state,e,"보이는 변화 없음");
        }
        if(!state.background && args.delivered && !state.signalCount && state.effects.some(e=>!["none","unchanged","absent"].includes(e.type)))candidate(state,"K3","입력 전달 뒤 DOM·주소·요청·대화상자 반응 없음");
        // appear 는 조작 전에 맞는 요소가 없어야 성립. text 는 부분 일치라 기존 글자에 포함되면 새 요소가 나타나도 미관찰
        for(const e of state.effects)if(!e.observed){const before=e.type==="appear"&&state.beforeEffects.get(e.id);candidate(state,"K1","기대 미관찰: "+e.type+" "+(e.text||e.name||e.to||e.url||e.path||"")+(e.type==="absent"?" (관찰이 끝날 때 대상이 화면에 있음)":"")+(before?.found?` (조작 전부터 조건에 맞는 요소 있음: ${before.text||"글자 없음"}. 정확한 이름은 role과 name 또는 sel로 지정)`:""));}
        const snapshots=[...state.snapshots.values()];
        if(snapshots.length && snapshots.every(s=>!s.bodyText && !s.visibleElements))candidate(state,"K6","본문 글자 없는 화면");
        for(const snapshot of snapshots)for(const item of snapshot.broken||[])candidate(state,"K6","불러오기 끝난 깨진 이미지: "+item.text,item.rect);
        const scene=capture(state,"S3",state.effects.every(e=>e.observed)?"기대 효과 확인 후 반응 구간 종료":"대기 상한 · 미관찰: "+state.effects.filter(e=>!e.observed).map(e=>e.id).join(", "));
        await Promise.all(state.pending);
        return {...result(state),observation:await io.diagSince(state.started) || {console:state.events.filter(e=>e.method==="Runtime.consoleAPICalled"),exceptions:state.events.filter(e=>e.method==="Runtime.exceptionThrown"),network:state.events.filter(e=>e.method.startsWith("Network."))}};
      }finally{
        state.idle=true;
        // 구간 종료 뒤 새 문서 주입 해제: 다음 진입 이동의 새 요소를 이 조작 반응으로 기록 방지, 현재 문서 늦은 반응만 유지
        const scripts=state.scripts.filter(s=>s.identifier);state.scripts=[];
        await Promise.allSettled(scripts.map(s=>(s.sid==null?state.send:state.send.on(s.sid))("Page.removeScriptToEvaluateOnNewDocument",{identifier:s.identifier})));
      }
    },
  };
  Object.defineProperties(commands,{hasActive:{value:wcId=>[...active.values()].some(state=>state.wc.id===wcId)},dispose:{value:async (wcId,send,io)=>{for(const state of [...active.values()])if(state.wc.id===wcId)await stop(attach(state,send,io));}}});
  return commands;
}

export {createQaReactionCommands,reactionWatch,matchesPattern};
