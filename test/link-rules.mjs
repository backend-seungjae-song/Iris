import assert from "node:assert/strict";
import test from "node:test";
import { describeLinkPattern, linkRuleForPageTab, matchLinkRule, parseLinkPattern } from "../web/js/browser/link-rules.js";

test("붙여 넣은 전체 주소도 규칙 모양으로 바꾼다", () => {
  const cases = [
    ["git.example", "git.example"],
    ["https://www.Git.example/acme/repo/?tab=1#readme", "git.example/acme/repo"],
    ["*.issues.example", "issues.example"],
    ["http://user@localhost:3000/app/", "localhost/app"],
    ["notes.example/", "notes.example"],
  ];
  for (const [input, pattern] of cases) assert.equal(parseLinkPattern(input).pattern, pattern, input);
});

test("알아볼 수 없는 입력은 이유와 함께 거절한다", () => {
  for (const input of ["", "   ", "git hub.com", "https://", "a_b.com", "x".repeat(400) + ".com"]) {
    const r = parseLinkPattern(input);
    assert.equal(r.ok, false, input);
    assert.ok(r.error);
  }
});

test("도메인 규칙은 하위 도메인까지, 경로 규칙은 그 경로와 그 아래만", () => {
  const rules = [{ pattern: "git.example", profile: "p" }, { pattern: "git.example/acme", profile: "w" }];
  assert.equal(matchLinkRule("https://gist.git.example/x", rules).profile, "p");
  assert.equal(matchLinkRule("https://www.git.example/acme/repo", rules).profile, "w");
  assert.equal(matchLinkRule("https://git.example/acme", rules).profile, "w");
  assert.equal(matchLinkRule("https://git.example/acmex", rules).profile, "p");
  assert.equal(matchLinkRule("https://notgit.example/", rules), null);
  assert.equal(matchLinkRule("mailto:a@example.com", rules), null);
  assert.equal(matchLinkRule("not a url", rules), null);
});

test("가장 구체적인 규칙이 이긴다(목록 순서와 무관)", () => {
  const rules = [{ pattern: "issues.example", profile: "a" }, { pattern: "acme.issues.example", profile: "b" }];
  assert.equal(matchLinkRule("https://acme.issues.example/jira", rules).profile, "b");
  assert.equal(matchLinkRule("https://acme.issues.example/jira", [...rules].reverse()).profile, "b");
});

test("페이지가 연 새 탭: 다른 규칙 주소로 가면 규칙 계정, 같은 규칙 안이면 원래 탭 계정", () => {
  const rules = [{ pattern: "figma.com/design/example", profile: "dev" }, { pattern: "issues.example", profile: "jira" }];
  // Figma 파일 목록에서 연 디자인 파일
  assert.equal(linkRuleForPageTab("https://www.figma.com/design/example/x?node-id=1", "https://www.figma.com/files/team/1/recents", rules).profile, "dev");
  // Jira 에서 연 Figma 링크
  assert.equal(linkRuleForPageTab("https://figma.com/design/example/x", "https://acme.issues.example/browse/A-1", rules).profile, "dev");
  // Jira 안의 다른 Jira 페이지는 원래 탭 계정
  assert.equal(linkRuleForPageTab("https://acme.issues.example/wiki/x", "https://acme.issues.example/browse/A-1", rules), null);
  // 규칙 없는 주소, 원래 탭을 모를 때
  assert.equal(linkRuleForPageTab("https://example.com/", "https://acme.issues.example/", rules), null);
  assert.equal(linkRuleForPageTab("https://acme.issues.example/", "", rules).profile, "jira");
});

test("범위 설명", () => {
  assert.equal(describeLinkPattern("git.example"), "git.example 전체(하위 도메인 포함)");
  assert.equal(describeLinkPattern("git.example/acme"), "git.example/acme 아래 주소 전체");
});
