import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
const { headlessLaunchOptions } = createRequire(import.meta.url)('../bin/headless-browser.cjs');

test('워크트리 계층에서 세션 추가·이름 변경·접기와 스페이스 전체 워크트리 생성을 조작한다', async () => {
  const server = createServer((req, res) => {
    try {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
      res.end(readFileSync(new URL('../web' + req.url, import.meta.url)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch(headlessLaunchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({width:1100,height:800,deviceScaleFactor:2});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const css=['00-tokens','01-base','01c-components','10-sidebar','19-terminal','38-worktrees'].map(name=>readFileSync(new URL(`../web/css/${name}.css`,import.meta.url),'utf8')).join('\n');
    await page.setContent(`<style>${css}</style><aside class="sidebar" style="height:760px"><div class="sidebar-head"><span class="conn on"></span><span class="brand">Iris</span></div><div class="panel-head"><span class="panel-title">Spaces · Agents</span></div><div class="panel-body" id="space-list"></div></aside><div id="file-tree"></div><div id="ctxmenu" class="ctxmenu" hidden></div>`);
    await page.evaluate(async () => {
      const { initTree, renderSpaces } = await import('/js/explorer/tree.js');
      const { initContextMenu } = await import('/js/explorer/context-menu.js');
      const { initAgents } = await import('/js/herdr/agents.js');
      const { replaceHerdrState } = await import('/js/herdr/state.js');
      const { initCapability } = await import('/js/worktrees/boot.js');
      window.spaces = [{ id: 'owner', folder: '/repo', label: 'repo' }];
      window.sent = []; window.local = true; window.selected = 'agent'; window.toasts = [];
      const esc = value => String(value).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
      const ctx = { $: s => document.querySelector(s), esc, cssEsc: CSS.escape, wsSend: msg => sent.push(msg),
        orderedSpaces: () => spaces, getIsLocal: () => local, getSelectedSpaceId: () => 'owner',
        showToast: message => toasts.push(message), focusSpace() {}, saveCollapsed() {}, syncWatchDirs() {}, getActiveFile: () => null,
        getCurTarget: () => selected, spk: String, selectSession: pane => { selected = pane; }, copyText: async () => true,
        collapsed: { dirs: new Set(), groups: new Set() }, dirCache: new Map(), renderSpaces };
      initTree(ctx); initAgents(ctx); initContextMenu(ctx);
      window.shellPaneCount = count => {
        replaceHerdrState({ workspaces: spaces, agents: [{ paneId:'agent', sessionUuid:'session', workspaceId:'owner', tabId:'tab', agent:'codex', status:'working', tabLabel:'검색 구현', cwd:'/repo-wt/topic' }], tabs:{owner:[{tabId:'tab'},{tabId:'shell-tab',label:'터미널',paneCount:count}]} });
      };
      shellPaneCount(1);
      const { ws } = initCapability(ctx); window.ws = ws; window.render = renderSpaces;
      const request = sent.find(msg => msg.type === 'worktrees.list');
      const item = { path:'/repo-wt/topic', branch:'feat/topic', managed:true, users:[], running:[], change:{uncommitted:0} };
      ws['worktrees.result']({ requestId: request.requestId, ok:true, repo:'/repo', primary:'/repo', panes:[{paneId:'shell',workspaceId:'owner',tabId:'shell-tab',cwd:'/repo-wt/topic'}], branches:['main'], entries:[{path:'/repo',primary:true,branch:'main'}, item, {...item,path:'/repo-wt/unused',branch:'fix/unused'}] });
      window.nested = () => {
        spaces = [{id:'owner',folder:'/alias/multi',label:'marblewalk'}];
        replaceHerdrState({workspaces:spaces, agents:[{paneId:'agent',tabLabel:'일일 퀘스트 검토',sessionUuid:'session',workspaceId:'owner',tabId:'tab',agent:'codex',status:'working',cwd:'/multi'}],tabs:{owner:[{tabId:'tab'}]}});
        renderSpaces();
        const req = sent.findLast(msg => msg.type === 'worktrees.list');
        ws['worktrees.result']({requestId:req.requestId,ok:true,repo:'/multi',primary:null,entries:[],repositories:['client','server','admin'].map(name=>({repo:'/multi/'+name,primary:'/multi/'+name,branches:['main'],entries:[{path:'/multi/'+name,primary:true,branch:'main'}, {...item,path:'/multi/.working/task/'+name,taskUsers:[{paneId:'agent',sessionUuid:'session'}]}]}))});
      };

    });
    const group = path => `.wt-group[data-wt-path="${path}"]`;
    const topic=group('/repo-wt/topic');
    const terminal=`${topic} .wt-terminal-session`;
    assert.equal(await page.$$eval(`${topic} [data-target="agent"]`,els=>els.length),1);
    const alignment=await page.evaluate(topic=>{
      const group=document.querySelector(topic);
      const agent=group.querySelector('[data-target="agent"]');
      const terminal=group.querySelector('.wt-terminal-session');
      return {agentName:agent.querySelector('.srow-name').getBoundingClientRect().left,
        terminalName:terminal.querySelector('.srow-name').getBoundingClientRect().left,
        agentMark:agent.querySelector('.srow-mark').getBoundingClientRect().right,
        terminalMark:terminal.querySelector('.srow-mark').getBoundingClientRect().right,
        spaceArrow:document.querySelector('.space-tog .i').getAttribute('viewBox'),
        worktreeArrow:group.querySelector('.wt-caret .i').getAttribute('viewBox'),
        openArrow:getComputedStyle(group.querySelector('.wt-caret')).transform};
    },topic);
    assert.equal(alignment.terminalName,alignment.agentName);
    assert.equal(alignment.terminalMark,alignment.agentMark);
    assert.equal(alignment.worktreeArrow,alignment.spaceArrow);
    assert.equal(alignment.openArrow,'matrix(0, 1, -1, 0, 0, 0)');
    await page.click(terminal);
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'tab-focus',tabId:'shell-tab',origin:'sidebar'});
    await page.click(terminal,{button:'right'});
    await page.locator('::-p-text(터미널 닫기)').click();
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'tab-close',tabId:'shell-tab'});
    assert.equal(await page.evaluate(()=>selected),'agent');
    for (const [local,paneCount] of [[false,1],[true,2]]) {
      await page.evaluate(({local:next,paneCount})=>{local=next;shellPaneCount(paneCount);render();},{local,paneCount});
      await page.click(terminal,{button:'right'});
      assert.equal(await page.$eval('#ctxmenu .ci',el=>el.classList.contains('disabled')),true);
      const before=await page.evaluate(()=>sent.length);
      await page.click('#ctxmenu .ci');
      assert.equal(await page.evaluate(()=>sent.length),before);
    }
    await page.evaluate(()=>{local=true;shellPaneCount(1);render();});
    for (const [label, launch] of [['새 터미널',''], ['새 Codex 세션','codex'], ['새 Claude 세션','claude']]) {
      await page.click(`${topic} [data-worktree-action="group-add"]`);
      await page.locator('::-p-text(' + label + ')').click();
      assert.deepEqual(await page.evaluate(() => sent.at(-1)), {type:'tab.create',workspaceId:'owner',cwd:'/repo-wt/topic',launch});
      assert.equal(await page.evaluate(()=>selected),'agent','추가 메뉴가 기존 세션 선택을 바꾸지 않는다');
    }
    assert.equal(await page.$(group('/repo-wt/unused')),null,'안 쓰는 worktree 는 접힌 묶음 안');
    await page.click('[data-worktree-action="idle-toggle"]');
    await page.click(`${group('/repo-wt/unused')} [data-worktree-action="group-add"]`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'tab.create',workspaceId:'owner',cwd:'/repo-wt/unused',launch:'codex'});
    await page.click(`${topic} [data-worktree-action="group-toggle"]`);
    assert.equal(await page.$(`${topic} [data-target="agent"]`),null);
    assert.equal(await page.$eval(`${topic} .wt-caret`,el=>getComputedStyle(el).transform),'none');
    await page.click(`${topic} [data-worktree-action="group-add"]`);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#ctxmenu',el=>el.hidden),true);
    await page.click(`${topic} [data-worktree-action="group-toggle"]`);
    await page.click(`${topic} [data-worktree-action="group-menu"]`);
    await page.locator('::-p-text(표시 이름 바꾸기)').click();
    await page.type('.askwrap input','검색 개선');
    await page.click('.askwrap button.primary');
    const rename=await page.evaluate(()=>sent.at(-1));
    assert.equal(rename.type,'worktrees.rename');
    assert.equal(rename.path,'/repo-wt/topic');
    assert.equal(rename.label,'검색 개선');
    await page.evaluate(rename=>ws['worktrees.result']({requestId:rename.requestId,ok:true,repo:'/repo',primary:'/repo',entries:[{path:'/repo',primary:true,branch:'main'},{path:'/repo-wt/topic',branch:'feat/topic',label:rename.label,users:[],running:[],managed:true}]}),rename);
    assert.equal(await page.$eval(`${topic} .wt-group-name`,el=>el.textContent),'검색 개선');
    assert.equal(await page.$eval(`${topic} .wt-loc-branch`,el=>el.textContent),'feat/topic');
    // 삭제가 막힌 이유를 메뉴 이름에 보인다
    await page.click(`${topic} [data-worktree-action="group-menu"]`);
    await page.locator('::-p-text(새로고침)').click();
    await page.evaluate(()=>{const req=sent.findLast(msg=>msg.type==='worktrees.list');ws['worktrees.result']({requestId:req.requestId,ok:true,repo:'/repo',primary:'/repo',entries:[{path:'/repo',primary:true,branch:'main'},
      {path:'/repo-wt/topic',branch:'feat/topic',users:[],running:[],managed:false},{path:'/repo-wt/unused',branch:'fix/unused',users:[],running:[],managed:true,change:{uncommitted:2}}]});});
    for (const [path,label] of [['/repo-wt/topic','worktree 삭제 (Iris 에서 만든 것만)'],['/repo-wt/unused','worktree 삭제 (커밋하지 않은 변경 있음)']]) {
      await page.click(`${group(path)} [data-worktree-action="group-menu"]`);
      assert.deepEqual(await page.$eval('#ctxmenu .ci:last-child',el=>[el.textContent,el.classList.contains('disabled')]),[label,true]);
      await page.keyboard.press('Escape');
    }
    if (process.env.IRIS_WORKTREE_SCREENSHOTS) {
      mkdirSync(process.env.IRIS_WORKTREE_SCREENSHOTS,{recursive:true});
      await page.evaluate(()=>document.fonts.ready);
      await page.screenshot({path:process.env.IRIS_WORKTREE_SCREENSHOTS+'/hierarchy-single.png',clip:{x:0,y:0,width:340,height:650}});
    }
    await page.evaluate(() => nested());
    const task=group('/multi/.working/task');
    assert.equal(await page.$$eval(`${task} [data-target="agent"]`,els=>els.length),1);
    await page.click(`${task} [data-worktree-action="group-add"]`);
    await page.locator('::-p-text(새 Codex 세션)').click();
    assert.deepEqual(await page.evaluate(() => sent.at(-1)), {type:'tab.create',workspaceId:'owner',cwd:'/multi/.working/task',launch:'codex'});
    assert.equal(await page.$$eval('.wt-repositories, [data-worktree-action="repositories-toggle"]',els=>els.length),0);
    assert.equal(await page.$eval(task,el=>/저장소 \d+개/.test(el.textContent)),false);
    await page.click(`${task} [data-worktree-action="group-menu"]`);
    await page.locator('::-p-text(저장소별 작업)').click();
    await page.locator('#ctxmenu .ci:nth-child(2)').click();
    await page.locator('::-p-text(새 터미널)').click();
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'tab.create',workspaceId:'owner',cwd:'/multi/.working/task/server',launch:''});
    await page.click(`${task} [data-worktree-action="group-menu"]`);
    await page.locator('::-p-text(표시 이름 바꾸기)').click();
    await page.type('.askwrap input','일일 퀘스트');
    await page.click('.askwrap button.primary');
    const nestedRename=await page.evaluate(()=>sent.at(-1));
    assert.equal(nestedRename.repo,'/multi/client');
    assert.equal(nestedRename.groupPath,'/multi/.working/task');
    await page.evaluate(req=>ws['worktrees.result']({requestId:req.requestId,ok:true,repo:req.repo,primary:req.repo,entries:[{path:req.repo,primary:true,branch:'main'},{path:req.path,groupLabel:req.label,branch:'feat/topic',users:[],running:[],taskUsers:[{paneId:'agent',sessionUuid:'session'}]}]}),nestedRename);
    assert.equal(await page.$eval(`${task} .wt-group-name`,el=>el.textContent),'일일 퀘스트');
    if (process.env.IRIS_WORKTREE_SCREENSHOTS) {
      mkdirSync(process.env.IRIS_WORKTREE_SCREENSHOTS,{recursive:true});
      await page.evaluate(()=>document.fonts.ready);
      await page.screenshot({path:process.env.IRIS_WORKTREE_SCREENSHOTS+'/hierarchy-multi.png',clip:{x:0,y:0,width:340,height:650}});
      await page.click(`${task} [data-worktree-action="group-add"]`);
      await page.screenshot({path:process.env.IRIS_WORKTREE_SCREENSHOTS+'/hierarchy-menu.png',clip:{x:0,y:0,width:470,height:650}});
      await page.keyboard.press('Escape');
    }
    await page.click('.space-row[data-space="owner"]', {button:'right'});
    await page.locator('#ctxmenu ::-p-text(새 worktree)').click();
    assert.deepEqual(errors, []);
    await page.waitForSelector('.wt-dialog .wt-name', {visible:true});
    assert.equal(await page.$eval('.wt-dialog .asknote',el=>el.textContent),'/multi');
    await page.type('.wt-dialog .wt-name','dialog-task');
    await page.click('.wt-dialog [data-wt-dialog="create"]');
    const dialogCreate=await page.evaluate(()=>sent.at(-1));
    assert.equal(dialogCreate.type,'worktrees.create');
    assert.equal(dialogCreate.repo,'/multi');
    assert.equal(dialogCreate.base,'');
    assert.equal(dialogCreate.branch,'feat/dialog-task');
    await page.evaluate(req=>ws['worktrees.result']({requestId:req.requestId,ok:false,message:'검사용 충돌'}),dialogCreate);
    await page.click('[data-worktree-action="compose"]');
    await page.type('.wt-compose-input','new-one');
    await page.keyboard.press('Enter');
    const create=await page.evaluate(()=>sent.at(-1));
    assert.equal(create.type,'worktrees.create');
    assert.equal(create.repo,'/multi');
    assert.equal(create.base,'');
    await page.evaluate(req=>ws['worktrees.result']({requestId:req.requestId,ok:true,repo:req.repo,spaceCwd:'/multi/.working/new-one',entries:[],repositories:['client','server','admin'].map(name=>({repo:'/multi/'+name,primary:'/multi/'+name,branches:['main','feat/new-one'],entries:[{path:'/multi/'+name,primary:true,branch:'main'},{path:'/multi/.working/new-one/worktrees/'+name,branch:'feat/new-one',users:[],running:[]}]}))}),create);
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'tab.create',workspaceId:'owner',cwd:'/multi/.working/new-one',launch:''});
    assert.equal(await page.$$eval('.wt-group[data-wt-path="/multi/.working/new-one"]',els=>els.length),1);
    assert.equal(await page.$$eval('.wt-meta[role="status"]',els=>els.length),0);
    await page.click('[data-worktree-action="compose"]');
    await page.type('.wt-compose-input','next-task');
    await page.keyboard.press('Enter');
    const nextCreate=await page.evaluate(()=>sent.at(-1));
    assert.equal(nextCreate.type,'worktrees.create');
    assert.equal(nextCreate.name,'next-task');
    assert.equal(nextCreate.repo,'/multi');
    await page.evaluate(req=>ws['worktrees.result']({requestId:req.requestId,ok:false,message:'검사용 충돌'}),nextCreate);

    assert.equal(await page.evaluate(()=>sent.filter(message=>message.type==='space.create').length),0);
    await page.evaluate(() => { local = false; render(); });
    assert.equal(await page.$$eval('[data-worktree-action="group-add"], [data-worktree-action="sessions"]',els=>els.length),0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
