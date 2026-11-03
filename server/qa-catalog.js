import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateHome } from './state-home.cjs';

export const REACTION_CLASSES = ['연관 반응','무관 반응','방해 화면','배경 반응','문제'];
// 최근 10회 미등장 반응의 재확인 기준
export const REACTION_RECHECK_RUNS = 10;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function appIdentity(repo) {
  const root = fs.realpathSync(repo);
  try { const origin = execFileSync('git',['-C',root,'config','--get','remote.origin.url'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); if (origin) return origin; }
  catch {}
  // 원격이 없으면 본 저장소 경로: 회차마다 새로 만드는 수정 worktree 도 같은 목록 사용
  try {
    const common = execFileSync('git',['-C',root,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    if (path.basename(common) === '.git') return fs.realpathSync(path.dirname(common));
  } catch {}
  return root;
}
const repoPath = app => typeof app === 'string' ? app : app.path || app.root || app.repo;
export const catalogKey = app => hash(appIdentity(repoPath(app)));
export const catalogPath = app => path.join(stateHome(),'qa-reactions',catalogKey(app)+'.json');
export function loadReactionCatalog(app) {
  try { const value=JSON.parse(fs.readFileSync(catalogPath(app),'utf8')); if(value.version!==1 || !Array.isArray(value.items) || value.removed!==undefined && !Array.isArray(value.removed))throw Error('반응 목록 형식 오류'); return value; }
  catch(error) { if(error.code!=='ENOENT')throw error; return {version:1,app:appIdentity(repoPath(app)),items:[]}; }
}
// roots: 회차 계획의 연결 저장소(build.related). 관리자 화면처럼 다른 저장소에 원인이 있는 반응을 '미확인'으로만 적던 사례
// 제품 저장소 밖 파일은 절대 경로로 저장. recorded: 이미 저장한 출처의 파일 변경 확인(등록 때 범위를 확인함)
export function verifyReactionSource(source,{repo,roots=[],attempts=[],recorded=false}={}) {
  if(source==='미확인') {
    if(!Array.isArray(attempts)||!attempts.length||attempts.some(x=>!nonempty(x)))throw Error('미확인 출처는 시도한 검색이 필요합니다');
    return {source,attempts,sourceHash:null};
  }
  const match=typeof source==='string' && /^(.*):(\d+)$/.exec(source);
  if(!match||!repo)throw Error('source는 제품 저장소의 file:line이 필요합니다');
  const root=fs.realpathSync(repo),file=fs.realpathSync(path.resolve(root,match[1]));
  const inside=dir=>file===dir||file.startsWith(dir+path.sep);
  const allowed=[root,...roots.filter(Boolean).flatMap(dir=>{try{return [fs.realpathSync(dir)];}catch{return [];}})];
  if(!recorded&&!allowed.some(inside))throw Error('source가 제품 저장소와 연결 저장소(build.related) 밖에 있습니다');
  const bytes=fs.readFileSync(file),line=Number(match[2]);
  if(line<1||line>bytes.toString('utf8').split(/\r?\n/).length)throw Error('source 줄이 없습니다');
  return {source:(inside(root)?path.relative(root,file):file)+':'+line,sourceHash:hash(bytes),attempts};
}
const validTarget = target => target && (nonempty(target.text) || nonempty(target.role)&&nonempty(target.name));
// text 하나뿐인 조건이 숫자뿐이거나 한 글자면 부분 일치로 다른 화면 반응까지 맞음. text "10" 이 앱 팝업에도 붙은 사례
export const weakCondition=condition=>{const entries=Object.entries(condition||{});if(entries.length!==1||entries[0][0]!=='text')return false;const text=String(entries[0][1]).trim();return text.length<2||/^[\d\s.,:%+\-/]+$/.test(text);};
export function validateReactionJudgment(args,{repo,roots=[]}={}) {
  if(!REACTION_CLASSES.includes(args.class))throw Error('반응 class가 필요합니다');
  const entries=Object.entries(args.condition||{});
  if(!entries.length||entries.some(([k,v])=>!['sel','text','role','name','code','kind'].includes(k)||!nonempty(v)))throw Error('반응 식별 조건이 필요합니다');
  if(weakCondition(args.condition))throw Error('condition.text가 숫자뿐이거나 한 글자라 다른 화면 반응까지 맞습니다. 대표 반응의 전체 글자, sel 또는 role·name으로 지정하세요');
  if(!nonempty(args.cause))throw Error('반응 cause가 필요합니다');
  if(args.class==='연관 반응'&&(!nonempty(args.action?.kind)||!validTarget(args.action?.target)||!args.expect?.effects?.length))throw Error('연관 반응의 대상 조작과 필수 기대가 필요합니다');
  if(args.class==='방해 화면') {
    const h=args.handler;
    if(!h||!['click','escape','wait'].includes(h.method)||!h.expect?.effects?.length)throw Error('방해 화면의 처리 방법과 처리 뒤 기대가 필요합니다');
    if(h.method==='click'&&!validTarget(h.target))throw Error('닫기 대상이 필요합니다');
    if(h.method==='wait'&&(!Number.isInteger(h.within)||h.within<1||h.within>15000))throw Error('대기 상한은 1~15000ms입니다');
  }
  return {...args,...verifyReactionSource(args.source,{repo,roots,attempts:args.attempts})};
}
export function catalogStaleness(item,{repo,runSeq=0}={}) {
  const reasons=[];
  if(item.source==='미확인')reasons.push('출처 미확인');
  else { try { if(verifyReactionSource(item.source,{repo,recorded:true}).sourceHash!==item.sourceHash)reasons.push('출처 파일 변경'); }catch{reasons.push('출처 확인 실패');} }
  if(Number.isInteger(item.lastRunSeq)&&runSeq-item.lastRunSeq>=REACTION_RECHECK_RUNS)reasons.push('최근 회차 미등장');
  return {needsReview:reasons.length>0,reviewReasons:reasons};
}
// 회차별 반응 목록을 카탈로그 항목에 합침(마지막으로 본 회차·횟수). runs: [{name, sightings:{runSeq, items}}]
// 카탈로그 항목마다 모은 목록 전체를 다시 펼쳐 거르던 것을 키별로 한 번 묶음. 회차 수백 개에서 2분에 13GB 를 할당한 사례
export function applyCatalogSightings(catalog,runs,{repo,runSeq}={}) {
  const byKey=new Map(),grouped=new Map();
  for(const item of catalog.items)if(!byKey.has(item.key))byKey.set(item.key,item);
  // 같은 반응이 회차마다 수만 번 반복됨. 맞춰 보는 값이 같으면 결과도 같아 한 번만 맞춤
  const fields=[...new Set(catalog.items.flatMap(item=>entriesOf(item.condition).map(([key])=>key)))],matched=new Map();
  const match=item=>{
    const sig=JSON.stringify(fields.map(key=>{const v=item[key]??item.condition?.[key]??item.clues?.[key];return [typeof v,v];}));
    if(!matched.has(sig))matched.set(sig,matchCatalogReaction(catalog,item));
    return matched.get(sig);
  };
  for(const {name,sightings} of runs) {
    for(const item of sightings.items) {
      const saved=byKey.get(item.catalogKey)||match(item);if(!saved)continue;
      let records=grouped.get(saved.key);if(!records)grouped.set(saved.key,records=new Map());
      const key=name+":"+item.id,prior=records.get(key);
      records.set(key,{count:Math.max(prior?.count||0,item.count||1),run:name,seq:sightings.runSeq});
    }
  }
  for(const item of catalog.items) {
    const records=grouped.get(item.key);
    if(records?.size) {
      const list=[...records.values()],latest=list.reduce((a,b)=>a.seq>b.seq?a:b);
      item.lastRun=latest.run;item.lastRunSeq=latest.seq;
      item.count=Math.max(item.count||0,list.reduce((sum,x)=>sum+x.count,0));
    }
    Object.assign(item,catalogStaleness(item,{repo,runSeq}));
  }
  return catalog;
}
export function loadReactionCatalogForRun(app,options={}) {
  const catalog=loadReactionCatalog(app);
  return {...catalog,items:catalog.items.map(item=>({...item,...catalogStaleness(item,{repo:repoPath(app),...options})}))};
}
// 반응마다 카탈로그 항목마다 조건 목록을 다시 만들지 않게 조건 객체별로 한 번만 만듦
const conditionEntries=new WeakMap();
const entriesOf=condition=>{if(!condition||typeof condition!=='object')return [];let entries=conditionEntries.get(condition);if(!entries){entries=Object.entries(condition);conditionEntries.set(condition,entries);}return entries;};
export function matchCatalogReaction(catalog,item) {
  return catalog?.items?.find(saved=>{if(weakCondition(saved.condition))return false;const entries=entriesOf(saved.condition);return entries.length && entries.every(([key,value])=>{
    const observed=item[key]??item.condition?.[key]??item.clues?.[key];
    return key==='text' ? String(observed||'').includes(value) : observed===value;
  });}) || null;
}
export function classifyCatalogReaction(catalog,item) {
  const found=matchCatalogReaction(catalog,item);
  return found ? {catalogKey:found.key,catalogClass:found.class,needsReview:found.needsReview===true,recurrence:found.class==='문제',known:found.class!=='문제'&&!found.needsReview} : {known:false};
}
export function reactionCatalogForAction(catalog,action) {
  return (catalog?.items||[]).filter(item=>item.class==='연관 반응'&&item.action?.kind===action.kind&&same(item.action.target,action.target));
}
export function recordReactionJudgments(app,judgments,context={}) {
  const catalog=structuredClone(context.catalog || loadReactionCatalog(app));
  const checked=judgments.map(j=>validateReactionJudgment(j,{repo:repoPath(app),roots:context.roots||[]}));
  for(const judgment of checked) {
    const key=judgment.key||hash(JSON.stringify(canonical([judgment.condition,judgment.action||null])));
    const prior=catalog.items.find(item=>item.key===key);
    const item={...prior,...judgment,key,firstRun:prior?.firstRun||context.runId,firstSeq:prior?.firstSeq??context.seq,
      firstPhoto:prior?.firstPhoto||judgment.photo,lastRun:context.runId,lastRunSeq:context.runSeq,
      count:(prior?.count||0)+(judgment.count||1),lastSeenAt:judgment.lastAt||Date.now(),
      runs:[...new Set([...(prior?.runs||[]),context.runId])],needsReview:false};
    if(prior)catalog.items[catalog.items.indexOf(prior)]=item;else catalog.items.push(item);
  }
  return saveReactionCatalog(app,catalog);
}
function saveReactionCatalog(app,catalog) {
  const file=catalogPath(app);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(catalog,null,2),{mode:0o600});fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}
  return catalog;
}
// 잘못 등록한 항목 삭제. 삭제한 항목과 이유는 removed 에 보존
export function removeReactionCatalogItem(app,key,{cause,source,attempts,by,runId}={},context={}) {
  if(!nonempty(cause))throw Error('삭제 이유(cause)가 필요합니다');
  const checked=verifyReactionSource(source,{repo:repoPath(app),attempts});
  const catalog=structuredClone(context.catalog || loadReactionCatalog(app));
  const item=catalog.items.find(saved=>saved.key===key);
  if(!item)throw Error(`반응 목록에 없는 항목입니다: ${key}`);
  catalog.items=catalog.items.filter(saved=>saved!==item);
  catalog.removed=[...(catalog.removed||[]),{item,cause,...checked,by,runId,at:Date.now()}];
  return {catalog:saveReactionCatalog(app,catalog),removed:item};
}
