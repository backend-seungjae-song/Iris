import { qaRiskResults } from "./qa-list-review.js";
import { deriveQaRows } from "./qa-rows.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const prose = value => value == null ? "" : typeof value !== "object" ? String(value) : Array.isArray(value) ? value.map(prose).filter(Boolean).join(" · ") : Object.entries(value).map(([key, item]) => `${key}: ${prose(item)}`).join(" · ");
const sameLane = (a, b) => a.rowId && a.rowId === b.rowId && (!a.path || !b.path || a.path === b.path)
  || a.lanes?.some(lane => (b.lanes || []).some(other => prose(lane) === prose(other)));
export const isQaCalibration = event => event.phase === "calibration" || event.calibration === true || event.claim?.kind === "calibration";
export const effectText = effect => [({ appear: "표시", disappear: "사라짐", change: "변경", unchanged: "바뀌지 않음", absent: "없음", navigate: "주소 이동", dialog: "대화상자", request: "요청", none: "변화 없음" })[effect.type], effect.text, effect.sel, effect.role && `${effect.role} ${effect.name}`, effect.from != null && `이전 ${effect.from}`, effect.to != null && `이후 ${effect.to}`, effect.url, effect.kind, effect.method, effect.path, effect.status].filter(v => v !== false && v != null && v !== "").join(" · ");
// 화면 비율 좌표와 기록 시각을 사람이 읽는 값으로
const percent = value => Number.isFinite(value) ? `${Math.round(value * 100)}%` : "미기록";
const clock = ms => Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Seoul" }) + `.${String(ms % 1000).padStart(3, "0")}` : "미기록";
const duration = (ms, missing) => Number.isFinite(ms) ? `${ms}ms` : missing;

// 사진을 본문에 넣는 총량. 넘으면 회차 폴더의 파일 주소로 연결. 사진 7,684장(3.3GB)을 모두 넣다 메모리가 부족해 회차 요약이 죽던 사례
const INLINE_PHOTO_BYTES = 16 * 1024 * 1024;

// 조작 순번으로 묶은 기대·반응·판정과 사진 참조
export function renderQaActionReport(events, folder, { prefix = "qa", inlineBytes = INLINE_PHOTO_BYTES } = {}) {
  let inlined = 0;
  const records = events.filter(record => !isQaCalibration(record.event));
  const rows = deriveQaRows(records).rows;
  const bySeq = new Map(records.map(record => [record.seq, record]));
  const rendered = new Set();
  const canonical = record => {
    const seen = new Set();
    while (record && !seen.has(record.seq)) {
      seen.add(record.seq);
      const next = record.event.sameSceneSeq || record.event.shotSeq;
      if (!next || next === record.seq || !bySeq.get(next)?.event.shot) break;
      record = bySeq.get(next);
    }
    return record;
  };
  const photo = (record, reason = "대응하는 장면을 촬영하지 못함") => {
    if (record && !record.event.shot && (record.event.detail?.sourceSeq || record.event.detail?.sceneSeq)) record = bySeq.get(record.event.detail.sourceSeq || record.event.detail.sceneSeq);
    if (!record?.event.shot) return `<span class="no-photo">사진 없음 · ${esc(reason)}</span>`;
    const first = canonical(record), e = first.event;
    const id = `${prefix}-scene-${first.seq}`;
    if (rendered.has(first.seq)) return `<a href="#${id}">사진 #${first.seq}</a>`;
    const file = path.resolve(folder, e.shot);
    let src;
    try {
      const size = fs.statSync(file).size;
      if (inlined + size > inlineBytes) src = pathToFileURL(file).href;
      else { src = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`; inlined += size; }
    } catch { return `<span class="no-photo">사진 없음 · 저장한 이미지 파일을 읽지 못함 (#${record.seq})</span>`; }
    rendered.add(first.seq);
    // 표시 위치는 배열이나 {marks:[...]} 로 저장됨. 객체 형식에서 회차 요약이 실패하던 사례
    const marks = (Array.isArray(e.marks) ? e.marks : e.marks?.marks)?.map(mark => `${mark.label?.trim() || "대상"} (가로 ${percent(mark.x)}, 세로 ${percent(mark.y)}, 너비 ${percent(mark.w ?? mark.width)}, 높이 ${percent(mark.h ?? mark.height)})`).join(" · ") || "표시 위치 없음";
    const time = Number.isFinite(e.capturedAt) ? `촬영 ${clock(e.capturedAt)}` : `기록 ${clock(e.at)}`;
    return `<figure id="${id}"><img src="${esc(src)}" loading="lazy" alt="사진 #${first.seq}"><figcaption>사진 #${first.seq}${record.seq !== first.seq ? ` · 기록 #${record.seq}와 같은 장면` : ""} · ${esc(time)} · 위치 ${esc(marks)}</figcaption></figure>`;
  };
    const relatedFrame = (group, kind, idKey, id, seq) => group.find(record => record.event.shot && record.event.claim?.kind === kind && (seq && record.seq === seq || !seq && (!idKey || String(record.event.claim?.[idKey]) === String(id))));
  const claim = (description, record, reason) => `<li><p>${esc(description)}</p>${photo(record, reason)}</li>`;
  const judgmentFor = item => records.findLast(record => record.event.kind === "unexpected" && record.event.detail?.id === item.id)?.event.detail
    || !item.needsReview && item.catalogKey && (records.findLast(record => record.event.kind === "catalog_update" && record.event.detail?.item?.key === item.catalogKey)?.event.detail.item
      || records.findLast(record => record.event.kind === "catalog_begin")?.event.detail?.catalog?.items?.find(saved => saved.key === item.catalogKey));
  const reactionText = item => {
    const judgment = judgmentFor(item);
    return `${item.id || "반응"} · 단서 ${prose(item)} · 판단 ${judgment ? prose(judgment) : item.known ? "알려진 반응" : "판단 안 됨"}`;
  };
  // 판단이 끝난 반응은 같은 판단끼리 한 줄로 묶고 첫 장면만 붙임. 홈 화면 주기 변화 190여 건을 한 건씩 원본 사진과 함께 적은 사례
  const judgedGroups = items => {
    const open = [], groups = new Map();
    for (const item of items) {
      const verdict = judgmentFor(item);
      if (!verdict) { open.push(item); continue; }
      const key = item.catalogKey || JSON.stringify([verdict.class || verdict.verdict, verdict.source, prose(verdict.condition)]);
      if (!groups.has(key)) groups.set(key, { verdict, items: [] });
      groups.get(key).items.push(item);
    }
    // 한 건뿐인 판단은 묶지 않고 단서까지 그대로 적음
    const many = [...groups.values()].filter(entry => entry.items.length > 1);
    open.push(...[...groups.values()].filter(entry => entry.items.length === 1).map(entry => entry.items[0]));
    for (const entry of many) for (const item of entry.items) { folded.ids.add(item.id); if (item.sceneSeq) folded.seqs.add(item.sceneSeq); }
    return { open: items.filter(item => open.includes(item)), groups: many };
  };
  // 묶은 반응의 장면은 아래 항목 확인 기록·개별 확인 장면에도 다시 넣지 않음
  const folded = { ids: new Set(), seqs: new Set() };
  const isFolded = record => folded.seqs.has(record.seq) || record.event.claim?.kind === "S4" && folded.ids.has(record.event.claim.candidateId);
  const groupClaim = ({ verdict, items }, scene, reason) => claim(`${verdict.verdict || "판단 완료"} · ${verdict.class || "분류 없음"} · ${items.length}건 (${items.map(item => item.id).slice(0, 3).join(", ")}${items.length > 3 ? " 외" : ""}) · ${items[0].description || items[0].text || items[0].reason || "반응"} · source ${verdict.source || "미확인"} · 원인 ${verdict.cause || "미기록"} · 조건 ${prose(verdict.condition) || "미기록"}`, scene(items[0]), reason);
  const strips = [];
  for (const accepted of records.filter(record => record.event.kind === "accepted")) {
    const group = records.filter(record => record.event.acceptedSeq === accepted.seq);
    const action = group.find(record => record.event.kind === "action");
    // 기대 선언이 없는 준비 조작(viewport 등)은 판정 대상이 아님
    if (!accepted.event.expected) continue;
    const reaction = group.find(record => record.event.kind === "reaction");
    const data = reaction?.event.detail || {};
    const expectation = accepted.event.expected;
    const effects = data.effects || [];
    const candidates = [...new Map(group.filter(r=>r.event.kind==="reaction").flatMap(r=>[...(r.event.detail?.candidates || []),...(r.event.detail?.unexpected || [])]).map(item=>[item.id,item])).values()];
    const nextAction = records.find(record => record.seq > accepted.seq && record.event.kind === "accepted" && record.event.expected);
    const followup = records.filter(record => record.seq > accepted.seq && (!nextAction || record.seq < nextAction.seq));
    const stages = [];
    const expectedText = expectation?.effects?.map(effect => `${effectText(effect)} · 기준: ${effect.oracle}`).join(" / ") || "기대 기록 없음";
    const actionText = relatedFrame(group, "S1")?.event.claim?.description || action?.event.cmd || accepted.event.cmd || "조작";
    const what = records.findLast(record => record.seq <= accepted.seq && record.event.kind === "row" && record.event.action === "declare" && record.event.rowId === accepted.event.rowId && record.event.rowData?.what)?.event.rowData.what;
    stages.push(`<section data-stage="S1"><h3>S1 기대와 조작</h3>${what ? `<p>확인 항목: ${esc(what)}</p>` : ""}<ul>${claim(`${actionText} · ${expectedText}${expectation?.within ? ` · ${expectation.within}ms 이내` : ""}`, relatedFrame(group, "S1") || group.find(record => record.event.phase === "before"), "조작 전 장면 없음")}</ul></section>`);
    stages.push(`<section data-stage="S2"><h3>S2 관찰한 효과</h3>${effects.length ? `<ul>${effects.map((effect, index) => claim(`${effect.description || effectText(effect.expected || effect)} · 관찰 ${effect.observed === true ? "성공" : effect.observed === false ? "실패" : "미확인"}${effect.elapsedMs != null ? ` · ${effect.elapsedMs}ms` : ""}`, relatedFrame(group, "S2", "effectId", effect.id || effect.effectId || `e${index + 1}`, effect.sceneSeq), effect.noPhotoReason || effect.reason || "해당 효과의 장면 없음")).join("")}</ul>` : "<p>관찰한 효과 기록 없음 · 사진 없음 · 반응 관찰 기록 없음</p>"}</section>`);
    stages.push(`<section data-stage="S3"><h3>S3 기대 판정</h3><p>첫 반응 ${esc(duration(data.firstReactionMs, "미관찰"))} · 효과 완료 ${esc(duration(data.completedMs, "미관찰"))} · 총 관찰 ${esc(duration(data.elapsedMs, "미기록"))} · 꼬리 기록 ${esc(duration(data.tailMs, "미기록"))}</p>${data.unavailable?.length ? `<p>확인 불가: ${esc(prose(data.unavailable))}</p>` : ""}${data.limits?.length ? `<p>관찰 한계: ${esc(prose(data.limits))}</p>` : ""}<ul>${claim(data.pass === true ? "기대 효과 충족" : data.pass === false ? "기대 효과 미충족" : "기대 판정 미확인", relatedFrame(group, data.pass === true ? "S2" : "S3"), "기대 판정에 대응하는 장면 없음")}</ul></section>`);
    const candidateScene = candidate => bySeq.get(candidate.sceneSeq) || relatedFrame(group, "S4", "candidateId", candidate.id, candidate.sceneSeq);
    const sorted = judgedGroups(candidates);
    stages.push(`<section data-stage="S4"><h3>S4 후보와 기대 밖 반응</h3>${candidates.length ? `<ul>${sorted.open.map(candidate => {
      const verdict = judgmentFor(candidate);
      const evidence = verdict ? ` · ${verdict.class || verdict.verdict || "판단"} · source ${verdict.source || "미확인"} · 원인 ${verdict.cause || "미기록"} · 조건 ${prose(verdict.condition) || candidate.description || "미기록"}` : "";
      return claim(`${candidate.id} · ${candidate.description || candidate.reason || "반응"} · 단서 ${prose(candidate)} · ${verdict ? `${verdict.verdict || "판단 완료"}${evidence}` : "판단 안 됨"}`, candidateScene(candidate), candidate.noPhotoReason || "후보에 대응하는 장면 없음");
    }).join("")}${sorted.groups.map(entry => groupClaim(entry, candidateScene, entry.items[0].noPhotoReason || "후보에 대응하는 장면 없음")).join("")}</ul>` : "<p>의외 후보 없음</p>"}</section>`);
    const endJudgments = followup.filter(record => record.event.kind === "row" && record.event.action === "close" && sameLane(accepted.event, record.event));
    const assertions = followup.filter(record => record.event.kind === "assertion" && sameLane(accepted.event, record.event));
    stages.push(`<section data-stage="S5"><h3>S5 확인과 종료 판단</h3><ul>${assertions.map(record => claim(`판정 #${record.seq} · ${record.event.pass ? "통과" : "실패"} · ${prose(record.event.observed || record.event.expected)}`, record, "조건 판정의 장면 없음")).join("")}${endJudgments.map(record => { const frame = followup.findLast(r => r.seq < record.seq && r.event.claim?.kind === "S5" && sameLane(record.event, r.event)); const source = frame || (record.event.detail?.sourceSeq && bySeq.get(record.event.detail.sourceSeq)); return claim(["장면 전체 판단", record.event.rowData?.sceneJudgment || "미기록", record.event.rowData?.note].filter(Boolean).join(" · "), source || relatedFrame(group, "S5") || assertions.at(-1), "종료 판단에 대응하는 장면 없음"); }).join("")}</ul></section>`);
    const blocked = followup.filter(record => sameLane(accepted.event, record.event) && (record.event.kind === "blocked" || record.event.cmd === "capture_failed" || record.event.detail?.captureError || record.event.claim?.kind === "S6"));
    stages.push(`<section data-stage="S6"><h3>S6 확인하지 못한 내용</h3>${blocked.length ? `<ul>${blocked.map(record => claim(record.event.reason || record.event.claim?.description || record.event.detail?.captureError || prose(record.event.detail), record, "확인을 중단하여 장면 없음")).join("")}</ul>` : "<p>기록 없음</p>"}</section>`);
    strips.push({ event: accepted.event, html: `<article class="qa-action" data-accepted-seq="${accepted.seq}"><h2>조작 #${accepted.seq} · ${esc(actionText)}</h2>${stages.join("")}</article>` });
  }
  const backgroundSorted = judgedGroups([...new Map(records.filter(r=>r.event.kind==="background_reaction").flatMap(r=>r.event.detail?.items || []).map(item=>[item.id,item])).values()]);
  const rowStrips = rows.map(row => {
    const owns = event => sameLane({rowId:row.id}, event) || event.lanes?.some(lane => (Array.isArray(lane) ? lane[0] : lane.rowId) === row.id);
    const special = records.filter(record => owns(record.event) && (record.event.cmd === "obstacle_scene" || ["unknown_occlusion", "obstacle_seen"].includes(record.event.kind)));
    const obstacles = special.map(record => {
      const e = record.event;
      return claim(e.kind === "unknown_occlusion" ? `모르는 가림 · ${reactionText(e.detail || {})}` : e.kind === "obstacle_seen" ? `등록 방해 화면 · ${reactionText(e.detail || {})}` : `방해 화면 ${e.detail?.phase || e.phase || "장면"} · ${prose(e.detail?.blocker || e.detail)}`, record, "방해 화면의 장면 없음");
    }).join("");
    const other = records.filter(record => owns(record.event) && (record.event.shot && !rendered.has(canonical(record).seq) && !isFolded(record) || ["play_step", "blocked", "play_failure"].includes(record.event.kind))).map(record => {
      const e = record.event;
      const description = e.kind === "play_step" ? `${e.detail?.setup ? "준비 " : ""}단계 ${e.detail?.index ?? "?"} · ${e.detail?.status || "미기록"} · ${e.detail?.reason || ""}`
        : e.kind === "assertion" ? `판정 #${record.seq} · ${e.pass === true ? "통과" : e.pass === false ? "실패" : "미확인"} · ${prose(e.observed || e.expected || e.reason)}`
        : e.claim?.description || e.reason || e.cmd || "확인 장면";
      return claim(description, record);
    }).join("");
    const closing = !strips.some(strip => owns(strip.event)) ? records.filter(record => owns(record.event) && record.event.kind === "row" && record.event.action === "close").map(record => {
      const source = records.findLast(scene => scene.seq < record.seq && owns(scene.event) && scene.event.shot);
      return claim(`장면 전체 판단 · ${record.event.rowData?.sceneJudgment || "미기록"} · ${record.event.rowData?.note || ""}`, source, "종료 판단에 대응하는 장면 없음");
    }).join("") : "";
    return `<section class="qa-row-scenes" data-row-id="${esc(row.id)}"><h2>확인 항목 · ${esc(row.what || row.id)}</h2>${strips.filter(strip => owns(strip.event)).map(strip => strip.html).join("")}${obstacles ? `<section data-stage="obstacles"><h3>방해 화면</h3><ul>${obstacles}</ul></section>` : ""}${other || closing ? `<section><h3>항목 확인 기록</h3><ul>${other}${closing}</ul></section>` : ""}</section>`;
  }).join("");
  const unassigned = strips.filter(strip => !rows.some(row => sameLane({rowId:row.id}, strip.event) || strip.event.lanes?.some(lane => (Array.isArray(lane) ? lane[0] : lane.rowId) === row.id))).map(strip => strip.html).join("");
  const standalone = records.filter(record => (record.event.shot || ["obstacle_scene", "play_step", "list_review", "catalog_update"].includes(record.event.kind)) && !rendered.has(canonical(record).seq) && !isFolded(record));
  const remaining = standalone.map(record => {
    const e = record.event, d = e.detail || {};
    const text = e.kind === "play_step" ? `${d.setup ? "준비 " : ""}단계 ${d.index ?? "?"} · ${d.status || "미기록"} · ${d.reason || ""}`
      : e.kind === "list_review" ? `목록 검토 · ${prose(d.review || d.inventory)}`
      : e.kind === "catalog_update" ? `목록 변경 · ${d.removed ? "삭제" : prose(d.item)} · 이전 ${prose(d.previous)}`
      : e.kind === "obstacle_scene" ? `방해 화면 · ${e.phase || d.phase || "장면"} · ${prose(d)}`
      : `${e.claim?.kind || "상태 확인"} · ${e.claim?.description || e.reason || e.cmd || "화면 기록"}`;
    return claim(text, record);
  }).join("");
  const background = backgroundSorted.open.map(item=>claim(reactionText(item),bySeq.get(item.sceneSeq))).join("") + backgroundSorted.groups.map(entry=>groupClaim(entry,item=>bySeq.get(item.sceneSeq),"대응하는 장면을 촬영하지 못함")).join("");
  const listReviews=records.filter(r=>r.event.kind==="list_review").map(r=>`<li>${esc(prose(r.event.detail?.review))}</li>`).join("");
  const risks=qaRiskResults(records,rows).map(r=>`<li>${esc(r.id)} · ${esc(r.risk)} · ${esc(r.decision)} · ${esc(r.result)} · ${esc(r.reason || "")}</li>`).join("");
  return `<section class="qa-actions"><h2>조작과 결과</h2><p>코드로 확인 불가: canvas·동영상·WebGL 내부 효과</p>${risks?`<section><h3>위험별 완료 근거</h3><ul>${risks}</ul></section>`:""}${listReviews?`<section><h3>목록 검토</h3><ul>${listReviews}</ul></section>`:""}${rowStrips}${unassigned}${!strips.length && !rows.length ? "<p>기록한 조작 없음</p>" : ""}${background ? `<section><h3>테스트와 별개로 본 것</h3><ul>${background}</ul></section>` : ""}${remaining ? `<section><h3>개별 확인 장면</h3><ul>${remaining}</ul></section>` : ""}</section>`;
}

export function renderQaCaptureInfo(captures) {
  // 사진마다 한 줄이라 1,500장이면 5만 px. 칸 전체를 접어 둠
  return `<section class="req"><h2>촬영 정보</h2><details class="captures"><summary>사진 ${captures.length}장의 촬영 대상·화면 크기·안정 여부</summary>${captures.map(capture => {
    const target = capture.captureTarget || {}, size = capture.viewport || {}, stability = capture.stability || {};
    const outcome = stability.remaining?.includes?.("not-requested") ? "안정화 확인 생략" : stability.stable === false ? "안정 전 촬영" : stability.stable === true ? "안정 확인" : "안정 여부 미기록";
    return `<details><summary>#${capture.seq} · 사진 #${capture.sameSceneSeq || capture.shotSeq || capture.seq} · ${esc(outcome)}</summary><dl><dt>촬영 대상</dt><dd>${esc(target.id || target.tab || target.device || "미기록")} · ${esc(target.surface || "")}</dd><dt>주소</dt><dd>${esc(capture.url || "미기록")}</dd><dt>화면 크기</dt><dd>${esc(size.width || "?")} × ${esc(size.height || "?")} · 배율 ${esc(size.dpr || 1)}</dd><dt>기다린 시간</dt><dd>${esc(stability.waitedMs ?? "미기록")}ms</dd><dt>남은 확인</dt><dd>${esc(prose(stability.remaining) || "없음")}</dd></dl></details>`;
  }).join("")}</details></section>`;
}
