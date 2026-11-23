import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const here=dirname(fileURLToPath(import.meta.url));
assert.equal(process.cwd(),here,'cd to scenarios first');
const src=resolve(process.env.SMARTSELL_SOURCE??'../../.local/mcp-lab-Lh53qf');
const apiPort=Number(process.env.LAB_API_PORT??46431), webPort=Number(process.env.LAB_WEB_PORT??46432), fixturePort=Number(process.env.LAB_FIXTURE_PORT??46433);
const origin=`http://127.0.0.1:${webPort}`, url=`http://127.0.0.1:${fixturePort}/catalog/desk-lamp`;
const now=()=>new Date().toISOString(), run=now().replaceAll(':','-'), dir=resolve(here,'runs',run), tmp=resolve(dir,'runtime');
await mkdir(tmp,{recursive:true,mode:0o700});
console.log(dir);
const file=(name,text)=>writeFile(resolve(dir,name),text,{mode:0o600});
const secrets=new Set();
const selection = new Set(process.argv.slice(2));
const selected = key => !selection.size || selection.has(key);
function redactText(s){ for(const secret of secrets) s=s.replaceAll(secret,'[REDACTED]'); return s.replace(/(\\*["'](?:fencing_token|lease_token|session_token|access_token|refresh_token|password|passwordHash)\\*["']\s*:\s*)(?:\\*["'][^"']*\\*["']|\d+)/gi,'$1"[REDACTED]"').replace(/(`?fencing_token`?\s*(?:=|为|是)?\s*`?)\d+/gi,'$1[REDACTED]'); }
function scrub(v) { if (typeof v==='string') return redactText(v); if(Array.isArray(v)) return v.map(scrub); if(v && typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/^(?:fencing_token|.*(?:token|secret|password)|authorization|cookie|lease_credential_id)$/i.test(k)?'[REDACTED]':scrub(x)])); return v; }
const json=(name,v)=>file(name,JSON.stringify(scrub(v),null,2)+'\n');
const log=(name,v)=>appendFile(resolve(dir,name),JSON.stringify(scrub(v))+'\n',{mode:0o600});
const dep=p=>import(pathToFileURL(resolve(src,'node_modules/.pnpm',p)).href);
const {chromium}=await dep('playwright@1.65.1/node_modules/playwright/index.mjs');
const sdk='@modelcontextprotocol+sdk@1.32.2_zod@4.6.7/node_modules/@modelcontextprotocol/sdk/dist/esm/client';
const {Client}=await dep(`${sdk}/index.js`), {StreamableHTTPClientTransport}=await dep(`${sdk}/streamableHttp.js`);
const sha=b=>createHash('sha256').update(b).digest('hex');
const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权公开样页</title><h1 id="name">棱镜暖光桌灯</h1><p id="sku">PRISM-QA-21</p><data id="price" value="12900" data-currency="CNY">¥129.00</data><p id="stock">有货</p></html>';
await file('source-fixture.html',html);
const fixture=createServer((req,res)=>req.method==='GET'&&req.url==='/catalog/desk-lamp'?res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html):res.writeHead(404).end());
await new Promise((ok,fail)=>fixture.once('error',fail).listen(fixturePort,'127.0.0.1',ok));
let server,browser,client,conn,rest,root,meta;
const dbPath=resolve(tmp,'workspace.sqlite');
const scheduleTz = 'Asia/Shanghai';
const scheduleOffsetMs = 3 * 60 * 1000;
let videoMcp;
let videoSchedule;
async function videoMcpUrl() {
  videoMcp = createServer(async (req, res) => {
    try {
      const headers = { ...req.headers, host: new URL(origin).host };
      let body;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
        const message = JSON.parse(body);
        const args = message.params?.arguments;
        const create = message.method === 'tools/call' && (message.params.name === 'publishing_create_target' ||
          (message.params.name === 'smartsell_operation_call' && args?.operation === 'publishing_create_target'));
        if (create && args?.body) {
          const key = args.idempotency_key;
          if (!key || (videoSchedule && videoSchedule.key !== key)) {
            res.writeHead(400).end('Use one idempotency key for the video target');
            return;
          }
          if (!videoSchedule) {
            const requestAt = Date.now();
            videoSchedule = { key, requestAt: new Date(requestAt).toISOString(), scheduledAt: new Date(requestAt + scheduleOffsetMs).toISOString() };
          }
          args.body.scheduled_at = videoSchedule.scheduledAt;
          args.body.schedule_tz = scheduleTz;
          body = Buffer.from(JSON.stringify(message));
          delete headers['transfer-encoding'];
          headers['content-length'] = String(body.length);
        }
      }
      const upstream = request(new URL('/mcp', origin), { method: req.method, headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      upstream.end(body);
    } catch { res.writeHead(400).end(); }
  });
  await new Promise((ok, fail) => videoMcp.once('error', fail).listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${videoMcp.address().port}/mcp`;
}
const tools=['smartsell_operation_call','smartsell_operations_describe','workspace_get_context','account_list_social_accounts','content_create_item','content_create_variant','content_autosave_variant','content_commit_revision','content_get_variant','publishing_create_target','publishing_request_approval','publishing_get_target','posts_list','commerce_store_list','catalog_search','catalog_get_product','commerce_product_create','commerce_variant_create','import_template_list','commerce_store_import','import_create','import_preview','import_rows','import_confirm','import_get','agent_jobs_get','agent_jobs_claim','agent_jobs_heartbeat','agent_jobs_submit_result'];
async function native(key,prompts){
  await mkdir(resolve(dir,key),{recursive:true});
  const mcpUrl=key==='01-video' ? await videoMcpUrl() : `${origin}/mcp`;
  const cfg=JSON.stringify({mcpServers:{smartsell_lab:{type:'http',url:mcpUrl,headers:{Authorization:'Bearer ${SMARTSELL_SCENARIO_TOKEN}'}}}});
  const instruction='你是 SmartSell 隔离验收运营 Agent。只用本次 smartsell_lab MCP，不用 shell、网页或其他服务。所有写入使用幂等键与最新版本。保留审核，不核准、不授权、不发布、不伪造回执。遇到阻塞把真实原因提交为任务结果，中文简洁报告。';
  const {CLAUDECODE,...env}=process.env;
  const c=spawn('claude',['-p','--no-session-persistence','--setting-sources','','--strict-mcp-config','--mcp-config',cfg,'--model','claude-opus-5-5','--effort','low','--tools','','--input-format','stream-json','--output-format','stream-json','--verbose','--append-system-prompt',instruction,'--allowedTools',...tools.map(n=>`mcp__smartsell_lab__${n}`)],{cwd:here,env:{...env,SMARTSELL_SCENARIO_TOKEN:conn.token},stdio:['pipe','pipe','pipe']});
  const turns=[], events=[];let i=0, visible=[], stderr='';
  c.stderr.on('data',x=>{stderr+=x}); c.stdin.on('error',()=>{});
  const event=(e)=>events.push(scrub({at:now(),seq:events.length+1,turn:i+1,...e}));
  function send(){const text=prompts[i];turns.push({turn:i+1,user:text,userAt:now()});event({type:'operator_prompt',text});c.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text}]}})+'\n');}
  try {
    await new Promise((done,fail)=>{
      const timeout=setTimeout(()=>{event({type:'harness_timeout'});c.kill('SIGTERM')},240000);
      c.once('error',e=>{clearTimeout(timeout);fail(e)});c.once('close',()=>{clearTimeout(timeout);done()});
      createInterface({input:c.stdout}).on('line',raw=>{
        let e;try{e=JSON.parse(raw)}catch{event({type:'unparsed',text:raw});return;}
        if(Array.isArray(e.message?.content)) e.message.content=e.message.content.filter(x=>!['thinking','redacted_thinking'].includes(x.type));
        event(e);
        if(e.type==='assistant') visible.push(...(e.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text));
        if(e.type==='result') {Object.assign(turns[i],{reply:e.result??null,visible,status:e.subtype,isError:e.is_error,responseAt:now(),sessionId:e.session_id});visible=[];if(++i<prompts.length)send();else c.stdin.end();}
      });send();
    });
  } finally {
    if(turns[i])Object.assign(turns[i],{visible,status:'incomplete_no_cli_result'});
    for(let j=turns.length;j<prompts.length;j++)turns.push({turn:j+1,user:prompts[j],status:'not_sent'});
    await file(`${key}/claude-code.jsonl`,events.map(x=>JSON.stringify(x)).join('\n')+'\n');
    await json(`${key}/conversation.json`,turns);
    await file(`${key}/claude-stderr.log`,redactText(stderr));
  }
  return {turns:turns.map(x=>({turn:x.turn,status:x.status,reply:!!(x.reply||x.visible?.length)})),calls:events.flatMap(x=>(x.type==='assistant'?x.message?.content??[]:[]).filter(z=>z.type==='tool_use').map(z=>z.input?.operation??z.name))};
}
try{
  const {openSync,closeSync}=await import('node:fs'); const fd=openSync(resolve(tmp,'server.log'),'wx',0o600);
  server=spawn(process.execPath,['--import','tsx','apps/server/dev.ts','--host','127.0.0.1','--port',String(webPort),'--no-watch'],{cwd:src,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:tmp,TZ:'Asia/Shanghai',NODE_ENV:'development',ROLE:'all',HOST:'127.0.0.1',PORT:String(apiPort),SMARTSELL_DATA_FILE:dbPath,MEDIA_DIRECTORY:resolve(tmp,'media'),SMARTSELL_VITE_CACHE_DIR:resolve(tmp,'vite')}}); closeSync(fd);
  let ready=false;for(let j=0;j<100;j++){if(await fetch(origin).then(r=>r.ok).catch(()=>false)){ready=true;break;}if(server.exitCode!=null)break;await delay(250)} assert.ok(ready,'Server not ready');
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
  const ctx=await browser.newContext({timezoneId:'Asia/Shanghai',locale:'zh-TW'});
  await ctx.route('**/*',r=>[origin,new URL(url).origin].includes(new URL(r.request().url()).origin)?r.continue():r.abort());
  let csrf;
  rest=async(method,path,data,version)=>{const r=await ctx.request.fetch(`${origin}/api/v1${path}`,{method,data,headers:{Origin:origin,'Idempotency-Key':randomUUID(),...(csrf&&{'X-CSRF-Token':csrf}),...(version!=null&&{'If-Match':String(version)})}});const v=r.status()===204?null:await r.json();if(!r.ok())throw new Error(`${method} ${path}: ${r.status()} ${JSON.stringify(v)}`);return v?.data??v};
  const password=`Lab!${randomBytes(24).toString('hex')}`;secrets.add(password);
  const setup=await rest('POST','/setup',{name:'Scenario QA Owner',email:`scenario-${randomUUID()}@example.test`,password,workspaceName:'Agent Ops Scenario Sandbox'});
  const wid=setup.workspaces[0].id;root=`/workspaces/${wid}`;csrf=(await rest('GET','/session/csrf')).csrf_token;secrets.add(csrf);
  const brand=await rest('POST',`${root}/brands`,{name:'棱镜验收品牌',slug:'prism-qa'});
  const market=await rest('POST',`${root}/brands/${brand.id}/markets`,{name:'中国测试市场',country_code:'CN',primary_language:'zh-CN',currency:'CNY',timezone:'Asia/Shanghai'});
  const account=await rest('POST',`${root}/social-accounts`,{brand_id:brand.id,provider:'meta_facebook',external_account_id:`synthetic-${randomUUID()}`,display_name:'仅本地测试・无平台凭据',default_timezone:'Asia/Shanghai',owned_account_confirmed:true});
  const store=await rest('POST',`${root}/stores`,{brand_id:brand.id,provider:'file_import',mode:'import',external_store_id:`prism-file-${randomUUID()}`,name:'棱镜 CSV 测试店（非远端沙箱）',default_currency:'CNY',default_locale:'zh-CN'});
  if (selected('02-shop')) await rest('PUT',`${root}/stores/${store.id}/markets`,{market_id:market.id,channel:'online_store',price_source:'store_market_price'});
  const board=await rest('POST',`${root}/research-boards`,{brand_id:brand.id,title:'授权样页采集记录'});
  conn=await rest('POST',`${root}/agent-connections`,{label:'Claude Code 运营验收',client:'claude_code',expires_days:1});secrets.add(conn.token);
  client=new Client({name:'deterministic-scenario-sdk',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${conn.token}`}}}));
  async function call(operation,args={},phase='fixtures'){
    const r=await client.callTool({name:'smartsell_operation_call',arguments:{operation,idempotency_key:randomUUID(),...args}});const v=r.structuredContent??JSON.parse(r.content[0].text);
    await log(`sdk-${phase}.jsonl`,{at:now(),operation,args:{...args,...(args.body?.base64&&{body:{...args.body,base64:'[binary: video.mp4]'}})},result:v,isError:r.isError===true});
    if(r.isError)throw new Error(JSON.stringify(v));return v.data??v;
  }
  const video=resolve(dir,'video.mp4');execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=480x270:rate=15','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',video]);const bytes=await readFile(video);
  const ticket=await call('file_begin_upload',{body:{purpose:'asset',mime_type:'video/mp4',size_bytes:bytes.length,sha256:sha(bytes),original_filename:'prism-qa.mp4'}});
  const uploaded=await call('file_complete_upload',{params:{id:ticket.id},body:{base64:bytes.toString('base64')}});
  const asset=await call('asset_create',{body:{brand_id:brand.id,title:'棱镜桌灯 3 秒测试视频',kind:'video',file_object_id:uploaded.id}});
  const grant=await rest('POST',`${root}/rights-grants`,{brand_id:brand.id,grant_type:'owned',usages:['organic_social'],asset_ids:[asset.id]});await rest('POST',`${root}/rights-grants/${grant.id}/activate`,{},grant.version);
  const page=await ctx.newPage();const fetched=await page.goto(url);const observedAt=now();assert.equal(fetched.status(),200);
  const fields=await page.evaluate(()=>({name:document.querySelector('#name').textContent,sku:document.querySelector('#sku').textContent,price_minor:Number(document.querySelector('#price').value),currency:document.querySelector('#price').dataset.currency,availability:document.querySelector('#stock').textContent}));
  const capture={source_url:fetched.url(),observed_at:observedAt,http_status:fetched.status(),sha256:sha(await fetched.body()),fields,authorization:'本轮自建的回环公开页面、无登录；授权读取、入库与模型处理。'};
  await page.screenshot({path:resolve(dir,'source-page.png')});await json('source-capture.json',capture);
  const titles={'01-video':'视频排期与沙箱回执','02-shop':'商品建品、导入与沙箱上架','03-collect':'授权公开样页采集与回读'};
  const jobs={};for(const [k,title] of Object.entries(titles).filter(([k])=>selected(k)))jobs[k]=await rest('POST',`${root}/agent-jobs`,{title,expected_output:{type:'note'},input_scope:{brand_ids:[brand.id],constraints:'仅隔离测试；保持人工审核；不得发布到任何真实社媒或店铺。'}});
  meta={run,cwd:here,workspace:wid,brand:brand.id,market:market.id,account:account.id,store:store.id,board:board.id,asset:asset.id,assetVersion:asset.asset_version.id,sha256:sha(bytes),bytes:bytes.length,agentConnection:conn.id,deviceId:null,deviceReason:'HTTP MCP，未绑定 Connector 设备；本地 Chrome 仅用于读取页面。',jobs:Object.fromEntries(Object.entries(jobs).map(([k,j])=>[k,{id:j.id,workItem:j.work_item_id}]))};await json('fixtures.json',meta);
  const lease=k=>`平台任务 ${jobs[k]?.id}。请读任务，claim，然后完成业务并调用 agent_jobs_submit_result，带最新版本与原 fencing_token；result_ref.note 写业务 ID、回读及缺口。每次写带幂等键。租约字段只传工具，不要向用户复述。`;
  const copy='暖光陪你工作到夜晚。#棱镜桌灯 #测试素材';
  const csv=`external_product_id,external_variant_id,title,sku,currency,price,available,market_id\nprism-import-01,prism-import-v1,棱镜桌灯 · CSV 样品,PRISM-IMPORT-21,CNY,129.00,12,${market.id}`;
  const prompts={
    '01-video':[`把现成的棱镜桌灯短片做成 Facebook 内容，配文「${copy}」，上海时区排期并送审；只在真实授权沙箱有回执才说已发布。${lease('01-video')}\nbrand_id=${brand.id}; market_id=${market.id}; social_account_id=${account.id}; asset_version_id=${asset.asset_version.id}; 排期为创建发布目标时约 3 分钟后，schedule_tz=Asia/Shanghai；创建目标的 MCP 转发会写入实际 scheduled_at，以创建回执为准。创建 item、Facebook video variant，autosave 文案与素材版本，commit（首次 base_revision_id:null），创建目标（connector_mode_pref:assist），送审再 get。此账号纯本地、无远端授权，反馈 NO_AUTHORIZED_SOCIAL_SANDBOX，不要审批。`,`请再次读任务与排期，告诉我上海时间、审批状态和是否存在真正的沙箱回执。不要再写。`],
    '02-shop':[`把桌灯备到测试店：先建 SmartSell 内部商品「棱镜暖光桌灯 · 内建草稿」，再导入另一个 CSV 样品。只有已授权可写远端沙箱才上架。${lease('02-shop')}\nstore_id=${store.id}，只有 file_import，没有远端授权。用具名 import_create（body.template_key=product_list、body.store_id=上述店铺 ID，body.csv_text=下方 CSV）创建批次，或用同作用域的 commerce_store_import；调用 import_rows，确认无错误后用 import_confirm 本地合并，最后用 import_get 读回。注意 CSV synthetic external_product_id 只是导入来源键，不是远端商品 ID。CSV 输入如下：\n${csv}\n持久化 NO_AUTHORIZED_STORE_SANDBOX。`,`重新读任务和导入批次。分别说内部商品 ID、导入批次及状态、远端商品 ID／上架回执有哪些；不要再写。`],
    '03-collect':[`把我们授权公开样页中的商品名、SKU、价格、币种、库存存进 SmartSell，保留来源和实际采集时间。${lease('03-collect')}\n以下是本地 Chrome 实际读取，不需要你再访问网站：${JSON.stringify(capture)}。用 smartsell_operation_call 调 research_add_item，params.id=${board.id}，body={item_type:'link',url:来源URL,title:商品名,body:上述采集结果的 JSON 字符串,labels:['授权样页']}，再调 research_board_get 回读持久化字段。`,`再从平台读这条记录和任务，逐项给出价格、库存、来源、采集时间与记录 ID。不要重复写。`]
  };const enabled=Object.entries(prompts).filter(([k])=>selected(k));await json('operator-prompts.json',Object.fromEntries(enabled));
  const results=await Promise.allSettled(enabled.map(async([k,p])=>[k,await native(k,p)]));
  const nativeSummary={};for(const result of results)if(result.status==='fulfilled')nativeSummary[result.value[0]]=result.value[1];else console.error(result.reason);
  const read=async path=>{try{return await rest('GET',`${root}${path}`)}catch(e){return {readError:e.message}}};
  const [targets,posts,products,savedStore,savedBoard,activity,imports]=await Promise.all(['/publish-targets','/platform-posts','/products',`/stores/${store.id}`,`/research-boards/${board.id}`,'/views/activity?limit=100','/imports'].map(read));
  const importRows=Array.isArray(imports)?await Promise.all(imports.map(async b=>({batchId:b.id,rows:await read(`/imports/${b.id}/rows`)}))):[];
  const summary={at:now(),nativeSummary,jobs:{},posts:Array.isArray(posts)?posts.length:null};
  for(const [k,j] of Object.entries(jobs)){const job=await read(`/agent-jobs/${j.id}`);summary.jobs[k]={id:j.id,status:job.status,result:job.result_ref};await json(`${k}/platform-readback.json`,{at:now(),deviceId:null,job,...(k==='01-video'?{targets,posts}:k==='02-shop'?{products,store:savedStore,imports,importRows}:{board:savedBoard,capture})});}
  await json('platform-activity.json',activity);await json('summary.json',summary);
  if (selected('01-video')) {
    assert.ok(videoSchedule && Array.isArray(targets) && targets.length === 1, 'Expected one real video target');
    const initial = targets[0];
    const targetId = initial.id;
    const due = Date.parse(initial.scheduled_at);
    const leadMs = due - Date.parse(initial.created_at);
    assert.equal(initial.schedule_tz, scheduleTz);
    assert.equal(due, Date.parse(videoSchedule.scheduledAt));
    assert.ok(Math.abs(leadMs - scheduleOffsetMs) <= 5000, `Observed lead: ${leadMs} ms`);
    const shanghai = value => new Date(value).toLocaleString('sv-SE', { timeZone: scheduleTz,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const sample = async (phase, earliest) => {
      while (Date.now() < earliest) await delay(Math.min(1000, earliest - Date.now()));
      const requestedAt = now();
      const target = await rest('GET', `${root}/publish-targets/${targetId}`);
      const receivedAt = now();
      assert.equal(target.id, targetId);
      assert.equal(target.scheduled_at, initial.scheduled_at);
      const postRows = await rest('GET', `${root}/platform-posts`);
      assert.ok(Array.isArray(postRows));
      assert.equal(postRows.length, 0);
      assert.equal(target.platform_post_id, null);
      assert.equal(target.published_at, null);
      return { phase, targetId, requestedAt, receivedAt, requestedAtShanghai: shanghai(requestedAt),
        requestOffsetMs: Date.parse(requestedAt) - due, planStatus: target.plan_status, displayStatus: target.display_status,
        approvalRequestId: target.approval_request_id, precheckSummary: target.precheck_summary,
        executionStatus: target.execution_status, executionSubstatus: target.execution_substatus,
        platformPostId: target.platform_post_id, publishedAt: target.published_at, platformPostCount: postRows.length };
    };
    const samples = [await sample('before_due', 0)];
    assert.ok(samples[0].requestOffsetMs < 0, 'Initial read missed the before-due window');
    console.log(`Video target ${targetId} due ${initial.scheduled_at}; waiting for same-target reads`);
    samples.push(await sample('due', due), await sample('after_due', due + 15000));
    const finalActivity = await rest('GET', `${root}/views/activity?limit=100`);
    const audit = finalActivity.filter(row => row.resource?.id === targetId).map(row => ({ id: row.id, action: row.action,
      source: row.source, actorType: row.actor?.type, occurredAt: row.occurred_at, count: row.count, targetId }));
    for (const action of ['publishing_create_target', 'publishing_request_approval']) {
      assert.equal(audit.filter(row => row.action === action && row.source === 'mcp').length, 1, `Missing or duplicate audit: ${action}`);
    }
    const receipt = { targetId, jobId: jobs['01-video'].id, scheduleTz, targetCreatedAt: initial.created_at,
      targetCreatedAtShanghai: shanghai(initial.created_at), scheduleRequestAt: videoSchedule.requestAt,
      scheduledAt: initial.scheduled_at, scheduledAtShanghai: shanghai(initial.scheduled_at),
      expectedLeadMs: scheduleOffsetMs, observedLeadMs: leadMs, deviationMs: leadMs - scheduleOffsetMs, samples, audit };
    await json('01-video/three-minute-receipt.json', receipt);
    if (selection.size === 1) {
      const output = resolve(here, 'three-minute');
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, `${run}.receipt.json`), JSON.stringify(scrub(receipt), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify(receipt));
  }
}catch(e){await json('run-error.json',{at:now(),error:e.message,stack:e.stack});throw e}
finally{
  if(conn)await rest('DELETE',`${root}/agent-connections/${conn.id}`).catch(()=>{});
  if(client)await client.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});
  if(server&&server.exitCode==null&&server.signalCode==null)await new Promise(ok=>{server.once('exit',ok);server.kill('SIGTERM')});
  videoMcp?.close();
  videoMcp?.closeAllConnections();
  fixture.close();
  if(meta){const db=new DatabaseSync(dbPath,{readOnly:true});try{const snap=JSON.parse(db.prepare('SELECT payload FROM snapshot WHERE id=1').get().payload);const rows=snap.records.flatMap(([key,r])=>{const match=/(?:^|[/"_])(activity_event|agent_job_event|agent_tool_call|import_batch|execution_attempt|platform_post)(?:$|[/"])/.exec(`${key} ${r.kind} ${r.id}`);if(!match)return [];const d=r.data;return [{kind:match[1],id:r.id,data:typeof d?.value==='string'?JSON.parse(d.value):d}]});await json('platform-audit-rows.json',{at:now(),rows});}finally{db.close()}}
}
