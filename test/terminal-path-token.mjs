import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("web/js/panel/xterm-wiring.js", "utf8");
const match = source.match(/function terminalBarePathToken\(raw\) \{[\s\S]*?\n\}/);
assert.ok(match, "terminalBarePathToken helper must exist");

const context = {};
vm.runInNewContext(`${match[0]}\nthis.terminalBarePathToken = terminalBarePathToken;`, context);
const token = context.terminalBarePathToken;

// 픽스처가 검사하는 것은 형태다. 긴 경로, 날짜가 붙은 작업 폴더, 하이픈이 섞인 한글 파일명,
// 확장자 뒤에 붙은 조사를 본다. 실제 업무 산출물 이름을 쓰면 공개본에 그 이름이 그대로
// 포함되어 작업 내역이 드러나므로, 형태만 남기고 내용은 바꾼다.
const actual = "/Users/you/Projects/Acme/shop/out/20260806-1231-report-review/reports/분기-정리-최종-목록-20260806.xlsx를";
const expected = "/Users/you/Projects/Acme/shop/out/20260806-1231-report-review/reports/분기-정리-최종-목록-20260806.xlsx";
assert.equal(token(actual), expected, "확장자 뒤 목적격 조사 `를`은 경로에서 분리해야 한다");

assert.equal(token("/Users/you/프로젝트/보고서.pdf에서"), "/Users/you/프로젝트/보고서.pdf");
assert.equal(token("docs/한글/안내.md로"), "docs/한글/안내.md");
assert.equal(token("docs/한글/안내.md를"), "docs/한글/안내.md");

assert.equal(token("/Users/you/프로젝트/보고서를-검토한.xlsx"), "/Users/you/프로젝트/보고서를-검토한.xlsx", "파일명 안의 조사는 보존해야 한다");
assert.equal(token("/Users/you/프로젝트/안내.xlsx"), "/Users/you/프로젝트/안내.xlsx", "조사가 없는 한글 파일명은 보존해야 한다");
assert.equal(token("/Users/you/프로젝트/보고서를"), "/Users/you/프로젝트/보고서를", "확장자가 없으면 실제 파일명일 수 있으므로 보존해야 한다");

console.log("terminal path token tests passed");
