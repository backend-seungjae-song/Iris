import { playQaSteps } from "./qa-play.js";
import { validateQaPlanList, reviewQaList, assertReviewed, unchangedExpectations } from "./qa-list-review.js";
import { appIdentity, applyCatalogSightings, matchCatalogReaction, loadReactionCatalogForRun, recordReactionJudgments, validateReactionJudgment, classifyCatalogReaction, reactionCatalogForAction, removeReactionCatalogItem, loadReactionCatalog } from "./qa-catalog.js";
import { QA_REACTION_ACTIONS, qaPendingReactions, assertQaReactionsJudged, reactionExpectation, recordQaReaction, compactReactionResponse, briefReactionItem, briefActionResponse, briefPlayResponse } from "./qa-reaction.js";
import { deriveQaRemediation, compactQaRemediation, assertQaRemediationComplete, deferQaRemediation, assertQaReplayContract, qaFailedPlay } from "./qa-remediation.js";
import { applyQaFix, validateQaRetest, QA_FIX_MAX_ATTEMPTS } from "./qa-fix.js";
import { createQaSummary } from "./qa-summary.js";
import { qaUnattendedPolicy, assertQaInvestigationTime, recordQaHumanRequired } from "./qa-unattended.js";
import { recordQaSession } from "./qa-session.js";
import { createQaMobile } from "./qa-mobile.js";
import fs from "node:fs";
import { artifactDir } from "./artifacts-home.cjs";
import { stateHome } from "./state-home.cjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyQaRow, deriveQaRows, reopenAfterVoid } from "./qa-rows.js";
import { createQaReport, qaReportProblems } from "./qa-report.js";
import { validateQaSession } from "./qa-session-contract.js";
import { bulkPolicy } from "./bulk-fill.js";
import { isLocalOrigin } from "./local-origin.cjs";
import crypto from "node:crypto";
import { createQaCombinedReport } from "./qa-combined-report.js";
import { createQaRoutes } from "./qa-routes.js";
import { validateQaCommand } from "./qa-protocol.js";

const INPUT = new Set(["click", "dblclick", "hover", "drag", "type", "key", "scroll"]);
const ACTION = new Set([...INPUT,"history","dialog","viewport"]);
const INVESTIGATION_ACTIONS = new Set(["play",...ACTION, "select", "login", "bulk_fill", "route_replay", "app_tap", "app_swipe", "app_type", "app_key"]);
const VIEW = new Set(["snapshot", "screenshot", "text", "url", "observe"]);
// 탭이 이미 닫혔다는 호스트 오류 (mcp-host/current-server.js·mcp-worker/browser-service.js 문구)
const GONE_TAB = /명령을 실행할 탭을 찾지 못했습니다|현재 실행할 수 있는 탭이 아닙니다/;
const requireOk = (r) => {
  if (!r?.ok || r.data?.ok === false || r.data?.error) {
    const error = new Error(r?.error || r?.data?.error || "실행 결과를 확인하지 못했습니다.");
    const dialogOpen = r?.dialogOpen || r?.data?.dialogOpen;
    if (dialogOpen) error.dialogOpen = dialogOpen;
    throw error;
  }
  return r.data || {};
};

// 회차 시작 승인 무응답 자동 수락까지의 시간
const keyHash = key => crypto.createHash("sha256").update(String(key)).digest("hex");
const validRunKey = (stored, runKey) => {
  const given = Buffer.from(keyHash(runKey || ""), "hex"), expected = Buffer.from(stored || "", "hex");
  return Boolean(stored && runKey && given.length === expected.length && crypto.timingSafeEqual(given, expected));
};
const assertRunKey = (stored, runKey) => {
  if (!validRunKey(stored, runKey))
    throw new Error("이 회차를 연 도구 연결이 아닙니다. 도구 연결이 다시 시작됐으면 qa_run_resume을 부르세요. 회차를 연 세션이면 새 열쇠로 이어받습니다.");
};
// 마지막 열쇠가 유효. 이어받을 때마다 새 열쇠를 기록
const runKeyHash = events => events.findLast(event => event?.kind === "run_key")?.detail?.hash;

// 회차별 직렬 실행과 서버가 소유하는 판정
// runKeys: 회차를 연 호출자만 아는 열쇠를 요구. session 은 호출자가 적는 문자열이라 소유 증명이 못 됨
// qa_summary·qa_report 의 overviewFile. overview 와 같은 검사를 받도록 읽은 값을 돌려줌
const OVERVIEW_FILE_MAX = 4 * 1024 * 1024;
function readOverviewFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { throw new Error(`args.overviewFile: 파일이 없습니다: ${file}`); }
  if (!stat.isFile() || stat.size > OVERVIEW_FILE_MAX) throw new Error(`args.overviewFile: 4MB 이하 파일이어야 합니다: ${file}`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`args.overviewFile: JSON으로 읽지 못했습니다: ${String(error?.message || error).slice(0, 200)}`); }
}
const unavailable = name => async () => ({ ok: false, error: `${name} host API가 연결되지 않았습니다.` });
const deferredSameProcessGrants = () => {
  let instance;
  const get = async () => instance ||= import("./mcp-worker/same-process-host.js").then(module => module.createSameProcessQaGrants());
  return {
    approve: async (...args) => (await get()).approve(...args),
    renew: async (...args) => (await get()).renew(...args),
    end: async (...args) => (await get()).end(...args),
    forRun: async (...args) => (await get()).forRun(...args),
    active: async (...args) => (await get()).active(...args),
  };
};

export function createQaChannel({ runKeys = false, autoResume = false, ledger,
  createEntry = unavailable("qa.tabCreate"), execute: executeCommand = unavailable("browser.executeWithDialog"),
  release = unavailable("qa.releaseIfOwner"), releaseDevice = unavailable("qa.releaseIfOwner"),
  close = unavailable("qa.tabClose"), ask = unavailable("qa.askUser"), restore = unavailable("qa.tabsRestore"),
  openReport = unavailable("qa.reportOpen"), runContext = (_state, invoke) => invoke(),
  mobileFactory = () => createQaMobile({ listDevices: unavailable("app.command") }),
  makeRoutes = createQaRoutes, activity,
  grants = deferredSameProcessGrants() } = {}) {
  const runs = new Map();
  const trackObservation = (st, surface, origin) => {
    if (!activity || !surface || !origin?.id) return;
    st.workerObservations ||= new Map();
    st.workerObservations.get(surface)?.release();
    const id = `${st.id}:${surface}:${origin.id}`;
    st.workerObservations.set(surface, {
      id: origin.id,
      release: activity.hold("observations", id, { run: st.id, session: st.session, surface, reactionId: origin.id }),
    });
  };
  const releaseObservation = (st, surface, id) => {
    const active = st.workerObservations?.get(surface);
    if (!active || id && active.id !== id) return;
    active.release();
    st.workerObservations.delete(surface);
  };
  // 열쇠는 도구 연결(MCP 프로세스) 메모리에만 있어 연결이 다시 시작되면 사라짐. 회차를 연 세션이 다시 부르면 묻지 않고 새 열쇠 발급, 다른 세션은 거부
  const issueRunKey = async (runId) => {
    const runKey = crypto.randomBytes(32).toString("hex"), hash = keyHash(runKey);
    await append(runId,{kind:"run_key",detail:{hash,via:"같은 세션 재연결",at:new Date().toISOString()}});
    return {runKey, hash};
  };
  const append = async (id,event) => {
    if(event.shot) {
      const state = runs.get(id);
      const surface = event.surface || event.tab || state?.tab;
      const mobile = state?.devices.has(surface) || String(event.url || "").startsWith("app://");
      event.captureTarget ||= {type:mobile ? "device":"tab",id:surface || "unknown"};
      if (!event.url) {
        if (mobile) event.url = "app://" + surface;
        else event.url = (await ledger.verify(id)).events.findLast(record => record.event.url && (!surface || record.event.surface === surface || record.event.tab === surface))?.event.url || "unknown";
      }
      if (!event.viewport) {
        try {
          const png = fs.readFileSync(event.shot);
          if (png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) event.viewport = {width:png.readUInt32BE(16),height:png.readUInt32BE(20),unit:"image-pixels"};
        } catch {}
        event.viewport ||= {unavailable:true};
      }
      event.stability ||= {waitedMs:0,stable:false,remaining:["not-measured"]};
      for(const [suffix,key] of [[".caption.txt","caption"],[".marks.json","marks"]]) {
        try {
          const raw = fs.readFileSync(event.shot + suffix,"utf8");
          event[key] = key === "marks" ? JSON.parse(raw):raw;
        } catch(error) { if(error.code !== "ENOENT") throw error; }
      }
    }
    const receipt = await ledger.append(id,event);
    if (event.shot && path.dirname(path.resolve(event.shot)) === path.resolve(artifactDir("shots")) && /^qa-/.test(path.basename(event.shot))) {
      for(const suffix of ["", ".caption.txt", ".marks.json"]) {
        try { fs.unlinkSync(event.shot + suffix); } catch(error) { if(error.code !== "ENOENT") throw error; }
      }
    }
    return receipt;
  };
  const savedPath = (id,receipt) => receipt?.event?.shot && ledger.paths ? path.resolve(ledger.paths(id).folder,receipt.event.shot) : receipt?.event?.shot;
  const moments = async (st,items = []) => {
    const saved = [];
    st.moments ||= new Map((await ledger.verify(st.id)).events.filter(r=>r.event.cmd === "moment" && r.event.detail?.momentKey).map(r=>[r.event.detail.momentKey,{...r,runId:st.id}]));
    for(const moment of items) {
      const momentKey = crypto.createHash("sha256").update(JSON.stringify([moment.targetId || st.tab,moment.ts,moment.shot || moment.path,moment.text || moment.texts])).digest("hex");
      if(st.moments.has(momentKey)) {
        const receipt=st.moments.get(momentKey);
        saved.push({...moment,shot:savedPath(st.id,receipt),seq:receipt.seq});
        continue;
      }
      // 순간 알림은 사라진 뒤에 전달되므로 기록 순서가 아닌 촬영 시각과 그때의 조작 번호로 연결
      const originRecord = Number.isFinite(moment.ts) ? (await ledger.verify(st.id)).events.findLast(r=>r.event.kind === "accepted" && r.event.at <= moment.ts && (r.event.surface === (moment.targetId || st.tab) || !r.event.surface)) : null;
      const origin = originRecord?.event;
      const context = moment.context || (origin ? {rowId:origin.rowId,path:origin.path,lanes:origin.lanes,acceptedSeq:originRecord.seq,mode:origin.mode}:{});
      const receipt = await append(st.id,{kind:"observation",mode:st.row ? "agent_action":"preparation",cmd:"moment",rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path]),...context,...(Number.isFinite(moment.ts) ? {capturedAt:moment.ts} : {}),surface:moment.targetId || st.tab,shot:moment.shot || moment.path,url:moment.url,viewport:moment.viewport,stability:moment.stability,captureTarget:moment.captureTarget,caption:moment.caption,marks:moment.marks,moment:moment.text || moment.texts?.join("\n"),detail:{lived:moment.lived,momentKey},pass:true});
      st.moments.set(momentKey,receipt);
      saved.push({...moment,shot:savedPath(st.id,receipt),seq:receipt.seq});
    }
    return saved;
  };
  const execute = async (tab,cmd,args) => {
    const response = await executeCommand(tab,cmd,args);
    const state = [...runs.values()].find(st=>st.tabs.has(tab));
    if(state && response?.data?.moments?.length) await moments(state,response.data.moments);
    return response;
  };
  const preserveFailure = async (st, failure, {device, mobile = false, contextOnly = false, capturedScene, capturedObservation} = {}) => {
    const stamp = {rowId:failure.event.rowId,path:failure.event.path,lanes:failure.event.lanes};
    const detail = contextOnly ? {} : {failureSeq:failure.seq};
    let scene = capturedScene || {}, observation = capturedObservation || {};
    const read = async command => requireOk(mobile
      ? await st.mobile.execute(st.session,command,{device})
      : await execute(tabOf(st),command,{}));
    try { if (!capturedScene) scene = await read("screenshot"); }
    catch (error) { detail.captureError = error.message; }
    try { if (!capturedObservation) observation = await (mobile ? read("observe") : execute(tabOf(st),"observe",{screenshot:false}).then(requireOk)); }
    catch (error) { detail.observeError = error.message; }
    for (const key of ["console","network","exceptions","alerts","snapshot"]) {
      if (observation[key] !== undefined) detail[key] = observation[key];
    }
    if (mobile) detail.unavailable = ["console","network","exceptions"].filter(key => observation[key] === undefined);
    if (!scene.viewport) {
      try {
        const png = fs.readFileSync(scene.path || scene.shot || observation.shot || observation.screenshot);
        if (png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) scene.viewport = {width:png.readUInt32BE(16),height:png.readUInt32BE(20),unit:"image-pixels"};
      } catch {}
    }
    const target = scene.targetId || observation.targetId || device || failure.event.surface;
    detail.environment = {url:scene.url || observation.url || failure.event.url || (mobile && target ? "app://" + target : undefined),
      viewport:scene.viewport || observation.viewport,
      device:mobile ? {targetId:target,platform:scene.platform || observation.platform,device:scene.device || observation.device} : {type:"browser",tab:st.tab}};
    const receipt = await append(st.id,{kind:contextOnly ? "observation":"failure",cmd:contextOnly ? "defect_context":undefined,mode:failure.event.mode,...stamp,surface:mobile ? target : st.tab,
      shot:scene.path || scene.shot || observation.screenshot || observation.path || observation.shot,
      claim:{kind:contextOnly ? "S4":"S3",description:contextOnly ? "결함 후보의 현재 화면":"실패 판정 시점의 화면"},
      url:detail.environment.url,viewport:scene.viewport || observation.viewport,stability:scene.stability || observation.stability,captureTarget:scene.captureTarget || observation.captureTarget,detail});
    const extra = observation.screenshot || observation.path || observation.shot;
    if (extra && extra !== (scene.path || scene.shot)) await append(st.id,{kind:"observation",mode:failure.event.mode,...stamp,
      cmd:mobile ? "app_observe":"observe",surface:mobile ? target : st.tab,shot:extra,url:observation.url,viewport:observation.viewport,stability:observation.stability,captureTarget:observation.captureTarget,detail:{failureSeq:failure.seq},pass:true});
    await moments(st,[...(scene.moments || []),...(observation.moments || [])]);
    return receipt;
  };
  // 다른 회차는 앞 줄(run_begin·catalog_begin)만 읽어 고름. 회차 시작마다 모든 회차를 전체 확인해 설치본 서버가 600MB 를 넘은 사례
  const runHead = name => { try { return ledger.head ? ledger.head(name,4) : []; } catch { return []; } };
  const catalogRunNumber = async (repo,id) => {
    if(!ledger.paths)return 1;
    const root=path.dirname(ledger.paths(id).folder),identity=appIdentity(repo);let count=0;
    for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
      if(!entry.isDirectory())continue;
      const begin=runHead(entry.name).find(r=>r.event?.kind==="run_begin")?.event;
      if(begin?.plan?.build?.repo)try{if(appIdentity(begin.plan.build.repo)===identity)count++;}catch{}
    }
    return count || 1;
  };
  // 같은 앱 회차의 반응 목록. 장부가 그대로면 지난 계산을 다시 씀(줄 전체는 보관하지 않음)
  const sightingCache = new Map();
  // 디스크에도 저장. 서버가 재시작될 때마다 모든 회차 기록(642MB)을 다시 읽어 2분 동안 CPU 300%·메모리 2.3GB 를 쓴 사례
  // 회차 폴더마다 파일을 나눔. 시험처럼 다른 폴더를 쓰는 채널이 실제 회차 목록을 지우지 않게
  const sightingFile = () => path.join(stateHome(), `qa-sightings-${crypto.createHash("sha1").update(ledger.paths ? path.dirname(ledger.paths("cache").folder) : "").digest("hex").slice(0, 12)}.json`);
  let sightingDisk = "unloaded";
  const loadSightings = () => {
    if(sightingDisk!=="unloaded")return;
    sightingDisk="clean";
    try{for(const [name,entry] of Object.entries(JSON.parse(fs.readFileSync(sightingFile(),"utf8")).runs||{}))if(!sightingCache.has(name))sightingCache.set(name,entry);}catch{}
  };
  const saveSightings = live => {
    if(sightingDisk!=="dirty")return;
    sightingDisk="clean";
    for(const name of sightingCache.keys())if(!live.has(name))sightingCache.delete(name);
    try{const file=sightingFile(),tmp=file+"."+process.pid+".tmp";fs.writeFileSync(tmp,JSON.stringify({runs:Object.fromEntries(sightingCache)}));fs.renameSync(tmp,file);}catch{}
  };
  const runSightings = async (name,current) => {
    let stat;try{stat=fs.statSync(ledger.paths(name).journal);}catch{return null;}
    loadSightings();
    const prior=sightingCache.get(name);
    if(prior && prior.ino===stat.ino && prior.size===stat.size && prior.mtimeMs===stat.mtimeMs)return prior.value;
    const verified=await ledger.verify(name,current?{}:{retain:false,photos:false}).catch(()=>null);
    if(!verified)return null;
    const begin=verified.events.find(r=>r.event.kind==="catalog_begin")?.event.detail;
    const items=[];
    for(const {event} of verified.events)
      for(const item of event.kind==="reaction"?[...(event.detail?.candidates||[]),...(event.detail?.unexpected||[])]:event.kind==="background_reaction"?event.detail?.items||[]:["unknown_occlusion","obstacle_seen"].includes(event.kind)?[event.detail]:[]) {
        const {elements,members,...kept}=item||{};items.push(kept);
      }
    const value={app:begin?.app,runSeq:begin?.runSeq,items};
    sightingCache.set(name,{ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,value});
    sightingDisk="dirty";
    return value;
  };
  const catalogForRun = async (repo,id,runSeq) => {
    const catalog=loadReactionCatalogForRun(repo,{runSeq});
    if(!ledger.paths || !catalog.items.length)return catalog;
    const root=path.dirname(ledger.paths(id).folder),runs=[],live=new Set();
    for(const dir of fs.readdirSync(root,{withFileTypes:true})) {
      if(!dir.isDirectory())continue;
      live.add(dir.name);
      // catalog_begin 이 앞 줄에 있으면 다른 앱 회차는 읽지 않음
      const headBegin=runHead(dir.name).find(r=>r.event?.kind==="catalog_begin")?.event.detail;
      if(headBegin && headBegin.app!==catalog.app)continue;
      const sightings=await runSightings(dir.name,dir.name===id);
      if(sightings && sightings.app===catalog.app)runs.push({name:dir.name,sightings});
    }
    saveSightings(live);
    return applyCatalogSightings(catalog,runs,{repo,runSeq});
  };
  const signature = item => JSON.stringify([item.code || item.kind || "dom",item.sel || item.selector || item.clues?.sel || item.description || item.text]);
  const normalizeReactions = (st,result,action,acceptedSeq,background=false) => {
    st.reactions ||= new Map();
    const omitted=new Set();
    for(const observed of result.effects || []) {
      const effect=observed.expected || observed;
      // 목록에서 붙인 기대가 안 나타남: 등록이 틀렸을 수 있어 재판단 대상
      if(effect.catalogKey && observed.observed===false) {
        result.unexpected ||= [];
        if(!result.unexpected.some(item=>item.id===`mismatch-${effect.catalogKey}`))result.unexpected.push({id:`mismatch-${effect.catalogKey}`,code:"catalog-mismatch",catalogKey:effect.catalogKey,catalogMismatch:true,needsReview:true,known:false,sel:effect.sel,role:effect.role,name:effect.name,text:effect.to || effect.text,description:"목록 기대 불일치: 반응 목록의 연관 반응이 나타나지 않음",sceneId:observed.sceneId});
        continue;
      }
      if(!effect.catalogKey || !effect.needsReview || !observed.observed)continue;
      result.unexpected ||= [];
      if(!result.unexpected.some(item=>item.catalogKey===effect.catalogKey))result.unexpected.push({id:`recheck-${effect.catalogKey}`,catalogKey:effect.catalogKey,needsReview:true,known:false,sel:effect.sel,role:effect.role,name:effect.name,text:effect.to || effect.text,description:"재확인 필요: 연관 반응 관찰",sceneId:observed.sceneId});
    }
    for(const item of [...(result.candidates || []),...(result.unexpected || [])]) {
      item.sel ||= item.selector || item.clues?.sel;
      item.action=action;item.background=background;item.rawId ||= item.id;item.rawCount=item.count || 1;
      const key=signature(item),prior=st.reactions.get(key);
      const classification=classifyCatalogReaction(st.catalog,item);
      if(item.catalogKey && item.needsReview)Object.assign(item,{known:false});else Object.assign(item,classification);
      if(prior) {
        item.absoluteId=prior.id;item.count=(prior.count || 1)+(prior.rawId===item.rawId ? Math.max(0,item.rawCount-(prior.rawCount || 1)) : item.rawCount);item.sceneSeq=prior.sceneSeq;
        item.firstAt=prior.firstAt || prior.at;item.lastAt=item.lastAt || item.at || Date.now();
        item.background=prior.background;
        omitted.add(item.sceneId);
      }else{item.absoluteId=`a${acceptedSeq}-${item.id}`;item.firstAt=item.at || Date.now();}
      item._signature=key;
    }
    result.scenes=(result.scenes || []).filter(scene=>!omitted.has(scene.id));
  };
  const rememberReactions = (st,saved) => {
    for(const item of [...saved.candidates,...saved.unexpected])st.reactions.set(item._signature,item);
  };
  const saveDrainedReactions = async (st,surface,origin,result) => {
    if(!result.id && !result.reactionId)return;
    // drain 결과는 그 관찰의 반응 전체라 이미 기록한 반응이 다시 들어옴. 횟수가 그대로면 새 기록이 아님
    // 판단·무효 처리한 반응이 다음 qa_play 결과에 판단 대기로 다시 보이던 사례(qa-295879da seq 45·46·48·53)
    const before=new Map([...(st.reactions || new Map())].map(([key,item])=>[key,item.count || 1]));
    normalizeReactions(st,result,origin.action,origin.accepted.seq,origin.background);
    const fresh=item=>!before.has(item._signature) || (item.count || 1)!==before.get(item._signature);
    result.candidates=(result.candidates || []).filter(fresh);result.unexpected=(result.unexpected || []).filter(fresh);
    if(!result.candidates.length && !result.unexpected.length)return;
    const saved=await recordQaReaction({runId:st.id,...origin,surface,result,append,savePath:savedPath,sceneMap:origin.scenes});
    rememberReactions(st,saved);
    const background=[...saved.candidates,...saved.unexpected].filter(item=>origin.background || item.background);
    if(background.length)await append(st.id,{kind:"background_reaction",surface,detail:{items:background}});
    if(!origin.background)await append(st.id,{kind:"reaction",mode:origin.mode,...origin.stamp,surface,acceptedSeq:origin.accepted.seq,detail:{candidates:saved.candidates.filter(item=>!item.background),unexpected:saved.unexpected.filter(item=>!item.background),events:result.events || [],idle:true,...(result.idleError?{idleError:result.idleError}:{})}});
  };
  const drainReactions = async (st,surface,mobile=false,device) => {
    const origin=st.reactionOrigins?.get(surface);if(!origin)return;
    const response=mobile?await st.mobile.execute(st.session,"reaction_drain",{device,id:origin.id}):await execute(surface,"qa-reaction-drain",{id:origin.id});
    // 브라우저 쪽이 이미 정리한 관찰이나 이미 닫힌 탭. 남길 반응이 없으므로 번호만 지우고 다음 조작을 진행
    const failure = response?.error || response?.data?.error || "";
    if(!mobile && (/반응 관찰을 찾지 못했습니다/.test(failure) || GONE_TAB.test(failure))) {
      st.reactionOrigins.delete(surface); releaseObservation(st, surface, origin.id); return;
    }
    const result=requireOk(response);
    await saveDrainedReactions(st,surface,origin,result);
  };
  const drainAll = async st => {
    for(const surface of st.reactionOrigins?.keys() || [])await drainReactions(st,surface,st.devices.has(surface),surface);
  };
  const observeBackground = async (st,surface,url,session,mobile=false) => {
    st.backgroundSeen ||= new Set();const key=surface+":"+url;
    if(st.backgroundSeen.has(key))return;
    const result=requireOk(mobile?await st.mobile.execute(session,"background_observe",{device:surface}):await execute(surface,"qa-background-observe",{}));
    const origin=await append(st.id,{kind:"observation",mode:"preparation",cmd:mobile?"app_observe":"observe",surface,url,pass:true,detail:{background:true}});
    result.candidates=(result.candidates || []).filter(item=>item.code!=="K1");
    normalizeReactions(st,result,{kind:"background"},origin.seq,true);
    const saved=await recordQaReaction({runId:st.id,accepted:origin,stamp:{},mode:"preparation",surface,result,append,savePath:savedPath});
    rememberReactions(st,saved);
    st.reactionOrigins ||= new Map();
    const reactionOrigin={id:result.id || result.reactionId,accepted:origin,stamp:{},mode:"preparation",action:{kind:"background"},background:true,scenes:saved.sceneMap};
    st.reactionOrigins.set(surface,reactionOrigin);
    if(!mobile)trackObservation(st,surface,reactionOrigin);
    await append(st.id,{kind:"background_reaction",mode:"preparation",surface,url,detail:{items:[...saved.candidates,...saved.unexpected]}});
    st.backgroundSeen.add(key);
  };
  const listInventory = (st,events) => {
    const rows=deriveQaRows(events).rows;
    const inventory=reviewQaList({plan:st.plan,rows:rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!["walked","state"].includes(key)))),repo:st.plan.build.repo});
    const prior=events.findLast(r=>r.event.kind==="list_review")?.event.detail;
    inventory.changedRows=inventory.rows.filter(row=>prior?.inventory?.rowFingerprints?.[row.id]!==inventory.rowFingerprints[row.id]).map(row=>row.id);
    return inventory;
  };
  const mergeListReview = (inventory,events,answer) => {
    const prior=events.findLast(r=>r.event.kind==="list_review")?.event.detail;
    const keep=(prior?.review?.information || []).filter(item=>!inventory.changedRows.includes(item.row) && inventory.rows.some(row=>row.id===item.row));
    return {...answer,information:[...keep.filter(item=>!answer.information.some(next=>next.row===item.row)),...answer.information],
      duplicates:[...(prior?.review?.duplicates || []).filter(item=>!item.rows.some(id=>inventory.changedRows.includes(id)) && !answer.duplicates.some(next=>JSON.stringify(next.rows)===JSON.stringify(item.rows))),...answer.duplicates],
      fingerprint:inventory.fingerprint,rowFingerprints:inventory.rowFingerprints};
  };
  const play = async (st,args,session,events) => {
    if(!st.row || st.lanes.length!==1)throw Error("qa_play는 열린 확인 항목 하나가 필요합니다");
    const inventory=listInventory(st,events),review=events.findLast(r=>r.event.kind==="list_review")?.event.detail.review;
    assertReviewed(inventory,review);
    const row=inventory.rows.find(row=>row.id===st.row);
    const merged=review?.information.find(item=>item.row===row.id && item.sameAs && item.decision==="merge");
    if(merged || review?.duplicates.some(item=>item.decision==="merge"&&item.rows.slice(1).includes(row.id)))throw Error("병합한 항목은 대표 항목에서 실행하세요");
    // 입력하는 대상을 바뀌지 말아야 할 대상으로 선언하면 항목이 항상 실패하므로 실행 전에 거부
    const invariants=Array.isArray(row.mustNotChange) ? row.mustNotChange : [];
    for(const [i,step] of (args.steps || []).entries()) {
      if(!["type","select","app_type"].includes(step.action) || !step.target?.role) continue;
      if(invariants.some(item=>item.role===step.target.role && item.name===step.target.name))
        throw Error(`단계 ${i+1}이 바뀌지 말아야 할 대상(mustNotChange: ${step.target.role} ${step.target.name})에 입력합니다. 실행 전이므로 qa_row declare로 같은 id의 선언을 고치세요`);
    }
    const stamp={rowId:st.row,path:st.lanes[0].path,lanes:st.lanes.map(l=>[l.id,l.path])};
    let currentDevice;
    const obstacles=st.catalog.items.filter(item=>item.class==="방해 화면" && item.condition).map(item=>Object.fromEntries(["sel","text","role","name"].filter(key=>typeof item.condition[key]==="string" && item.condition[key].trim()).map(key=>[key,item.condition[key]]))).filter(c=>Object.keys(c).length);
    // qa_snapshot 은 같은 역할·이름이 여럿이면 둘째부터 이름 끝에 " (7th)" 를 붙임. 그 이름도 순번(nth)으로 받음
    const ordinalName=target=>{const m=typeof target?.name==="string" && /^(.*) \((\d+)(?:st|nd|rd|th)\)$/.exec(target.name);return m && target.nth==null ? {...target,name:m[1],nth:Number(m[2])} : target;};
    const resolve=async(rawTarget,step,{obstacles:withObstacles=false}={})=>{
      const target=ordinalName(rawTarget);
      const mobile=!!step.device || step.action?.startsWith("app_") || ["tap","swipe"].includes(step.action);
      const found=requireOk(mobile?await st.mobile.execute(session,"target_resolve",{target,device:step.device,...(withObstacles && obstacles.length?{obstacles}:{})}):await execute(tabOf(st),"qa-target-resolve",{target}));
      currentDevice=mobile ? found.targetId || step.device : undefined;
      if(currentDevice)step.device=currentDevice;
      // 대상을 하나로 정하지 못해 조작 전에 멈춘 것이라 제품 실패가 아닌 막힘
      if(found.ambiguous)throw Object.assign(Error(`조작 대상이 여러 개입니다: ${JSON.stringify(target)} ${found.count || ""}개. target.nth(1부터, qa_snapshot의 순서)로 하나를 고르세요`),{delivered:false});
      await append(st.id,{kind:"observation",mode:"agent_action",...stamp,surface:step.device || st.tab,cmd:mobile?"app_snapshot":"snapshot",pass:true,detail:{target,found}});
      return found;
    };
    const input=async(step,found,{obstacle=false}={})=>{
      const mobile=!!step.device || step.action.startsWith("app_") || ["tap","swipe"].includes(step.action);
      const cmd=mobile?({click:"app_tap",tap:"app_tap",type:"app_type",key:"app_key",swipe:"app_swipe"}[step.action] || step.action):step.action;
      const raw={...Object.fromEntries(["text","key","index","value","deltaX","deltaY","duration","device"].filter(key=>step[key]!==undefined).map(key=>[key,step[key]])),expect:step.expect,playTarget:step.target};
      // 순번으로 고른 대상은 같은 이름이 여럿이라 재확인도 같은 순번으로 해야 같은 요소를 찾음
      const chosen=ordinalName(step.target);
      if(found)Object.assign(raw,{x:found.x,y:found.y,expectedTarget:chosen?.nth==null && found.target?.role && found.target?.name ? {role:found.target.role,name:found.target.name} : chosen});
      if(step.to){const destination=await resolve(step.to,step);if(destination.found===false||destination.occluded)throw Error("도착 대상에 입력할 수 없습니다");if(cmd==="app_swipe"){delete raw.x;delete raw.y;Object.assign(raw,{x1:found.x,y1:found.y,x2:destination.x,y2:destination.y});}else Object.assign(raw,{toX:destination.x,toY:destination.y});}
      const result=await reactionAction(st,cmd,raw,session);
      if(obstacle)await append(st.id,{kind:"obstacle_action",...stamp,surface:step.device || st.tab,detail:{cmd,pass:result.pass}});
      return result;
    };
    const retestOf=args.retestOf || row.retestOf;
    const retest=retestOf ? await validateQaRetest({ledger,runId:st.id,retestOf}) : {};
    // 다른 회차의 결함은 그 결함을 retestOf 로 선언한 항목에서 재확인하고, 원래 실패 단계와의 대조는 결함을 기록한 회차 기록으로 함
    // 선언과 회차 요약은 다른 회차 재확인을 받는데 실행만 막아 끝난 회차의 결함을 다시 확인할 수 없던 사례
    const crossRun=!!retestOf && retestOf.run!==st.id;
    const source=crossRun ? (await ledger.verify(retestOf.run)).events : events;
    const defectEvent=retestOf && source.find(r=>r.seq===retestOf.defect)?.event;
    if(crossRun && (row.retestOf?.run!==retestOf.run || row.retestOf?.defect!==retestOf.defect)) throw Error("다른 회차 결함의 재확인은 그 결함을 retestOf로 선언한 항목에서 실행하세요");
    if(retestOf && !crossRun && defectEvent?.rowId!==st.row && defectEvent?.detail?.rowId!==st.row && row.retestOf?.defect!==retestOf.defect) throw Error("수정한 결함의 항목을 재실행하세요");
    // 수정 재실행: steps 를 빼면 원래 실패한 실행의 단계를 그대로 사용
    if(!args.steps) {
      const failedPlay=retestOf ? qaFailedPlay(source,retestOf.defect) : null;
      if(!failedPlay)throw Error("원래 실패가 qa_play 실행이 아니어서 steps가 필요합니다");
      args={...args,steps:structuredClone(failedPlay.event.detail.steps)};
    }
    const startSeq=events.at(-1)?.seq || 0;
    const impacted=deriveQaRemediation(events).pendingRows.find(n=>n.row===st.row);
    // 선언한 재실행 방식대로만 실행: 첫 실행이 바꾼 데이터로 수정 뒤 재실행이 거짓으로 실패하지 않게
    const rerun=row.rerun,firstCheck=args.steps.findIndex(step=>!step.setup);
    if(args.steps.some(step=>step.setup)) {
      if(rerun?.mode!=="setup")throw Error("setup 단계는 rerun.mode가 setup인 항목에만 넣습니다");
      if(firstCheck===-1)throw Error("setup 단계 뒤에 확인할 조작 단계가 필요합니다");
      if(args.steps.slice(firstCheck).some(step=>step.setup))throw Error("setup 단계는 확인할 조작 단계보다 앞에 모아 둡니다");
    } else if(rerun?.mode==="setup")throw Error(`항목 ${row.id}는 rerun.mode가 setup입니다. 시작 상태를 만드는 앞 단계에 setup:true를 붙입니다`);
    const template=JSON.stringify(args.steps);
    if(rerun?.mode==="generated" && !template.includes("{{unique}}"))throw Error(`항목 ${row.id}는 rerun.mode가 generated입니다. 확인 대상이 아닌 입력값과 그 값을 기대하는 곳에 {{unique}}를 넣습니다`);
    if(rerun?.mode!=="generated" && template.includes("{{unique}}"))throw Error("{{unique}}는 rerun.mode가 generated인 항목에만 씁니다");
    if(rerun?.mode==="human" && (retestOf || impacted))throw Error(`항목 ${row.id}는 수정 뒤 재실행을 사람 확인으로 선언했습니다(${rerun.reason}). 다시 실행하지 않고 qa_review decisions에 {row:"${row.id}",reason}으로 넘깁니다`);
    // 실행마다 다른 값. 대조와 기록은 치환 전 단계로
    const unique=`r${st.runSeq}-${startSeq}`;
    const steps=rerun?.mode==="generated" ? JSON.parse(template.replaceAll("{{unique}}",unique)) : args.steps;
    assertQaReplayContract(source,crossRun ? defectEvent?.rowId || defectEvent?.detail?.rowId : st.row,args.steps,{fixSeq:retest.retestFix?.seq || impacted?.fixSeq,defect:retestOf?.defect,path:stamp.path,addedEffects:unchangedExpectations(row)});
    const wasPassed=events.some(r=>r.event.rowId===st.row && (r.event.kind==='play_result' && r.event.detail.pass===true || r.event.kind==='row' && r.event.action==='close' && r.event.rowData.color==='green'));
    const result=await playQaSteps({steps,resolve,input,handlers:st.catalog.items.filter(item=>item.class==="방해 화면"),
      augment:step=>({...step.expect,effects:[...step.expect.effects,...unchangedExpectations(row)]}),
      record:event=>append(st.id,{mode:"agent_action",...stamp,surface:currentDevice || st.tab,...event}),
      capture:async(phase,blocker)=>{
        const scene=requireOk(currentDevice?await st.mobile.execute(session,"screenshot",{device:currentDevice}):await execute(tabOf(st),"screenshot",{stable:false}));
        const receipt=await append(st.id,{kind:"frame",cmd:"obstacle_scene",mode:"agent_action",...stamp,surface:currentDevice || st.tab,shot:scene.path || scene.shot,claim:{kind:"S6",description:`방해 화면 ${phase}`},detail:{phase,blocker}});
        return {seq:receipt.seq,shot:savedPath(st.id,receipt)};
      },close:async({blocked,reason})=>{
        if(!blocked) {
          const records=(await ledger.verify(st.id)).events;
          if(!records.some(r=>r.event.rowId===stamp.rowId && r.event.path===stamp.path && r.event.pass===false && ["reaction","assertion"].includes(r.event.kind))) {
            const scene=await captureCurrent(st,reason,"S3");
            const failure=await append(st.id,{kind:"assertion",mode:"agent_action",...stamp,...scene,pass:false,expected:{mode:"exists",text:"조작 가능한 대상"},reason});
            await preserveFailure(st,failure,{mobile:!!currentDevice,device:currentDevice,...(scene.shot?{capturedScene:{...scene,path:savedPath(st.id,failure)}}:{})});
          }
        }
        await append(st.id,{kind:blocked?"blocked":"play_failure",mode:"agent_action",...stamp,surface:currentDevice || st.tab,reason});
        await append(st.id,{kind:"row",mode:"agent_action",...stamp,action:"close",rowData:{color:blocked?"gray":"red",note:reason,sceneJudgment:"자동 실행 중단: "+reason,automatic:true}});
        st.lanes=[];st.row=null;
      }});
    const after=(await ledger.verify(st.id)).events;
    const shotSeq=after.findLast(r=>r.seq>startSeq && r.event.shot)?.seq;
    await append(st.id,{kind:'play_result',...stamp,surface:currentDevice || st.tab,detail:{pass:result.pass,...retest,shotSeq,startSeq,steps:args.steps,...(rerun?.mode==="generated"?{unique}:{})}});
    if(impacted && wasPassed && !result.pass && result.status!=="막힘") {
      const failure=after.findLast(r=>r.seq>startSeq && ['assertion','reaction'].includes(r.event.kind) && r.event.pass===false);
      if(failure)await append(st.id,{kind:'defect',...stamp,surface:currentDevice || st.tab,detail:{problem:'수정 뒤 영향 항목 재실패',rowId:stamp.rowId,failureSeq:failure.seq,regressionOf:impacted.fixSeq,frames:shotSeq?[{seq:shotSeq}]:[]}});
    }
    // 수정 시도 횟수는 결함을 기록한 회차의 기록
    if(retestOf && !crossRun && !result.pass) {
      const attempts=after.filter(r=>r.event.kind==='fix' && r.event.detail.defect===retestOf.defect && r.event.detail.commit);
      if(attempts.length>=QA_FIX_MAX_ATTEMPTS)await append(st.id,{kind:'fix',detail:{defect:retestOf.defect,status:'고치지 못함',lastAttempt:attempts.at(-1).event.detail}});
    }
    // 조치 목록은 지난 qa_play 응답 뒤로 바뀌었을 때만 전체를 줌. 매번 같은 목록 1.2k자가 붙은 사례
    const remediation=compactQaRemediation(deriveQaRemediation((await ledger.verify(st.id)).events)),digest=JSON.stringify(remediation);
    const same=st.remediationDigest===digest;st.remediationDigest=digest;
    return {...result,remediation:same?{unchanged:true,openDefects:remediation.defects.length,pendingRows:remediation.pendingRows.length,detail:"지난 qa_play 결과와 같음. 전체는 qa_review"}:remediation};
  };
  const reactionAction = async (st, cmd, args, session, privateInput = false, retryOf = null) => {
    if(cmd === "select" && args.index > 1000)throw Error("선택 항목 범위 초과");
    const runId = st.id, mobile = cmd.startsWith("app_") || cmd === "wait" && !!args.device;
    const stamp = {rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path])};
    const actionTarget = args.playTarget || args.selected;
    const required = actionTarget ? reactionCatalogForAction(st.catalog,{kind:cmd.replace(/^app_/,""),target:actionTarget}).flatMap(item=>(item.expect?.effects||[]).map((effect,i)=>({...effect,id:`catalog-${item.key}-${i}`,catalogKey:item.key,needsReview:item.needsReview}))) : [];
    // 단계가 이미 같은 효과를 선언했으면 목록 쪽 사본은 넣지 않음
    const effectBody = effect => JSON.stringify(Object.entries(effect).filter(([key])=>!["id","reason","oracle","catalogKey","needsReview"].includes(key)).sort());
    const declared = new Set(args.expect.effects.map(effectBody));
    const mode = st.row ? "agent_action":"preparation", expect = reactionExpectation({...args.expect,effects:[...args.expect.effects,...required.filter(effect=>!declared.has(effectBody(effect)))]});
    let surface = mobile ? args.device : tabOf(st);
    // device 생략 시 이 회차의 기기 하나로 확정. surface 가 비면 반응 판단 도구가 웹 탭으로 취급해 거부
    if(mobile && !surface && st.devices.size === 1) { surface = [...st.devices][0]; args = {...args,device:surface}; }
    const redactReaction = value => {
      if(!privateInput || !args.text)return value;
      return JSON.parse(JSON.stringify(value,(key,item)=>typeof item === "string" && !["path","shot","id","sceneId","url"].includes(key) ? item.split(args.text).join("[입력값 숨김]") : item));
    };
    await drainReactions(st,surface,mobile,args.device);
    // 페이지가 준비되기 전 입력은 반응 없이 끝나 같은 조작의 판정이 실행마다 갈림(qa-5a27bca3 seq 384 실패 → 409 통과)
    let settle;
    if(!mobile && cmd !== "wait") {
      try { settle = requireOk(await execute(surface,"qa-settle",{})); }
      catch(error) { settle = {stable:false,remaining:["observation"],error:error.message}; }
    }
    const accepted = await append(runId,{kind:"accepted",mode,...stamp,surface,cmd,expected:redactReaction(expect)});
    let humanReason;
    const call = async (command,input) => {
      const response=mobile ? await st.mobile.execute(session,command,input) : await execute(surface,command,input);
      if(response?.humanRequired || response?.data?.humanRequired) {
        humanReason=response.data?.reason || response.reason || "조작 중 사람 확인 필요";
        return {...response.data,humanRequired:true,reason:humanReason};
      }
      // 입력 중에 뜬 확인 창은 조작이 페이지에 닿았다는 반응. 전달 실패로 적으면 제품 실패 판정이 됨
      if(!mobile && response?.ok === false && response.dialogOpen) throw Object.assign(new Error(response.error),{dialogOpen:response.dialogOpen});
      const output=requireOk(response);
      if(mobile && output.moments?.length)await moments(st,output.moments);
      return output;
    };
    const mobileArgs=Object.fromEntries(Object.entries(args).filter(([key])=>key!=="playTarget"));
    let start;
    try { start = await call(mobile ? "reaction_start":"qa-reaction-start",mobile ? {device:args.device,expect,action:{command:cmd==="wait"?"wait":cmd.slice(4),args:cmd==="wait"?{}:Object.fromEntries(Object.entries(mobileArgs).filter(([key])=>!["expect","device"].includes(key)))}} : {expect,action:cmd,target:{x:args.x,y:args.y}}); }
    catch(error) {
      const premise=/기대 전제 불성립/.test(error.message);
      // 웹 관찰 시작은 같은 탭의 이전 대기 관찰을 먼저 정리함. 시작이 실패하면 그 번호가 남아 다음 조작마다 "관찰을 찾지 못했습니다"로 멈춘 사례
      if(!mobile && !/끝나지 않은 반응 관찰/.test(error.message)) {
        st.reactionOrigins?.delete(surface);
        releaseObservation(st, surface);
      }
      await append(runId,{kind:"observation",mode,...stamp,surface,acceptedSeq:accepted.seq,cmd:"capture_failed",phase:"S1",pass:false,reason:error.message,claim:{kind:"S1",description:premise?"조작 전 기대 전제 불성립":"조작 전 기대 장면 기록 실패"}});
      throw Object.assign(error,{delivered:false});
    }
    if(mobile && !surface && start.targetId) { surface = start.targetId; args = {...args,device:surface}; st.devices.add(surface); }
    const scenes = new Map();
    const save = result => recordQaReaction({runId,accepted,stamp,mode,surface:surface || start.targetId,result:redactReaction(result),append,savePath:savedPath,sceneMap:scenes});
    await save(start);
    st.reactionOrigins ||= new Map();
    const reactionOrigin={id:start.id || start.reactionId,accepted,stamp,mode,action:{kind:cmd.replace(/^app_/,""),target:actionTarget},background:false,scenes};
    st.reactionOrigins.set(surface,reactionOrigin);
    if(!mobile)trackObservation(st,surface,reactionOrigin);
    let data = {}, inputError, dialogDuring;
    try {
      // 이미 포커스가 있는 입력칸을 다시 누르면 앞 단계의 선택(Meta+a 등)이 풀림. 순번 대상은 같은 이름이 여럿이라 항상 누름
      const keepFocus = !mobile && args.playTarget && ["type","key"].includes(cmd) && args.expectedTarget?.nth == null
        && (current => current?.role === args.expectedTarget?.role && current?.name === args.expectedTarget?.name)((await call("qa-focused",{}))?.focused);
      if(args.playTarget && ["type","key","app_type","app_key"].includes(cmd) && Number.isFinite(args.x) && !keepFocus) {
        const focused=await call(mobile?"reaction_focus":"qa-input",mobile?{device:args.device,id:start.id || start.reactionId,x:args.x,y:args.y,expectedTarget:args.expectedTarget}:{action:"click",x:args.x,y:args.y,expectedTarget:args.expectedTarget});
        if(mobile ? focused.native!==true || focused.inputAccepted!==true : focused.trusted!==true)throw Error("실제 포커스 입력 수신을 확인하지 못했습니다.");
      }
      if(cmd === "wait") data={};
      else if (mobile) data = await call(cmd.slice(4),{...mobileArgs,expect});
      else if (cmd === "select") {
        // 화살표 키는 macOS 의 닫힌 선택 상자 값을 바꾸지 못함. 첫 글자 입력으로 고르고, 고른 뒤 실제 선택을 다시 읽어 확인
        const selection = await call("qa-select-resolve",args), count = selection.typeahead?.count;
        if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error("선택 항목 범위 초과");
        const steps = [{action:"click",x:args.x,y:args.y,expectedTarget:args.expectedTarget},{action:"key",key:"Escape"},
          ...Array.from({length:count},()=>({action:"typeahead",text:selection.typeahead.char}))];
        for(const input of steps) { data = await call("qa-input",input); if(data.humanRequired)break; if(data.trusted !== true) throw new Error("실제 입력 수신을 확인하지 못했습니다."); }
        if(!data.humanRequired) {
          const after = await call("qa-select-resolve",{x:args.x,y:args.y,index:selection.index});
          if(after.selectedIndex !== selection.index) throw new Error(`선택 상자가 '${selection.selected}'로 바뀌지 않았습니다.`);
        }
        data.index = selection.index;
      } else data = await call(INPUT.has(cmd) ? "qa-input":cmd === "history" ? args.action:cmd,
        INPUT.has(cmd) ? {...args,action:cmd}:cmd === "history" ? {}:args);
      if(!mobile && INPUT.has(cmd) && data.trusted !== true) throw new Error("실제 입력 수신을 확인하지 못했습니다.");
    } catch(error) { if(error.dialogOpen) dialogDuring = error.dialogOpen; else inputError = error.message; }
    let result;
    if(dialogDuring) {
      // 창이 떠 있는 동안 페이지가 멈춰 관찰 종료가 응답하지 않음. 창 자체로 대화상자 기대만 판정하고 관찰은 qa_dialog 답 뒤에 끝냄
      const shown = effect => effect.type === "dialog" && (!effect.kind || effect.kind === dialogDuring.kind) && (effect.text == null || String(dialogDuring.message).includes(effect.text));
      const effects = expect.effects.map(effect=>shown(effect) ? {...effect,observed:true} : {...effect,observed:false});
      const pass = effects.every(effect=>effect.observed);
      result = {pass,effects,scenes:[],candidates:[],unexpected:[],
        ...(pass ? {} : {error:`조작 뒤 확인 창(${dialogDuring.kind})이 떠 페이지가 멈춤: "${dialogDuring.message}". 확인 창 밖의 기대 효과는 확인하지 못함`})};
      st.staleReaction = {surface,id:start.id || start.reactionId};
    } else {
      try { result = await call(mobile ? "reaction_end":"qa-reaction-end",{device:args.device,id:start.id || start.reactionId,delivered:!inputError}); }
      catch(error) {
        result = {pass:false,effects:expect.effects.map(effect=>({...effect,observed:false})),scenes:[],error:error.message};
        // 확인 창이 페이지를 멈추면 관찰 종료도 실패해 실행기에 관찰이 남고, 30초 동안 같은 탭의 다음 조작이 막힘. qa_dialog 답 뒤에 다시 종료
        if(!mobile) st.staleReaction = {surface,id:start.id || start.reactionId};
      }
    }
    if(result.targetId) st.devices.add(result.targetId);
    // 페이지 반응이 하나도 없던 클릭은 준비 전 입력일 수 있어 안정 뒤 한 번 더 누름. 첫 시도는 판정에서 빼고 재시도 판정에 표시
    // 클릭만: 입력·키는 값이 DOM 변경 없이 바뀔 수 있어 다시 보내면 두 번 들어감
    const silent = !mobile && cmd === "click" && !retryOf && !inputError && !dialogDuring && result.pass !== true && !humanReason
      && !result.error && !result.effects?.some(effect=>effect.observed) && result.candidates?.some(item=>item.code === "K3");
    // 전달되지 않은 조작과 다시 누를 첫 시도는 판정이 아님(pass 없음). 판단할 반응 후보도 만들지 않음
    const verdictless = !!inputError || silent;
    if(silent) result.candidates = (result.candidates || []).filter(item=>item.code !== "K3");
    if(!verdictless && result.pass !== true && !result.candidates?.some(item=>item.code === "K1")) result.candidates = [...(result.candidates || []),
      {id:"missing",code:"K1",description:result.error || "상한 시간 안에 기대 효과를 확인하지 못함",sceneId:result.scenes?.findLast(scene=>scene.claim?.kind === "S3")?.id}];
    normalizeReactions(st,result,{kind:cmd.replace(/^app_/,""),target:actionTarget},accepted.seq);
    const saved = await save(result);
    rememberReactions(st,saved);
    const pass = verdictless ? null : result.pass === true;
    const receipt = await append(runId,{kind:"action",mode,...stamp,surface:surface || result.targetId,acceptedSeq:accepted.seq,cmd,pass:silent ? null : pass === true,
      expected:redactReaction(expect),target:data.target,received:data.received,trusted:data.trusted,
      input:{kind:cmd,delivered:!inputError,...Object.fromEntries(["x","y","toX","toY","x1","y1","x2","y2","key","deltaX","deltaY"].filter(key=>args[key] !== undefined).map(key=>[key,args[key]])),
        ...(typeof args.text === "string" ? {length:args.text.length,valueOmitted:"입력 원문은 보관하지 않음"}:{})},reason:inputError || result.error,
      // 휠 뒤 위치가 그대로였거나 도구가 기본 동작을 대신한 경우의 메모. 응답에만 있어 원인을 못 찾은 사례(qa-6face637 seq 895)
      ...(data.scrollNote ? {scrollNote:data.scrollNote} : {}),...(settle ? {detail:{settle}} : {})});
    const detail = {pass,...(dialogDuring ? {dialog:dialogDuring} : {}),...(silent ? {noReaction:true} : {}),...(retryOf ? {retryOf} : {}),
      action:{kind:cmd.replace(/^app_/,""),target:actionTarget},effects:saved.effects,candidates:saved.candidates.filter(item=>!item.background),unexpected:saved.unexpected.filter(item=>!item.background),
      events:redactReaction(result.events || []),firstReactionMs:result.firstReactionMs ?? result.firstVisibleMs,within:result.within,elapsedMs:result.elapsedMs,tailMs:result.tailMs,completedMs:result.completedMs,unavailable:result.unavailable,limits:result.limits};
    const backgroundItems=[...saved.candidates,...saved.unexpected].filter(item=>item.background);
    if(backgroundItems.length)await append(runId,{kind:"background_reaction",surface,detail:{items:backgroundItems}});
    const reaction = await append(runId,{kind:"reaction",mode,...stamp,surface:surface || result.targetId,acceptedSeq:accepted.seq,cmd,pass,expected:redactReaction(expect),detail});
    if(humanReason && st.policy?.unattended)return humanRequired(st,humanReason);
    if(silent) return reactionAction(st,cmd,args,session,privateInput,reaction.seq);
    if(pass === false) {
      const scene = saved.scenes.findLast(scene=>scene.claim?.kind === "S3");
      await preserveFailure(st,receipt,{mobile,device:args.device || result.targetId,
        ...(scene?.shot ? {capturedScene:{...scene,path:scene.shot},capturedObservation:result.observation || result.diagnostics}:{})});
    }
    // 이벤트 원본은 reaction 기록에만 저장. 같은 원본 479만 자를 두 줄에 저장해 장부가 커진 사례
    if(args.playTarget) await append(runId,{kind:"observation",mode,...stamp,surface,acceptedSeq:accepted.seq,cmd:mobile?"app_observe":"observe",pass:true,detail:{source:"reaction",reactionSeq:reaction.seq}});
    return {...data,...detail,...compactReactionResponse({candidates:detail.candidates,unexpected:detail.unexpected,scenes:[...scenes.values()]}),delivered:!inputError,receipt,...(inputError || result.error ? {ok:false,error:inputError || result.error}:{}),
      ...(retryOf ? {note:`첫 클릭에 화면 반응이 없어 다시 누름(첫 시도 seq ${retryOf})`} : {}),
      next:dialogDuring ? "확인 창이 떠 있음. qa_dialog로 답한 뒤 qa_snapshot으로 결과 확인"
        : saved.candidates.length || saved.unexpected.length ? "qa_unexpected로 각 반응을 판단하세요. 문제로 판단하면 qa_defect로 기록하세요.":undefined};
  };
  const captureCurrent = async (st, reason, kind = "S6") => {
    const recent=(await ledger.verify(st.id)).events.findLast(r=>r.event.surface && (!st.row || r.event.rowId === st.row));
    const device=st.devices.has(recent?.event.surface)?recent.event.surface:null;
    if(!device && !st.tab)return {};
    const scene=requireOk(device ? await st.mobile.execute(st.session,"screenshot",{device}) : await execute(st.tab,"screenshot",{stable:false}));
    return {shot:scene.path || scene.shot,surface:device || st.tab,url:scene.url,viewport:scene.viewport,claim:{kind,description:reason}};
  };
  const humanRequired = async (st, reason) => {
    const scene=await captureCurrent(st,reason);
    if(scene.shot)await append(st.id,{kind:"frame",mode:"agent_action",rowId:st.row,path:st.lanes.at(-1)?.path,...scene});
    return recordQaHumanRequired({ledger, runId:st.id, lanes:st.lanes, reason});
  };
  const queues = new Map();
  const serial = (id, operation) => {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(id, next);
    return next.finally(() => { if (queues.get(id) === next) queues.delete(id); });
  };
  const tabOf = (st) => {
    if (!st.tab) throw new Error("계획의 진입 주소를 먼저 여세요.");
    return st.tab;
  };
  const routes = makeRoutes({ ledger, executor: async ({ step, runId, params }) => {
    const st = runs.get(runId);
    if (!st || st.ended) throw new Error("진행 중인 회차가 없습니다.");
    const current = requireOk(await execute(tabOf(st), "url", {}));
    const url = new URL(current.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("로컬 화면에서만 경로를 재생할 수 있습니다.");
    if (url.origin !== step.origin) throw new Error("경로를 검증한 출처와 현재 화면의 출처가 다릅니다.");
    const found = requireOk(await execute(tabOf(st), "qa-locate", step.target));
    await append(runId,{kind:"observation",cmd:"snapshot",mode:"route_replay",surface:st.tab,pass:!!requireOk(await execute(st.tab,"snapshot",{}))});
    const accepted = await append(runId,{kind:"accepted",mode:"route_replay",cmd:step.cmd,surface:st.tab});
    const routeInput = {kind:step.cmd,x:found.at.x,y:found.at.y,...(step.cmd === "type"
      ? {length:params[step.input.param].length,param:step.input.param,valueOmitted:"입력 원문은 보관하지 않음"}
      : Object.fromEntries(Object.entries(step.input || {}).filter(([key])=>["key","deltaX","deltaY"].includes(key))))};
    let action;
    try {
      const response = await execute(st.tab, "qa-input", { action: step.cmd, x: found.at.x, y: found.at.y, expectedTarget: step.target,
        ...(step.cmd === "type" ? {text:params[step.input.param]} : step.input || {}) });
      if (st.policy?.unattended && (response.humanRequired || response.data?.humanRequired))
        throw Object.assign(new Error("사람 필요 기록 후 재생 중단"), {qaHumanResult:await humanRequired(st, response.data?.reason || response.reason || "경로 재생 중 사람 확인 필요")});
      action = requireOk(response);
      const receiver = action.received?.findLast(e => e.type === ({ click: "click", dblclick: "dblclick", hover: "mousemove", type:"input", key:"keydown",scroll:"wheel" })[step.cmd] && e.trusted);
      if (receiver?.role !== step.target.role || receiver?.name !== step.target.name) throw new Error("재생 입력의 실제 수신 대상이 다릅니다.");
      await append(runId,{kind:"action",mode:"route_replay",cmd:step.cmd,acceptedSeq:accepted.seq,surface:st.tab,pass:true,target:action.target,received:action.received,trusted:action.trusted,input:routeInput});
    } catch(error) {
      if (error.qaHumanResult) throw error;
      const failed = await append(runId,{kind:"action",mode:"route_replay",cmd:step.cmd,acceptedSeq:accepted.seq,surface:st.tab,pass:false,reason:error.message,input:routeInput});
      await preserveFailure(st,failed);
      throw error;
    }
    await append(runId,{kind:"observation",cmd:"snapshot",mode:"route_replay",surface:st.tab,pass:!!requireOk(await execute(st.tab,"snapshot",{}))});
    let arrival;
    try { arrival = requireOk(await execute(st.tab, "qa-expect", step.arrival)); }
    catch (error) {
      const failed = await append(runId,{kind:"observation",cmd:"route_arrival",mode:"route_replay",surface:st.tab,pass:false,expected:step.arrival,reason:error.message});
      await preserveFailure(st,failed);
      throw error;
    }
    const arrivalReceipt = await append(runId,{kind:"observation",cmd:"route_arrival",mode:"route_replay",surface:st.tab,pass:arrival.pass === true && !!arrival.shot,claim:{kind:"S5",description:"경로 도착 상태 판정",expected:step.arrival,actual:arrival.got},shot:arrival.shot,url:arrival.url,viewport:arrival.viewport,stability:arrival.stability,captureTarget:arrival.captureTarget,observed:arrival.got,expected:step.arrival});
    if (!arrivalReceipt.event.pass) await preserveFailure(st,arrivalReceipt);
    return { ok: true, topTarget: { role: action.target?.role, name: action.target?.name }, received:action.received, pass: arrival.pass === true && !!arrival.shot, arrival: step.arrival };
  } });
  const followAction = async (...values) => {
    const [cmd,args] = values;
    if(QA_REACTION_ACTIONS.has(cmd) && !args.expect) {
      const effect=cmd === "type" ? {type:"change",sel:":focus",to:args.text} : {type:"none"};
      values[1]={...args,expect:{effects:[{...effect,oracle:"기능의 용도"}],within:5000}};
    }
    const result = await perform(...values, true);
    if (result?.humanRequired) throw Object.assign(new Error("사람 필요 기록 후 조작 중단"), {qaHumanResult:result});
    if(result?.ok === false || result?.pass === false)throw Error(result.error || "기대 효과 미관찰");
    return result;
  };
  async function perform(cmd, args, session, runId, privateInput = false, runKey) {
    // 실행기 전용: MCP 도구 목록에 없음
    if (cmd === "unattended_approve") return grants.approve(args, session);
    if (cmd === "unattended_renew") return grants.renew(args, session);
    if (cmd === "unattended_end") return grants.end(args, session);
    args = validateQaCommand(cmd, args);
    if (args.overviewFile) { const { overviewFile, ...rest } = args; args = validateQaCommand(cmd, {...rest, overview:readOverviewFile(overviewFile)}); }
    if (!session) throw new Error("세션 식별자가 필요합니다.");
    if (cmd === "catalog") {
      const catalog = loadReactionCatalogForRun(args.repo);
      return {app:catalog.app,items:catalog.items,removed:catalog.removed || []};
    }
    if (cmd === "catalog_revise") {
      // 사람이 반응 목록을 고치는 경로. 무인 실행 중에는 답할 사람이 없어 거부
      if (await grants.active(session)) throw new Error("무인 실행 중에는 반응 목록을 고칠 수 없습니다. 사람이 있을 때 다시 요청하세요.");
      // 진행 중인 회차는 시작 때 읽은 목록으로 다시 저장하므로 끝난 뒤에만 수정
      const app = appIdentity(args.repo);
      if ([...runs.values()].some(run => !run.ended && appIdentity(run.plan.build.repo) === app)) throw new Error("이 앱의 QA 회차가 진행 중입니다. 회차가 끝난 뒤 고치세요.");
      const catalog = loadReactionCatalog(args.repo);
      // 삭제한 항목은 삭제 기록에서 찾아 다시 등록
      const previous = catalog.items.find(item => item.key === args.key) || (catalog.removed || []).findLast(record => record.item?.key === args.key)?.item;
      if (!previous) throw new Error(`반응 목록과 삭제 기록에 없는 항목입니다: ${args.key}`);
      const {remove, repo, key, ...judgment} = args;
      // 연결 저장소 출처는 그 항목을 마지막으로 본 회차 계획의 build.related 로 확인
      const roots = (previous.lastRun && runHead(previous.lastRun).find(r=>r.event?.kind==="run_begin")?.event?.plan?.build?.related) || [];
      if (remove && judgment.class) throw new Error("remove와 class는 함께 넣지 않습니다.");
      if (remove && !catalog.items.includes(previous)) throw new Error("이미 삭제한 항목입니다.");
      if (!remove) {
        if (judgment.expect) validateQaCommand("click",{x:0,y:0,expect:judgment.expect});
        if (judgment.handler?.expect) validateQaCommand("click",{x:0,y:0,expect:judgment.handler.expect});
        validateReactionJudgment({...judgment,condition:judgment.condition || previous.condition,action:judgment.action || previous.action}, {repo,roots});
      }
      // 승인 창에 앱과 바뀌는 칸의 이전·이후 값을 모두 표시. 자르면 무엇을 승인하는지 알 수 없어 넘치면 거부
      const show = value => value === undefined ? "없음" : JSON.stringify(value);
      const fields = remove ? [] : ["class","condition","action","expect","handler"].filter(field => judgment[field] !== undefined && show(judgment[field]) !== show(previous[field]));
      const kind = remove ? "삭제" : catalog.items.includes(previous) ? "수정" : "삭제 기록에서 복원";
      const summary = [`앱: ${path.basename(app)}`, `항목: ${previous.class} ${show(previous.condition)}`, `동작: ${kind}`,
        ...fields.map(field => `${field}: ${show(previous[field])} → ${show(judgment[field])}`), `이유: ${judgment.cause}`].join(" · ");
      if (summary.length > 300) throw new Error("승인 창에 모두 표시할 수 없습니다. 바꾸는 칸을 나눠 여러 번 요청하세요.");
      // 사람 승인은 세션 콘솔에서 받음. 사용자가 승인하면 같은 인자에 userApproved:true 로 다시 부름
      if (args.userApproved !== true) {
        const asked = requireOk(await ask(null, session, summary, {_kind:"approve", title:"반응 목록을 고칠까요?", summary}));
        throw new Error(`반응 목록 수정 승인 필요. ${asked.note} 사용자가 승인하면 같은 인자에 userApproved:true를 넣어 다시 부르세요.`);
      }
      if (remove) return {removed:removeReactionCatalogItem(repo, key, {cause:judgment.cause, source:judgment.source, attempts:judgment.attempts, by:"사람 승인"}, {catalog}).removed};
      const saved = recordReactionJudgments(repo, [{...judgment, condition:judgment.condition || previous.condition, action:judgment.action || previous.action, key, count:0, revisedBy:"사람 승인", revisions:[...(previous.revisions || []), {at:Date.now(), class:previous.class, cause:judgment.cause}]}], {catalog, runId:previous.lastRun, runSeq:previous.lastRunSeq, roots});
      return {item:saved.items.find(item => item.key === key), previous};
    }
    if (cmd === "summary") {
      // title 이 있으면 여러 회차를 사람용 보고서 한 장으로. title 없는 요약은 overview 를 쓰지 않으므로 고치는 칸을 주면 거부
      if (!args.title && (args.overview?.text?.length || args.overview?.notes?.length || (args.overview?.cases || []).some(c => c?.scenes?.length || c?.text?.length))) throw new Error("overview의 text·notes와 cases의 scenes·text는 title을 준 합친 보고서에서만 씁니다. title을 넣으세요.");
      const report = args.title ? await createQaCombinedReport(ledger, args.runIds, {session,title:args.title,overview:args.overview,replaces:args.replaces,activity})
        : await createQaSummary(ledger, args.runIds, {session,runJson:args.runJson});
      const tab = requireOk(await openReport(session, pathToFileURL(report.path).href));
      return {...report, reportTab:tab.handle || tab.tabId};
    }
    if (cmd === "run_begin") {
      const id = "qa-" + crypto.randomUUID();
      const plan = validateQaPlanList(structuredClone(args.plan));
      plan.surfaces ||= plan.entries;
      if (!plan.surfaces.length) throw new Error("확인할 화면을 surfaces에 선언하세요.");
      // 웹 회차: 보고서 검사가 판정 주소를 surfaces 앞부분과 대조
      const labels = plan.entries.length ? plan.surfaces.filter(surface => !/^https?:\/\/[^\s]+$/.test(surface)) : [];
      if (labels.length) throw new Error(`surfaces에는 확인할 화면 주소의 앞부분을 적습니다(예: ${plan.entries[0]}). 주소가 아닌 값: ${labels.join(", ")}`);
      // 실행기가 시작할 때 받은 승인이 있으면 그 범위 안에서 다시 묻지 않음
      const grant = args.charter.unattended ? await grants.forRun(session, plan.build.repo, args.charter) : null;
      if (grant) args.charter.investigationLimitMin ??= grant.investigationLimitMin;
      // 무인 승인이 살아 있는 세션은 무인 회차로만 시작: 무인 판단이 사람 회차 기록에 섞이지 않게
      if (!args.charter.unattended && await grants.active(session)) throw new Error("무인 실행 중인 세션입니다. charter.unattended 를 true 로 두고 시작하세요.");
      // 사용자 결정(P148): 무인 회차는 승인 창 없이 시작. QA 도구 조작은 되돌릴 수 있는 작업
      const startApproval = "사용자 지시";
      await ledger.begin({ runId: id, session, plan, charter: args.charter });
      if (args.charter.unattended) await append(id,{kind:"start_approval",detail:grant
        ? {via:"실행기 시작",grant:grant.id,approvedAt:new Date(grant.approvedAt).toISOString(),logins:grant.logins,bulkFill:grant.bulkFill,investigationLimitMin:grant.investigationLimitMin}
        : {via:startApproval,approvedAt:new Date().toISOString()}});
      const state = {id,session,plan,tab:null,tabs:new Set(),row:null,lanes:[],approvals:new Set(),bulk:new Map(),devices:new Set(),ended:false};
      state.mobile = mobileFactory(id,device=>state.devices.add(device));
      state.runSeq=await catalogRunNumber(plan.build.repo,id);
      state.catalog=await catalogForRun(plan.build.repo,id,state.runSeq);
      await append(id,{kind:"catalog_begin",detail:{app:appIdentity(plan.build.repo),runSeq:state.runSeq,catalog:state.catalog}});
      let runKey;
      if (runKeys) {
        runKey = crypto.randomBytes(32).toString("hex");
        state.keyHash = keyHash(runKey);
        await append(id,{kind:"run_key",detail:{hash:state.keyHash}});
      }
      runs.set(id,state);
      const availableRoutes = await routes.list({});
      return { runId: id, ...(runKey ? {runKey} : {}), plan, reactions:state.catalog, routes: availableRoutes,
        suggestedRoutes: availableRoutes.filter(r => !r.stale && plan.preconditions?.includes(r.name)).map(r => r.name) };
    }
    let takenOver = null;
    const automaticResume = autoResume && cmd !== "run_resume" && Boolean(runId) && !runs.has(runId);
    if((cmd === "run_resume" || automaticResume) && !runs.has(runId)) {
      // 앞선 서버 프로세스가 머리 해시 없이 남긴 마지막 한 줄 분리. 회차를 연 세션일 때만
      let lines=[];
      try{lines=fs.readFileSync(ledger.paths(runId).journal,"utf8").split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line).event;}catch{return null;}});}catch{}
      // 새 열쇠는 기록 검증 뒤에 남김
      let approved=false, storedKeyHash=null;
      if(lines[0]?.kind==="run_begin"&&lines[0].session===session){
        storedKeyHash=runKeyHash(lines);
        if(runKeys && automaticResume) assertRunKey(storedKeyHash,runKey);
        if(runKeys && !automaticResume && !validRunKey(storedKeyHash,runKey)) approved=true;
        if(ledger.recoverUnanchored) await ledger.recoverUnanchored(runId);
      }
      const verified = await ledger.verify(runId);
      const begin = verified.events.find(r=>r.event.kind === "run_begin")?.event;
      if(!begin || begin.session !== session) throw new Error("이 세션의 QA 회차가 아닙니다.");
      // 기록 파일을 직접 읽지 못한 경우는 검증한 기록으로 판단
      storedKeyHash ||= runKeyHash(verified.events.map(r=>r.event));
      if(runKeys && automaticResume) assertRunKey(storedKeyHash,runKey);
      if(!approved && runKeys && !automaticResume && !validRunKey(storedKeyHash,runKey)) approved=true;
      const ended = verified.events.some(r=>r.event.kind === "run_end");
      // 마지막 진입 뒤에 qa_close_tab 으로 닫은 탭은 되살리지 않음
      const lastSeq = (kind, tab) => verified.events.findLast(r=>r.event.kind === kind && r.event.tab === tab && (kind === "entry" || r.event.cmd === "close_tab"))?.seq || 0;
      let tabs = [...new Set(verified.events.filter(r=>r.event.kind === "entry").map(r=>r.event.tab).filter(Boolean))]
        .filter(tab=>lastSeq("observation",tab) < lastSeq("entry",tab));
      // 도구 밖에서 닫혀 없어진 탭은 복구가 빼고 돌려줌
      let goneTabs = [];
      if(!ended) {
        const restored = requireOk(await restore(session,tabs,runId));
        if(Array.isArray(restored.tabs)) tabs = tabs.filter(tab=>restored.tabs.includes(tab));
        if(Array.isArray(restored.gone)) goneTabs = restored.gone;
      }
      const rows = deriveQaRows(verified.events);
      const state = {id:runId,session,plan:begin.plan,tab:verified.events.findLast(r=>tabs.includes(r.event.tab))?.event.tab || null,tabs:new Set(tabs),row:rows.open.at(-1)?.id || null,lanes:rows.open,approvals:new Set(),bulk:new Map(),devices:new Set(),ended,goneTabs};
      state.mobile = mobileFactory(runId,device=>state.devices.add(device));
      if(!ended) {
        const devices = [...new Set(verified.events.filter(r=>r.event.cmd?.startsWith("app_") && r.event.surface).map(r=>r.event.surface))];
        // 세션이 qa_app_target clear 로 놓은 기기는 확인하지 않고 뺌. 확인이 기기 할당을 요구해 그 회차를 닫을 수 없던 사례
        const held = devices.length ? requireOk(await state.mobile.execute(session,"targets",{})) : {};
        // select 의 할당 조건과 같게 등록 기기와 이 세션 소유 탭만. 사용자 스페이스 탭(mine)은 할당 아님
        const usable = new Set([...(held.registered || []),...(held.devices || []).filter(device=>device.owner===session).map(device=>device.targetId)]);
        state.releasedDevices = devices.filter(device=>!usable.has(device));
        for(const device of devices.filter(device=>usable.has(device))) requireOk(await state.mobile.execute(session,"snapshot",{device}));
      }
      state.runSeq=verified.events.find(r=>r.event.kind==="catalog_begin")?.event.detail.runSeq || 1;
      state.catalog=await catalogForRun(state.plan.build.repo,runId,state.runSeq);
      state.backgroundSeen=new Set(verified.events.filter(r=>r.event.kind==="background_reaction").map(r=>r.event.surface+":"+r.event.url));
      // 새 열쇠는 복원·기기 확인이 모두 끝난 뒤 기록. 중간에 실패하면 옛 열쇠도 새 열쇠도 쓸 수 없는 회차가 됨
      if(approved) takenOver = await issueRunKey(runId);
      state.keyHash=takenOver?.hash || storedKeyHash;
      runs.set(runId,state);
    }
    const st = runs.get(runId);
    // 서버가 다시 시작되면 메모리의 회차가 비어 이 세션의 회차도 남의 회차로 거부되던 사례(qa-2ab6e345 install73 뒤 qa_report)
    if (!st) {
      let first=null;
      // 기록 파일은 수백 MB 라 첫 줄이 든 앞부분만 읽음
      try{const fd=fs.openSync(ledger.paths(runId).journal,"r");try{const buf=Buffer.alloc(1<<20),n=fs.readSync(fd,buf,0,buf.length,0);first=JSON.parse(buf.subarray(0,n).toString("utf8").split("\n",1)[0]).event;}finally{fs.closeSync(fd);}}catch{}
      if(first?.kind==="run_begin" && first.session===session) throw new Error("서버가 다시 시작되어 이 회차를 다시 불러와야 합니다. qa_run_resume 을 먼저 부르세요.");
    }
    if (!st || st.session !== session) throw new Error("이 세션의 QA 회차가 아닙니다.");
    // 서버는 그대로이고 도구 연결만 다시 시작된 경우의 이어받기
    if (cmd === "run_resume" && runKeys && !takenOver && !validRunKey(st.keyHash, runKey)) {
      takenOver = await issueRunKey(runId);
      st.keyHash = takenOver.hash;
    }
    // 단계 실행 안에서 부르는 내부 호출(privateInput)은 이미 확인한 호출의 일부
    if (runKeys && !privateInput) assertRunKey(st.keyHash, takenOver?.runKey || runKey);
    // 회차가 쓰던 기기는 이어받을 때 다시 확인·소유함. 알리지 않아 압축 뒤마다 qa_app_target 을 다시 부른 사례
    if(cmd === "run_resume") { await ledger.verify(runId); return {runId,ended:st.ended,tab:st.tab,tabs:[...st.tabs],open:st.lanes,
      ...(st.devices.size?{devices:[...st.devices],deviceNote:"이 기기는 이 회차에 연결된 채로 이어집니다. qa_app_target 을 다시 부르지 않아도 됩니다."}:{}),
      ...(st.goneTabs?.length?{goneTabs:st.goneTabs,goneNote:"이 탭은 도구 밖에서 닫혀 없어 이어받지 않았습니다. 필요하면 qa_open_entry 로 다시 엽니다."}:{}),
      ...(st.releasedDevices?.length?{releasedDevices:st.releasedDevices,releasedNote:"이 세션이 놓은 기기라 이어받지 않았습니다. 다시 쓰려면 qa_app_target device 로 할당합니다."}:{}),
      ...(takenOver?{runKey:takenOver.runKey,takenOver:true}:{})}; }
    if (cmd === "report" || cmd === "handoff") {
      const report = await createQaReport(ledger, runId, {handoff:cmd === "handoff",steps:args.steps,overview:args.overview,resume:args.resume,session,activity});
      const tab = requireOk(await openReport(session, pathToFileURL(report.path).href));
      return {...report, reportTab:tab.handle || tab.tabId};
    }
    if (cmd === "fix") return applyQaFix({ledger,runId,args});
    if (st.ended) throw new Error("종료된 QA 회차입니다.");
    if(["review","unexpected","run_end"].includes(cmd) || cmd==="row" && ["close","end"].includes(args.action))await drainAll(st);
    const verified = await ledger.verify(runId);
    st.policy = qaUnattendedPolicy(verified.events);
    if (cmd === "run_end") assertQaReactionsJudged(verified.events);
    if (INVESTIGATION_ACTIONS.has(cmd)) assertQaInvestigationTime(verified.events, st.lanes);
    if(cmd === "review") {
      if(args.decisions)await deferQaRemediation(ledger,runId,args.decisions);
      // 미판단 반응이 수백 건이면 응답이 1.7MB 한 줄이 되어 파일로 떨어짐. 기본은 요약·100건씩, full 이면 전부
      const remediation=deriveQaRemediation((await ledger.verify(runId)).events);
      const pending=qaPendingReactions(verified.events), offset=args.offset || 0, limit=args.full ? pending.length : args.limit || 100;
      const items=pending.slice(offset,offset+limit).map(item=>({...(args.full ? item : briefReactionItem(item)),shot:item.shot || (item.sceneSeq ? savedPath(runId,verified.events.find(r=>r.seq===item.sceneSeq)) : undefined)}));
      const byCode=Object.entries(pending.reduce((counts,item)=>({...counts,[item.code || item.kind || "기타"]:(counts[item.code || item.kind || "기타"] || 0)+1}),{})).map(([code,count])=>({code,count}));
      return {remediation:args.full ? remediation : compactQaRemediation(remediation),total:pending.length,byCode,offset,items,...(offset+items.length<pending.length?{nextOffset:offset+items.length}:{})};
    }
    if(cmd === "list_review") {
      const inventory=listInventory(st,verified.events);
      if(!args.review)return inventory;
      const review=mergeListReview(inventory,verified.events,args.review);
      assertReviewed(inventory,review);
      const merges=new Map(review.duplicates.filter(item=>item.decision==="merge").flatMap(item=>item.rows.slice(1).map(id=>[id,item.rows[0]])));
      for(const item of review.information)if(item.sameAs && item.decision==="merge")merges.set(item.row,item.sameAs);
      for(const [from,to] of merges)if(merges.has(to) || from===to)throw Error("병합 대상은 실행할 대표 항목이어야 합니다");
      const receipt=await append(runId,{kind:"list_review",detail:{inventory,review}});
      for(const [from,to] of merges) {
        const row=inventory.rows.find(row=>row.id===from);
        for(const path of row.paths)await append(runId,{kind:"row",mode:"agent_action",action:"close",rowId:from,path,rowData:{color:"gray",note:`${to} 항목에 병합`,sceneJudgment:"별도 실행 없이 대표 항목에서 확인",mergedInto:to}});
      }
      st.lanes=deriveQaRows((await ledger.verify(runId)).events).open;st.row=st.lanes.at(-1)?.id || null;
      return receipt;
    }
    if(cmd === "play") {
      // 열린 항목이 없으면 row 로 지정한 항목, 또는 직전 qa_play 가 막힘(회색)으로 자동 종료한 항목을 열고 실행. 매번 qa_row open 을 다시 부르던 사례(열린 항목 없음 거부 37건)
      // 빨강으로 자동 종료한 항목은 다시 실행할지 세션이 정하므로 row 지정 때만 엶
      const {row:wanted,path:wantedPath,...playArgs}=args;
      if(!st.row) {
        const lastClose=verified.events.findLast(r=>r.event.kind==="row" && r.event.action==="close");
        const blocked=lastClose?.event.rowData?.automatic && lastClose.event.rowData.color==="gray" ? lastClose.event : null;
        const id=wanted || blocked?.rowId;
        if(id) {
          const declared=listInventory(st,verified.events).rows.find(row=>row.id===id);
          if(!declared) throw Error(`없는 항목입니다: ${id}`);
          const path=wantedPath || (!wanted || wanted===blocked?.rowId ? blocked?.path : null) || (declared.paths.length===1 ? declared.paths[0] : null);
          if(!path) throw Error(`항목 ${id}의 경로가 여럿입니다(${declared.paths.join(", ")}). path로 고르세요`);
          const opened=await applyQaRow({ledger,runId,args:{action:"open",row:id,path}});
          st.lanes=opened.open || opened.openLanes || [];st.row=st.lanes.at(-1)?.id || null;
          return play(st,playArgs,session,(await ledger.verify(runId)).events);
        }
      } else if(wanted && wanted!==st.row) throw Error(`항목 ${st.row}이 열려 있습니다. 닫은 뒤 ${wanted}를 실행하세요`);
      return play(st,playArgs,session,verified.events);
    }
    if (cmd === "unexpected") {
      // 묶음 판단으로 잘못 처리된 반응을 판단 전으로 되돌림. 대표 반응을 넣으면 그 묶음 전체
      if(args.undo) {
        const judged=qaPendingReactions(verified.events,{all:true}), target=judged.find(entry=>entry.id===args.id);
        if(!target?.groupId)throw Error("undo는 묶음 판단으로 처리된 반응에만 씁니다. 대표 반응 id를 넣으면 그 묶음 전체를 되돌립니다.");
        const ids=target.groupId===target.id ? judged.filter(entry=>entry.groupId===target.id).map(entry=>entry.id) : [target.id];
        await append(runId,{kind:"unexpected_undo",mode:"agent_action",rowId:target.rowId,surface:target.surface,detail:{ids,groupId:target.groupId,cause:args.cause,source:args.source}});
        return {undone:ids.length,ids:ids.slice(0,20),remaining:qaPendingReactions((await ledger.verify(runId)).events).length};
      }
      const pendingNow=qaPendingReactions(verified.events), item=pendingNow.find(item=>item.id===args.id);
      // 문제로 판단했지만 결함 연결이 빠진 반응은 defect 만 넣어 연결. ids 로 함께 판단한 반응에 연결이 빠졌던 사례
      if(item?.verdict==="문제" && !item.defectSeq && args.defect!==undefined && !args.ids && (args.class===undefined || args.class==="문제")) {
        if(!verified.events.some(r=>r.seq===args.defect && r.event.kind==="defect"))throw Error(`defect는 문제로 분류할 때 이 회차의 결함 seq를 넣습니다. 이 회차의 결함 seq: ${verified.events.filter(r=>r.event.kind==="defect").map(r=>r.seq).join(", ") || "없음"}`);
        return append(runId,{kind:"unexpected_defect",mode:"agent_action",rowId:item.rowId,surface:item.surface,detail:{id:item.id,members:item.members,defectSeq:args.defect}});
      }
      // 같은 분류로 이미 판단한 반응을 다시 부르면 기존 판단을 돌려줌. 다시 부른 것만으로 거부되던 사례 16건
      if(!item && !args.ids) {
        const done=qaPendingReactions(verified.events,{all:true}).find(entry=>entry.id===args.id || entry.members?.includes(args.id));
        if(done?.class && done.class===args.class) return {alreadyJudged:true,id:args.id,class:done.class,verdict:done.verdict,remaining:pendingNow.length};
        if(done?.class) throw Error(`반응 ${args.id}은 이미 '${done.class}'로 판단했습니다. 바꾸려면 묶음 판단이면 undo로 되돌린 뒤 다시 판단합니다.`);
        throw Error(`판단할 반응이 아닙니다: ${args.id}. 판단 대기 ${pendingNow.length}건은 qa_review로 봅니다.`);
      }
      if(!item || item.class || item.verdict)throw Error("판단할 반응이 없거나 이미 판단했습니다."+(item?.verdict==="문제" && !item.defectSeq ? " 문제로 판단했고 결함 연결만 빠졌으면 defect에 결함 seq만 넣어 다시 부르세요." : ""));
      const chosen=(args.ids||[]).filter(id=>id!==item.id);
      const missing=chosen.filter(id=>!pendingNow.some(other=>other.id===id));
      if(missing.length)throw Error(`ids 중 판단할 반응이 없거나 이미 판단한 것: ${missing.slice(0,10).join(", ")}${missing.length>10?` 외 ${missing.length-10}개`:""}`);
      // 문제로 분류한 반응을 이미 기록한 결함에 연결
      const {defect:linkDefect,remove,...judgmentArgs}=args;
      if(linkDefect!==undefined && (args.class!=="문제" || !verified.events.some(r=>r.seq===linkDefect && r.event.kind==="defect")))
        throw Error(`defect는 문제로 분류할 때 이 회차의 결함 seq를 넣습니다. 이 회차의 결함 seq: ${verified.events.filter(r=>r.event.kind==="defect").map(r=>r.seq).join(", ") || "없음"}`);
      args=judgmentArgs;
      const mismatch=item.catalogMismatch===true;
      if(remove && !mismatch)throw Error("remove는 목록 기대 불일치 항목에만 씁니다.");
      if(remove && args.class)throw Error("remove와 class는 함께 넣지 않습니다.");
      if(remove) {
        const {catalog,removed}=removeReactionCatalogItem(st.plan.build.repo,item.catalogKey,{cause:args.cause,source:args.source,attempts:args.attempts,by:"세션 판단",runId},{catalog:st.catalog});
        st.catalog=catalog;
        await append(runId,{kind:"catalog_update",detail:{item:null,previous:removed,removed:true,mismatch:true,by:"세션 판단",cause:args.cause}});
        return append(runId,{kind:"unexpected",mode:"agent_action",rowId:item.rowId,surface:item.surface,acceptedSeq:item.acceptedSeq,
          detail:{id:item.id,class:"목록에서 삭제",cause:args.cause,source:args.source,verdict:"문제 아님",status:"목록 삭제"}});
      }
      if(args.expect)validateQaCommand("click",{x:0,y:0,expect:args.expect});
      if(args.handler?.expect)validateQaCommand("click",{x:0,y:0,expect:args.handler.expect});
      const roots=(st.plan.build.related||[]).map(r=>typeof r==="string" ? r : r?.repo);
      const checked=validateReactionJudgment(args,{repo:st.plan.build.repo,roots});
      const photo=item.shot || (item.sceneSeq ? savedPath(runId,verified.events.find(r=>r.seq===item.sceneSeq)) : undefined);
      const previous=st.catalog.items.find(saved=>saved.key===item.catalogKey);
      let stored=null;
      // 불일치를 문제로 판단: 등록은 맞고 제품이 실패한 것이라 목록 유지
      if(!(mismatch && args.class==="문제")) {
        st.catalog=recordReactionJudgments(st.plan.build.repo,[{...checked,key:item.catalogKey,photo,count:item.count || 1}],{runId,seq:item.seq,runSeq:st.runSeq,catalog:st.catalog,roots});
        stored=st.catalog.items.find(saved=>saved.key===item.catalogKey) || st.catalog.items.findLast(saved=>saved.id===item.id);
        await append(runId,{kind:"catalog_update",detail:{item:stored,previous,...(mismatch?{mismatch:true,by:"세션 판단",cause:args.cause}:{})}});
      }
      if(item.kind === "unknown_occlusion" || verified.events.some(r=>r.event.kind==="unknown_occlusion" && r.event.detail.id===item.id)) {
        if(args.class === "방해 화면") await append(runId,{kind:"retest_required",detail:{row:item.rowId,reason:"방해 화면 처리 등록"}});
      }
      // 같은 저장 판단에 걸리거나 방금 저장한 식별 조건에 맞는 대기 반응은 같은 판단으로 처리. 반응마다 하나씩 판단하면 한 회차 천 번 가까이 불러야 했던 사례
      // 문제는 결함 연결을 반응마다 정해야 하므로 넓히지 않음
      // 저장 판단이 다른 반응은 묶지 않고, 저장 판단이 없으면 조건이 전체 일치할 때만 묶음. 부분 일치로는 text "10" 이 다른 화면 반응 101건을 묶은 사례
      // 웹 탭 반응과 앱 반응은 같은 저장 판단에 걸려도 다른 화면이라 묶지 않음
      const surfaceKind=surface=>String(surface||"").startsWith("browser:")?"web":"app";
      const sameCondition=(condition,other)=>{const entries=Object.entries(condition||{});return entries.length>0 && entries.every(([key,value])=>(other[key]??other.condition?.[key]??other.clues?.[key])===value);};
      // ids 를 주면 세션이 고른 반응만 판단. 숫자 조건 시절 잘못 붙은 키를 따라 넣지 않은 반응 9건이 함께 판단된 사례
      // 키가 같아도 새로 저장한 조건이 맞지 않으면 묶지 않음. 짧은 조건으로 붙은 키가 다른 종류 반응 235건에 남아 있던 사례
      const same=stored && !args.ids && args.class!=="문제" && !mismatch ? pendingNow.filter(other=>other.id!==item.id && !other.catalogMismatch && !other.class && !other.verdict && other.originKind!=="unknown_occlusion"
        && (other.catalogKey ? other.catalogKey===stored.key && matchCatalogReaction({items:[stored]},other) && surfaceKind(other.surface)===surfaceKind(item.surface) : sameCondition(stored.condition,other))) : [];
      // 세션이 사진·화면을 보고 고른 반응에 같은 판단을 기록. 조건으로 묶을 수 없는 text 없는 DOM 변화가 수백 건이던 사례
      const picked=pendingNow.filter(other=>chosen.includes(other.id) && !same.includes(other));
      const extra=[...same,...picked];
      const members=extra.length ? [...new Set([...(item.members||[item.id]),...extra.flatMap(other=>other.members||[other.id])])] : item.members;
      const judged=await append(runId,{kind:"unexpected",mode:"agent_action",rowId:item.rowId,surface:item.surface,acceptedSeq:item.acceptedSeq,
        detail:{...checked,...(members?{members}:{}),verdict:args.class === "문제"?"문제":"문제 아님",status:args.class === "문제"?(linkDefect!==undefined?"결함 연결":"qa_defect 필요"):"판단 기록"}});
      if(linkDefect!==undefined)await append(runId,{kind:"unexpected_defect",mode:"agent_action",rowId:item.rowId,surface:item.surface,detail:{id:item.id,members,defectSeq:linkDefect}});
      return extra.length ? {...judged,alsoJudged:extra.length,remaining:qaPendingReactions((await ledger.verify(runId)).events).length} : judged;
    }
    // 확인 창이 떠 있는 동안 페이지가 멈춰 화면 보기·반응 관찰이 응답하지 않음. 창을 조작 전 관찰로 남기고 브라우저 층에서 바로 답함
    if (cmd === "dialog") {
      const open = requireOk(await execute(tabOf(st), "qa-dialog-state", {}))?.dialog;
      if (open) {
        const mode = st.row ? "agent_action" : "preparation", stamp = {rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path])};
        const accepted = await append(runId,{kind:"accepted",mode,...stamp,surface:st.tab,cmd,expected:args.expect});
        await append(runId,{kind:"observation",mode,...stamp,surface:st.tab,acceptedSeq:accepted.seq,cmd:"dialog_open",pass:true,detail:{kind:open.kind,message:open.message}});
        const answered = requireOk(await execute(tabOf(st), "qa-dialog-answer", {answer:args.answer,...(args.text != null ? {text:args.text} : {})}));
        if (st.staleReaction?.surface === tabOf(st)) {
          const stale = st.staleReaction; delete st.staleReaction;
          await execute(tabOf(st), "qa-reaction-end", {id:stale.id,delivered:true}).catch(() => {});
          releaseObservation(st, stale.surface, stale.id);
        }
        const action = await append(runId,{kind:"action",mode,...stamp,surface:st.tab,cmd,acceptedSeq:accepted.seq,pass:true,trusted:true,dialogBlocked:true,
          input:{kind:"dialog",delivered:true,answer:args.answer},expected:args.expect,detail:{kind:open.kind,message:open.message,via:answered?.via || "native"}});
        return {receipt:String(action.seq),answered:args.answer,dialog:open,
          note:"확인 창이 떠 있는 동안 페이지가 멈춰 반응 관찰 없이 답했습니다. qa_snapshot으로 결과 화면을 보고 qa_expect로 기대를 확인하세요."};
      }
    }
    if (QA_REACTION_ACTIONS.has(cmd)) {
      // 보고서 검사 S0·L 과 같은 기준: 진입이나 직전 조작 뒤 화면을 본 다음에만 단일 조작
      if(!privateInput && !cmd.startsWith("app_")) {
        const last=verified.events.findLast(r=>["entry","action"].includes(r.event.kind) && r.event.surface===st.tab)?.seq || 0;
        if(!verified.events.some(r=>r.seq>last && r.event.kind==="observation" && r.event.pass && ["snapshot","observe"].includes(r.event.cmd) && r.event.surface===st.tab))
          throw new Error("진입이나 직전 조작 뒤 아직 화면을 보지 않았습니다. qa_snapshot으로 화면을 본 다음 조작하세요.");
      }
      return reactionAction(st,cmd,args,session,privateInput);
    }
    if(cmd === "tabs") return {tabs:[...st.tabs],active:st.tab};
    if(cmd === "tab") {
      if(!st.tabs.has(args.tab)) throw new Error("이 회차의 탭이 아닙니다.");
      st.tab = args.tab;
      await append(runId,{kind:"observation",cmd:"tab",tab:st.tab,surface:st.tab,pass:true});
      return {tab:st.tab};
    }
    if(cmd === "close_tab") {
      if(!st.tabs.has(args.tab)) throw new Error("이 회차의 탭이 아닙니다.");
      if(st.row) throw new Error("항목 실행 중에는 탭을 닫을 수 없습니다.");
      // 닫기 전에 이 탭의 반응을 수거 · 남겨 두면 run_end 의 수거가 닫힌 탭으로 감
      // 수거 실패(확인 창 등)가 탭 닫기를 막지 않게 함 · 그 탭의 미수거 반응은 닫으면서 사라짐
      try { await drainReactions(st, args.tab); } catch {}
      await close(args.tab, runId);
      st.reactionOrigins?.delete(args.tab);
      releaseObservation(st, args.tab);
      st.tabs.delete(args.tab);
      if(st.tab === args.tab) st.tab = [...st.tabs].at(-1) || null;
      await append(runId,{kind:"observation",cmd:"close_tab",tab:args.tab,surface:args.tab,pass:true});
      return {closed:args.tab,tabs:[...st.tabs],active:st.tab};
    }
    if (cmd === "open_entry") {
      if (!st.plan.entries.includes(args.url)) throw new Error("계획에 없는 진입 주소입니다.");
      if (st.row) throw new Error("항목 실행 중에는 진입 주소로 이동할 수 없습니다.");
      const data = st.tab && !args.newTab
        ? requireOk(await execute(st.tab, "goto", { url: args.url }))
        : requireOk(await createEntry(session, args.url, runId));
      if (!st.tab || args.newTab) st.tab = data.tabId;
      st.tabs.add(st.tab);
      await append(runId, { kind: "entry", mode: "preparation", surface: st.tab, url: args.url, tab: st.tab });
      await observeBackground(st,st.tab,args.url,session);
      return { ...data, tabId: st.tab };
    }
    if (cmd === "row") {
      if(["close","end"].includes(args.action)) {
        if (typeof args.sceneJudgment !== "string" || !args.sceneJudgment.trim()) throw new Error("sceneJudgment를 입력하세요.");
        const recent = verified.events.findLast(r=>r.event.shot && r.event.rowId === (args.row || args.id || st.row) && (!args.path || r.event.path === args.path));
        if(recent) await append(runId,{kind:"frame",mode:"agent_action",rowId:st.row,path:st.lanes.at(-1)?.path,
          surface:recent.event.surface,shot:savedPath(runId,recent),url:recent.event.url,viewport:recent.event.viewport,
          ...(recent.event.stability ? {stability:recent.event.stability}:{}),
          claim:{kind:"S5",description:args.sceneJudgment},detail:{sourceSeq:recent.seq}});
      }
      const result = await applyQaRow({ledger, runId, args});
      // 무효로 한 판정 때문에 qa_play 가 자동으로 닫은 경로는 다시 엶
      const again = args.action === "void" ? await reopenAfterVoid({ledger, runId, voided:result.event?.rowData}) : null;
      const reopened = again?.reopened;
      if(again?.result) Object.assign(result, {open:again.result.open, openLanes:again.result.openLanes});
      st.lanes = result.open || result.openLanes || [];
      st.row = st.lanes.at(-1)?.id || null;
      // 응답에는 이 항목과 열린 경로만. 전체 항목 목록은 매 호출 수십 KB라 qa_list_review 로 조회
      const {rows,lists,list,notes,coverage,groups,openLanes,...reply} = result;
      return {...reply,rowCount:rows.length,...(reopened ? {reopened} : {})};
    }
    if (["defect","note","charter"].includes(cmd)) {
      let surface;
      if (cmd === "defect") {
        const events = (await ledger.verify(runId)).events;
        const recent = events.findLast(r => r.event.surface && (!st.row || r.event.rowId === st.row));
        const mobile = recent?.event.cmd?.startsWith("app_") || recent?.event.url?.startsWith("app://") || st.devices.has(recent?.event.surface);
        if (mobile || st.tab) {
          const context = await preserveFailure(st,{event:{rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path]),mode:st.row ? "agent_action":"preparation",surface:recent?.event.surface}},
          {contextOnly:true,mobile,device:mobile ? recent?.event.surface:undefined});
          surface = context.event.surface;
        }
      }
      const receipt = await recordQaSession({ledger,runId,cmd,args,rowId:st.row,surface});
      if(cmd === "defect") {
        const item = qaPendingReactions(verified.events).find(item=>item.verdict === "문제" && !item.defectSeq);
        if(item) await append(runId,{kind:"unexpected_defect",mode:"agent_action",rowId:item.rowId,surface:item.surface,detail:{id:item.id,members:item.members,defectSeq:receipt.seq}});
      }
      return receipt;
    }
    if (cmd === "run_end") {
      assertQaRemediationComplete(verified.events);
      if (st.row) throw new Error("진행 중인 항목을 먼저 종료하세요.");
      const state = deriveQaRows((await ledger.verify(runId)).events);
      if (state.gaps?.length) throw new Error("미완료 확인 항목: " + state.gaps.map(gap => `${gap.rowId} ${gap.path}`).join(", "));
      const inventory=listInventory(st,(await ledger.verify(runId)).events);
      for(const risk of st.plan.risks) if(risk.decision === "test" && !inventory.rows.some(row=>row.risk.includes(risk.id)))throw Error(`risk ${risk.id}: test 위험의 row가 없습니다`);
      // 보고서 검사를 종료 기록 전에 돌림. 끝난 회차는 무효 처리·재실행을 더 기록할 수 없어 보고서가 막히던 사례
      // 경로 색과 판정이 서로 맞지 않는 기록만 막음. 실패·미확인을 드러낸 종료는 받고 남은 사유는 결과로 알림
      // 관찰 마무리(flush) 전이라 거부돼도 회차를 이어 갈 수 있음
      const before = (await ledger.verify(runId)).events;
      const reportProblems = qaReportProblems([...before,{seq:(before.at(-1)?.seq || 0)+1,event:{kind:"run_end",mode:"preparation",sessionRecord:{...validateQaSession(args.session),defects:"없음"}}}]);
      const contradictions = reportProblems.filter(problem=>/^\[(P1|P1c|P1d|execution|A2)\]/.test(problem));
      if(contradictions.length) throw new Error(`경로 색과 판정이 맞지 않아 회차를 끝내지 않았습니다(${contradictions.length}건). 앞선 실패는 무효 처리(qa_row void)하거나 수정 뒤 재실행으로 다시 확인하고, 실패가 남으면 그 경로를 red로 다시 닫은 뒤 부르세요: ${contradictions.slice(0,40).join(" / ")}${contradictions.length>40?` 외 ${contradictions.length-40}건`:""}`);
      const activeTab = st.tab;
      // 도구 밖에서 닫힌 탭은 관찰할 수 없어 닫힌 것으로 기록하고 넘어감 (run_resume 의 goneTabs 와 같은 처리)
      try {
        for(const tab of [...st.tabs]) {
          st.tab=tab;
          try { await followAction("observe",{},session,runId); }
          catch(error) {
            if(!GONE_TAB.test(String(error?.message || error))) throw error;
            st.tabs.delete(tab);
            await append(runId,{kind:"observation",cmd:"close_tab",tab,surface:tab,pass:true,detail:{closedOutside:true}});
          }
        }
      }
      finally { st.tab=st.tabs.has(activeTab) ? activeTab : [...st.tabs].at(-1) || null; }
      if(st.mobile.flush) {
        const flushed = await st.mobile.flush(session,{close:true});
        await moments(st,flushed.moments);
        for(const result of flushed.observations || []) {
          const entry=[...(st.reactionOrigins || [])].find(([,origin])=>origin.id===(result.id || result.reactionId));
          if(entry)await saveDrainedReactions(st,entry[0],entry[1],result);
        }
        if(flushed.watchErrors?.length) await append(runId,{kind:"observation",cmd:"app_watch_failed",pass:false,reason:flushed.watchErrors.join("; ")});
      }
      assertQaReactionsJudged((await ledger.verify(runId)).events);
      const result = await ledger.end(runId, { session: args.session });
      st.ended = true;
      if(reportProblems.length) result.reportProblems = reportProblems.slice(0,40);
      for(const tab of st.tabs) await release(tab, runId);
      for(const tab of st.tabs) releaseObservation(st, tab);
      for (const device of st.devices) await releaseDevice("device:"+device,runId);
      return result;
    }
    if (cmd === "route_list") return routes.list({});
    if (cmd === "route_save") {
      const current = requireOk(await execute(tabOf(st), "url", {}));
      return routes.save({ ...args, runId, currentUrl: current.url });
    }
    if (cmd === "route_replay") {
      if (st.row) throw new Error("경로 재생은 항목 밖의 준비 단계에서만 실행합니다.");
      return routes.replay({ ...args, runId });
    }
    if (cmd === "blocked") {
      if (!st.row) throw new Error("진행 중인 항목이 필요합니다.");
      let scene = {};
      if(st.tab) scene = requireOk(await execute(st.tab,"screenshot",{stable:false}));
      return append(runId, { shot:scene.path || scene.shot,claim:{kind:"S6",description:args.reason}, kind: "blocked", mode: "agent_action", rowId: st.row, path: st.lanes.at(-1)?.path, lanes: st.lanes.map(l => [l.id, l.path]), reason: args.reason });
    }
    if (cmd === "expect") {
      if (!st.row) throw new Error("판정할 항목을 먼저 시작하세요.");
      let result;
      try { result = requireOk(await execute(tabOf(st), "qa-expect", args)); }
      catch (error) {
        const failed = await append(runId, { kind: "assertion", mode: "agent_action", rowId: st.row, path: st.lanes.at(-1)?.path, lanes: st.lanes.map(l => [l.id, l.path]), surface:st.tab, pass: false, expected: args, reason: error.message });
        await preserveFailure(st,failed);
        throw error;
      }
      const receipt = await append(runId, { kind: "assertion", mode: "agent_action", rowId: st.row, path: st.lanes.at(-1)?.path, lanes: st.lanes.map(l => [l.id, l.path]),
        pass: result.pass === true && !!result.shot && !result.shotError, tries: 1,
        claim:{kind:"S5",description:"현재 상태 판정",expected:args,actual:result.got}, surface:st.tab, expected: args, observed: result.got, arrival: args, shot: result.shot || null, url: result.url, viewport:result.viewport,stability:result.stability,captureTarget:result.captureTarget,
        reason: result.inspectionError || result.shotError || null });
      if (!receipt.event.pass) await preserveFailure(st,receipt);
      return { ...result, shot:savedPath(runId,receipt), receipt, pass: receipt.event.pass };
    }
    if (cmd.startsWith("app_")) {
      const command = cmd.slice(4);
      if (command === "expect" && !st.row) throw new Error("판정할 항목을 먼저 여세요.");
      const stamp = {rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path])};
      const mode = st.row ? "agent_action" : "preparation";
      const accepted = await append(runId,{kind:"accepted",mode,cmd,...stamp});
      const input = ["tap","swipe","type","key"].includes(command);
      let response;
      try { response = await st.mobile.execute(session,command,args,{acceptedSeq:accepted.seq,...stamp,mode}); }
      catch { response = {ok:false,error:"모바일 실행기 응답 오류"}; }
      const data = response.data || {};
      if(data.watchError || data.watchErrors?.length) await append(runId,{kind:"observation",cmd:"app_watch_failed",mode,...stamp,pass:false,reason:data.watchError || data.watchErrors.join("; ")});
      if (data.targetId) st.devices.add(data.targetId);
      const event = await append(runId,{kind:command === "expect" ? "assertion" : input ? "action" : "observation",mode,...stamp,
        cmd,acceptedSeq:accepted.seq,pass:response.ok === true && (command !== "expect" || data.pass === true),
        ...(command === "expect" ? {claim:{kind:"S5",description:"현재 앱 상태 판정",expected:args,actual:data.observed}}:{}),
        observed:command === "expect" ? data.observed : undefined,
        expected:command === "expect" ? {mode:args.mode,label:args.label,type:args.type,text:args.text} : undefined,
        input:input ? {kind:command,...Object.fromEntries(["x","y","x1","y1","x2","y2","duration","key","keycode"].filter(key=>args[key] !== undefined).map(key=>[key,args[key]])),...(command === "type" ? {length:args.text.length,valueOmitted:"입력 원문은 보관하지 않음"}: {})} : undefined,
        url:data.url || (data.targetId ? "app://"+data.targetId : undefined),viewport:data.viewport,stability:data.stability,captureTarget:data.captureTarget,
        shot:command === "expect" ? data.shot : ["screenshot","observe"].includes(command) ? data.path || data.shot : undefined,surface:data.targetId});
      if (!event.event.pass && (input || command === "expect")) await preserveFailure(st,event,{mobile:true,device:args.device || data.targetId});
      if ((data.humanRequired || response.humanRequired) && st.policy.unattended) return humanRequired(st, data.reason || response.reason || "결제·본인확인");
      requireOk(response);
      if(command==="target" && data.targetId)await observeBackground(st,data.targetId,"app://"+data.targetId,session,true);
      return {...data,...(event.event.shot ? {shot:savedPath(runId,event),...(data.path ? {path:savedPath(runId,event)}:{})}:{}),moments:await moments(st,data.moments),receipt:event};
    }
    if (cmd === "select") {
      if(args.index > 1000) throw new Error("선택 항목 범위 초과");
      const selection = requireOk(await execute(tabOf(st),"qa-select-resolve",args));
      args.index = selection.index;
      const keySteps = selection.keySteps ?? selection.index;
      if(!Number.isInteger(args.index) || !Number.isInteger(keySteps) || keySteps < 0 || args.index > 1000) throw new Error("선택 항목 범위 초과");
      await followAction("snapshot",{},session,runId);
      await followAction("click",{x:args.x,y:args.y},session,runId);
      await followAction("snapshot",{},session,runId);
      await followAction("key",{key:"Escape"},session,runId);
      await followAction("snapshot",{},session,runId);
      await followAction("key",{key:"Home"},session,runId);
      await followAction("snapshot",{},session,runId);
      for(let i=0;i<keySteps;i++) { await followAction("key",{key:"ArrowDown"},session,runId); await followAction("snapshot",{},session,runId); }
      await followAction("key",{key:"Tab"},session,runId);
      await followAction("snapshot",{},session,runId);
      return {index:args.index,verificationRequired:true};
    }
    if (cmd === "login") {
      const current = requireOk(await execute(tabOf(st), "url", {}));
      // 로컬 주소는 무인 회차의 계정 승인 범위를 적용하지 않음(사용자 2026-10-28)
      const local = isLocalOrigin(current.url);
      if (st.policy.unattended && args.fields && !local) return humanRequired(st, "직접 지정한 로그인 값은 승인된 저장 계정과 동일한지 확인할 수 없습니다.");
      const info = requireOk(await execute(st.tab,"qa-login-info",args.account ? {account:args.account}:{}));
      if(info.humanRequired && (!args.fields || info.sensitive)) {
        if (st.policy.unattended) return humanRequired(st, info.reason || "결제·본인확인은 사용자가 직접 진행해야 합니다.");
        const asked = requireOk(await ask(st.tab,session,info.reason || "결제·본인확인은 사용자가 직접 진행해야 합니다."));
        return {humanRequired:true,filled:0,submitted:false,note:asked.note};
      }
      if(!args.fields) {
        const account = info.selectedAccount || args.account || (info.accounts?.length === 1 ? info.accounts[0].id : null);
        if(!account) return {accounts:info.accounts || [],selectionRequired:true};
        if(!info.accounts?.some(a=>a.id === account)) throw new Error("사용할 저장 계정이 없습니다.");
        args.account = account;
      }
      const selectedAccount = info.accounts?.find(account => account.id === args.account);
      const preapproved = st.policy.unattended && (local || st.policy.approvals.logins.some(account => account === args.account || account === selectedAccount?.username));
      if (st.policy.unattended && !preapproved) return humanRequired(st, `승인되지 않은 로그인 계정: ${args.account || "지정 안 됨"}`);
      const key = new URL(current.url).origin + ":" + args.account;
      if (preapproved) st.approvals.add(key);
      const stored = !args.fields && info.accounts?.find(account=>account.id === args.account);
      const approvalRequired = args.fields ? !isLocalOrigin(current.url) : !stored?.allowed && !stored?.local;
      if (approvalRequired && !st.approvals.has(key)) {
        if (args.userApproved !== true) {
          const asked = requireOk(await ask(st.tab, session, `${new URL(current.url).origin}에서 테스트 계정 로그인을 허용할까요?`, {choices:["승인", "취소"]}));
          throw new Error(`로그인 승인 필요. ${asked.note} 사용자가 승인하면 같은 인자에 userApproved:true를 넣어 다시 부르세요.`);
        }
        st.approvals.add(key);
      }
      const fields = args.fields || info.fields;
      if(!fields?.length) throw new Error("로그인 입력칸을 찾지 못했습니다.");
      for (const field of fields) {
        const now = requireOk(await execute(st.tab,"url",{}));
        if(new URL(now.url).origin !== new URL(current.url).origin) throw new Error("로그인 승인 후 출처가 바뀌었습니다.");
        await followAction("snapshot",{},session,runId);
        await followAction("click",{x:field.x,y:field.y},session,runId);
        await followAction("snapshot",{},session,runId);
        const beforeInput = requireOk(await execute(st.tab,"url",{}));
        if(new URL(beforeInput.url).origin !== new URL(current.url).origin) throw new Error("로그인 입력 전 출처가 바뀌었습니다.");
        if(args.fields) {
          // 칸에 남은 값 뒤에 이어 붙지 않게 전체 선택 뒤 입력해 바꿈
          await followAction("key",{key:process.platform === "darwin" ? "Meta+a" : "Control+a"},session,runId);
          await followAction("type",{text:field.text},session,runId);
        }
        else {
          const stamp = {rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path]),surface:st.tab};
          const accepted = await append(runId,{kind:"accepted",cmd:"type",mode:"preparation",...stamp});
          try {
            const result = requireOk(await execute(st.tab,"qa-login-input",{accountId:args.account,field:field.field,x:field.x,y:field.y,origin:new URL(current.url).origin,approved:st.approvals.has(key)}));
            if (result.humanRequired && st.policy.unattended) return humanRequired(st, result.reason || "로그인 중 사람 확인 필요");
            if(!result.trusted) throw new Error("실제 로그인 입력 수신을 확인하지 못했습니다.");
            await append(runId,{kind:"action",cmd:"type",mode:"preparation",...stamp,acceptedSeq:accepted.seq,pass:true,trusted:true,target:result.target,received:result.received,input:result.input});
          } catch(error) {
            const failed = await append(runId,{kind:"action",cmd:"type",mode:"preparation",...stamp,acceptedSeq:accepted.seq,pass:false,reason:"로그인 입력 실패"});
            await preserveFailure(st,failed);
            throw error;
          }
        }
        await followAction("snapshot",{},session,runId);
      }
      await append(runId, {kind:"observation",mode:"preparation",cmd:"login",pass:true});
      return {filled:fields.length, submitted:false};
    }
    if (cmd === "diff") {
      const v = await ledger.verify(runId);
      const shots = [args.before,args.after].map(seq => v.events.find(r=>r.seq===seq)?.event.shot);
      if (shots.some(x=>!x)) throw new Error("이 회차의 두 장면 순번이 필요합니다.");
      const folder = ledger.paths(runId).folder;
      const data = requireOk(await execute(tabOf(st), "diff", {before:path.resolve(folder,shots[0]),after:path.resolve(folder,shots[1]),path:path.join(artifactDir("shots"),"qa-diff-"+crypto.randomUUID()+".png")}));
      const receipt = await append(runId,{kind:"diff",mode:"preparation",shot:data.path});
      return {...data,path:savedPath(runId,receipt),receipt};
    }
    if (cmd === "shot_sizes") {
      const presets = {mobile:{width:390,height:844},"모바일":{width:390,height:844},tablet:{width:820,height:1180},"패드":{width:820,height:1180},desktop:{width:1440,height:900},"데스크톱":{width:1440,height:900}};
      const sizes = args.sizes.map(value=> {
        if(typeof value !== "string") return value;
        const match = /^(\d+)x(\d+)$/i.exec(value);
        const size = presets[value] || (match && {width:Number(match[1]),height:Number(match[2])});
        if(!size) throw new Error("알 수 없는 화면 크기: " + value);
        return size;
      });
      const previous = requireOk(await execute(tabOf(st),"qa-viewport-state",{})).viewport;
      const shots = [];
      try {
        for(const size of sizes) {
          try {
            await followAction("snapshot",{},session,runId);
            await followAction("viewport",{...size,...(args.dpr ? {dpr:args.dpr}:{})},session,runId);
            await followAction("snapshot",{},session,runId);
            const data = requireOk(await execute(st.tab,"screenshot",{dpr:args.dpr,caption:args.caption,settle:args.settle}));
            const event = await append(runId,{kind:"frame",mode:"agent_action",rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path]),surface:st.tab,shot:data.path,url:data.url,viewport:data.viewport,stability:data.stability,captureTarget:data.captureTarget,caption:args.caption,cmd,pass:true});
            shots.push({...size,seq:event.seq,shot:event.event.shot});
          } catch(error) { shots.push({...size,error:error.message}); }
        }
      } finally {
        await followAction("snapshot",{},session,runId);
        await followAction("viewport",previous || {clear:true},session,runId);
        await followAction("snapshot",{},session,runId);
      }
      return {shots,failed:shots.filter(s=>s.error).length,restored:previous || null};
    }
    if (cmd === "bulk_fill") {
      if (st.row) throw new Error("확인 항목 안에서는 대량 기입할 수 없습니다.");
      const current = requireOk(await execute(tabOf(st),"url",{}));
      if (args.action === "plan") {
        const policy = bulkPolicy({url:current.url,where:current.url,surfaces:st.plan.surfaces || st.plan.entries,values:args.values});
        if (policy.mode === "deny") throw new Error("대량 기입 거부: 값 또는 확인 대상 화면");
        const token = crypto.randomUUID();
        st.bulk.set(token,{url:current.url,values:args.values,key:args.key || "Tab",remote:policy.mode === "confirm"});
        return {token,count:args.values.length,approvalRequired:policy.mode === "confirm"};
      }
      const plan = st.bulk.get(args.token);
      if (!plan || plan.url !== current.url) throw new Error("대량 기입 계획 또는 대상 화면이 다릅니다.");
      if (st.policy.unattended && !st.policy.approvals.bulkFill) return humanRequired(st, "대량 기입 사전 승인 없음");
      if (plan.remote && !st.policy.unattended) {
        if (args.userApproved !== true) {
          const asked = requireOk(await ask(st.tab,session,`원격 화면에 ${plan.values.length}칸 입력을 허용할까요?`,{choices:["승인","취소"]}));
          throw new Error(`대량 기입 승인 필요. ${asked.note} 사용자가 승인하면 같은 인자에 userApproved:true를 넣어 다시 부르세요.`);
        }
      }
      if(requireOk(await execute(st.tab,"url",{})).url !== plan.url) throw new Error("대량 기입 승인 후 화면이 바뀌었습니다.");
      st.bulk.delete(args.token);
      let typed = 0;
      const bulkStart = (await ledger.verify(runId)).events.at(-1)?.seq || 0;
      try {
        for (const value of plan.values) {
          await followAction("snapshot",{},session,runId);
          if(requireOk(await execute(st.tab,"url",{})).url !== plan.url) throw new Error("대량 기입 중 화면이 바뀌었습니다.");
          await followAction("type",{text:value},session,runId); typed++;
          await followAction("snapshot",{},session,runId);
          if (typed < plan.values.length) { await followAction("key",{key:plan.key},session,runId); await followAction("snapshot",{},session,runId); }
        }
      } catch (error) {
        if (error.qaHumanResult) throw error;
        typed = (await ledger.verify(runId)).events.filter(r=>r.seq>bulkStart && r.event.kind === "action" && r.event.cmd === "type" && (r.event.input?.delivered === true || r.event.pass)).length;
        return {ok:false,error:"대량 기입 중단",typed,total:plan.values.length};
      }
      await append(runId,{kind:"observation",mode:"preparation",cmd,pass:true});
      return {typed,total:plan.values.length};
    }
    if (cmd === "ask_user") {
      if (st.policy.unattended) return humanRequired(st, args.reason);
      const result = await ask(tabOf(st), session, args.reason);
      await append(runId, { kind: "observation", mode: "preparation", cmd, rowId: st.row, path: st.lanes.at(-1)?.path, lanes: st.lanes.map(l => [l.id, l.path]), pass: result.ok === true && result.data?.ok !== false && !result.data?.error });
      return requireOk(result);
    }
    let nativeCmd = cmd, nativeArgs = args;
    if (INPUT.has(cmd)) { nativeCmd = "qa-input"; nativeArgs = { ...args, action: cmd }; }
    else if (cmd === "history") { nativeCmd = args.action; nativeArgs = {}; }
    else if (!VIEW.has(cmd) && !["viewport", "dialog"].includes(cmd)) throw new Error("QA 허용 목록에 없는 명령입니다.");
    const mode = st.row ? "agent_action" : "preparation";
    const accepted = await append(runId, { kind: "accepted", mode, rowId: st.row, path: st.lanes.at(-1)?.path, lanes: st.lanes.map(l => [l.id, l.path]), surface:st.tab, cmd });
    const stamp = {rowId:st.row,path:st.lanes.at(-1)?.path,lanes:st.lanes.map(l=>[l.id,l.path])};
    let result;
    try { result = await execute(tabOf(st), nativeCmd, nativeArgs); }
    catch { result = {ok:false,error:"실행기 응답 오류"}; }
    const data = result?.data || {};
    const dialogOpen = result?.dialogOpen || data.dialogOpen;
    const pass = result?.ok === true && data.ok !== false && !data.error && (!INPUT.has(cmd) || data.trusted === true);
    const receipt = await append(runId, { kind: ACTION.has(cmd) ? "action" : "observation", mode, rowId: st.row, path: st.lanes.at(-1)?.path, lanes: st.lanes.map(l => [l.id, l.path]),
      acceptedSeq: accepted.seq, cmd, pass, surface:st.tab,url:data.url,viewport:data.viewport,stability:data.stability,captureTarget:data.captureTarget, target: data.target, received: data.received,
      trusted: data.trusted, selected: args.selected,
      input: { ...Object.fromEntries(["x","y","toX","toY"].filter(key=>Number.isFinite(args[key])).map(key=>[key,args[key]])), kind: cmd === "type" ? "text" : cmd === "key" ? "key" : cmd === "scroll" ? "scroll" : "none", ...(cmd === "type" ? { length: args.text.length, param:args.param,valueOmitted:"입력 원문은 보관하지 않음" } : cmd === "key" ? {key:args.key} : cmd === "scroll" ? {deltaX:args.deltaX || 0,deltaY:args.deltaY || 0} : {}) },
      caption:args.caption || data.caption,marks:data.marks || args.mark,detail:cmd === "observe" ? {console:data.console,network:data.network,exceptions:data.exceptions} : undefined,
      shot: cmd === "screenshot" ? data.path : cmd === "observe" ? data.screenshot : undefined });
    if (!pass && ACTION.has(cmd)) await preserveFailure(st,receipt);
    if(data.humanRequired || result?.humanRequired) {
      const reason = data.reason || result.reason || "결제·본인확인은 사용자가 직접 진행해야 합니다.";
      if (st.policy.unattended) return humanRequired(st, reason);
      const asked = requireOk(await ask(st.tab,session,reason));
      if (!pass) throw new Error(`${reason} ${asked.note}`);
    }
    if (!pass) {
      const error = new Error(result?.error || data.error || "실제 입력 수신을 확인하지 못했습니다.");
      if (dialogOpen) error.dialogOpen = dialogOpen;
      throw error;
    }
    const savedMoments = await moments(st,data.moments);
    return {...requireOk(result),...(receipt.event.shot ? {[cmd === "screenshot" ? "path":"screenshot"]:savedPath(runId,receipt)}:{}),...(savedMoments.length ? {moments:savedMoments}:{})};
  }
  const handle = async (cmd, args, session, runId, runKey) => {
    const invoke = async () => {
    try {
      const full = await serial(runId || "begin:" + session, () => perform(cmd, args, session, runId, false, runKey));
      // 바깥으로는 요약만. qa_play 안쪽 단계 실행은 perform 의 전체 결과를 씀
      const data = cmd === "play" ? briefPlayResponse(full) : QA_REACTION_ACTIONS.has(cmd) || cmd === "wait" ? briefActionResponse(full) : full;
      return data?.ok === false ? {ok:false,error:data.error,data} : { ok: true, data };
    } catch (error) { return error.qaHumanResult ? {ok:true,data:error.qaHumanResult}
      : { ok: false, error: String(error.message), ...(error.dialogOpen ? { dialogOpen: error.dialogOpen } : {}) }; }
    };
    if (!activity) return invoke();
    return activity.run("commands", `${runId || session || "unknown"}:${cmd}:${crypto.randomUUID()}`, invoke,
      { allowDuringDrain: cmd === "dialog", detail: { command: cmd, session, run: runId || null } });
  };
  handle.stopObservations = async reason => {
    const stopped = [], failures = [];
    for (const st of runs.values()) {
      await runContext(st, async () => {
      for (const [surface, origin] of [...(st.reactionOrigins || [])]) {
        if (st.devices.has(surface)) continue;
        try {
          const result = requireOk(await execute(surface, "qa-reaction-end", { id: origin.id, delivered: true }));
          await saveDrainedReactions(st, surface, origin, result);
        } catch (error) {
          failures.push({ run: st.id, surface, id: origin.id, error: String(error.message) });
          continue;
        }
        releaseObservation(st, surface, origin.id);
        st.reactionOrigins.delete(surface);
        stopped.push({ run: st.id, session: st.session, surface, id: origin.id });
      }
      if (st.mobile?.flush) {
        const flushed = await st.mobile.flush(st.session, { close: true });
        await moments(st, flushed.moments);
        for (const result of flushed.observations || []) {
          const entry = [...(st.reactionOrigins || [])].find(([, origin]) => origin.id === (result.id || result.reactionId));
          if (entry) await saveDrainedReactions(st, entry[0], entry[1], result);
          stopped.push({ run: st.id, session: st.session, id: result.id || result.reactionId || null });
        }
      }
      if (stopped.some(item => item.run === st.id)) await append(st.id, { kind: "observation", mode: "preparation",
        cmd: "worker_observations_stopped", pass: true, detail: { reason: String(reason || "worker 교체") } });
      });
    }
    if (failures.length) throw Object.assign(new Error("일부 활성 관찰을 중단하지 못했습니다."), { code: "BUSY", details: { observations: failures } });
    return stopped;
  };
  return handle;
}
