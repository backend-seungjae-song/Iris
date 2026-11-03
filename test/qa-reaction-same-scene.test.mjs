// 같은 화면 증거 장면의 촬영 원본 재사용
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordQaReaction } from "../server/qa-reaction.js";

test("sameSceneId 장면은 먼저 저장된 장면의 사본으로 기록한다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-same-scene-"));
  const source = path.join(dir, "qa-mobile-end.png");
  fs.writeFileSync(source, "png");
  const saved = new Map(), events = [];
  // qa-channel append 순서: 원본을 회차 폴더에 복사한 뒤 원본 삭제
  const append = async (_run, event) => {
    const seq = events.length + 1;
    const copy = path.join(dir, `${seq}.png`);
    fs.writeFileSync(copy, fs.readFileSync(event.shot));
    if (event.shot === source) fs.unlinkSync(source);
    saved.set(seq, copy); events.push(event);
    return { seq, event: { shot: copy } };
  };
  const end = { id: "end", path: source, claim: { kind: "S3", description: "기대 시간 종료" } };
  const result = { candidates: [{ id: "k1", code: "K1", description: "기대 효과 미관찰", sceneId: "proof" }],
    scenes: [end, { ...end, id: "proof", sameSceneId: "end", claim: { kind: "S4", description: "기대 효과 미관찰", candidateId: "k1" } }] };
  const out = await recordQaReaction({ runId: "r", accepted: { seq: 7 }, stamp: {}, mode: "agent_action", surface: "d",
    result, append, savePath: (_run, receipt) => receipt.event.shot });
  assert.equal(out.scenes.length, 2);
  assert.equal(events[1].sameSceneSeq, 1);
  assert.equal(events[1].shot, saved.get(1));
  assert.equal(out.candidates[0].sceneSeq, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
