// 장부에서 복구하는 반응 판단과 사진 연결
export const QA_REACTION_ACTIONS = new Set(['click','dblclick','type','key','select','drag','scroll','history','dialog','app_tap','app_swipe','app_type','app_key']);

export function qaPendingReactions(events, { catalog, all = false } = {}) {
  const items = new Map(), groups = new Map(), voided = new Set(), beforeGroup = new Map();
  for (const {seq,event:e} of events) {
    if (e.kind === 'row' && e.action === 'void' && e.rowData?.receipt != null) voided.add(String(e.rowData.receipt));
    if (e.kind === 'reaction') for (const item of [...(e.detail?.candidates || []),...(e.detail?.unexpected || [])])
      items.set(item.id,{...items.get(item.id),...item,seq:items.get(item.id)?.seq || seq,rowId:items.get(item.id)?.rowId || e.rowId,surface:e.surface,acceptedSeq:items.get(item.id)?.acceptedSeq || e.acceptedSeq});
    if (['background_reaction','unknown_occlusion','obstacle_seen'].includes(e.kind)) {
      for (const item of (e.detail?.items || e.detail?.reactions || [e.detail]).filter(Boolean)) {
        const id = item.id || `${e.kind}-${item.seq || seq}`;
        const prior = items.get(id);
        items.set(id, {...prior, ...item, rowId:e.rowId || prior?.rowId, surface:e.surface || prior?.surface, id, seq: prior?.seq || seq, kind:item.kind || prior?.kind || e.kind, originKind:e.kind, background:e.kind === 'background_reaction'});
      }
    }
    if (e.kind === 'human_review' && e.detail?.row) for(const [id,item] of items) {
      if(item.originKind === 'unknown_occlusion' && item.rowId===e.detail.row) items.delete(id);
    }
    // 묶음 판단 전 상태. 잘못 묶인 반응을 되돌릴 때 씀
    if (e.kind === 'unexpected' && Array.isArray(e.detail?.members)) for (const id of e.detail.members) if (items.has(id)) beforeGroup.set(id, {...items.get(id)});
    if (e.kind === 'unexpected_undo') for (const id of e.detail?.ids || []) if (beforeGroup.has(id)) { items.set(id, beforeGroup.get(id)); beforeGroup.delete(id); }
    if (e.kind === 'unexpected' && items.has(e.detail?.id)) Object.assign(items.get(e.detail.id),e.detail);
    // 한 조작의 기대 밖 화면 변화 묶음 판단: 묶인 요소 전부에 적용
    if (e.kind === 'unexpected' && Array.isArray(e.detail?.members)) {
      groups.set(e.detail.id, e.detail.members);
      for (const id of e.detail.members) if (items.has(id)) Object.assign(items.get(id), {...e.detail, id, groupId:e.detail.id, members:undefined});
    }
    if (e.kind === 'qa_unexpected' && items.has(e.detail?.id)) Object.assign(items.get(e.detail.id),e.detail);
    if (e.kind === 'unexpected_defect') for (const id of e.detail?.members || groups.get(e.detail?.id) || [e.detail?.id]) if (items.has(id)) items.get(id).defectSeq = e.detail.defectSeq;
    // 기대 미관찰(K1)은 실패 판정 자체: 그 판정을 failureSeq로 가리킨 결함에 연결
    if (e.kind === 'defect' && Number.isInteger(e.detail?.failureSeq)) for (const item of items.values()) if (item.code === 'K1' && item.seq === e.detail.failureSeq && !item.defectSeq) item.defectSeq = seq;
  }
  if (all) return [...items.values()];
  // 무효로 한 판정의 기대 미관찰·목록 기대 불일치는 그 판정과 같은 실수라 판단 대상에서 뺌. 다른 화면 변화는 실제로 관찰된 것이라 남김
  const fromVoided = item => (item.code === 'K1' || item.catalogMismatch) && voided.has(String(item.seq));
  const pending = [...items.values()].filter(item => !item.known && !item.defectSeq && !fromVoided(item) && (!item.class && !item.verdict || item.class === '문제' || item.verdict === '문제'));
  return groupUnexpectedChanges(pending).map(item=>({...item,repeatCount:item.count || 1,lastSeenAt:item.lastAt || item.seenAt}));
}

// 같은 조작의 기대 밖 화면 변화(-uN)를 한 항목으로 묶음. 화면 이동·목록 다시 그리기 한 번에 요소마다 항목이 생겨 한 회차 5천 건을 하나씩 판단할 수 없던 사례
function groupUnexpectedChanges(pending) {
  const byAction = new Map();
  for (const item of pending) if (/-u\d+$/.test(item.id) && item.acceptedSeq != null && !item.catalogMismatch) {
    const key = `${item.acceptedSeq}:${item.verdict || ''}`;
    byAction.set(key, [...(byAction.get(key) || []), item]);
  }
  const grouped = new Map();
  for (const members of byAction.values()) if (members.length > 1) {
    const first = members[0], texts = [...new Set(members.map(m => m.text).filter(Boolean))];
    grouped.set(first.id, {
      id: `a${first.acceptedSeq}-changes${first.verdict ? '-problem' : ''}`, group: true, acceptedSeq: first.acceptedSeq, rowId: first.rowId, surface: first.surface,
      seq: Math.min(...members.map(m => m.seq)), sceneSeq: first.sceneSeq, sceneSeqs: [...new Set(members.map(m => m.sceneSeq).filter(Boolean))].slice(0, 20),
      description: (`기대 밖 화면 변화 ${members.length}건: ` + (texts.slice(0, 8).join(', ') || '요소 표시')).slice(0, 300),
      members: members.map(m => m.id), count: members.length, at: Math.min(...members.map(m => m.at || Infinity)), lastAt: Math.max(...members.map(m => m.lastAt || 0)),
      elements: members.slice(0, 30).map(m => ({ id: m.id, text: m.text, sel: m.sel, rect: m.rect, count: m.count })),
      ...(first.verdict ? { verdict: first.verdict, class: first.class } : {}),
    });
    for (const m of members.slice(1)) grouped.set(m.id, null);
  }
  return pending.flatMap(item => grouped.has(item.id) ? (grouped.get(item.id) ? [grouped.get(item.id)] : []) : [item]);
}

export function assertQaReactionsJudged(events) {
  const pending = qaPendingReactions(events);
  if (pending.length) throw new Error('반응 판단을 완료하세요: ' + pending.map(item=>`${item.id} (${item.verdict === '문제' ? 'qa_defect 필요':'판단 안 됨'})`).join(', '));
}

export function reactionExpectation(expect) {
  return {...expect,effects:expect.effects.map((effect,index)=>({...effect,id:effect.id || `e${index+1}`}))};
}

// 조작 응답용 요약. 장부에는 전체를 저장하고, 응답에는 판단할 반응만 전체로 줌
// 알려진 반응(known)은 반응 목록에서 이미 판단했으므로 요약만. 장면 표시 좌표는 사진 옆 파일과 보고서에 있음
// 묶음의 구성원 id·바뀐 요소 목록은 반응 하나에 수백 개. 판단은 묶음 id 와 앞쪽 요소·사진으로 하므로 개수만 남김
export function briefReactionItem(item) {
  const {members,elements,...rest} = item;
  return {...rest,...(Array.isArray(members)?{memberCount:members.length}:{}),...(Array.isArray(elements)?{elements:elements.slice(0,5),elementCount:elements.length}:{})};
}

export function compactReactionResponse({candidates = [], unexpected = [], scenes = []}) {
  const brief = item => item.known !== true ? briefReactionItem(item) : {id:item.id,known:true,catalogKey:item.catalogKey,catalogClass:item.catalogClass,
    description:String(item.description || "").slice(0,120),count:item.count || 1,sceneSeq:item.sceneSeq};
  return {candidates:candidates.map(brief),unexpected:unexpected.map(brief),
    scenes:scenes.map(({marks,...scene})=>Array.isArray(marks) && marks.length ? {...scene,markCount:marks.length} : scene)};
}

// MCP 로 돌려주는 조작 결과. 회차 기록 파일에는 전체를 저장하고 응답에는 다음 판단에 쓰는 것만 남김
// 장면 목록·이벤트 원본·영수증 사본이 조작 하나에 평균 8천 자, QA 한 회차 도구 결과 1,135만 자로 압축이 17분마다 일어난 사례
const EFFECT_TARGET_KEYS = ['text','name','role','sel','nth','value'];
const ACTION_NOTE_KEYS = ['delivered','blocked','humanRequired','index','atEdge','scrollUnchanged','scrollApplied','scrollNote','ok','error','next','note','dialog'];
const oneLine = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
export function briefActionResponse(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.effects)) return data;
  // 통과 장면 사진은 qa_review 로 다시 볼 수 없어 효과마다 경로를 남김
  const sceneShot = effect => { const scene = (data.scenes || []).find(item => (effect.sceneId && item.id === effect.sceneId) || (effect.sceneSeq && item.seq === effect.sceneSeq)); return scene?.shot || scene?.path; };
  const effects = data.effects.map(effect => {
    const expected = effect.expected || effect, shot = sceneShot(effect);
    return {id:effect.id, type:expected.type, ...Object.fromEntries(EFFECT_TARGET_KEYS.filter(key => expected[key] !== undefined).map(key => [key, expected[key]])),
      observed:effect.observed === true, ...(effect.description ? {description:oneLine(effect.description, 160)} : {}),
      ...(effect.reason ? {reason:oneLine(effect.reason, 200)} : {}), ...(effect.sceneSeq ? {sceneSeq:effect.sceneSeq} : {}),
      ...(shot ? {shot} : {}), ...(expected.needsReview || effect.needsReview ? {needsReview:true} : {})};
  });
  const items = [...(data.candidates || []), ...(data.unexpected || [])];
  const pending = items.filter(item => item.known !== true);
  const failureScene = data.pass === true ? null : (data.scenes || []).findLast(scene => scene.claim?.kind === 'S3') || (data.scenes || []).at(-1);
  return {pass:data.pass === true, receipt:data.receipt?.seq ?? data.receipt, ...(data.action ? {action:data.action} : {}), effects,
    ...(pending.length ? {reactions:{pending:pending.length, items:pending.slice(0, 5).map(item => ({id:item.id, ...(item.code ? {code:item.code} : {}),
      description:oneLine(item.description, 160), ...(item.sceneSeq ? {sceneSeq:item.sceneSeq} : {})}))}} : {}),
    ...(items.length > pending.length ? {knownReactions:items.length - pending.length} : {}),
    ...(failureScene?.shot || failureScene?.path ? {shot:failureScene.shot || failureScene.path} : {}),
    ...Object.fromEntries(ACTION_NOTE_KEYS.filter(key => data[key] !== undefined).map(key => [key, data[key]]))};
}
// qa_play 결과: 통과 단계는 영수증과 효과 요약(반응 목록이 더한 필수 기대 포함), 통과하지 못한 단계는 조작 결과 요약과 이유
export function briefPlayResponse(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.steps)) return data;
  const steps = data.steps.map(step => step.status === '통과' ? (({index, status, receipt, effects, reactions, knownReactions}) => ({index, status, receipt, effects, ...(reactions ? {reactions} : {}), ...(knownReactions ? {knownReactions} : {})}))({...briefActionResponse(step), index:step.index, status:step.status})
    : step.status === '미실행' ? {index:step.index, status:step.status}
    : {...briefActionResponse(step), index:step.index, status:step.status, ...(step.reason ? {reason:step.reason} : {})});
  // 조치 목록은 qa_play 마다 붙음. 같은 상태·대기 사유의 결함은 번호만 묶고, 이유 전문은 qa_review 에서 봄
  const groupDefects = defects => [...defects.reduce((groups, d) => {
    const waiting = (d.waiting || []).slice(0, 3).map(item => oneLine(item, 80)), key = d.status + '|' + waiting.join(',');
    const group = groups.get(key) || {status:d.status, ...(waiting.length ? {waiting, waitingCount:(d.waiting || []).length} : {}), seqs:[]};
    group.seqs.push(d.seq); return groups.set(key, group);
  }, new Map()).values()];
  const remediation = data.remediation && typeof data.remediation === 'object' ? {...data.remediation,
    ...(Array.isArray(data.remediation.defects) ? {defects:groupDefects(data.remediation.defects)} : {}),
    ...(Array.isArray(data.remediation.pendingRows) ? {pendingRows:data.remediation.pendingRows.map(r => r.reason ? {...r, reason:oneLine(r.reason, 100)} : r)} : {})} : data.remediation;
  return {...data, steps, ...(remediation ? {remediation} : {})};
}

export async function recordQaReaction({runId,accepted,stamp,mode,surface,result,append,savePath,sceneMap = new Map()}) {
  const prefix = `a${accepted.seq}-`;
  const candidates = (result.candidates || []).map((item,index)=>({...item,id:item.absoluteId || prefix+(item.id || `k${index+1}`)}));
  const unexpected = (result.unexpected || []).map((item,index)=>({...item,id:item.absoluteId || prefix+(item.id || `u${index+1}`)}));
  const scenes = [];
  for (const [index,scene] of (result.scenes || []).entries()) {
    const id = scene.id || `${scene.claim?.kind || 'scene'}-${index}`;
    if (sceneMap.has(id)) { scenes.push(sceneMap.get(id)); continue; }
    const claim = {...scene.claim};
    if(claim.candidateId) claim.candidateId = prefix+claim.candidateId;
    // 같은 화면 장면: 원본은 첫 기록 뒤 삭제되므로 회차 폴더 사본 사용
    const same = sceneMap.get(scene.sameSceneId), sameSceneSeq = same?.seq;
    const receipt = await append(runId,{...scene,kind:'frame',mode,...stamp,surface,acceptedSeq:accepted.seq,
      shot:same?.shot || scene.shot || scene.path,claim,caption:claim.description,phase:claim.kind,
      ...(sameSceneSeq ? {sameSceneSeq}:{}),detail:{sceneId:id,signalAt:scene.signalAt,lived:scene.lived,shotError:scene.shotError}});
    const saved = {...scene,id,seq:receipt.seq,shot:savePath(runId,receipt),claim};
    sceneMap.set(id,saved); scenes.push(saved);
  }
  const effects = (result.effects || []).map(effect=>({...effect,sceneSeq:sceneMap.get(effect.sceneId)?.seq}));
  for(const item of [...candidates,...unexpected]) item.sceneSeq ||= sceneMap.get(item.sceneId)?.seq;
  return {effects,candidates,unexpected,scenes,sceneMap};
}
