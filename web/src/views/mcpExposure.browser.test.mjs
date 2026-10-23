import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startBrowserTestServer, waitForBrowserReady} from '../browserTestServer.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({chromium} = require(process.env.OPENBEAR_PLAYWRIGHT_MODULE || '/opt/openclaw/node_modules/playwright-core')); } catch {}
const html = '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/@id/__x00__virtual:mcp-test"></script></body></html>';
const entry = `import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import '/src/theme.js'; import 'element-plus/dist/index.css'; import '/src/style.css'; import '/src/admin-mobile.css'; import '/src/mobile-overlays.css'; import '/src/mobile-inputs.css'; const component=(await import('/src/views/McpView.vue')).default; createApp(component).use(ElementPlus).mount('#app');`;

function fixture(legacy = false) {
  return {ok:true,enabled:true,settingsAvailable:true,agentAccessAvailable:false,
    ...(!legacy ? {toolSelectionAvailable:true,thresholds:{toolCount:30,definitionBytes:65536}} : {}),
    servers:[{key:'rea',name:'REA',enabled:true,transport:'stdio',status:legacy?'connected':'awaiting_confirmation',approval:'ask',
      toolCount:legacy?170:0,visibleTools:legacy?170:0,totalTools:170,enabledTools:170,definitionBytes:599952,disabledTools:[],agentAccess:{mode:'disabled',tools:[]}}],
    tools:Array.from({length:170},(_,i)=>({serverKey:'rea',publicName:`mcp__rea__read_${i}`,originalToolName:`read_${i}_${'very_long_name_'.repeat(4)}`,description:`读取工具 ${i} 的简短说明。${'需要展开的详细说明。'.repeat(20)}`,definitionBytes:3500,enabled:true,filtered:!legacy,filterReason:legacy?'allowed':'awaiting_confirmation',parameters:[]})),prompts:[]};
}

test('MCP search, batch selection, budget gate and old backend fallback on phone/desktop', {skip:!chromium,timeout:180000}, async t => {
  const server = await startBrowserTestServer(t,{name:'mcp-exposure',entries:['virtual:mcp-test','/src/views/McpView.vue'],plugins:[{name:'mcp-test-entry',resolveId(id){if(id==='virtual:mcp-test') return '\0virtual:mcp-test';},load(id){if(id==='\0virtual:mcp-test') return entry;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/__test')){res.setHeader('content-type','text/html');res.end(html);}else next();});}}]});
  const browser = await chromium.launch({executablePath:process.env.OPENBEAR_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  t.after(async()=>{await browser.close();await server.close();});
  // Phone and desktop layout. McpView's html.dark rules only recolour, and no
  // assertion after toggling the dark class checked colour or theme, so the
  // theme axis is not repeated.
  for (const width of [320,1280]) {
    await t.test(`${width}px tool selection and cancellation`, async()=>{
      const context = await browser.newContext({viewport:{width,height:844}});
      const page = await context.newPage(), errors=[], writes=[];
      const status=fixture();
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/api/**', async route=>{
        const path=new URL(route.request().url()).pathname,method=route.request().method(),body=route.request().postDataJSON();
        let data={ok:true},code=200;
        if(path==='/api/mcp/status') data=status;
        else if(path==='/api/settings/specs') data={ok:true,groups:[{key:'mcp',paths:['mcp.installDir','mcp.toolCountThreshold','mcp.definitionSizeThresholdKB']}]};
        else if(method!=='GET') {
          writes.push({path,body});
          const count=170-(body?.disabledTools?.length || 0);
          if(count>30 && !body?.exposureConfirmations){code=409;data={ok:false,error:'mcp_exposure_confirmation_required',confirmationText:'当前已启用 170 / 170 个工具，定义 599,952 字节，数量阈值 30、体积阈值 64 KB。每次请求固定占用约 149,988 tokens，可以停用部分工具。',exposureConfirmations:[{server:'rea',fingerprint:'fixture'}]};}
          else if(body?.disabledTools){status.servers[0].disabledTools=body.disabledTools;status.servers[0].enabledTools=count;status.servers[0].definitionBytes=count?count*3500+count+1:0;status.servers[0].status='connected';status.tools.forEach(tool=>{tool.filtered=body.disabledTools.includes(tool.originalToolName);tool.filterReason=tool.filtered?'tool_disabled':'allowed';});}
        }
        await route.fulfill({status:code,contentType:'application/json',body:JSON.stringify(data)});
      });
      await page.goto(server.base+'/__test');
      await waitForBrowserReady(page,page.locator('.mcp-card'),errors);
      await page.getByRole('button',{name:'查看详情 →',exact:true}).click();
      const section=page.getByRole('region',{name:'工具启停'});
      await section.waitFor();
      assert.equal(await section.locator('.mcp-selection-row').count(),170);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.ok(await section.locator('.el-switch').first().evaluate(el=>el.getBoundingClientRect().height>=44));
      await section.getByLabel('搜索工具',{exact:true}).fill('read_169_');
      assert.equal(await section.locator('.mcp-selection-row').count(),1);
      await section.getByLabel('搜索工具',{exact:true}).fill('');
      await section.getByRole('button',{name:'全不选',exact:true}).click();
      assert.ok((await section.innerText()).includes('已启用 0 / 170'));
      await section.getByRole('button',{name:'保存工具启停',exact:true}).click();
      await page.getByText('工具启停已保存，新回合生效',{exact:true}).last().waitFor();
      await section.getByRole('button',{name:'全选',exact:true}).click();
      await section.getByRole('button',{name:'保存工具启停',exact:true}).click();
      await page.locator('.mcp-exposure-confirmation').waitFor();
      assert.ok((await page.locator('.mcp-exposure-confirmation').innerText()).includes('149,988 tokens'));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      const before=writes.length;
      await page.getByRole('button',{name:'先调整工具',exact:true}).click();
      await page.waitForTimeout(100);
      assert.equal(writes.length,before);
      await section.getByRole('button',{name:'保存工具启停',exact:true}).click();
      await page.getByRole('button',{name:'确认启用',exact:true}).click();
      await page.getByText('工具启停已保存，新回合生效',{exact:true}).last().waitFor();
      assert.deepEqual(writes.at(-1).body.exposureConfirmations,[{server:'rea',fingerprint:'fixture'}]);
      assert.deepEqual(errors,[]);
      await context.close();
    });
  }
  await t.test('older backend still supports its original MCP switches without calling new APIs', async()=>{
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),calls=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname;calls.push(path);
      await route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/api/mcp/status'?fixture(true):path==='/api/settings/specs'?{ok:true,groups:[{key:'mcp',paths:['mcp.installDir']}]}:{ok:true})});
    });
    await page.goto(server.base+'/__test');await waitForBrowserReady(page,page.locator('.mcp-card'),errors);
    await page.getByRole('button',{name:'查看详情 →',exact:true}).click();
    assert.equal(await page.getByRole('region',{name:'工具启停'}).count(),0);
    await page.locator('.mcp-drawer .el-switch').first().click();
    await page.waitForTimeout(100);
    assert.ok(calls.includes('/api/mcp/servers/rea/enabled'));
    assert.ok(!calls.some(p=>p.endsWith('/tools')||p.endsWith('/confirm-exposure')));
    assert.deepEqual(errors,[]);await context.close();
  });
});
