import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startBrowserTestServer} from './browserTestServer.mjs';
const require=createRequire(import.meta.url);
let chromium;
try {({chromium}=require(process.env.OPENBEAR_PLAYWRIGHT_MODULE || '/opt/openclaw/node_modules/playwright-core'));} catch {}
const folder=(id,parentId='',name=id)=>({kind:'folder',id,folderId:id,parentId,name,path:parentId?`项目 / ${name}`:name,conversationCount:3});
const folders=[folder('root','','项目'),folder('child','root','后台任务')];
const row=(id,extra={})=>({kind:'conversation',id,conversationUuid:id,title:id==='background'?'很长的后台会话名称，用来验证目录与手机待处理提示不会挤坏布局':'当前会话',folderId:id==='background'?'child':'root',parentId:id==='background'?'child':'root',path:id==='background'?'项目 / 后台任务':'项目',activityAtMs:1,activityVersion:1,activityReadVersion:1,running:false,activityState:'idle',...extra});
const pending=[{interactionId:'confirm-one',action:'confirm',expiresAtMs:Date.now()+3600000},{interactionId:'choose-two',action:'select',expiresAtMs:Date.now()+3600000},{interactionId:'questionnaire-three',action:'questionnaire',expiresAtMs:Date.now()+3600000}];
const entry=`import '/src/monaco-worker.js'; import '/src/theme.js'; import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import * as Icons from '@element-plus/icons-vue'; import 'element-plus/dist/index.css'; import 'element-plus/theme-chalk/dark/css-vars.css'; import '/src/style.css'; import '/src/dark-theme.css'; import '/src/admin-mobile.css'; import '/src/mobile-overlays.css'; import '/src/mobile-inputs.css'; import App from '/src/App.vue'; const app=createApp(App); app.use(ElementPlus); for(const [name,component] of Object.entries(Icons))app.component(name,component);app.mount('#app');`;
const html='<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.__OPENBEAR_AUTH_MODE__="controller"</script></head><body><div id="app"></div><script type="module" src="/@id/__x00__virtual:pending-test"></script></body></html>';

test('App shows background waiting work without recents/sidebar, navigates to exact form and clears realtime markers', {skip:!chromium,timeout:180000},async t=>{
  const fixture=await startBrowserTestServer(t,{name:'pending-conversations',entries:['virtual:pending-test'],plugins:[{
    name:'pending-test',resolveId(id){if(id==='virtual:pending-test')return '\0virtual:pending-test';},load(id){if(id==='\0virtual:pending-test')return entry;},
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/chat')){res.setHeader('content-type','text/html');res.end(html);}else next();});},
  }]});
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await fixture.close();}});
  browser=await chromium.launch({executablePath:process.env.OPENBEAR_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  // Desktop and the narrowest phone; 390px followed the same phone branches.
  for(const width of [1440,320]) await t.test(`${width}px`,async t=>{
    const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<761,isMobile:width<761});
    t.after(()=>context.close());
    const page=await context.newPage(),errors=[],writes=[];
    page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(30000);
    let waiting=true,eventsSocket,seq=1;
    const background=()=>row('background',{running:waiting,activityState:waiting?'waiting':'completed',activityPending:waiting?pending:[]});
    const status=()=>({items:waiting?[background()]:[],activityItems:waiting?[background()]:[],recentItems:[row('current')],folderConversationCounts:{root:2,child:1},folderRunningCounts:waiting?{root:1,child:1}:{},revision:Date.now()});
    const state=id=>({ok:true,conversationUuid:id,conversation:row(id),running:id==='background'&&waiting,messages:[],operations:[],usage:{},frameSeq:0});
    const forms=id=>id==='background'&&waiting?pending.map(request=>({confirmationId:request.interactionId,action:request.action,title:request.interactionId,body:'测试交互内容',options:['选项一','选项二'],questions:request.action==='questionnaire'?[{id:'q1',type:'open',question:'补充说明',required:true}]:[],createdAtMs:Date.now(),expiresAtMs:request.expiresAtMs})):[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{localStorage.setItem('openbear:conversation-sidebar-view','folders');localStorage.setItem('openbear.notifications.prompt.v1','dismissed');});
    await page.route('**/api/**',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname;
      if(request.method()!=='GET')writes.push(path);
      let data={ok:true,items:[]};
      if(path==='/api/conversation-tree/bootstrap')data={ok:true,rootFolders:[folders[0]],selected:{item:row('current'),folderPath:['root'],folderItems:[folders[0]]},initialExpandedPaths:[['root','child']],locatedFolders:folders,running:status(),activeCount:2,archivedCount:0,temporaryCount:0};
      else if(path==='/api/conversation-tree/children')data={ok:true,items:url.searchParams.get('parentId')==='root'?[folders[1],row('current')]:url.searchParams.get('parentId')==='child'?[background()]:[],hasMore:false};
      else if(path==='/api/conversation-tree/folders')data={ok:true,items:folders};
      else if(path==='/api/conversation-tree/status')data={ok:true,...status()};
      else if(path.includes('/conversation-tree/locate/')){const id=path.split('/').at(-1);data={ok:true,item:id==='background'?background():row(id),folderPath:id==='background'?['root','child']:['root'],folderItems:folders};}
      else if(/\/conversations\/[^/]+\/state$/.test(path))data=state(path.split('/')[3]);
      else if(path==='/api/rath/options')data={ok:true,models:[],agents:[]};
      else if(path==='/api/settings')data={ok:true,providerCount:1,values:{},revision:1};
      else if(path==='/api/auth/session')data={ok:true,authenticated:true,mode:'controller'};
      else if(path==='/api/system/version')data={ok:true,version:'test'};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.routeWebSocket('**/api/**',socket=>{
      const path=new URL(socket.url()).pathname;
      if(path==='/api/events/ws'){
        eventsSocket=socket;
        socket.send(JSON.stringify({type:'snapshot',epoch:'test',seq,items:[],includeArchived:false,treeStatus:status()}));
      }else{
        const match=path.match(/\/conversations\/([^/]+)\/ws/);
        if(match)socket.send(JSON.stringify({type:'bootstrap',pendingConfirmations:forms(match[1])}));
      }
      socket.onMessage(message=>{if(message==='ping')socket.send('pong');});
    });
    await page.goto(fixture.base+'/chat?id=current');
    await page.waitForFunction(()=>document.querySelector('.recent-waiting-count')?.textContent.includes('待处理 1'),{timeout:30000});
    await page.locator('[data-tree-id="root"] .tree-waiting-state').waitFor({state:'attached'});
    const phone=width<761;
    if(phone)assert.ok(await page.locator('.composer-shell').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight+1),'pending strip must not push the composer below the viewport');
    if(phone){
      assert.equal(await page.locator('#openbear-sidebar').evaluate(el=>el.classList.contains('is-open')),false);
      await page.locator('.mobile-pending-entry').click();
    }else{
      assert.equal(await page.locator('.mobile-pending-entry').isVisible(),false);
      await page.locator('.recent-waiting-count').click();
    }
    const panel=page.locator('.pending-conversations');
    await panel.waitFor({state:'visible'});
    assert.equal(await panel.locator('[data-pending-conversation]').count(),1);
    assert.equal(await panel.locator('[data-interaction-id]').count(),3);
    for(const dark of [false,true]){
      await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
      assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await panel.locator('[data-interaction-id="choose-two"]').click();
    await page.waitForURL('**/chat?id=background');
    await page.waitForFunction(()=>document.activeElement?.classList.contains('web-confirm-card')&&document.activeElement.dataset.interactionId==='choose-two');
    assert.equal(await page.locator('.web-confirm-card').count(),3);
    const questionnaire=page.locator('[data-questionnaire-id="questionnaire-three"]');
    await questionnaire.locator('textarea').fill('未提交的问卷回答');
    if(phone)await page.getByRole('button',{name:'打开导航',exact:true}).filter({visible:true}).click();
    if(phone)await page.locator('.sidebar-new-session').click();
    else {
      await page.getByRole('button',{name:'新建会话或目录',exact:true}).click();
      await page.getByRole('menuitem',{name:'新建临时会话',exact:true}).click();
    }
    await page.waitForURL(url=>url.searchParams.get('id')==='local:new');
    await page.waitForFunction(()=>document.querySelectorAll('.web-confirm-card').length===0);
    assert.equal(await page.locator('.recent-waiting-count').textContent(),'待处理 1');
    // The "new conversation" toast covers the phone title bar; it must not take the tap.
    if(phone)assert.equal(await page.locator('.el-message').first().evaluate(el=>getComputedStyle(el).pointerEvents),'none');
    await (phone?page.locator('.mobile-pending-entry'):page.locator('.recent-waiting-count')).click();
    await panel.locator('[data-interaction-id="questionnaire-three"]').click();
    await page.waitForURL('**/chat?id=background');
    await page.waitForFunction(()=>document.activeElement?.dataset.interactionId==='questionnaire-three');
    assert.equal(await questionnaire.locator('textarea').inputValue(),'未提交的问卷回答');
    assert.equal(await page.locator('.web-confirm-card').count(),3);
    assert.equal(await page.locator('.recent-waiting-count').textContent(),'待处理 1');
    if(phone)await page.getByRole('button',{name:'打开导航',exact:true}).filter({visible:true}).click();
    assert.equal(await page.locator('[data-tree-id="background"] .tree-waiting-state').textContent(),'待确认 · 3项');
    assert.equal(await page.locator('[data-tree-id="background"] .running-leaf').count(),0);
    await page.locator('[data-tree-id="root"] .tree-chevron').click();
    assert.equal(await page.locator('[data-tree-id="root"] .tree-waiting-state').textContent(),'待处理 1');
    if(phone)await page.locator('.app-sidebar-backdrop').click({position:{x:width-8,y:100}});
    await (phone?page.locator('.mobile-pending-entry'):page.locator('.recent-waiting-count')).click();
    await panel.waitFor({state:'visible'});
    if(phone){
      await panel.locator('.pending-header').click({position:{x:40,y:20}});
      const box=await panel.locator('.pending-header').boundingBox();
      const cdp=await context.newCDPSession(page);
      const touch=(y)=>[{x:box.x+40,y:box.y+y,id:1}];
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touch(20)});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touch(75)});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touch(135)});
      assert.ok(await panel.evaluate(el=>el.classList.contains('is-dragging')),'header drag is captured after the enter animation');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await cdp.detach();
    }else await page.keyboard.press('Escape');
    await panel.waitFor({state:'hidden'});
    waiting=false;
    eventsSocket.send(JSON.stringify({type:'patch',epoch:'test',previousSeq:seq,seq:++seq,upserts:[],removed:[],treeStatus:status()}));
    await page.waitForFunction(()=>document.querySelector('.recent-waiting-count')?.textContent==='待处理 0');
    assert.equal(await page.locator('.mobile-pending-entry').count(),0);
    assert.equal(await page.locator('.tree-waiting-state').count(),0);
    assert.ok(!writes.some(path=>path.endsWith('/answer')||path.endsWith('/send')));
    assert.deepEqual(errors,[]);
  });
});
