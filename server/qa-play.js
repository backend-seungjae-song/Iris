// 처리 반복 상한: 사라지지 않는 방해 화면으로 인한 무한 입력 방지
export const QA_OBSTACLE_RETRIES = 3;
// 누를 수 없는 대상이 풀리기를 기다리는 상한. 대화상자 닫힘 애니메이션은 수백 ms
export const QA_INERT_WAIT_MS = 3000;
const matches = (condition, blocker) => condition && blocker &&
  Object.entries(condition).filter(([key]) => ['sel','text','role','name'].includes(key)).length > 0 &&
  Object.entries(condition).filter(([key]) => ['sel','text','role','name'].includes(key)).every(([key,value]) =>
    key === 'text' ? String(blocker.text || '').includes(value) : blocker[key] === value);

// 단계 실행기는 해석 없이 입력·관찰 영수증으로만 계속 여부 결정
export async function playQaSteps({ steps, resolve, input, record, capture, close, handlers = [], augment = step => step.expect, now = Date.now, wait = ms => new Promise(done => setTimeout(done, ms)) }) {
  const results = [];
  for (const [index, original] of steps.entries()) {
    const step = {...original, expect:augment(original)};
    let result, location;
    const handled = [];
    try {
      for (let retry = 0; retry <= QA_OBSTACLE_RETRIES; retry++) {
        // 조작 대상 확인에만 방해 화면 조건 전달. 닫기 대상은 그 방해 화면 위에 있음
        location = await resolve(step.target, step, {obstacles:true});
        // 창 밖 대상은 제품 실패가 아니라 스크롤 단계가 빠진 것
        // 휠은 창 안의 점에만 보낼 수 있음. scroll 단계에 창 밖 대상을 걸라는 안내를 따르면 그 단계도 같은 막힘이던 사례
        if (location.found === false && location.offscreen) {
          const sign = { 위: "음수", 왼쪽: "음수" }[location.offscreen] || "양수";
          const how = step.action === "scroll" ? `scroll 단계의 대상은 창 안에 보이는 요소(목록 영역 등)로 두고` : `앞에 창 안에 보이는 요소를 대상으로 한 scroll 단계를 넣고`;
          result = {pass:false,blocked:true,reason:`막힘: 조작 대상이 창 ${location.offscreen}에 있음. ${how} ${["왼쪽","오른쪽"].includes(location.offscreen) ? "deltaX" : "deltaY"}를 ${sign}로 주세요`}; break;
        }
        if (location.found === false) {
          const near = (location.near || []).map(item => `${item.role} "${String(item.name).replace(/\n/g, '\\n').slice(0, 60)}"`).join(', ');
          // 모바일 경로에서 app_ 없이 type 으로 적은 단계가 웹 탭에서 대상을 찾다 실패한 사례
          const where = location.platform ? '' : ' (웹 탭에서 찾음. 기기 조작이면 app_tap·app_type 처럼 app_ 단계로 적기)';
          result = {pass:false,reason:`조작 대상을 찾을 수 없음${near ? ` — 비슷한 후보: ${near}` : ''}${where}`}; break;
        }
        if (!location.occluded) break;
        const handler = handlers.find(item => matches(item.condition, location.blocker));
        const appeared = await capture('나타남', location.blocker);
        if (!handler || retry === QA_OBSTACLE_RETRIES) {
          // 무엇이 덮었는지 알려야 다른 시작점을 고르거나 방해 화면으로 등록할 수 있음. 좌표를 직접 계산해서야 알았던 사례
          const by = [location.blocker?.role, location.blocker?.name || location.blocker?.text, location.blocker?.sel].filter(Boolean).join(' ');
          const reason = handler ? '막힘: 방해 화면 처리 상한' : `막힘: 모르는 가림${by ? ` — ${by.slice(0, 80)} 이(가) 대상 중심을 덮음. 그 요소를 피한 대상을 고르거나 방해 화면이면 qa_unexpected 로 처리 방법을 등록` : ''}`;
          await record({kind:'unknown_occlusion', detail:{id:`occlusion-${appeared.seq}`, ...location.blocker, sceneSeq:appeared.seq, shot:appeared.shot, at:now(), action:{kind:step.action,target:step.target}, reason}});
          result = {pass:false,blocked:true,reason}; break;
        }
        await record({kind:'obstacle_seen',detail:{id:`obstacle-${appeared.seq}`,...location.blocker,sceneSeq:appeared.seq,shot:appeared.shot,
          catalogKey:handler.key,catalogClass:'방해 화면',known:!handler.needsReview,needsReview:handler.needsReview,count:1,at:now()}});
        const method = handler.handler;
        if (method.method === 'wait') {
          const checked = await input({action:'wait',expect:{...method.expect,within:method.within},device:step.device}, null, {obstacle:true});
          if (!checked.pass) { result = {pass:false,blocked:true,reason:'막힘: 방해 화면 대기 뒤 상태 불일치'}; break; }
        } else {
          let dismiss = null, failure;
          if (method.method === 'click') {
            try { dismiss = await resolve(method.target, step); failure = dismiss.found === false ? '찾을 수 없음' : dismiss.occluded ? '가려짐' : null; }
            catch (error) { failure = error.message; }
          }
          // 닫기 대상을 못 찾으면 회차 안에서 처리 방법을 고칠 수 있게 판단 대기로 되돌림. 화면이 바뀌어 같은 글자가 여러 곳에 생긴 사례
          if (failure) {
            const id = `obstacle-${appeared.seq}`, target = JSON.stringify(method.target);
            await record({kind:'obstacle_seen',detail:{id,known:false,needsReview:true,handlerError:`닫기 대상 ${target}: ${failure}`}});
            result = {pass:false,blocked:true,reason:`막힘: 방해 화면 닫기 대상 ${target} — ${failure}. qa_unexpected id ${id}에 고친 handler 기록`}; break;
          }
          const handled = await input({action:method.method === 'click' ? 'click':'key', target:method.target,
            key:method.method === 'click' ? undefined:'Escape', expect:method.expect, device:step.device}, dismiss, {obstacle:true});
          if (!handled.pass) { result = {pass:false,blocked:true,reason:'막힘: 방해 화면 처리 뒤 상태 불일치'}; break; }
        }
        handled.push(location.blocker);
        await capture('처리', location.blocker);
        const after = await resolve(step.target, step, {obstacles:true});
        if (!after.occluded && after.found !== false) await capture('사라짐', location.blocker);
      }
      // 페이지가 포인터 입력을 막은 동안 누르면 화면에 닿지 않음. 닫히는 대화상자 뒤의 '삭제'가 무반응으로 기록된 사례(qa-6face637 결함 1224)
      for (const started = now(); !result && location?.inert && now() - started < QA_INERT_WAIT_MS;) {
        await wait(250);
        location = await resolve(step.target, step, {obstacles:true});
        if (location.found === false || location.occluded) result = {pass:false,blocked:true,reason:'막힘: 입력을 기다리는 동안 조작 대상이 사라지거나 가려짐'};
      }
      if (!result && location?.inert) result = {pass:false,blocked:true,reason:`막힘: 조작 대상이 ${QA_INERT_WAIT_MS / 1000}초 동안 포인터 입력을 받지 않음(pointer-events: none). 화면 전환이 끝난 뒤의 단계로 다시 실행하세요`};
      if (!result) result = await input(step, location);
      // 전달되지 않은 조작은 제품을 확인하지 못한 것이므로 실패(빨강)가 아닌 막힘(회색)
      if (result.delivered === false) result = {...result, pass:false, blocked:true, reason:`막힘: 조작 전달 실패 — ${result.error || result.reason || '원인 미기록'}`};
    } catch (error) {
      // 조작 전 기대 장면 단계에서 도구가 거부한 조작도 전달되지 않은 것이라 막힘
      result = error.delivered === false ? {pass:false,blocked:true,delivered:false,reason:`막힘: 조작 전달 전 거부 — ${error.message}`} : {pass:false,reason:error.message};
    }
    // 방해 화면 처리가 단계 직전에 닫은 요소를 그 단계가 사라짐으로 기대하면 전제 검사가 막음. 원인을 여러 줄 이름으로 잘못 적은 사례(qa-edc59fef 1539)
    if (result.blocked && /기대 전제 불성립/.test(result.reason || '') && handled.length) {
      const names = handled.map(b => String(b?.name || b?.text || b?.sel || '').replace(/\n/g, ' ').slice(0, 40)).filter(Boolean);
      result = {...result, reason:`${result.reason} — 이 단계 직전에 등록된 방해 화면 처리가 ${names.map(n => `"${n}"`).join(', ') || '방해 화면'}을(를) 닫음. 그 요소의 사라짐은 기대에서 빼고 처리 뒤 화면을 기대로 적기`};
    }
    const status = result.pass === true ? '통과' : result.blocked ? '막힘':'실패';
    results.push({index, status, ...result});
    await record({kind:'play_step',detail:{index,action:step.action,target:step.target,...(step.setup?{setup:true}:{}),status,reason:result.reason || result.error}});
    if (result.pass !== true) {
      for (let rest = index + 1; rest < steps.length; rest++) {
        results.push({index:rest,status:'미실행'});
        await record({kind:'play_step',detail:{index:rest,action:steps[rest].action,target:steps[rest].target,...(steps[rest].setup?{setup:true}:{}),status:'미실행',reason:'앞 단계 실패'}});
      }
      await close({blocked:result.blocked === true,reason:result.reason || result.error || '기대 효과 미관찰'});
      return {pass:false,status,steps:results};
    }
  }
  return {pass:true,status:'통과',steps:results};
}
