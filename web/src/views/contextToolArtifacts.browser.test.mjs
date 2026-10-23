import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startBrowserTestServer} from '../browserTestServer.mjs';

let chromium;
try { ({chromium} = createRequire(import.meta.url)(process.env.OPENBEAR_PLAYWRIGHT_MODULE || '/opt/openclaw/node_modules/playwright-core')); } catch {}
const path = 'contextManagement.toolResultArtifactTokens';
const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script>window.__OPENBEAR_AUTH_MODE__="controller";</script></head><body><div id="app"></div><script type="module" src="/@id/__x00__virtual:context-settings-test"></script></body></html>';
const entry = `import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import '/src/theme.js'; import 'element-plus/dist/index.css'; import '/src/style.css'; import '/src/admin-mobile.css'; import '/src/mobile-overlays.css'; import '/src/mobile-inputs.css'; import View from '/src/views/SettingsView.vue'; createApp(View).use(ElementPlus).mount('#app');`;

test('tool result setting real mobile/desktop light/dark layout and old-server save', {skip:!chromium, timeout:180000}, async t=>{
  // The shared fixture owns the Vite cache, including removal after an interrupted run.
  const fixture = await startBrowserTestServer(t, {name:'context-settings', entries:['virtual:context-settings-test'], warmupTimeoutMs:150000,
    plugins:[{name:'context-settings-test', resolveId(id){if(id==='virtual:context-settings-test')return '\0virtual:context-settings-test';},
      load(id){if(id==='\0virtual:context-settings-test')return entry;}, configureServer(server){server.middlewares.use((req,res,next)=>{
        if(req.url?.split('?')[0]==='/__test'){res.setHeader('content-type','text/html');res.end(html);}else next();
      });}}]});
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await fixture.close();}});
  const base=fixture.base;
  browser=await chromium.launch({executablePath:process.env.OPENBEAR_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  // The new setting row is checked at phone and desktop width, in light and dark
  // (the only theme assertion is its text/background contrast); the old-backend
  // save path does not depend on width or theme and runs once.
  for(const [width,theme,newBackend] of [[390,'light',true],[1280,'dark',true],[390,'light',false]]){
    await t.test(`${width}px ${theme} ${newBackend?'new':'old'} backend`, async t=>{
      const context=await browser.newContext({viewport:{width,height:844}});
      t.after(()=>context.close());
      await context.addInitScript(theme=>localStorage.setItem('openbear.theme.v1',theme),theme);
      const page=await context.newPage(), errors=[], calls=[];
      page.on('pageerror',e=>errors.push(e.message));
      const specs={'agent.compactRatio':{path:'agent.compactRatio',title:'压缩触发比例',desc:'模型未设置独立触发阈值时，按模型窗口的这个比例触发当前会话选择的压缩策略。',kind:'float',group:'compaction',effect:'下一轮生效',min:.1,max:.95}};
      const values={'agent.compactRatio':.7};
      if(newBackend){specs[path]={path,title:'工具结果落盘阈值',desc:'仅实际压缩时，把超过阈值的普通工具结果完整保存为文件，上下文保留路径和头尾预览，可用 Read 分段读取全文；包括最新未读结果。滑动窗口和模型摘要共用。默认 16000 token，0 关闭；用户要求、确认决策和 Agent 编排结论不落盘，未授权 Read 时保持原文。',kind:'int',group:'compaction',effect:'下一轮生效',min:0,unit:'token'};values[path]=16000;}
      await page.route('**/*',async route=>{
        const request=route.request(), url=new URL(request.url());
        if(url.origin!==base)return route.abort();
        if(!url.pathname.startsWith('/api/'))return route.continue();
        let data={ok:true},status=200;
        if(url.pathname==='/api/settings/specs')data={ok:true,domains:[{key:'agent',title:'Agent',sections:[{key:'compaction',title:'上下文压缩',paths:Object.keys(specs)}]}],specs};
        else if(url.pathname==='/api/settings')data={ok:true,values:{...values}};
        else if(url.pathname.startsWith('/api/settings/')&&request.method()==='PATCH'){
          const key=decodeURIComponent(url.pathname.slice('/api/settings/'.length)), body=request.postDataJSON();calls.push({path:key,...body});
          if(!specs[key]){status=400;data={ok:false,error:'未知设置项'};}else{values[key]=Number(body.value);data={ok:true,value:values[key]};}
        }else if(url.pathname==='/api/rath/options')data={ok:true,models:[]};
        await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      });
      await page.goto(base+'/__test');
      const title=newBackend?'工具结果落盘阈值':'压缩触发比例';
      const row=page.locator('.settings-row').filter({has:page.locator('h4',{hasText:title})});
      await row.waitFor();
      await row.locator('.value-pill').click();
      await row.locator('input').fill(newBackend?'0':'0.6');
      await row.locator('input').press('Enter');
      await row.locator('.value-pill').filter({hasText:newBackend?'关闭（0 token）':'0.6'}).waitFor();
      assert.equal(calls.length,1);
      assert.equal(calls[0].path,newBackend?path:'agent.compactRatio');
      if(!newBackend)assert.equal(await page.getByText('工具结果落盘阈值',{exact:true}).count(),0);
      const dimensions=await page.evaluate(()=>({width:innerWidth,body:document.body.scrollWidth,root:document.documentElement.scrollWidth}));
      assert.ok(dimensions.body<=width+1&&dimensions.root<=width+1,JSON.stringify(dimensions));
      const colors=await row.evaluate(el=>({background:getComputedStyle(el).backgroundColor,text:getComputedStyle(el.querySelector('p')).color}));
      assert.notEqual(colors.background,colors.text);
      assert.deepEqual(errors,[]);
    });
  }
});
