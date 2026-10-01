import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { headlessLaunchOptions } from '../bin/headless-browser.cjs';
import { linkedWorktrees, handleGit, gitStatusRich } from '../server/git-handlers.js';
import { replace } from '../server/runtime-state.js';
const root = path.resolve('web');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding:'utf8' });

test('외부 워크트리의 서로 다른 변경을 비교하고 허용 경로를 지킨다', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-scm-')));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const main = path.join(dir, 'main'), other = path.join(dir, 'other tree');
  fs.mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'base'); git(main, 'add', '.');
  git(main, '-c', 'user.name=test', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git(main, 'worktree', 'add', '-qb', 'topic', other);
  fs.writeFileSync(path.join(other, 'topic.txt'), 'topic'); git(other, 'add', '.');
  git(other, '-c', 'user.name=test', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'topic');
  assert.deepEqual(linkedWorktrees(main), [main, other]);
  assert.deepEqual(linkedWorktrees(other), [main, other]);

  const messages = [], ws = { send: (raw) => messages.push(JSON.parse(raw)) };
  replace({ allowedRoots:[main] }); handleGit(ws, { type:'git.repos', path:main });
  assert.deepEqual(messages[0].worktrees, [main]);
  assert.deepEqual(gitStatusRich(main).worktrees, [{ root:main, branch:'main' }, { root:null, branch:'topic' }]);
  replace({ allowedRoots:[dir] }); handleGit(ws, { type:'git.repos', path:main });
  assert.deepEqual(messages[1].worktrees, [main, other]);
  assert.deepEqual(gitStatusRich(main).worktrees, [{ root:main, branch:'main' }, { root:other, branch:'topic' }]);
  handleGit(ws, { type:'git.branchDiff', path:other, base:'main', mode:'committed' });
  assert.equal(messages[2].files[0].rel, 'topic.txt');
  handleGit(ws, { type:'git.branchDiff', path:main, base:'topic', mode:'committed' });
  assert.equal(messages[3].files.length, 0);
});

test('패널 버튼·워크트리별 파일 클릭·PR Markdown과 끝까지 스크롤', async (t) => {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = await puppeteer.launch(headlessLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.evaluate(async () => {
    const sc = await import('/js/devtool/source-control.js');
    const md = await import('/js/core/markdown.js');
    const pr = await import('/js/github-pr/view.js'); md.initMarkdown({ esc:pr.esc });
    document.body.className = 'sc-active';
    document.body.innerHTML = `<aside class="sc-panel" style="height:600px">${sc.panelHtml}</aside><div class="center-body" style="position:absolute;left:240px;top:0;width:600px;height:400px"><div class="githubprview" id="githubprview"></div></div>`;
    window.sent = []; window.opened = []; window.scFolder="/repo"; window.scSpaces=[{id:"space",folder:"/repo"}];
    const candidates = sc.scCandidatesOf('space', [{ id:'space', folder:'/repo' }],
      [{ workspaceId:'space', cwd:'/unrelated' }], '/repo', [], ['/outside/topic']);
    if (candidates.map(c => c.dir).join(',') !== '/repo,/outside/topic') throw new Error('워크트리 후보 경계 오류');
    const receive = sc.handleSourceControlMessage;
    sc.initSourceControl({ $:s => document.querySelector(s), esc:pr.esc, wsSend:m => window.sent.push(m),
      getCurrentAgent:() => ({ cwd:window.scFolder, workspaceId:'space' }), spaceRootFor:() => window.scFolder, getSelectedSpaceId:() => 'space',
      getSpaces:() => window.scSpaces, getLastAgents:() => [], openDiff:(file, opts) => window.opened.push({ file, opts }) });
    receive({ type:'git-repos', path:'/repo', repos:[], worktrees:['/repo', '/outside/topic'] });
    for (const root of ['/repo', '/outside/topic']) receive({ type:'git-status', path:root, root, isRepo:true,
      branch:root === '/repo' ? 'main' : 'topic', branches:['main','topic','free','blocked'], base:'main', staged:[], changes:[],
      worktrees:[{ root:'/repo', branch:'main' }, { root:'/outside/topic', branch:'topic' }, { root:null, branch:'blocked' }] });
    window.branchResponses = () => {
      for (const root of ['/repo','/outside/topic']) receive({ type:'git-branch-diff', root, mode:'committed', base:'main', bases:['main'],
        files:[{ rel:root === '/repo' ? 'main.txt':'topic.txt', abs:root + '/file.txt', code:'M' }] });
    };
    const input = { root:'/repo', number:1, title:'PR', state:'OPEN', head:'topic', base:'main', author:'a',
      body:'# 제목\n\n**강조**\n\n- 항목\n\n<script>window.unsafe=true</script>\n\n' + '문단\n\n'.repeat(100),
      comments:[{ body:'`댓글 코드`', author:'b', createdAt:'2026-09-30' }], reviews:[], checks:[], files:[] };
    pr.renderGithubPrView({ pr:input }, { host:document.querySelector('#githubprview'), onRefresh:()=>{}, onOpenUrl:()=>{}, onLog:()=>{}, onDraft:()=>{} });
  });
  for (const width of [272, 220]) {
    await page.$eval('.sc-panel', (el, width) => el.style.width = width + 'px', width);
    assert.equal(await page.$$eval('.sc-view', buttons => buttons.every(b => b.scrollWidth <= b.clientWidth)), true);
  }
  await page.click('[data-view="base"]'); await page.evaluate(() => window.branchResponses());
  assert.equal(await page.$$eval('.sc-repo', rows => rows.length), 1, '같은 저장소의 워크트리는 한 섹션으로 묶는다');
  await page.click('#sc-branch-dd .cc-dd-trigger');
  await page.click('#sc-branch-dd [data-value="/outside/topic"]');
  await page.click('[data-root="/outside/topic"] .sc-file');
  assert.deepEqual(await page.evaluate(() => window.opened[0].opts), { root:'/outside/topic', rel:'topic.txt', untracked:false, mode:'committed', base:'main', oldRel:'' });
  await page.click('#sc-branch-dd .cc-dd-trigger');
  await page.click('#sc-branch-dd [data-value="/outside/topic"]');
  assert.equal(await page.$eval('#sc-branch-dd .cc-dd-value', el => el.textContent), 'topic');
  assert.equal(await page.$eval('.sc-repo', el => el.dataset.root), '/outside/topic');
  assert.equal(await page.evaluate(() => window.sent.some(m => m.type === 'git.checkout')), false);
  assert.equal(await page.evaluate(() => window.sent.at(-1).path), '/outside/topic');
  await page.click('#sc-branch-dd .cc-dd-trigger');
  await page.click('#sc-branch-dd [data-value="/repo"]');
  assert.equal(await page.$eval('.sc-repo', el => el.dataset.root), '/repo');
  await page.click('#sc-branch-dd .cc-dd-trigger');
  await page.click('#sc-branch-dd [data-value="branch:blocked"]');
  assert.equal(await page.evaluate(() => window.sent.some(m => m.type === 'git.checkout')), false);
  await page.click('#sc-branch-dd .cc-dd-trigger');
  await page.click('#sc-branch-dd [data-value="branch:free"]');
  assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type:'git.checkout', path:'/repo', expectRoot:'/repo', branch:'free' });
  await page.evaluate(async () => {
    const sc = await import('/js/devtool/source-control.js');
    document.querySelector('.sc-view[data-view="local"]').click();
    window.scFolder='/collection';window.scSpaces=[{id:'space',folder:window.scFolder}];
    const roots=['admin','server','client'].map(name=>'/collection/marblewalk-'+name);
    const linked=['admin','server','client'].map(name=>'/collection/.working/sample-task/worktrees/'+name);
    sc.handleSourceControlMessage({type:'git-repos',path:'/collection',repos:roots,worktrees:linked});
    window.multiStatuses=[];
    for(let i=0;i<roots.length;i++)for(const root of [roots[i],linked[i]]) {
      const status={type:'git-status',path:root,root,isRepo:true,branch:root===roots[i]?'feat/daily-quest':'feat/onboarding-renewal',
        branches:['feat/daily-quest','feat/onboarding-renewal'],base:'main',staged:[],changes:[{rel:'a.txt',abs:root+'/a.txt',code:'M'}],
        worktrees:[{root:roots[i],branch:'feat/daily-quest'},{root:linked[i],branch:'feat/onboarding-renewal'}]};
      window.multiStatuses.push(status);sc.handleSourceControlMessage(status);
    }
  });
  assert.equal(await page.$$eval('.sc-commit-row',els=>els.every(e=>e.scrollWidth<=e.clientWidth)),true,'220px에서도 커밋 버튼이 넘치지 않는다');
  assert.equal(await page.$$eval('.sc-repo',els=>els.length),3,'원본과 온보딩의 여섯 경로를 세 저장소로 묶는다');
  await page.click('#sc-branch-dd .cc-dd-trigger');await page.click('#sc-branch-dd [data-value="group:sample-task"]');
  assert.equal(await page.$$eval('.sc-repo',els=>els.every(e=>e.dataset.root.includes('/worktrees/'))),true,'공통 선택이 세 저장소에 적용된다');
  assert.equal(await page.$eval('#sc-branch-row',e=>e.hidden),false);
  for (const width of [220,272]) {
    await page.$eval('.sc-panel',(e,w)=>e.style.width=w+'px',width);
    assert.equal(await page.$eval('#sc-branch-dd .cc-dd-trigger',e=>e.getBoundingClientRect().height),28,'상단 선택기 높이를 유지한다');
    await page.$eval('#sc-branch-dd .cc-dd-value',e=>e.textContent='아주-긴-워크트리-이름-'.repeat(8));
    assert.equal(await page.$eval('#sc-branch-row',e=>e.scrollWidth<=e.clientWidth),true,'긴 선택 이름이 패널을 벗어나지 않는다');
    assert.equal(await page.$eval('#sc-branch-dd .cc-dd-trigger',e=>{const r=e.getBoundingClientRect(),c=e.querySelector('svg').getBoundingClientRect();return c.right<=r.right&&c.top>=r.top&&c.bottom<=r.bottom;}),true,'화살표가 트리거 안에 남는다');
  }

  if (process.env.IRIS_TEST_ARTIFACT_DIR) await (await page.$('.sc-panel')).screenshot({path:path.join(process.env.IRIS_TEST_ARTIFACT_DIR,'scm-common.png')});
  await page.click('#sc-individual');
  assert.equal(await page.$$eval('.sc-worktree-slot .cc-dd-trigger',els=>els.length),3);
  assert.equal(await page.$$eval('.sc-worktree-slot .cc-dd-trigger',els=>els.every(e=>e.getBoundingClientRect().height===28)),true,'기존 선택기 높이를 유지한다');
  assert.equal(await page.$$eval('.sc-repo-head .sc-repo-branch',els=>els.length),3,'기존 저장소 헤더에 브랜치를 유지한다');
  assert.equal(await page.$$eval('.sc-worktree-branch',els=>els.length),0,'브랜치 표시 줄을 추가하지 않는다');
  const primary='/collection/marblewalk-admin';
  await page.evaluate(async()=>{const sc=await import('/js/devtool/source-control.js');for(const status of window.multiStatuses.filter(s=>s.root.endsWith('/admin') || s.root.endsWith('/marblewalk-admin')))sc.handleSourceControlMessage({...status,changes:[]});});
  await page.click(`[data-primary="${primary}"] .cc-dd-trigger`);
  assert.equal(await page.$$eval('.sc-worktree-slot .cc-dd.open .cc-dd-item',els=>els.every(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})),true,'선택 메뉴의 모든 항목이 다음 저장소 헤더 위에서 클릭된다');
  await page.click(`[data-primary="${primary}"] [data-value="${primary}"]`);
  const rootsNow=await page.$$eval('.sc-repo',els=>els.map(e=>e.dataset.root));
  if (process.env.IRIS_TEST_ARTIFACT_DIR) await (await page.$('.sc-panel')).screenshot({path:path.join(process.env.IRIS_TEST_ARTIFACT_DIR,'scm-individual.png')});
  assert.ok(rootsNow.includes(primary));assert.equal(rootsNow.filter(root=>root.includes('/worktrees/')).length,2,'admin만 바뀌고 server·client는 유지한다');
  await page.evaluate(async()=>{const sc=await import('/js/devtool/source-control.js');for(const status of window.multiStatuses)sc.handleSourceControlMessage(status)});
  assert.deepEqual(await page.$$eval('.sc-repo',els=>els.map(e=>e.dataset.root)),rootsNow,'상태 새로고침이 저장소별 선택을 덮지 않는다');
  await page.click(`[data-primary="${primary}"] .cc-dd-trigger`);
  await page.click(`[data-primary="${primary}"] [data-value="/collection/.working/sample-task/worktrees/admin"]`);
  await page.click('#sc-common');assert.equal(await page.$eval('#sc-branch-row',e=>e.hidden),false);
  assert.equal(await page.evaluate(()=>window.sent.filter(m=>m.type==='git.checkout').length),1,'워크트리 조회는 추가 checkout을 하지 않는다');
  assert.equal(await page.$eval('.gpr-markdown h1', el => el.textContent), '제목');
  assert.equal(await page.$eval('.gpr-markdown strong', el => el.textContent), '강조');
  assert.equal(await page.$eval('.gpr-event code', el => el.textContent), '댓글 코드');
  assert.equal(await page.evaluate(() => !!window.unsafe || !!document.querySelector('.gpr-markdown script')), false);
  await page.hover('.gpr-page'); await page.mouse.wheel({ deltaY:100000 });
  await page.waitForFunction(() => { const p = document.querySelector('.gpr-page'); return p.scrollTop > 0 && p.scrollTop + p.clientHeight >= p.scrollHeight - 1; });
  await page.evaluate(async () => {
    const boot = await import('/js/github-pr/boot.js');
    const diff = await import('/js/devtool/diff.js');
    const editor = await import('/js/center/text-editor.js');
    const tabs = await import('/js/center/tab-store.js');
    const views = await import('/js/core/tab-views.js');
    const hooks = await import('/js/core/hooks.js');
    const pr = await import('/js/github-pr/view.js');
    document.querySelector('.center-body').insertAdjacentHTML('beforeend','<div class="diffview" id="diffview"></div>');
    const anchor = document.createElement('div');document.body.append(anchor);
    tabs.ensureTabSpace('space');tabs.setCenterSpace('space');
    const show = () => {
      const tab = tabs.getTabs('space').find(t => t.id === tabs.getActiveTabId('space'));
      document.querySelector('#githubprview').style.display = tab?.kind === 'pullrequest' ? '' : 'none';
      document.querySelector('#diffview').style.display = tab?.kind === 'diff' ? '' : 'none';
      if (tab?.kind === 'diff') diff.renderDiffView(tab);else views.tabViewOf(tab.kind).render(tab);
    };
    diff.initDiff({ $:s => document.querySelector(s),esc:pr.esc,wsSend:m => window.sent.push(m),
      getSelectedSpaceId:() => 'space',renderTabs:()=>{},showActiveTab:show,ensureMonacoLib:editor.ensureMonacoLib,monacoTheme:editor.monacoTheme });
    hooks.provide('git.openPatchDiff',diff.openPatchDiff);
    const capability=boot.initCapability({wsSend:m=>window.sent.push(m),wsIsOpen:()=>true,
      getSelectedSpaceId:()=> 'space',renderTabs:()=>{},showActiveTab:show});
    hooks.callHook('githubpr.branch',{row:anchor,root:'/repo',branch:'topic',spaceId:'space'});
    const req=window.sent.at(-1);
    const input={root:'/repo',branch:'topic',number:7,title:'PR diff',state:'OPEN',head:'topic',base:'main',author:'a',body:'',
      comments:[],reviews:[],checks:[],files:[{path:'src/main.js',additions:1,deletions:1}]};
    capability.ws['githubpr-status']({requestId:req.requestId,ok:true,pr:input});
    window.diffCapability=capability;
  });
  await page.click('.gpr-branch-open');
  await page.click('[data-gpr-section="files"]');
  await page.click('[data-gpr-file="src/main.js"]');
  const request = await page.evaluate(() => window.sent.at(-1));
  assert.equal(request.type, 'githubpr.diff');assert.equal(request.file,'src/main.js');assert.equal(request.number,7);
  assert.equal(await page.$eval('#diffview .dv-empty', e => e.textContent), '불러오는 중…', '응답 전에 diff 탭을 열어 클릭 결과를 표시한다');
  assert.equal(await page.$eval('#diffview', e => getComputedStyle(e).display !== 'none'), true);
  await page.evaluate(req => window.diffCapability.ws['githubpr-diff']({requestId:req.requestId,ok:true,root:'/repo',number:7,file:'src/main.js',
    sha:'abc',base:'main',patch:'@@ -1 +1 @@\n-const old = 1;\n+const next = 2;'}),request);
  await page.waitForSelector('#diffview .dv-body.hl');
  if (process.env.IRIS_TEST_ARTIFACT_DIR) await (await page.$('#diffview')).screenshot({path:path.join(process.env.IRIS_TEST_ARTIFACT_DIR,'pr-diff.png')});
  assert.equal(await page.$eval('#diffview .del .dp',e=>e.textContent),'-');
  assert.equal(await page.$eval('#diffview .add .dp',e=>e.textContent),'+');
  assert.equal(await page.$eval('#diffview .del .dn',e=>e.textContent),'1');
  assert.equal(await page.$eval('#diffview .add .dn',e=>e.textContent),'1');
  assert.ok(await page.$$eval('#diffview .dt [class*="mtk"]',els=>els.length)>0,'실제 Monaco 코드 토큰을 표시한다');
  assert.notEqual(await page.$eval('#diffview .add',e=>getComputedStyle(e).backgroundColor),await page.$eval('#diffview .del',e=>getComputedStyle(e).backgroundColor));
  assert.equal(await page.evaluate(()=>window.sent.some(m=>m.type==='git.diff')),false,'PR patch를 로컬 diff로 다시 요청하지 않는다');
  const clickFile = async () => {
    await page.click('.gpr-branch-open');
    await page.click('[data-gpr-file="src/main.js"]');
    return page.evaluate(() => window.sent.at(-1));
  };
  const failedRequest = await clickFile();
  await page.evaluate(req => window.diffCapability.ws['githubpr-diff']({ requestId:req.requestId, ok:false,
    error:{message:'GitHub 요청 실패 <test>'} }), failedRequest);
  assert.equal(await page.$eval('#diffview [role="alert"]',e=>e.textContent),'GitHub 요청 실패 <test>','실패를 보이는 diff 탭 안에 표시한다');
  const staleRequest = await clickFile();
  const latestRequest = await clickFile();
  const reply = (req, patch) => page.evaluate(({req,patch}) => window.diffCapability.ws['githubpr-diff']({requestId:req.requestId,ok:true,patch}), {req,patch});
  await reply(staleRequest,'@@ -1 +1 @@\n-old\n+stale');
  assert.equal(await page.$eval('#diffview .dv-empty',e=>e.textContent),'불러오는 중…','이전 요청이 새 요청을 덮지 않는다');
  await page.click('.gpr-branch-open');
  await reply(latestRequest,'@@ -1 +1 @@\n-old\n+latest');
  assert.equal(await page.$eval('#githubprview',e=>getComputedStyle(e).display !== 'none'),true,'응답이 현재 PR 탭에서 포커스를 빼앗지 않는다');
  const saved = await page.evaluate(async()=>{
    const tabs=await import('/js/center/tab-store.js');
    return tabs.getTabs('space').filter(t=>t.kind==='diff').map(t=>({patch:t.patch,error:t.error}));
  });
  assert.deepEqual(saved,[{patch:'@@ -1 +1 @@\n-old\n+latest',error:''}],'다른 탭을 보는 동안에도 결과를 저장한다');
  const closedRequest = await clickFile();
  await page.evaluate(async()=>{
    const tabs=await import('/js/center/tab-store.js');
    const tab=tabs.getTabs('space').find(t=>t.kind==='diff');tabs.removeTab('space',tab);
  });
  await page.click('.gpr-branch-open');
  await reply(closedRequest,'@@ -1 +1 @@\n-old\n+closed');
  assert.equal(await page.evaluate(async()=>{const tabs=await import('/js/center/tab-store.js');return tabs.getTabs('space').filter(t=>t.kind==='diff').length;}),0,'닫힌 탭을 늦은 응답이 다시 열지 않는다');


});
