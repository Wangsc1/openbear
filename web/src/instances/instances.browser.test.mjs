import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserTestServer, waitForBrowserReady} from '../browserTestServer.mjs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({chromium} = require(process.env.OPENBEAR_PLAYWRIGHT_MODULE || '/opt/openclaw/node_modules/playwright-core')); } catch {}
const fixture = () => ({id:'child-a',name:'实例甲',status:'ready',healthStatus:'healthy',serverId:'srv-1',port:18970,managementUrl:'http://192.0.2.10:18970',workspacePath:'/opt/openbear/instances/' + 'long-alpha-account-'.repeat(3),models:{mode:'copy',primary:'parent/model'},account:{username:'alpha'},gateway:{status:'synced',revision:1,appliedRevision:1},notifications:{loginSuccess:false,loginFailure:true,health:true},createdAtMs:10,updatedAtMs:20,lastSeenAtMs:Date.now()-60000,lastLoginSuccessAtMs:Date.now()-3600000,lastHealthAtMs:Date.now()-120000});
const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/@id/__x00__virtual:instance-test"></script></body></html>';
const entry = `import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import * as Icons from '@element-plus/icons-vue'; import '/src/theme.js'; import 'element-plus/dist/index.css'; import '/src/style.css'; import '/src/admin-mobile.css'; import '/src/mobile-overlays.css'; import '/src/mobile-inputs.css';
const view = window.__view;
if (['settings','sessions'].includes(view)) await (await import('/src/authMode.js')).loadAuthMode();
const component = view === 'login' || location.pathname === '/login' ? (await import('/src/views/LoginView.vue')).default : view === 'app' ? (await import('/src/App.vue')).default : view === 'settings' ? (await import('/src/views/SettingsHubView.vue')).default : view === 'sessions' ? (await import('/src/views/SessionsView.vue')).default : (await import('/src/views/InstancesView.vue')).default;
window.__opened=[]; window.__folders=[]; const app=createApp(component, {section:'system-settings','onOpen-conversation': id => window.__opened.push(id),'onOpen-folder': id => window.__folders.push(id)}); app.use(ElementPlus); for (const [key,icon] of Object.entries(Icons)) app.component(key,icon); app.mount('#app');`;

// Real Chromium layout, real Vue SFCs and axios. Only HTTP endpoints are fixtures;
// no online backend, model call, Docker host or production dist is touched.
test('instance frontend real components / HTTP / phone regression', {skip: !chromium, timeout: 240000}, async t => {
  let pageMode='controller';
  const serverFixture = await startBrowserTestServer(t,{name:'instances',authMode:()=>pageMode,entries:['virtual:instance-test','/src/App.vue','/src/views/InstancesView.vue','/src/views/SettingsHubView.vue'],plugins:[{name:'instance-test-entry',resolveId(id){if(id === 'virtual:instance-test') return '\0virtual:instance-test';}, load(id){if(id === '\0virtual:instance-test') return entry;},configureServer(server){server.middlewares.use((req,res,next)=>{if(['/__test','/login','/instances','/chat'].includes(req.url?.split('?')[0])){res.setHeader('content-type','text/html');res.end(html.replace('<head>',`<head><script>window.__OPENBEAR_AUTH_MODE__=${JSON.stringify(pageMode)};</script>`));}else next();});}}]});
  const {base}=serverFixture;
  let browser;
  t.after(async () => {try {await browser?.close();} finally {await serverFixture.close();}});
  browser = await chromium.launch({executablePath:process.env.OPENBEAR_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  async function setup(t,{view='instances',mode='controller',width=390,loginStatus=401,verifyItemStatus='ready',verifyHealth,changeStatus=200,gatewayOn=true,instances=true,portUsed=false,syncFails=false}={}) {
    pageMode=mode;
    const context = await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1});
    t.after(()=>context.close());
    const page = await context.newPage(), calls = [], errors = [];
    let item = fixture(), operations = [{id:'op-1',kind:'deployment',status:'completed',conversationUuid:'conv-deploy',createdAtMs:1000}], failMaintain = false;
    let gateway = gatewayOn ? {ok:true,enabled:true,connected:true,status:'connected',publicUrl:'http://203.0.113.10:18962',serverId:'local',port:18962,clientIp:{source:'auto',trustedProxies:[]},observed:{peer:'127.0.0.1',header:'X-Forwarded-For',atMs:Date.now()-120000}} : {ok:true,enabled:false,connected:false,status:'disabled',publicUrl:'',serverId:'local',port:18962,clientIp:{source:'auto',trustedProxies:[]},observed:null};
    let servers = [{id:'local',name:'本机',local:true,publicIp:'203.0.113.10',status:'ok',usedBy:gatewayOn?['访问网关']:[]},{id:'srv-1',name:'云服务器',host:'192.0.2.10',port:22,username:'root',auth:'key',keyLabel:'deploy / 主密钥',publicIp:'198.51.100.7',docker:'27.3',status:'ok',usedBy:['实例甲']}];
    const keys = [{secret:'deploy',field:'主密钥',type:'ED25519',encrypted:true,usable:true,fingerprint:'SHA256:fixture',passphraseFields:['口令','备注'],suggestedPassphraseField:'口令'},{secret:'deploy',field:'备用',type:'RSA 4096',encrypted:false,usable:true,fingerprint:'SHA256:other',passphraseFields:[]},{secret:'site',field:'key',type:'RSA 2048',usable:true,likelyTls:true,passphraseFields:[]},{secret:'old',field:'ppk',usable:false,reason:'putty_format'}];
    await page.addInitScript(view => {window.__view=view;}, view);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req=route.request(), url=new URL(req.url()), path=url.pathname, method=req.method(), body=req.postDataJSON();
      calls.push({path,method,body});
      let data={ok:true,items:[]},status=200;
      if(path==='/api/auth/password/login'){status=loginStatus;data=status===200?{ok:true}:{ok:false,error:'DO-NOT-ECHO-password-fixture'};}
      else if(path==='/api/auth/password/change'){status=changeStatus;data=status===200?{ok:true}:{ok:false,error:'DO-NOT-ECHO-password-fixture'};}
      else if(path==='/api/instance-gateway') data=gateway;
      else if(path==='/api/instance-gateway/port') data={ok:true,free:portUsed&&url.searchParams.get('port')==='18962'?false:true,...(portUsed&&url.searchParams.get('port')==='18962'?{usedBy:'nginx'}:{})};
      else if(path==='/api/instance-gateway/suggest') data={ok:true,publicIp:url.searchParams.get('serverId')==='local'?'203.0.113.10':'198.51.100.7',port:Number(url.searchParams.get('port'))};
      else if(path==='/api/instance-gateway/enable'){gateway={...gateway,enabled:true,connected:true,status:'connected',...body,clientIp:{source:'auto',trustedProxies:[]}};data=gateway;}
      else if(path==='/api/instance-gateway/client-ip'){gateway={...gateway,clientIp:body.trustedProxies.length?{source:'header',trustedProxies:body.trustedProxies}:{source:'auto',trustedProxies:[]}};data=gateway;}
      else if(path==='/api/instance-gateway/disable'){gateway={...gateway,enabled:false,connected:false,status:'disabled'};data=gateway;}
      else if(path==='/api/instance-servers' && method==='GET') data={ok:true,items:servers};
      else if(path==='/api/instance-servers/ssh-keys') data={ok:true,items:keys};
      else if(path==='/api/instance-servers/test') data={ok:true,os:'Debian GNU/Linux 13',docker:'',publicIp:'198.51.100.9'};
      else if(path==='/api/instance-servers' && method==='POST'){const created={id:'srv-new',name:body.name,host:body.host,port:body.port,username:body.username,auth:body.auth==='upload'?'key':body.auth,keyLabel:body.keyRef?`${body.keyRef.secret} / ${body.keyRef.field}`:'',status:'ok',usedBy:[]};servers=[...servers,created];data={ok:true,item:created};}
      else if(path==='/api/instance-model-options') data={ok:true,primary:'parent/model',providers:[{name:'parent',models:['model','cheap']},{name:'second',models:['big']}]};
      else if(path==='/api/instance-deployment-folder') data={ok:true,folderUuid:'deploy-folder'};
      else if(path==='/api/instances' && method==='GET') data={ok:true,items:instances?[item]:[]};
      else if(path==='/api/instances' && method==='POST'){item={...fixture(),id:'child-new',name:body.name,serverId:body.serverId,status:'deploying',account:{username:body.account.username},models:body.models};instances=true;data={ok:true,item,conversationUuid:'conv-new',deployment:{ok:true}};}
      else if(/^\/api\/instances\/child-[a-z]+$/.test(path) && method==='GET') data={ok:true,item};
      else if(/^\/api\/instances\/child-[a-z]+$/.test(path) && method==='PATCH'){if(body.notifications)item.notifications=body.notifications;if(body.account)item.gateway=syncFails?{status:'pending_sync',error:'gateway_unreachable'}:{status:'synced'};data={ok:true,item};}
      else if(path.endsWith('/gateway-sync')){item.gateway={status:'synced'};data={ok:true,synced:true,item};}
      else if(path.endsWith('/operations')) data={ok:true,items:operations};
      else if(path.endsWith('/events')) data={ok:true,items:[{id:'evt-1',type:'login_failure',atMs:Date.now()-60000,data:{ip:'192.168.1.23'}},{id:'evt-2',type:'login_success',atMs:Date.now()-3600000,data:{ip:'192.168.1.23'}}]};
      else if(path.endsWith('/maintenance')){
        if(failMaintain){status=409;data={ok:false,error:'operation_running'};}
        else {const op={id:'op-2',kind:'maintenance',status:'running',conversationUuid:'conv-maint',createdAtMs:Date.now()};operations=[op,...operations];data={ok:true,operation:op,conversationUuid:'conv-maint'};}
      }
      else if(path.endsWith('/verify')){item.status=verifyItemStatus;item.healthStatus=verifyHealth || (verifyItemStatus==='ready'?'healthy':'degraded');data={ok:true,item,verification:{ok:verifyItemStatus==='ready'&&!verifyHealth,identity:true,ready:true,persistence:true,publicRoute:true,health:{status:item.healthStatus,issues:[]}}};}
      else if(path.endsWith('/archive')){item.status='archived';data={ok:true,item};}
      else if(path==='/api/channels') data={ok:true,primaryModel:'parent/model',providers:[{name:'parent',enabled:true,models:[{id:'model'}]}]};
      else if(path.endsWith('/request')) {
        let child={ok:true};
        if(body.path.startsWith('/api/memory/entries')) child=body.method==='GET'?{ok:true,items:[]}:{ok:true,item:{id:1,...body.body}};
        if(body.path==='/api/channels' && body.method==='GET') child={ok:true,primaryModel:'remote/model',providers:[{name:'remote',baseUrl:'https://provider.example.test',protocol:'chat',enabled:true,models:[{id:'model',name:'Model',contextWindow:128000,maxTokens:8192}]}]};
        if(body.path==='/api/skills') child={ok:true,skillsDir:'/workspace/skills',items:[{name:'readme',description:'测试技能',status:'enabled',configuredEnabled:true}]};
        if(body.path==='/api/skills/readme') child={ok:true,item:{name:'readme',content:'# Skill documentation'}};
        if(body.path==='/api/mcp/status') child={ok:true,enabled:true,servers:[{key:'tools',name:'tools',transport:'stdio',status:'connected',enabled:true,approval:'ask',toolCount:1}],tools:[]};
        if(body.path==='/api/settings') child={ok:true,values:{'agent.maxTurns':30,'memory.accessKey':'SERVER-SECRET-NOT-TO-RENDER'}};
        if(body.path==='/api/settings/specs') child={ok:true,specs:{'agent.maxTurns':{path:'agent.maxTurns',title:'最大轮次',kind:'int',min:1},'memory.accessKey':{path:'memory.accessKey',title:'记忆访问密钥',kind:'string',sensitive:true}}};
        if(body.path==='/api/managed/v1/jobs' && body.method==='POST') child={ok:true,job:{id:'job-1',status:'running',output:'',exitCode:null}};
        if(body.path==='/api/managed/v1/jobs/job-1') child={ok:true,job:{id:'job-1',status:'completed',output:'Python 3.12',exitCode:0}};
        if(body.path.endsWith('/cancel')) child={ok:true,job:{id:'job-1',status:'cancelled',output:'',exitCode:null}};
        data={ok:true,status:body.path==='/api/managed/v1/jobs'?202:200,data:child};
      }
      // Existing App bootstrap read paths, without exercising unrelated managers.
      else if(path==='/api/settings') data={ok:true,providerCount:1,values:{'agent.maxTurns':30,'web.taskNotifications.enabled':true,'web.port':8899},masked:{},revision:1};
      else if(path==='/api/settings/specs') data={ok:true,domains:[{key:'agent',title:'Agent 设置',desc:'常用业务设置',sections:[{key:'agent',title:'执行限制',paths:['agent.maxTurns']}]},{key:'web',title:'Web 服务',desc:'监听设置',sections:[{key:'web',title:'监听设置',paths:['web.port']}]},{key:'notifications',title:'通知',desc:'本设备系统通知与 Telegram 提醒',sections:[{key:'web_notifications',title:'Telegram 通知',paths:['web.taskNotifications.enabled']}]}],specs:{'agent.maxTurns':{path:'agent.maxTurns',title:'最大轮次',kind:'int',group:'agent',effect:'立即生效',desc:'常用轮次限制',min:1},'web.taskNotifications.enabled':{path:'web.taskNotifications.enabled',title:'Telegram 长任务通知',kind:'bool',group:'web_notifications',effect:'立即生效',desc:'通过 Telegram 发送'},'web.port':{path:'web.port',title:'监听端口',kind:'int',group:'web',effect:'需要重启',desc:'服务端口'}}};
      else if(path==='/api/auth/session') data={ok:true,authenticated:true,mode};
      else if(path==='/api/system/version') data={ok:true,version:'test',updateAvailable:true,latest:{version:'next',requiresRestart:true}};
      else if(path==='/api/rath/options') data={ok:true,models:[],agents:[]};
      else if(path.includes('/conversation-tree/')) data={ok:true,items:[],folders:[],conversations:[],root:{id:'root',kind:'folder'},recent:[],revision:1};
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    });
    const goto = async () => {
      await page.goto(base + (view==='login'?'/login':view==='app'?'/instances':'/__test'));
      await waitForBrowserReady(page,page.locator('#app > *').first(),errors);
    };
    const close = async () => {await context.close();assert.deepEqual(errors,[]);};
    return {page,calls,context,goto,close,failMaintain:()=>{failMaintain=true;}};
  }
  const click = (page,name) => page.getByRole('button',{name,exact:true}).click();
  async function noOverflow(page) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)); }

  await t.test('managed password form uses only password endpoint; errors do not echo secrets; 320px input avoids zoom', {timeout:60000}, async (t)=> {
    const h=await setup(t,{view:'login',mode:'managed',width:320});await h.goto();
    await h.page.getByLabel('账号',{exact:true}).fill('owner'); await h.page.getByLabel('密码',{exact:true}).fill('fixture-password');
    assert.ok(!await h.page.getByText('Telegram',{exact:false}).count());
    assert.equal(await h.page.getByLabel('密码',{exact:true}).getAttribute('type'),'password');
    assert.ok(await h.page.getByLabel('密码',{exact:true}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
    await click(h.page,'登录'); await h.page.getByRole('alert').waitFor();
    assert.equal(await h.page.getByLabel('密码',{exact:true}).inputValue(),'');
    assert.ok(!await h.page.getByText('DO-NOT-ECHO-password-fixture',{exact:false}).count());
    assert.deepEqual(h.calls.filter(c=>c.method==='POST').map(c=>[c.path,c.body]),[['/api/auth/password/login',{username:'owner',password:'fixture-password'}]]);
    assert.equal(await h.page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage})), '{}');
    await noOverflow(h.page);await h.close();
  });
  await t.test('controller login page shows Telegram at once, without a mode request', {timeout:60000}, async (t)=> {
    const h=await setup(t,{view:'login'});await h.goto();
    await h.page.getByText('输入 Web Secret Key 后，需要在 Telegram 中二次确认。').waitFor();
    assert.equal(await h.page.getByText('正在确认登录方式',{exact:false}).count(),0);
    assert.ok(!h.calls.some(c=>c.path==='/api/auth/mode'));assert.equal(h.calls.filter(c=>c.method==='POST').length,0);await h.close();
  });
  await t.test('real App role routing hides only instances on managed and retains controller navigation', {timeout:60000}, async (t)=> {
    for(const mode of ['managed','controller']){
      const h=await setup(t,{view:'app',mode,width:1280});await h.goto();
      await h.page.locator('.sidebar-desktop-nav').waitFor();
      if(mode==='managed'){await h.page.waitForURL('**/chat**');assert.equal(await h.page.locator('.sidebar-desktop-nav').getByText('实例',{exact:true}).count(),0);assert.equal(h.calls.filter(c=>c.path==='/api/instances').length,0);}
      else {await h.page.locator('.instances-page').waitFor({timeout:10000}).catch(async()=>assert.fail(JSON.stringify({url:h.page.url(),text:await h.page.locator('body').innerText(),calls:h.calls.map(c=>c.path),errors:await h.page.evaluate(()=>window.__view)})));assert.equal(await h.page.locator('.sidebar-desktop-nav').getByText('实例',{exact:true}).count(),1);}
      for(const name of ['记忆','凭证','文档','定时','Skills','MCP']) assert.equal(await h.page.locator('.sidebar-desktop-nav').getByText(name,{exact:true}).count(),1);
      await noOverflow(h.page); await h.close();
    }
  });
  await t.test('shared settings keep business controls but hide managed restart, TG configuration and updater; password change is usable', {timeout:60000}, async (t)=> {
    for (const mode of ['managed','controller']) {
      const h=await setup(t,{view:'settings',mode,width:390});await h.goto();await h.page.getByLabel('搜索全部设置').waitFor();
      assert.equal(await h.page.getByRole('button',{name:'重启 OpenBear',exact:true}).count(), mode==='controller'?1:0);
      await h.page.getByText('最大轮次',{exact:true}).waitFor();
      await h.page.getByLabel('搜索全部设置').fill('Telegram');
      assert.equal(await h.page.getByRole('button',{name:'发送 Telegram 测试通知',exact:true}).count(),mode==='controller'?1:0);
      assert.equal(await h.page.getByText('Telegram 长任务通知',{exact:true}).count(),mode==='controller'?1:0);
      await h.page.getByLabel('搜索全部设置').fill('web.port');assert.equal(await h.page.locator('h4').getByText('监听端口',{exact:true}).count(),mode==='controller'?1:0);
      await h.page.getByLabel('搜索全部设置').fill('agent.maxTurns');await h.page.getByText('最大轮次',{exact:true}).waitFor();await noOverflow(h.page);assert.ok(!h.calls.some(c=>c.method==='POST'&&(/restart|notifications\/test|system\/update/.test(c.path))));await h.close();
      const app=await setup(t,{view:'app',mode,width:1280});await app.goto();await app.page.locator('.sidebar-version').first().waitFor();
      const refresh=app.page.getByRole('button',{name:'保留当前编辑',exact:true});if(await refresh.count()) await refresh.click();
      const dismiss=app.page.getByRole('button',{name:'暂不开启',exact:true});if(await dismiss.count()) await dismiss.click();
      await app.page.locator('.sidebar-version').first().click();await app.page.getByText('版本与更新',{exact:true}).waitFor();
      assert.equal(await app.page.getByRole('button',{name:'更新到 vnext',exact:true}).count(),mode==='controller'?1:0);
      if(mode==='managed') await app.page.getByText('此受管实例不能自行升级或重启，请在主控实例的维护会话中操作容器，保留 /workspace 数据卷。').waitFor();
      assert.ok(!app.calls.some(c=>c.method==='POST'&&c.path.includes('/system/update')));await app.close();
      const account=await setup(t,{view:'sessions',mode,width:320});await account.goto();await account.page.locator('.sessions-content').waitFor();
      if(mode==='controller') assert.equal(await account.page.getByText('修改账号与密码',{exact:true}).count(),0);
      else {
        await account.page.getByText('修改账号与密码',{exact:true}).click();await account.page.getByLabel('当前密码',{exact:true}).fill('current-fixture-password');await account.page.getByLabel('新密码',{exact:true}).fill('new-fixture-password');await account.page.getByLabel('确认新密码',{exact:true}).fill('different-fixture-password');await click(account.page,'修改并退出所有设备');await account.page.getByText('两次输入的新密码不一致。').waitFor();assert.equal(account.calls.filter(c=>c.path==='/api/auth/password/change').length,0);
        await account.page.getByLabel('确认新密码',{exact:true}).fill('new-fixture-password');await noOverflow(account.page);assert.equal(await account.page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage})), '{}');
        await click(account.page,'修改并退出所有设备');await account.page.waitForURL('**/login');await account.page.getByLabel('账号',{exact:true}).waitFor();assert.deepEqual(account.calls.find(c=>c.path==='/api/auth/password/change').body,{currentPassword:'current-fixture-password',password:'new-fixture-password'});
      }
      await account.close();
    }
    const denied=await setup(t,{view:'sessions',mode:'managed',width:390,changeStatus:403});await denied.goto();await denied.page.getByText('修改账号与密码',{exact:true}).click();for(const name of ['当前密码','新密码','确认新密码']) await denied.page.getByLabel(name,{exact:true}).fill('fixture-password-long');await click(denied.page,'修改并退出所有设备');await denied.page.getByText('当前密码未通过验证，请重新输入。').waitFor();assert.equal(await denied.page.getByLabel('当前密码',{exact:true}).inputValue(),'');assert.equal(await denied.page.getByText('DO-NOT-ECHO-password-fixture',{exact:false}).count(),0);await denied.close();
  });
  await t.test('no gateway: empty state; enabling checks the port, defaults the address and warns about mapping', {timeout:60000}, async (t)=> {
    const h=await setup(t,{gatewayOn:false,instances:false,portUsed:true,width:390});await h.goto();
    await h.page.getByText('还没有启用访问网关',{exact:true}).waitFor();
    assert.equal(await h.page.getByRole('button',{name:'创建实例',exact:true}).isDisabled(),true);
    await click(h.page,'启用访问网关');
    await h.page.getByText('✗ 已被 nginx 占用',{exact:true}).waitFor();
    assert.equal(await h.page.getByRole('button',{name:'启用',exact:true}).isDisabled(),true);
    await h.page.getByLabel('网关端口').fill('18963');
    await h.page.getByText('✓ 本机上可用',{exact:true}).waitFor();
    assert.equal(await h.page.getByLabel('访问地址').inputValue(),'http://203.0.113.10:18963');
    await h.page.getByLabel('访问地址').fill('https://bear.example.com');
    await h.page.getByText('请自行把 bear.example.com 映射到 203.0.113.10:18963',{exact:false}).waitFor();
    await noOverflow(h.page);
    await click(h.page,'启用');await h.page.getByText('访问网关',{exact:true}).first().waitFor();
    assert.deepEqual(h.calls.find(c=>c.path==='/api/instance-gateway/enable').body,{serverId:'local',port:18963,publicUrl:'https://bear.example.com'});
    await h.page.getByRole('link',{name:'https://bear.example.com'}).waitFor();
    assert.equal(await h.page.getByRole('button',{name:'创建实例',exact:true}).isDisabled(),false);
    await h.close();
  });
  await t.test('create: generated password, copied models, automatic port/data dir; credentials shown once', {timeout:60000}, async (t)=> {
    const h=await setup(t,{instances:false,width:320});await h.goto();await click(h.page,'创建实例');
    const password=await h.page.getByLabel('登录密码').inputValue();
    // A short password only shows advice; it can still be submitted.
    await h.page.getByLabel('登录密码').fill('abc');await h.page.getByText('密码较短，容易被猜到；建议至少 8 位。',{exact:true}).waitFor();
    assert.equal(await h.page.getByLabel('登录密码').evaluate(el=>el.validity.valid),true);
    await h.page.getByLabel('登录密码').fill(password);
    assert.match(password,/^[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}$/);
    await h.page.getByLabel('实例名称').fill('实例乙');await h.page.getByLabel('登录账号').fill('beta');
    await h.page.getByLabel('运行位置').selectOption('srv-1');
    assert.equal(await h.page.getByLabel('默认模型').inputValue(),'parent/model');
    await h.page.getByText('复制主控已启用的 2 个渠道（含 API Key）到这个实例。',{exact:true}).waitFor();
    await h.page.getByText('高级（端口、数据目录、镜像、实例地址）').click();
    assert.equal(await h.page.getByLabel('数据目录').getAttribute('placeholder'),'自动：/opt/openbear/instances/beta');
    const dialog=h.page.getByRole('dialog');assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1));await noOverflow(h.page);
    assert.ok(await h.page.getByLabel('实例名称').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
    await click(h.page,'创建并部署');
    await h.page.getByText('已创建「实例乙」，正在部署',{exact:true}).waitFor();
    const body=h.calls.find(c=>c.path==='/api/instances'&&c.method==='POST').body;
    assert.deepEqual(body,{name:'实例乙',serverId:'srv-1',account:{username:'beta',password},models:{mode:'copy',primary:'parent/model'}});
    await h.page.getByText(password,{exact:true}).waitFor();
    await h.page.locator('.ob-checks li').filter({hasText:'账号已写入访问网关'}).waitFor();
    await click(h.page,'查看部署会话');assert.deepEqual(await h.page.evaluate(()=>window.__opened),['conv-new']);
    assert.equal(await h.page.getByText(password,{exact:true}).count(),0);
    assert.equal(await h.page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage})), '{}');
    await h.close();
  });
  await t.test('adding a server from the create form keeps the form; vault keys are grouped and the passphrase field is suggested', {timeout:60000}, async (t)=> {
    const h=await setup(t,{width:1280});await h.goto();await click(h.page,'创建实例');
    await h.page.getByLabel('实例名称').fill('保留我');
    await h.page.getByLabel('运行位置').selectOption('__add');
    const server=h.page.getByRole('dialog',{name:'添加服务器'});await server.waitFor();
    // Each auth option stays on one line with a checkbox-sized radio.
    const radios=await server.locator('.ob-radios label').evaluateAll(labels=>labels.map(label=>({input:Math.round(label.querySelector('input').getBoundingClientRect().width),height:Math.round(label.getBoundingClientRect().height)})));
    assert.equal(radios.length,3);for(const r of radios){assert.equal(r.input,16,JSON.stringify(radios));assert.ok(r.height<=24,JSON.stringify(radios));}
    const select=server.getByLabel('密钥库中的 SSH 私钥');
    assert.deepEqual(await select.locator('optgroup').evaluateAll(groups=>groups.map(g=>g.label)),['deploy','可能不是 SSH 私钥','无法使用']);
    assert.equal(await select.locator('option[disabled]').filter({hasText:'PuTTY'}).count(),1);
    await server.getByText('✓ 这个字段能解开私钥',{exact:true}).waitFor();
    await server.getByLabel('服务器名称').fill('新服务器');await server.getByLabel('服务器地址').fill('192.0.2.20');
    await server.getByRole('button',{name:'测试连接',exact:true}).click();await server.getByText('未安装 Docker',{exact:false}).waitFor();
    await server.getByRole('button',{name:'保存',exact:true}).click();await server.waitFor({state:'hidden'});
    assert.deepEqual(h.calls.find(c=>c.path==='/api/instance-servers'&&c.method==='POST').body,{name:'新服务器',host:'192.0.2.20',port:22,username:'root',auth:'key',keyRef:{secret:'deploy',field:'主密钥',passphraseField:'口令'}});
    assert.equal(await h.page.getByLabel('实例名称').inputValue(),'保留我');
    assert.equal(await h.page.getByLabel('运行位置').inputValue(),'srv-new');
    await h.close();
  });
  await t.test('detail: overview, notifications toggle immediately, sessions link the folder, maintenance opens its session', {timeout:60000}, async (t)=> {
    const h=await setup(t,{width:1280});await h.goto();
    const row=h.page.locator('.instance-row');await row.getByText('alpha · 云服务器',{exact:true}).waitFor();await row.getByText('最近登录 1 小时前',{exact:true}).waitFor();
    await row.click();
    await h.page.getByText('http://203.0.113.10:18962',{exact:false}).first().waitFor();
    await h.page.getByText('云服务器 · 端口 18970',{exact:true}).waitFor();
    await click(h.page,'登录与通知');await h.page.getByText('192.168.1.23',{exact:true}).first().waitFor();
    await h.page.getByLabel('登录成功').check();
    await h.page.waitForFunction(()=>true);
    for(let i=0;i<20&&!h.calls.some(c=>c.method==='PATCH'&&c.body?.notifications?.loginSuccess===true);i++) await h.page.waitForTimeout(50);
    assert.deepEqual(h.calls.find(c=>c.method==='PATCH').body,{notifications:{loginSuccess:true,loginFailure:true,health:true}});
    await click(h.page,'部署记录');await click(h.page,'打开目录 →');await h.page.waitForFunction(()=>window.__folders.length===1);assert.deepEqual(await h.page.evaluate(()=>window.__folders),['deploy-folder']);
    await click(h.page,'维护…');
    const dialog=h.page.getByRole('dialog',{name:'维护「实例甲」'});await dialog.waitFor();
    assert.equal(await dialog.getByRole('button',{name:'开始维护',exact:true}).isDisabled(),true);
    await dialog.getByLabel('维护内容').fill('安装 LibreOffice');await dialog.getByLabel('执行模型').selectOption('second/big');
    await dialog.getByRole('button',{name:'开始维护',exact:true}).click();await dialog.waitFor({state:'hidden'});await h.page.waitForFunction(()=>window.__opened.length===1);
    assert.deepEqual(h.calls.find(c=>c.path.endsWith('/maintenance')).body,{instructions:'安装 LibreOffice',model:'second/big'});
    assert.deepEqual(await h.page.evaluate(()=>window.__opened),['conv-maint']);
    await noOverflow(h.page);await h.close();
  });
  await t.test('reset password and a pending gateway sync are explicit; check shows problems', {timeout:60000}, async (t)=> {
    const h=await setup(t,{width:390,syncFails:true,verifyItemStatus:'needs_verification'});await h.goto();await h.page.locator('.instance-row').click();
    await h.page.getByRole('button',{name:'重置密码',exact:true}).click();
    const box=h.page.locator('.el-message-box');await box.waitFor();
    const text=await box.innerText();const password=text.match(/新密码：(\S+)/)[1];
    await box.getByRole('button',{name:'确认并复制',exact:true}).click();
    await h.page.getByText('新密码尚未同步到访问网关，系统会自动重试。',{exact:true}).waitFor();
    assert.deepEqual(h.calls.find(c=>c.method==='PATCH').body,{account:{password}});
    await h.page.getByText('账号变更尚未同步到访问网关',{exact:false}).waitFor();
    await click(h.page,'立即重试');await h.page.getByText('账号变更尚未同步到访问网关',{exact:false}).waitFor({state:'hidden'});
    await click(h.page,'立即检查');await h.page.getByText('检查完成：存在问题，请查看概况',{exact:true}).waitFor();
    assert.equal(await h.page.locator('.instance-detail-header .ob-dot').innerText(),'待检查');
    await noOverflow(h.page);await h.close();
  });
  await t.test('gateway settings show automatic IP detection; servers page lists usage and blocks deleting used servers', {timeout:60000}, async (t)=> {
    const h=await setup(t,{width:390});await h.goto();
    await h.page.locator('.ob-strip').getByRole('button',{name:'设置',exact:true}).click();
    const dialog=h.page.getByRole('dialog',{name:'访问网关'});await dialog.waitFor();
    await dialog.getByText('自动识别 · 经本机反向代理访问',{exact:true}).waitFor();
    await dialog.getByText('已从 X-Forwarded-For 读取真实 IP',{exact:false}).waitFor();
    await dialog.getByText('识别不对？手动指定代理',{exact:true}).click();
    await dialog.getByLabel('代理地址').fill('10.0.0.1');await dialog.getByRole('button',{name:'保存',exact:true}).click();
    await dialog.getByText('手动指定的代理',{exact:true}).waitFor();
    assert.deepEqual(h.calls.find(c=>c.path==='/api/instance-gateway/client-ip').body,{trustedProxies:['10.0.0.1']});
    await noOverflow(h.page);
    await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();await dialog.waitFor({state:'hidden'});
    await h.page.locator('.ob-pages').getByRole('button',{name:'服务器',exact:true}).click();
    const cards=h.page.locator('.ob-server');await cards.first().waitFor();
    await cards.nth(0).locator('.ix-usage').getByText('访问网关',{exact:true}).waitFor();
    for(const text of ['root@192.0.2.10:22','deploy / 主密钥','198.51.100.7','27.3']) await cards.nth(1).locator('.ix-facts').getByText(text,{exact:true}).waitFor();
    await cards.nth(1).locator('.ix-usage').getByText('实例甲',{exact:true}).waitFor();
    assert.equal(await cards.nth(1).getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
    assert.equal(await cards.nth(0).getByRole('button',{name:'删除',exact:true}).count(),0);
    await noOverflow(h.page);await h.close();
  });
});
