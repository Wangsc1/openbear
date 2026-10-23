import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startBrowserTestServer} from './browserTestServer.mjs';
const require=createRequire(import.meta.url);
let chromium;
try {({chromium}=require(process.env.OPENBEAR_PLAYWRIGHT_MODULE || '/opt/openclaw/node_modules/playwright-core'));} catch {}
const entry=`import '/src/monaco-worker.js'; import '/src/theme.js'; import {createApp,h} from 'vue'; import ElementPlus from 'element-plus'; import * as Icons from '@element-plus/icons-vue'; import 'element-plus/dist/index.css'; import 'element-plus/theme-chalk/dark/css-vars.css'; import '/src/style.css'; import '/src/dark-theme.css'; import '/src/mobile-inputs.css'; import ConsoleView from '/src/views/consoleView/ConsoleView.vue'; window.createdConversations=[]; const app=createApp({render:()=>h(ConsoleView,{conversationUuid:'original',onConversationCreated:id=>window.createdConversations.push(id)})}); app.use(ElementPlus); for(const [name,component] of Object.entries(Icons))app.component(name,component);app.mount('#app');`;
const html='<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.__OPENBEAR_AUTH_MODE__="controller"</script></head><body><div id="app"></div><script type="module" src="/@id/__x00__virtual:model-switch-test"></script></body></html>';
const model=(key,protocol)=>({key,id:key.split('/')[1],provider:key.split('/')[0],label:key.split('/')[1],protocol,thinkingLevels:['low','high'],defaultThinkingLevel:'low',contextWindow:128000});
const oldModel=model('source/gpt','responses'), newModel=model('target/claude','anthropic');
const runConfig=model=>({conversationUuid:'original',model,contextStrategy:'sliding_window',thinkingLevel:'low',effectiveThinkingLevel:'low',thinkingLevels:['low','high'],defaultThinkingLevel:'low',supportsThinking:true,fastMode:false,fastRequested:false,fastSupported:false,effectiveFastMode:false,agentRunConfig:{model:'',thinkLevel:'',fastMode:null,effective:{model,thinkLevel:'low',fastMode:false}},contextWindow:128000,rolloverTriggerTokens:89600,windowTriggerRatio:0.7});

test('model menu switches the original conversation without creating another, including missing channels and active runs', {skip:!chromium,timeout:180000}, async t=>{
  const fixture=await startBrowserTestServer(t,{name:'model-switch',entries:['virtual:model-switch-test'],plugins:[{
    name:'model-switch-test',resolveId(id){if(id==='virtual:model-switch-test')return '\0virtual:model-switch-test';},load(id){if(id==='\0virtual:model-switch-test')return entry;},
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/__model-test')){res.setHeader('content-type','text/html');res.end(html);}else next();});},
  }]});
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await fixture.close();}});
  browser=await chromium.launch({executablePath:process.env.OPENBEAR_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  // The switch menu itself runs at every width; the server-side branches
  // (deleted source model, active run, failed save) do not depend on width.
  const cases=[[1440,'idle'],[390,'idle'],[320,'idle'],[390,'source-deleted'],[390,'running'],[390,'failed-save']];
  for(const [width,scenario] of cases) await t.test(`${width}px ${scenario}`,async t=>{
    const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<761,isMobile:width<761,colorScheme:width===320?'dark':'light'});
    t.after(()=>context.close());
    const page=await context.newPage(),errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(30000);
    let selected=oldModel.key;
    const running=scenario==='running';
    await page.route('**/api/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      let data={ok:true,items:[]},status=200;
      if(req.method()!=='GET')writes.push({path,body:req.postDataJSON()});
      if(path==='/api/rath/options')data={ok:true,models:scenario==='source-deleted'?[newModel]:[oldModel,newModel],primaryModel:newModel.key,agents:[]};
      else if(path==='/api/conversations/original/state')data={ok:true,...runConfig(selected),running,messages:[{role:'user',content:'原会话的任务要求',turnUuid:'original-turn'},{role:'assistant',content:'原会话已经完成的结果',turnUuid:'original-turn'}],operations:[],usage:{},frameSeq:0,conversation:{conversationUuid:'original',title:'保留这个会话'}};
      else if(path==='/api/conversations/original/model'){
        if(scenario==='failed-save'&&writes.length===1){status=503;data={ok:false,error:'model_save_unavailable'};}
        else{selected=req.postDataJSON().model;data={ok:true,model:selected,nextRun:running,runConfig:runConfig(selected)};}
      }
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.routeWebSocket('**/api/**',socket=>{socket.send(JSON.stringify({type:'bootstrap',pendingConfirmations:[]}));socket.onMessage(message=>{if(message==='ping')socket.send('pong');});});
    await page.goto(fixture.base+'/__model-test');
    await page.getByText('原会话已经完成的结果',{exact:true}).waitFor({timeout:30000});
    await page.getByRole('button',{name:'运行配置',exact:true}).click();
    await page.getByRole('button',{name:'claude（target/claude）',exact:true}).click();
    if(scenario==='failed-save'){
      await page.locator('.el-message--error').waitFor();
      assert.match(await page.locator('.run-config-chip-model').innerText(),/gpt/);
      assert.equal(await page.locator('.el-message--success').count(),0);
      assert.equal(await page.locator('.el-message-box').count(),0);
      await page.getByRole('button',{name:'运行配置',exact:true}).click();
      await page.getByRole('button',{name:'claude（target/claude）',exact:true}).click();
    }
    await page.waitForFunction(()=>document.querySelector('.run-config-chip-model')?.textContent.includes('claude'));
    const message=page.locator('.el-message--success');
    await message.waitFor();
    assert.match(await message.innerText(),running?/下一轮运行生效/:/已切换模型/);
    assert.equal(await page.getByText('原会话已经完成的结果',{exact:true}).count(),1);
    assert.equal(await page.getByText('原会话的任务要求',{exact:true}).count(),1);
    assert.deepEqual(writes,Array.from({length:scenario==='failed-save'?2:1},()=>({path:'/api/conversations/original/model',body:{model:'target/claude'}})));
    assert.deepEqual(await page.evaluate(()=>window.createdConversations),[]);
    assert.equal(await page.locator('.el-message-box').count(),0);
    assert.deepEqual(errors,[]);
  });
});
