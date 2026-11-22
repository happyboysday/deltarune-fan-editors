import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {ROOT,args,data,copyProjects,openBrowserTest,requireData,requirePath,startStudioServer,workDir} from './test-env.mjs';
import {validateProject} from '../studio/format.mjs';
import {prepareArt,packArt} from '../studio/resources.mjs';
import {bundleModules,makeHtml} from '../studio/standalone.mjs';

const tmp=workDir('native-server');
const aExport=data.aExport;
const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8v5ThPwMDAwMTiEBhAABBWAKp5HYwGwAAAABJRU5ErkJggg==';
const small='iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAEklEQVR4nGNgYPj/n4mBgYEBAA0HAgFq0sgnAAAAAElFTkSuQmCC';
const upload={chapter:'ch1',name:'测试 PNG',png_base64:png};
const sequence={format:'director-animation-import/1',chapter:'ch1',character:'测试',action:'走',order:'natural',
  defaults:{fps:8,loop:true},origin:{x:1,y:2},frames:[{name:'f10.png',png_base64:png},{name:'f2.png',png_base64:small}]};
const services=[];
const launch=async options=>{const server=await startStudioServer(options);services.push(server);return server;};

async function request(server,route,body){
  const res=await fetch(server.origin+route,body===undefined?{}:{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const bytes=Buffer.from(await res.arrayBuffer()),kind=res.headers.get('content-type');
  return {status:res.status,kind,body:kind?.startsWith('application/json')?JSON.parse(bytes):bytes};
}
async function ok(server,route,body){
  const result=await request(server,route,body);
  assert.equal(result.status,200,route+' '+JSON.stringify(result.body).slice(0,350));
  return result.body;
}

function stageReference(){
  // V0.6 can extract UI audio beside its script. Run its unmodified files from a private copy.
  const src=path.resolve(process.env.SCENE_V06_ROOT||path.join(data.battleRoot,'../场景编辑器'));
  requirePath(path.join(src,'studio_server.py'),'V0.6 参照');
  const stage=path.join(tmp,'v06');
  fs.mkdirSync(stage);
  for(const name of fs.readdirSync(src).filter(n=>n.endsWith('.py')).concat('studio','tools','examples')){
    fs.cpSync(path.join(src,name),path.join(stage,name),{recursive:true});
  }
  return path.join(stage,'studio_server.py');
}

async function standaloneSmoke(){
  const empty=path.join(tmp,'empty'),projects=path.join(tmp,'smoke','projects');
  const server=await launch({base:null,aExport:null,projects,options:['--assets',empty,'--official-root',empty,
    '--battle-assets',empty,'--battle-root',empty,'--chapters',empty,'--ch6-assets',empty]});
  const home=await ok(server,'/');
  assert.match(home.toString(),/id="layoutLink" hidden/);
  assert.match((await ok(server,'/layout/')).toString(),/--base/);
  for(const url of ['/api/a/rooms','/api/a/rooms/room_beach','/a-files/exports/manifest.json']){
    const r=await request(server,url);
    assert.equal(r.status,503);assert.match(r.body.error,/未找到 A-export/);
  }
  const custom=(await ok(server,'/api/custom-assets',upload)).asset;
  const anim=(await ok(server,'/api/animations/import',sequence)).asset;
  const {assets}=await ok(server,'/api/assets/resolve',{chapter:'ch1',ids:[custom.asset,anim.asset]});
  assert.deepEqual(assets,[custom,anim]);
  assert.deepEqual(await ok(server,custom.url),Buffer.from(png,'base64'));
  assert.ok((await ok(server,anim.url)).length);
  await server.close();
  console.log('零 V0.4、零官方数据启动和自定义素材通过');
}

async function parity(native,reference){
  let count=0;
  async function compare(route,body){
    const [actual,want]=await Promise.all([request(native,route,body),request(reference,route,body)]);
    assert.equal(want.status,200,'V0.6 '+route);
    assert.deepEqual(actual,want,route);
    count++;
    return actual.body;
  }
  for(const chapter of ['ch1','ch2','ch3','ch4','ch5']){
    const catalog=await compare('/api/a/rooms?chapter='+chapter);
    const rooms=catalog.rooms.filter(r=>r.map_available);
    for(const r of [rooms[0],rooms[Math.floor(rooms.length/2)]])
      await compare('/api/a/rooms/'+encodeURIComponent(r.id)+'?chapter='+chapter);
  }
  const beach=await compare('/api/a/rooms/room_beach?chapter=ch1');
  const sprites=JSON.parse(fs.readFileSync(path.join(aExport,'sprites.json'),'utf8')).sprites;
  for(const chapter of ['ch1','ch5']){
    const tile=sprites.find(s=>s.kind==='tile_crop'&&s.chapter===chapter);
    const sprite=sprites.find(s=>s.kind==='official_sprite'&&s.chapter===chapter);
    const resolved=await compare('/api/assets/resolve',{chapter,ids:[tile.id,sprite.id,'missing']});
    assert.equal(resolved.assets.length,2);
    for(const row of resolved.assets)await compare(row.url);
    await compare('/official/'+sprite.path);
  }
  for(const route of ['/a-files/exports/manifest.json','/a-files/exports/chapters/ch1/rooms.json',
    '/ui-assets/manifest.json','/ui-assets/fonts/fnt_main/glyphs.png','/ui-assets/sprites/spr_heart/0.png',
    '/ui-assets/sounds/snd_select','/api/custom-assets?chapter=ch1','/api/animations?chapter=ch1'])await compare(route);
  const custom=(await compare('/api/custom-assets',upload)).asset;
  const animation=(await compare('/api/animations/import',sequence)).asset;
  assert.equal(custom.sha256,createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'));
  assert.deepEqual(animation.source_frames.map(f=>f.name),['f2.png','f10.png']);
  await compare('/api/animations/import',{...sequence,action:'重复',defaults:{fps:12,loop:false}});
  await compare('/api/animations/import',{...sequence,order:'explicit'});
  await compare('/api/custom-assets?chapter=ch1&q=PNG');
  await compare('/api/animations?chapter=ch1');
  await compare('/api/assets/resolve',{chapter:'ch1',ids:[animation.asset,custom.asset]});
  await compare(custom.url);
  await compare(animation.url);
  console.log('V0.6 响应完整比对通过 '+count+' 项');
  return {custom,animation,beach};
}

async function workflow(server,custom,beach){
  const index=(await ok(server,'/')).toString();
  assert.match(index,/id="layoutLink" hidden/);
  assert.match((await ok(server,'/layout/')).toString(),/--base/);
  const ch5=await ok(server,'/api/studio/example-chapter5');
  assert.equal(Object.keys(ch5.rooms).length,196);
  const layout=await ok(server,'/api/studio/layout/'+ch5.rooms[ch5.start.room].layout);
  const ids=[...new Set(layout.elements.filter(e=>e.asset).map(e=>e.asset))].slice(0,500);
  assert.ok((await ok(server,'/api/assets/resolve',{chapter:'ch5',ids})).assets.length);
  const dungeon=await ok(server,'/api/studio/example-dungeon');
  assert.ok(validateProject(dungeon).ok);
  assert.ok((await ok(server,'/api/studio/dungeon-animations')).length);
  assert.ok(Array.isArray((await ok(server,'/api/studio/official?chapter=ch1&room=room_beach')).candidates));
  const project=await ok(server,'/api/studio/example');
  project.title='T1 素材试玩';
  // Use a real imported layer and a registered asset in the same saved project.
  const map=structuredClone(beach.map);
  const element={...map.elements.find(e=>e.layer),id:'native-upload',kind:'image',file:custom.file,
    asset:custom.asset,visible:true,frame:0,x:40,y:80};
  map.elements.push(element);
  project.rooms[project.start.room].map=map;
  const saved=await ok(server,'/api/studio/projects/t1-native',{project,revision:null});
  assert.deepEqual(await ok(server,'/api/studio/projects/t1-native'),{project,revision:saved.revision});
  // Run the frontend's export pipeline. Node supplies just the relative URL,
  // image-load notification and blob-to-data-URL APIs normally supplied by Edge.
  const realFetch=globalThis.fetch;
  globalThis.fetch=(url,opts)=>realFetch(new URL(url,server.origin),opts);
  globalThis.Image=class {
    set src(url){
      fetch(url).then(async r=>{if(!r.ok)throw Error(url);await r.arrayBuffer();this.onload();}).catch(()=>this.onerror());
    }
  };
  globalThis.FileReader=class {
    async readAsDataURL(blob){
      this.result='data:'+blob.type+';base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');
      this.onload();
    }
  };
  try{
    const art=await prepareArt(project),pack=await packArt(art);
    assert.equal(pack.files[custom.url],'data:image/png;base64,'+png);
    assert.ok(pack.maps[project.start.room].back.concat(pack.maps[project.start.room].front).some(e=>e.url===custom.url));
    assert.ok(Object.keys(pack.ui.files).length);
    // The export bundles the player plus the project's plugins (T2), read through the native server.
    const modules=await bundleModules(project,async file=>(await ok(server,file)).toString());
    const html=makeHtml(project,pack,modules);
    assert.ok(html.includes('data:image/png;base64,'+png)&&html.includes('scene/player'));
    fs.writeFileSync(path.join(tmp,'native-offline.html'),html);
  }finally{
    globalThis.fetch=realFetch;delete globalThis.Image;delete globalThis.FileReader;
  }
  console.log('无 --base 首页、两项示例、官方房间、工程保存和离线打包通过');
}

async function security(server,custom,animation){
  const api='/api/a/rooms';
  for(const [route,method,headers] of [[api,'GET',{Origin:'null'}],[custom.url,'HEAD',{'Sec-Fetch-Site':'cross-site'}],
    [animation.url,'GET',{Origin:'https://example.invalid'}],['/api/custom-assets','POST',{Origin:'null'}]]){
    const r=await fetch(server.origin+route,{method,headers});
    assert.equal(r.status,403);
    if(method==='HEAD')assert.equal(await r.text(),'');
  }
  const hostStatus=await new Promise((resolve,reject)=>http.get(server.origin+'/',{headers:{Host:'example.invalid'}},r=>{
    r.resume();resolve(r.statusCode);
  }).on('error',reject));
  assert.equal(hostStatus,403);
  for(const route of ['/official/%2e%2e%5cmanifest.json','/a-files/baseline/manifest.json'])
    assert.equal((await request(server,route)).status,404);
  const head=await fetch(server.origin+custom.url,{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),Buffer.from(png,'base64').length);
  assert.equal(await head.text(),'');
}

async function portableExport(reference){
  // Install only data. Include the release's companion profiles for the complete room response.
  const assets=path.join(tmp,'portable'),stage=path.join(assets,'a-export');
  const source=path.join(data.base,'management/agents/A-assets'),v8=path.join(source,'exports/v8');
  for(const name of ['manifest.json','sprites.json','rooms.json','chapters.json','chapters/ch1/rooms.json',
      'chapters/ch1/rooms/room_beach.director-map.json']){
    fs.mkdirSync(path.dirname(path.join(stage,name)),{recursive:true});
    fs.copyFileSync(path.join(v8,name),path.join(stage,name));
  }
  const bare=await launch({base:null,aExport:null,options:['--assets',assets]});
  const rawRoom=await ok(bare,'/api/a/rooms/room_beach?chapter=ch1');
  assert.ok(rawRoom.map.elements.length);
  assert.equal(rawRoom.map.source_import_profile.visibility.applied,false);
  await bare.close();
  for(const name of ['metadata-overlays','metadata-prototypes','interface-review006.md']){
    fs.cpSync(path.join(source,name),path.join(assets,name),{recursive:true});
  }
  fs.mkdirSync(path.join(assets,'integration-admissions'));
  const admission='integration-admissions/review010-origin.json';
  fs.copyFileSync(path.resolve(source,'../..',admission),path.join(assets,admission));
  // The shipped source-only release has no bundled official tree. A full release can
  // use that read-only tree when admitting the profiles.
  const profileOfficial=path.resolve(source,'../../assets/official');
  if(fs.existsSync(profileOfficial))fs.symlinkSync(profileOfficial,path.join(assets,'profile-official'),'junction');
  const script=path.join(tmp,'extension-fixture.py');
  fs.writeFileSync(script,[
    'import sys',
    'sys.dont_write_bytecode = True',
    'sys.path.insert(0, '+JSON.stringify(ROOT)+')',
    'from studio_server import start, arguments',
    'from studio_core.http import Response',
    'def probe(method, path, query, body, head_only):',
    '    if path in ("/api/studio/hook-probe", "/hook-probe/test.js"):',
    '        return Response.json(200, [method, query, body, head_only])',
    'start(arguments(), [lambda *args: None, probe])',
  ].join('\n'));
  const chapters=path.join(tmp,'source-chapters'),state=path.join(tmp,'portable-state');
  const edits=path.join(chapters,'ch5/edits.json');
  fs.mkdirSync(path.dirname(edits),{recursive:true});
  for(const f of ['index.json','edits.json'])fs.copyFileSync(path.join(data.chapters,'ch5',f),path.join(chapters,'ch5',f));
  const original=fs.readFileSync(edits);
  const portable=await launch({base:null,aExport:null,script,options:['--assets',assets,'--chapters',chapters,'--data',state]});
  for(const route of ['/api/a/rooms?chapter=ch1','/api/a/rooms/room_beach?chapter=ch1','/a-files/exports/manifest.json']){
    assert.deepEqual(await ok(portable,route),await ok(reference,route),route);
  }
  assert.deepEqual(await ok(portable,'/api/studio/hook-probe?q=a&q=b',{test:true}),['POST',{q:['a','b']},{test:true},false]);
  assert.deepEqual(await ok(portable,'/hook-probe/test.js'),['GET',{},null,false]);
  const head=await fetch(portable.origin+'/hook-probe/test.js',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal(Number(head.headers.get('content-length')),Buffer.byteLength(JSON.stringify(['HEAD',{},null,true])));
  const room=(await ok(portable,'/api/studio/chapters/5/index')).rooms.find(r=>r.instances.length);
  const {revision}=await ok(portable,'/api/studio/chapters/5/edits');
  const item=room.instances[0];
  await ok(portable,'/api/studio/chapters/5/save',{revision,type:'instance',room:room.id,slot:0,x:item.x+1,y:item.y});
  assert.deepEqual(fs.readFileSync(edits),original);
  const workspaces=path.join(state,'chapter-workspace/ch5');
  assert.ok(fs.readdirSync(workspaces).some(id=>/^[0-9a-f]{64}$/.test(id)&&fs.existsSync(path.join(workspaces,id,'edits.json'))));
  await portable.close();
  console.log('仅含数据的便携 A-export、完整房间响应与额外路由挂钩通过');
}

async function browser(server){
  const {edge}=await openBrowserTest(server.origin,data.battleRoot,{profileDir:path.join(tmp,'edge')});
  const c=edge.cdp;
  async function evalPage(expression){
    const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);
    return r.result.value;
  }
  async function wait(expr){
    for(let i=0;i<300;i++){
      if(await evalPage(expr))return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error(expr+' · '+await evalPage('document.querySelector("#status").textContent'));
  }
  const click=id=>evalPage('document.getElementById('+JSON.stringify(id)+').click()');
  try{
    console.log('Edge 无头静音已连接，正在启用 Page 域');
    await c.send('Page.enable');
    console.log('Edge Page 域已启用，正在打开原生首页');
    await c.send('Page.navigate',{url:server.origin});
    await wait("document.body.dataset.ready==='true' && document.querySelector('#layoutLink').getAttribute('aria-disabled')==='true'");
    await wait("document.querySelector('#rooms').length===196");
    const dungeon=await ok(server,'/api/studio/example-dungeon');
    await click('dungeonExample');await wait("document.querySelector('#title').value==="+JSON.stringify(dungeon.title));
    await click('chapter5Example');await wait("document.querySelector('#rooms').length===196");
    await click('new');
    await evalPage("const ch=document.querySelector('#chapter');ch.value='ch1';ch.dispatchEvent(new Event('change'))");
    await wait("!!document.querySelector('#officialRooms option[value=room_beach]') && !document.querySelector('#importRoom').disabled");
    await evalPage("document.querySelector('#officialRooms').value='room_beach'");
    const before=await evalPage("document.querySelector('#rooms').length");
    await click('importRoom');await wait("document.querySelector('#rooms').length>"+before);
    await evalPage("fetch('/api/custom-assets',{method:'POST',headers:{'Content-Type':'application/json'},body:"+
      JSON.stringify(JSON.stringify(upload))+"}).then(r=>{if(!r.ok)throw Error(r.status)})");
    await click('open');await wait("document.querySelector('#dialog').open");
    await evalPage("document.querySelector('#dialog button[value=ok]').click()");
    await wait("!!document.querySelector('#dialog select')");
    await evalPage("document.querySelector('#dialog select').value='t1-native';document.querySelector('#dialog button[value=ok]').click()");
    await wait("document.querySelector('#title').value==='T1 素材试玩'");
    await c.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:tmp});
    await click('exportHtml');
    await wait("document.querySelector('#status').textContent.includes('已导出')");
    const downloaded=()=>fs.readdirSync(tmp).find(n=>n.endsWith('.html')&&n.startsWith('T1'));
    for(let i=0;i<100&&!downloaded();i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(downloaded(),'Edge 离线 HTML 下载');
    assert.ok(fs.readFileSync(path.join(tmp,downloaded()),'utf8').includes('data:image/png;base64,'+png));
  }finally{await edge.close();}
}

try{
  await standaloneSmoke();
  requireData('base/release/release.json','base/management/agents/A-assets/exports/v8/manifest.json','assets/chapter5','officialRoot');
  const reference=await launch({script:stageReference(),aExport:null});
  const state=path.join(tmp,'data');
  const native=await launch({base:null,options:['--data',state]});
  const {custom,animation,beach}=await parity(native,reference);
  for(const [oldDir,newDir,id] of [['legacy-user-assets','user-assets',custom.sha256],
                                   ['legacy-animations','user-assets/animations',animation.content_sha256]]){
    for(const ext of ['.json','.png']){
      const file=path.join('ch1',id+ext);
      assert.deepEqual(fs.readFileSync(path.join(state,newDir,file)),
        fs.readFileSync(path.join(path.dirname(reference.projects),oldDir,file)));
    }
  }
  assert.ok(fs.readdirSync(path.join(state,'.v04-cache')).length);
  await security(native,custom,animation);
  console.log('Host、Origin、HEAD 与路径边界检查通过');
  await workflow(native,custom,beach);
  const bridge=await launch({aExport:null});
  assert.match((await ok(bridge,'/layout/')).toString(),/studio\/layout-link\.js/);
  assert.match((await ok(bridge,'/js/editor.js')).toString(),/window.DirectorV05Layout/);
  for(const route of ['/layout/','/js/editor.js','/styles.css','/api/assets?chapter=ch1&limit=2']){
    assert.deepEqual(await ok(bridge,route),await ok(reference,route));
  }
  await ok(bridge,'/api/a/status');
  assert.deepEqual(await ok(bridge,'/api/a/rooms/room_beach?chapter=ch1'),beach);
  await bridge.close();
  const projects=copyProjects(),oldData=path.dirname(projects);
  for(const name of ['legacy-user-assets','legacy-animations'])
    fs.cpSync(path.join(path.dirname(reference.projects),name),path.join(oldData,name),{recursive:true});
  const oldBase=path.join(tmp,'old-base');
  const baseOnly=(await ok(reference,'/api/custom-assets',{...upload,name:'旧版目录',png_base64:small})).asset;
  fs.mkdirSync(path.join(oldBase,'user-assets/ch1'),{recursive:true});
  for(const ext of ['.json','.png']){
    const name=baseOnly.sha256+ext;
    fs.copyFileSync(path.join(path.dirname(reference.projects),'legacy-user-assets/ch1',name),path.join(oldBase,'user-assets/ch1',name));
  }
  const missing=await launch({base:null,projects,aExport:path.join(oldBase,'management/agents/A-assets/exports/v8'),options:['--assets',path.join(tmp,'empty-assets'),'--data',path.join(tmp,'empty-state')]});
  assert.deepEqual((await ok(missing,'/api/custom-assets?chapter=ch1')).assets.find(r=>r.asset===custom.asset),custom);
  assert.deepEqual(await ok(missing,baseOnly.url),Buffer.from(small,'base64'));
  const record=path.join(oldBase,'user-assets/ch1',baseOnly.sha256+'.json');
  const prior=fs.readFileSync(record);
  await ok(missing,'/api/custom-assets',{...upload,name:'新登记',png_base64:small});
  assert.deepEqual(fs.readFileSync(record),prior);
  assert.deepEqual(await ok(missing,custom.url),Buffer.from(png,'base64'));
  assert.equal((await ok(missing,'/api/assets/resolve',{chapter:'ch1',ids:[custom.asset,animation.asset]})).assets.length,2);
  assert.deepEqual(await ok(missing,animation.url),await ok(native,animation.url));
  const originalAliases=(await ok(missing,'/api/assets/resolve',{chapter:'ch1',ids:[animation.asset]})).assets[0].aliases;
  const promoted=await ok(missing,'/api/animations/import',{...sequence,action:'本机别名'});
  assert.deepEqual(promoted.asset.aliases.slice(0,-1),originalAliases);
  assert.ok(fs.existsSync(path.join(state,'user-assets/ch1',custom.sha256+'.json')));
  assert.ok(!fs.existsSync(path.join(path.dirname(native.projects),'user-assets')));
  const second=await launch({base:null,aExport:null,options:['--assets',path.join(tmp,'empty-assets'),'--data',state]});
  await Promise.all([ok(native,'/api/animations/import',{...sequence,action:'窗口甲'}),
                     ok(second,'/api/animations/import',{...sequence,action:'窗口乙'})]);
  const [shared]=(await ok(native,'/api/assets/resolve',{chapter:'ch1',ids:[animation.asset]})).assets;
  for(const action of ['窗口甲','窗口乙'])assert.ok(shared.aliases.some(a=>a.action===action));
  await second.close();await missing.close();
  await portableExport(reference);await reference.close();
  if(args.includes('--browser'))await browser(native);
  console.log('PASS · 原生服务、旧数据回退与可选工作台');
}finally{
  for(const server of services.reverse())await server.close();
}
