const stable=value=>JSON.stringify(value,(_key,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);

export function qaRowReplay(events,row,afterSeq) {
  const paths=events.findLast(r=>r.event.kind==='row' && r.event.action==='declare' && r.event.rowId===row)?.event.rowData?.paths || [undefined];
  const results=paths.map(path=> {
    const play=events.findLast(r=>r.seq>afterSeq && r.event.kind==='play_result' && r.event.rowId===row && (path===undefined || r.event.path===path));
    const failed=play && events.some(r=>r.seq>play.seq && r.event.rowId===row && (path===undefined || r.event.path===path) && ['reaction','assertion'].includes(r.event.kind) && r.event.pass===false);
    return {path,play,pass:play?.event.detail.pass===true && !failed};
  });
  return {pass:results.every(r=>r.pass),results};
}

// 반응 후보(접근성 이름 없음 등)에서 나온 결함: 실패 판정이 없고 qa_unexpected 로 이 결함에 연결한 후보만 있음.
// 그 후보가 기록된 반응 기록을 실패 근거로 씀
const reactionItems = e => [...(e.detail?.candidates || []),...(e.detail?.unexpected || []),...(e.detail?.items || [])];
export function qaCandidateFailure(events,defect) {
  const link=events.find(r=>r.event.kind==='unexpected_defect' && r.event.detail?.defectSeq===defect);
  const ids=link ? (link.event.detail.members || [link.event.detail.id]) : [];
  for(const id of ids) {
    const record=events.find(r=>['reaction','background_reaction'].includes(r.event.kind) && reactionItems(r.event).some(item=>item.id===id));
    if(record) return {seq:record.seq,record,item:reactionItems(record.event).find(item=>item.id===id)};
  }
  return null;
}
// 수정 재확인 구간에 같은 종류의 후보가 같은 대상에 다시 기록됐는가
export function qaCandidateRecurred(events,item,afterSeq,untilSeq) {
  const target=value=>value?.sel || value?.selector || value?.text;
  return events.some(r=>r.seq>afterSeq && r.seq<untilSeq && ['reaction','background_reaction'].includes(r.event.kind)
    && reactionItems(r.event).some(other=>(other.code || null)===(item.code || null) && target(other)===target(item)));
}
const failureSeqOf=(events,defect)=>events.find(r=>r.seq===defect && r.event.kind==='defect')?.event.detail?.failureSeq || qaCandidateFailure(events,defect)?.seq;

// 결함의 실패 판정을 만든 qa_play 실행. 항목 이름과 관계없이 실패 판정 번호로 찾음
export function qaFailedPlay(events,defect) {
  const failureSeq=failureSeqOf(events,defect);
  if(!failureSeq)return null;
  return events.find(r=>r.event.kind==='play_result' && r.event.detail?.steps && r.event.detail.startSeq<failureSeq && failureSeq<r.seq) || null;
}

// 화면 조건 판정(qa_expect·qa_app_expect)의 기대값을 반응 기대 효과로 바꿈
// 웹은 sel, 모바일은 type·label 로 대상을 가리킴. exists=appear, absent=disappear, contains·equals=change(to)
const assertionTarget = expected => Object.fromEntries(Object.entries({sel:expected.sel,role:expected.type,name:expected.label}).filter(([,value])=>value!=null));
export function assertionEffect(expected) {
  const target = assertionTarget(expected), byText = expected.text!=null && !Object.keys(target).length ? {text:expected.text} : {};
  if (expected.mode === "exists") return {type:"appear",...target,...byText};
  if (expected.mode === "absent") return {type:"absent",...target,...byText};
  return {type:"change",...target,to:expected.text};
}
export function assertionCovered(expected, effects) {
  const want = assertionEffect(expected);
  const sameTarget = e => ["sel","role","name"].every(key => want[key] == null || String(e[key] ?? "").toLowerCase() === String(want[key]).toLowerCase())
    && (want.text == null || e.text === want.text);
  // 조작 뒤 없음은 사라짐으로도, 끝까지 없음으로도 확인. 고친 코드에서 처음부터 안 뜨는 창은 사라짐으로 관찰되지 않음(O2 15704)
  const kinds = {appear:["appear","unchanged"], absent:["disappear","absent"], change:["change"]}[want.type];
  return effects.some(e => kinds.includes(e.type) && sameTarget(e) && (want.type !== "change" || e.to === want.to));
}

export function assertQaReplayContract(events,row,steps,{fixSeq,defect,path,addedEffects=[]}={}) {
  if(!fixSeq)return;
  const failedPlay=defect ? qaFailedPlay(events,defect) : null;
  // 판정을 무효 처리한 실행은 잘못 적은 기대를 담고 있어 재실행 기준이 아님(팝업에 가려 관찰할 수 없는 기대 등)
  const voided=new Set(events.filter(r=>r.event.kind==='row' && r.event.action==='void').map(r=>String(r.event.rowData?.receipt)));
  const voidedPlay=play=>events.some(r=>voided.has(String(r.seq)) && r.seq<play.seq && r.seq>=(play.event.detail?.startSeq ?? play.seq));
  // 영향 항목 재실행의 기준은 통과한 실행. 실패한 실행은 결함이나 잘못 적은 기대를 담고 있어 다시 하면 또 실패함(E2 2485 → 14597)
  const original=failedPlay || events.findLast(r=>r.seq<fixSeq && r.event.kind==='play_result' && r.event.rowId===row && (path===undefined || r.event.path===path) && r.event.detail.steps && r.event.detail.pass===true && !voidedPlay(r));
  const d=defect && events.find(r=>r.seq===defect)?.event.detail;
  const failurePartOfPlay=!!failedPlay;
  if(original && (!defect || failurePartOfPlay) && stable(original.event.detail.steps)!==stable(steps)) {
    // 수정으로 접근성 이름이 바뀌면 같은 조작도 대상 이름이 달라짐. 영향 항목 재실행은 조작·입력값·기대값이 같으면 대상(target·to)만 바뀐 것 허용.
    // 결함 재확인은 실패한 그 조작을 그대로 다시 해야 하므로 대상도 같아야 함
    // 같은 수정으로 바뀐 이름은 기대값의 요소 지정(role·name 의 name)에도 들어감. 기대 종류·role·글자·값·시간은 같아야 함
    const effectShape=effect=>effect?.role ? Object.fromEntries(Object.entries(effect).filter(([key])=>key!=='name')) : effect;
    const shape=step=>defect ? step : Object.fromEntries(Object.entries(step||{}).filter(([key])=>!['target','to'].includes(key))
      .map(([key,value])=>key==='expect' && Array.isArray(value?.effects) ? [key,{...value,effects:value.effects.map(effectShape)}] : [key,value]));
    const before=original.event.detail.steps, at=Math.max(before.length,steps.length);
    const differs=Array.from({length:at},(_,i)=>i).find(i=>stable(shape(before[i]))!==stable(shape(steps[i])));
    if(before.length!==steps.length || differs!==undefined) {
      const field=differs===undefined ? '단계 수' : Object.keys({...shape(before[differs]),...shape(steps[differs])}).find(key=>stable(before[differs]?.[key])!==stable(steps[differs]?.[key]));
      throw Error(`재실행은 원래 항목의 실행(seq ${original.seq})과 같은 조작·기대값이어야 합니다${defect?'':'(대상과 기대 요소의 이름만 바뀐 것은 허용)'}. 다른 곳: ${differs===undefined?'단계 수':`${differs+1}번째 단계의 ${field}`}. steps를 빼고 retestOf만 넣으면 원래 단계를 그대로 실행합니다`);
    }
  }
  if(defect && !failurePartOfPlay) {
    const candidate=!d?.failureSeq && qaCandidateFailure(events,defect);
    const failure=candidate ? candidate.record.event : events.find(r=>r.seq===d?.failureSeq)?.event;
    const expected=failure?.expected;
    // 배경 반응 후보는 조작 기대가 없음: 다시 실행한 구간에 같은 후보가 없는지로만 확인
    if(!expected && candidate)return;
    // 실패 판정 없이 기록한 결함(noFailure): 맞출 원래 기대값이 없어 재실행 통과로만 확인
    if(!d?.failureSeq && !candidate)return;
    if(!expected)throw Error('원래 실패 기대값이 없어 자동 수정 확인을 할 수 없습니다');
    // 도구가 단계마다 더하는 불변 조건도 원래 실패 기대값에 들어 있음
    const effects=[...steps.flatMap(s=>s.expect.effects),...addedEffects];
    const clean=e=>Object.fromEntries(Object.entries(e).filter(([key])=>!['id','reason','catalogKey','needsReview'].includes(key)));
    const missing=expected.effects ? expected.effects.filter(e=>!effects.some(now=>stable(clean(e))===stable(clean(now))))
      : assertionCovered(expected,effects) ? [] : [assertionEffect(expected)];
    // 세션이 맞출 수 있게 빠진 기대값과 원래 항목을 함께 알림
    if(missing.length)throw Error(`재실행은 원래 실패 기대값을 유지해야 합니다. 원래 항목 ${failure.rowId || '미상'}의 실패 판정 ${d.failureSeq}에서 빠진 기대값: ${missing.slice(0,3).map(e=>JSON.stringify(clean(e))).join(' / ')}`);
  }
}

// 수정 결과는 최신 커밋 이후의 실제 단계 실행으로만 확인
export function deriveQaRemediation(events) {
  const plays = events.filter(r => r.event.kind === 'play_result');
  const human = events.filter(r => r.event.kind === 'human_review');
  const needs = [];
  for (const r of events) {
    if (r.event.kind === 'fix' && r.event.detail?.commit)
      for (const row of r.event.detail.affectedRows || []) needs.push({row, afterSeq:r.seq, fixSeq:r.seq});
    if (r.event.kind === 'retest_required') needs.push({...r.event.detail, afterSeq:r.seq});
  }
  const latest = new Map();
  for (const n of needs) latest.set(n.row,n);
  const pendingRows = [...latest.values()].filter(n => !qaRowReplay(events,n.row,n.afterSeq).pass
    && !human.some(h => h.seq > n.afterSeq && h.event.detail.row === n.row));
  const defects = events.filter(r => r.event.kind === 'defect').map(r => {
    const fixes=events.filter(f=>f.event.kind==='fix' && f.event.detail.defect===r.seq);
    const fix=fixes.at(-1), d=fix?.event.detail;
    const retest=fix && plays.findLast(p=>p.seq>fix.seq && p.event.detail.retestOf?.defect===r.seq && p.event.detail.retestFix?.seq===fix.seq);
    const affectedRows=(d?.affectedRows || []).map(row=>({row, result:plays.findLast(p=>p.seq>fix.seq && p.event.rowId===row), replay:qaRowReplay(events,row,fix.seq), pending:pendingRows.some(n=>n.row===row)}));
    const deferred=human.findLast(h=>h.seq>r.seq && h.event.detail.defect===r.seq);
    const replay=retest && qaRowReplay(events,retest.event.rowId,fix.seq);
    const candidate=!r.event.detail?.failureSeq && qaCandidateFailure(events,r.seq);
    const recurred=!!(retest && candidate && qaCandidateRecurred(events,candidate.item,retest.event.detail.startSeq ?? fix.seq,retest.seq));
    const status=deferred?'사람 확인':d?.status==='고치지 못함'?'고치지 못함':retest?.event.detail.pass===true && !recurred && replay.pass && affectedRows.every(a=>!a.pending && a.replay.pass)?'수정 확인':'수정 미확인';
    // 수정 미확인의 남은 조건. 재확인이 통과해도 같은 항목의 다른 경로를 다시 실행하지 않아 이유를 알 수 없던 사례
    const waiting=status!=='수정 미확인'?[]:!fix?['qa_fix 기록 없음']:!retest?[`수정 seq ${fix.seq} 뒤 retestOf 재실행 없음`]:[
      ...(retest.event.detail.pass===true?[]:[`재실행 seq ${retest.seq} 실패`]),
      ...(recurred?[`재실행 seq ${retest.seq}에 같은 반응 후보(${candidate.item.code || "기대 밖 변화"}) 다시 기록됨`]:[]),
      ...replay.results.filter(x=>!x.pass).map(x=>`항목 ${retest.event.rowId}${x.path?` ${x.path} 경로`:''}를 수정 seq ${fix.seq} 뒤 qa_play로 다시 실행${x.play?`(seq ${x.play.seq} 뒤 실패 판정 있음)`:''}`),
      ...affectedRows.filter(a=>a.pending || !a.replay.pass).map(a=>`영향 항목 ${a.row} 재실행`)];
    return {seq:r.seq,status,fixSeq:fix?.seq,retest,affectedRows,reason:deferred?.event.detail.reason,...(waiting.length?{waiting}:{})};
  });
  return {defects,pendingRows};
}

// qa_play 응답용 요약. 재실행 기록 전체를 넣으면 결함 열한 건에 16KB
export function compactQaRemediation({defects,pendingRows}) {
  const open=defects.filter(d=>d.status!=='수정 확인');
  return {defects:open.map(d=>({seq:d.seq,status:d.status,...(d.fixSeq?{fixSeq:d.fixSeq}:{}),...(d.retest?{retestSeq:d.retest.seq}:{}),
      ...(d.waiting?{waiting:d.waiting}:{}),...(d.reason?{reason:d.reason}:{})})),
    confirmed:defects.length-open.length,pendingRows:pendingRows.map(({row,afterSeq,fixSeq,reason})=>({row,afterSeq,...(fixSeq?{fixSeq}:{}),...(reason?{reason}:{})})),
    detail:'전체 기록은 qa_review'};
}

export function assertQaRemediationComplete(events) {
  const state=deriveQaRemediation(events);
  if(state.pendingRows.length) throw Error('재실행 필요: '+state.pendingRows.map(n=>n.row).join(', '));
  const unresolved=state.defects.filter(d=>d.status==='수정 미확인');
  if(unresolved.length) throw Error('수정 확인·고치지 못함·사람 확인 판정이 필요한 결함: '+unresolved.map(d=>`${d.seq}${d.waiting?.length?` (${d.waiting.join('; ')})`:''}`).join(', '));
}

export async function deferQaRemediation(ledger,runId,decisions) {
  for(const item of decisions) {
    const events=(await ledger.verify(runId)).events;
    if(!item.reason?.trim() || (!!item.defect === !!item.row)) throw Error('사람 확인에는 defect 또는 row 하나와 reason이 필요합니다');
    if(item.defect && !events.some(r=>r.seq===item.defect && r.event.kind==='defect')) throw Error('없는 결함입니다');
    if(item.row && !events.some(r=>r.event.kind==='row' && r.event.action==='declare' && r.event.rowId===item.row)) throw Error('없는 항목입니다');
    await ledger.append(runId,{kind:'human_review',mode:'preparation',detail:item});
  }
}
