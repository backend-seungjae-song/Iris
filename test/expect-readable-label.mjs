import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const { createInspectCommands } = createRequire(import.meta.url)('../native/electron/cdp-cmd-inspect.cjs');
const el = (tag, text, attrs = {}) => ({ tagName: tag, innerText: text, textContent: text, getAttribute: (k) => attrs[k] || null });
async function run(elements, args = {}, ids = {}) {
  let capture;
  const handlers = createInspectCommands({ webContentsMod: () => ({}), cdpExecRaw: async (_mod, _id, _cmd, a) => { capture = a; return { path: '/fixture/shot.png' }; } });
  const send = { all: async (_cmd, a) => [{ result: { value: vm.runInNewContext(a.expression, { __acQA: () => elements, document: { getElementById: (id) => ids[id] } }) } }] };
  const result = await handlers.expect(send, { id: 1, getURL: () => 'file:///fixture.html' }, { sel: '#opaque .x:not([hidden])', ...args });
  return { result, capture };
}
test('visible button name replaces CSS only in image annotation', async () => {
  const { result, capture } = await run([el('BUTTON', '다음 증거')]);
  assert.equal(result.pass, true);
  assert.match(result.expected, /#opaque/);
  assert.match(capture.mark[0].label, /버튼 ‘다음 증거’/);
  assert.doesNotMatch(capture.caption, /#opaque|:not/);
  assert.equal(capture.mark[0].sel, '#opaque .x:not([hidden])');
});
test('matching element gets its own accessible name and index', async () => {
  const { result, capture } = await run([el('BUTTON', '취소'), el('BUTTON', '저장', { 'aria-label': '변경 저장' })], { text: '저장', mode: 'equals' });
  assert.equal(result.pass, true);
  assert.equal(capture.mark[0].nth, 1);
  assert.match(capture.caption, /변경 저장.*2곳 중 2번째/);
});
test('labelledby is read and whitespace normalized', async () => {
  const { result } = await run([el('INPUT', '', { 'aria-labelledby': 'name help' })], {}, { name: { textContent: ' 배송\n주소 ' }, help: { textContent: '필수' } });
  assert.equal(result.element, '입력칸 ‘배송 주소 필수’');
});
test('failure stays failure with readable condition and exact raw expected', async () => {
  const { result, capture } = await run([el('SPAN', '저장 실패')], { text: '저장 완료', mode: 'contains' });
  assert.equal(result.pass, false);
  assert.equal(result.got, '저장 실패');
  assert.match(capture.caption, /^안 됨.*저장 완료/);
  assert.match(result.expected, /#opaque/);
});
test('missing elements keep absent and exists judgments without invented names', async () => {
  for (const mode of ['exists', 'absent']) {
    const { result, capture } = await run([], { mode });
    assert.equal(result.pass, mode === 'absent');
    assert.equal(result.element, null);
    assert.equal(capture.mark.length, 0);
    assert.match(capture.caption, /지정한 화면 요소.*요소 없음/);
  }
});
test('text absence uses actual matching element on failure', async () => {
  const { result, capture } = await run([el('DIV', '정상'), el('DIV', '오류 발생')], { mode: 'absent', text: '오류' });
  assert.equal(result.pass, false);
  assert.equal(capture.mark[0].nth, 1);
  assert.match(capture.caption, /오류 발생/);
});
test('image alt and unnamed fallback never use selector as a label', async () => {
  assert.equal((await run([el('IMG', '', { alt: '주문 완료 화면' })])).result.element, '이미지 ‘주문 완료 화면’');
  assert.equal((await run([el('DIV', '')])).result.element, '이름 없는 화면 요소');
});
