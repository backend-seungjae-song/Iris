import assert from "node:assert/strict";
import test from "node:test";
import { createSourceControlFeature } from "../server/remote/features/source-control.js";
import { isErrorCode } from "../server/remote/contract/errors.js";

const REF = "a".repeat(32);

function feature(errorCode) {
  return createSourceControlFeature({
    agents: { resolve: () => ({ source: { cwd: "/tmp/repo" }, status: "idle" }) },
    githubAvailable: true,
    githubHandler: async (ws) => ws.send(JSON.stringify({ ok: false, error: { code: errorCode } })),
    runtimeSnapshot: () => ({ workspaces: [] }),
    getHerdr: () => ({}),
  });
}

test("packet 64 GitHub 실패 사유를 source feature가 보존한다", async () => {
  for (const code of ["auth_required", "no_pr", "no_remote", "not_github", "timeout"]) {
    const result = await feature(code).pr(REF);
    assert.deepEqual(result, { ok: false, code });
    assert.equal(isErrorCode(code), true);
  }
});

test("packet 64 gh 설치 여부만 GitHub capability를 결정한다", () => {
  assert.equal(feature("auth_required").githubAvailable(), true);
});

test('packet64 로그인 실패와 무관하게 설치된 gh만 capability에 반영', () => {
  for (const [executable, expected] of [['/not-executed/gh', true], [null, false]]) {
    const source = createSourceControlFeature({ agents: {}, githubExecutable: executable });
    assert.equal(source.githubAvailable(), expected);
  }
});

test('packet64 GitHub 등록 요청과 operation이 사유별 오류 응답을 생성', async () => {
  const { installFeatureOperations } = await import('../server/remote/ops/features.js');
  const { hasRemoteRequestType, isRemoteRequest } = await import('../server/remote/contract/requests.js');
  for (const code of ['auth_required', 'no_pr', 'no_remote', 'not_github', 'timeout', 'unrecognized-private-code']) {
    const table = new Map();
    installFeatureOperations(table, { terminal: {}, browser: {}, source: feature(code) });
    for (const type of ['github.pr', 'github.check.log']) {
      const request = { type, rid: 'r1', agent: REF, ...(type.endsWith('log') ? { run: '123' } : {}) };
      assert.equal(hasRemoteRequestType(request), true); assert.equal(isRemoteRequest(request), true);
      assert.deepEqual(await table.get(type)({}, request), {
        type: 'error', rid: 'r1', error: { code: code === 'unrecognized-private-code' ? 'unavailable' : code },
      });
    }
  }
});
