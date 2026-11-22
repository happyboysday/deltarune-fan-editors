import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT,args,data,openBrowserTest,pythonCommand,requireData,startTestStudio,workDir} from './test-env.mjs';

const dir=workDir('settings'), settingsPath=path.join(dir,'settings.json');
const dirs=(...names)=>{
  const paths=names.map(name=>path.join(dir,name));
  for(const p of paths)fs.mkdirSync(p,{recursive:true});
  return paths;
};
const [assets,cliAssets,projects,plugins,invalid]=dirs('assets/chapter5','cli-assets/ui-sprites','work/projects','plugins','empty');
const launcher=['--data',dir,'--node',process.execPath];
const servers=[];
async function launch(options=[],ephemeral=true){
  const server=await startTestStudio(options,undefined,ephemeral);
  servers.push(server);return server;
}
async function request(server,route,body,expected=200,extra={}){
  const response=await fetch(server.origin+'/api/studio/'+route,body===undefined?undefined:{
    method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body),
  });
  const result=await response.json();
  assert.equal(response.status,expected,JSON.stringify(result));
  return result;
}
const read=server=>request(server,'settings');
const save=(server,settings)=>request(server,'settings',{settings});
const config=()=>JSON.parse(fs.readFileSync(settingsPath,'utf8'));

try{
  const empty=await launch([...launcher,'--battle-assets',invalid,'--official-root',invalid,'--battle-root',invalid]);
  const first=await read(empty);
  assert.equal(first.settings.assets.source,'default');
  assert.equal(first.settings.base.value,null);
  assert.equal(first.settings.firstRunDone.value,false);
  assert.equal(first.settings.version.value,1);
  assert.equal(first.settings.port.source,'cli');
  assert.equal(first.boundPort,Number(new URL(empty.origin).port));
  assert.equal(fs.existsSync(settingsPath),false);
  const {capabilities}=await request(empty,'capabilities');
  for(const [key,setting] of Object.entries({roomImport:'aExport',officialAssets:'officialRoot',chapter5:'assets',
    chapters:'assets',uiAssets:'battleAssets',officialArt:'assets',battle:'battleRoot',battleAssets:'battleAssets',
    layout:'base',trailer:'trailerRoot',ch6Assets:'ch6Assets'})){
    assert.equal(capabilities[key].available,false,key);
    assert.ok(capabilities[key].missingSettings.includes(setting),key);
    assert.match(capabilities[key].reason,/\p{Script=Han}/u,key);
  }
  assert.equal(typeof capabilities.chapters.realGame,'boolean');
  assert.equal(capabilities.plugins.available,true);
  assert.ok((await request(empty,'settings/detect')).results.assets.reason);
  const rejected=await request(empty,'settings',{settings:{firstRunDone:true}},403,{Origin:'https://invalid.example'});
  assert.match(rejected.error,/跨站/);
  await request(empty,'restart',{},403,{Origin:'https://invalid.example'});

  const partial=await save(empty,{assets:path.dirname(assets),officialRoot:invalid,base:invalid,aExport:invalid,
    ch6Assets:invalid,plugins:path.join(dir,'missing-plugins'),projects,firstRunDone:true});
  assert.equal(partial.ok,false);
  for(const key of ['officialRoot','base','aExport','ch6Assets','plugins','firstRunDone'])assert.equal(partial.results[key].ok,false,key);
  assert.match(partial.results.base.reason,/server\.py/);
  assert.match(partial.results.aExport.reason,/rooms\.json/);
  assert.equal(partial.settings.assets.value,ROOT);
  assert.equal(partial.settings.assets.pending.value,path.dirname(assets));
  const initialSaved=config();
  assert.deepEqual([initialSaved.assets,initialSaved.projects,initialSaved.version],[path.dirname(assets),projects,1]);
  assert.equal(initialSaved.aExport,null);
  assert.equal(initialSaved.officialRoot,null);
  assert.equal(initialSaved.firstRunDone,false);
  const before=fs.readFileSync(settingsPath);
  assert.equal((await save(empty,{firstRunDone:true,plugins})).ok,true);
  assert.deepEqual(fs.readFileSync(settingsPath+'.bak'),before);
  assert.equal(config().firstRunDone,true);
  assert.match((await save(empty,{port:18947})).results.port.reason,/命令行/);
  assert.equal(config().port,null);
  assert.equal((await request(empty,'restart',{},202)).exitCode,3);
  assert.equal(await empty.exited,3);

  fs.writeFileSync(settingsPath,JSON.stringify({...config(),port:0,assets:'assets'}));
  const persisted=await launch(launcher,false);
  const active=await read(persisted);
  assert.deepEqual([active.settings.assets.value,active.settings.assets.source],[path.dirname(assets),'settings']);
  assert.deepEqual([active.settings.projects.value,active.settings.projects.source],[projects,'settings']);
  assert.equal(active.data,dir);
  assert.equal(active.settings.port.source,'settings');
  assert.equal(active.firstRunDone,true);
  assert.match(persisted.output(),/assets = .*\(settings\)/);
  assert.match(persisted.output(),/port = \d+ \(settings\)/);
  await persisted.close();

  const override=await launch([...launcher,'--assets',path.dirname(cliAssets)]);
  const cli=await read(override);
  assert.equal(cli.settings.assets.value,path.dirname(cliAssets));
  assert.equal(cli.settings.assets.source,'cli');
  assert.equal(cli.settings.port.source,'cli');
  const locked=await save(override,{assets:path.dirname(assets),port:4444});
  assert.equal(locked.ok,false);
  assert.match(locked.results.assets.reason,/命令行/);
  assert.equal(config().assets,'assets');
  assert.equal(config().port,0);
  const peer=await launch(launcher);
  const baseline=new Set(fs.readdirSync(dir));
  await Promise.all([save(override,{firstRunDone:false}),save(peer,{trailerRoot:data.trailerRoot}),
    save(override,{projects})]);
  assert.equal(config().firstRunDone,false);
  assert.equal(config().trailerRoot,data.trailerRoot);
  assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(settingsPath+'.bak','utf8')));
  assert.deepEqual(new Set(fs.readdirSync(dir)),baseline);
  await peer.close();
  await override.close();

  const broken=Buffer.from('{配置已损坏');
  fs.writeFileSync(settingsPath,broken);
  const recovered=await launch(launcher);
  const recovery=await read(recovered);
  assert.equal(recovery.firstRunDone,false);
  assert.equal(recovery.settings.assets.source,'default');
  assert.equal(recovery.settings.projects.value,path.join(dir,'projects'));
  assert.match(recovery.warning,/设置文件损坏，已备份为/);
  assert.equal((await request(recovered,'capabilities')).warning,recovery.warning);
  const backups=fs.readdirSync(dir).filter(name=>name.startsWith('settings.json.corrupt-'));
  assert.equal(backups.length,1);
  assert.deepEqual(fs.readFileSync(path.join(dir,backups[0])),broken);
  assert.equal(fs.existsSync(settingsPath),false);
  if(args.includes('--browser')){
    const {edge}=await openBrowserTest(recovered.origin,data.battleRoot,{profileDir:path.join(dir,'edge')});
    try{
      console.log('Edge 已连接，正在启用 CDP 页面域');
      await edge.cdp.send('Page.enable');
      await edge.cdp.send('Page.navigate',{url:recovered.origin+'/?blank'});
      async function until(expression){
        for(let i=0;i<150;i++){
          const response=await edge.cdp.send('Runtime.evaluate',{expression,returnByValue:true,userGesture:true});
          if(response.result.value)return;
          await new Promise(r=>setTimeout(r,100));
        }
        throw Error(expression);
      }
      await until("location.pathname==='/studio/settings.html'&&document.getElementById('heading')?.textContent==='首次启动引导'");
      await until("document.getElementById('save').click(),true");
      await until("document.getElementById('status')?.textContent.includes('设置已保存')");
      await edge.cdp.send('Page.navigate',{url:recovered.origin+'/?blank'});
      await until("document.body?.dataset.ready==='true'&&document.getElementById('importRoom').disabled&&document.getElementById('layoutLink').getAttribute('aria-disabled')==='true'");
    }finally{await edge.close();}
  }else assert.equal((await save(recovered,{firstRunDone:true})).ok,true);
  assert.equal(config().firstRunDone,true);

  const [cliProjects]=dirs('cli-state/projects');
  const inferred=await launch(['--projects',cliProjects]);
  assert.equal((await read(inferred)).data,path.dirname(cliProjects));
  assert.equal((await read(inferred)).settings.projects.source,'cli');

  const realSettings=['assets','battleAssets','officialRoot','aExport','battleRoot','ch6Assets','trailerRoot'];
  const assetsPaths=requireData(...realSettings);
  const fullState=workDir('settings-capabilities');
  fs.writeFileSync(path.join(fullState,'settings.json'),JSON.stringify({...Object.fromEntries(
    realSettings.map((key,i)=>[key,assetsPaths[i]])),version:1,firstRunDone:true}));
  const full=await launch(['--data',fullState]);
  const fullCapabilities=(await request(full,'capabilities')).capabilities;
  for(const key of ['roomImport','officialAssets','chapter5','chapters','uiAssets','officialArt','battle',
    'battleAssets','trailer','ch6Assets','plugins','dungeonExample','projectSave'])assert.equal(fullCapabilities[key].available,true,key);
  if(process.platform==='win32'){
    const [batch]=dirs('launcher');
    fs.copyFileSync(path.join(ROOT,'launch-v1.cmd'),path.join(batch,'launch-v1.cmd'));
    fs.writeFileSync(path.join(batch,'studio_server.py'),`
import json, sys
from pathlib import Path
log = Path("calls.jsonl")
first = not log.exists()
with log.open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
sys.exit(3 if first else 0)
`);
    const [python,mode]=pythonCommand();
    const env={...process.env};
    if(mode!=='-3')env.PYTHON=python;
    const result=spawnSync(process.env.ComSpec??'cmd.exe',['/d','/c','.\\launch-v1.cmd','--port','24680'],
      {cwd:batch,env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(result.status,0,result.stderr||result.error?.message);
    assert.deepEqual(fs.readFileSync(path.join(batch,'calls.jsonl'),'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line)),
      [['--open','--port','24680'],['--open','--port','24680']]);
  }
  console.log('PASS · 设置优先级、路径校验、原子保存、损坏恢复、能力报告与重启');
}finally{
  for(const server of servers.reverse())await server.close();
}
