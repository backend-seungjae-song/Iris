import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { devCommand } from '../scripts/run-dev.mjs';
import { developmentCommands, documentMatchesEnvironment } from '../bin/smoke/sections/two-flows.mjs';

const scripts = JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).scripts;
const doc = fs.readFileSync(new URL('../docs/two-flows.md',import.meta.url),'utf8');
const home = path.resolve('fixture-home');

test('실제 개발 실행기의 macOS·Windows 환경을 검사한다', () => {
  const commands = developmentCommands(scripts,{home});
  assert.equal(commands.length,8);
  assert.equal(commands.find((item)=>item.platform==='darwin'&&item.name==='dev:seed').env.IRIS_PORT,'4271');
  assert.equal(commands.find((item)=>item.platform==='win32'&&item.name==='dev:seed').env.IRIS_PORT,'4291');
});

for (const platform of ['darwin','win32']) for (const field of ['IRIS_PORT','PORT','IRIS_STATE_DIR']) {
  test(`${platform} 개발 ${field}에 설치본 값을 넣으면 실패한다`, () => {
    const command = (mode,options) => {
      const result=devCommand(mode,options);
      if (options.platform===platform&&mode==='server') result.env[field]=field==='IRIS_STATE_DIR'?path.join(home,'.iris'):'4271';
      return result;
    };
    assert.throws(()=>developmentCommands(scripts,{command,home}), /개발 상태 폴더|개발 포트|서버 포트/);
  });
}

test('package의 dev 명령이 다른 모드에 연결되면 실패한다', () => {
  assert.throws(()=>developmentCommands({...scripts,dev:'node scripts/run-dev.mjs seed'},{home}),/실행기 연결/);
});

test('문서의 개발·설치 칸은 실행기와 기본 서버 값에 각각 맞아야 한다', () => {
  const environment={devPort:'4291',appPort:'4271',devState:'.iris-dev',appState:'.iris'};
  assert.equal(documentMatchesEnvironment(doc,environment),true);
  for(const changed of [
    doc.replace('| 포트 | 4291 | 4271 |','| 포트 | 4271 | 4291 |'),
    doc.replace('| 상태·증거 | `~/.iris-dev/` | `~/.iris/` |','| 상태·증거 | `~/.iris/` | `~/.iris-dev/` |'),
    doc.replace('| 상태·증거 | `~/.iris-dev/` | `~/.iris/` |','| 상태·증거 | `~/.iris-dev/` | |'),
  ]) assert.throws(()=>documentMatchesEnvironment(changed,environment),/코드와 다릅니다/);
});
