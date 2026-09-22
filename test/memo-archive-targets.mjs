import assert from "node:assert/strict";
import test from "node:test";

import { appendMemoArchiveBlock } from "../server/memo-note-archive.js";

test("중앙·로컬·공유 메모는 같은 장부 객체의 정확한 범위에 이름과 함께 쌓인다", () => {
  const archives = {};
  const base = { date: "2026-08-06", at: 1_786_000_000_000, clock: "14:30" };

  assert.equal(appendMemoArchiveBlock(archives, {
    ...base, space: "folder:k", text: "중앙", requestId: "archive-central", id: "block-central",
  }).changed, true);
  assert.equal(appendMemoArchiveBlock(archives, {
    ...base, space: "folder:k", text: "로컬", name: "조사", requestId: "archive-local", id: "block-local",
  }).changed, true);
  assert.equal(appendMemoArchiveBlock(archives, {
    ...base, space: "__shared__", text: "공유", requestId: "archive-shared", id: "block-shared",
  }).changed, true);

  assert.deepEqual(archives["folder:k"][0].blocks.map((b) => [b.name || "", b.text]), [
    ["", "중앙"], ["조사", "로컬"],
  ]);
  assert.deepEqual(archives.__shared__[0].blocks.map((b) => b.text), ["공유"]);
});

test("같은 보관 requestId는 reload와 날짜 경계를 지나도 중복 블록을 만들지 않는다", () => {
  const archives = {};
  appendMemoArchiveBlock(archives, {
    space: "folder:k", date: "2026-08-06", at: 1, clock: "23:59", text: "한 번",
    requestId: "same-request", id: "block-one",
  });
  const reloaded = JSON.parse(JSON.stringify(archives));
  const retry = appendMemoArchiveBlock(reloaded, {
    space: "folder:k", date: "2026-08-07", at: 2, clock: "00:00", text: "한 번",
    requestId: "same-request", id: "block-two",
  });

  assert.equal(retry.changed, false);
  assert.equal(Object.values(reloaded).flatMap((entries) => entries).flatMap((entry) => entry.blocks).length, 1);
});

