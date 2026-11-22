import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pluginIssues} from '../studio/plugin-availability.mjs';
import {ROOT,args,data,openBrowserTest,pythonCommand,startTestStudio,workDir} from './test-env.mjs';

const dir=workDir('plugin-manager'), pluginDir=path.join(dir,'plugins');
const source=path.join(ROOT,'examples/plugins/fireflies');
const project=JSON.parse(fs.readFileSync(path.join(source,'demo.scene.json'),'utf8'));
const options=['--data',dir];
const servers=[];
async function launch(){
  const server=await startTestStudio(options);servers.push(server);return server;
}
async function request(server,route,body,expected=200,extra={}){
  const response=await fetch(server.origin+route,body===undefined?undefined:{
    method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body),
  });
  const content=await response.text();
  assert.equal(response.status,expected,content);
  return response.headers.get('content-type')?.includes('application/json')?JSON.parse(content):content;
}
const api='/api/studio/', plugins=api+'plugins', savedProject=api+'projects/firefly-test';
const list=async server=>(await request(server,plugins)).plugins;
const manage=(server,id,action,expected)=>request(server,plugins+'/'+id+'/'+action,{},expected);
const install=(server,body,expected=201)=>request(server,plugins+'/install',body,expected);

const manifest=(id,extra={})=>JSON.stringify({id,name:'安装测试',version:'1.0.0',apiVersion:1,
  description:'测试安装入口。',author:'Scene Studio',runtime:'runtime.mjs',
  provides:{modes:[],entities:[],actions:[]},...extra});
function zip(entries){
  const [exec,...flags]=pythonCommand();
  const result=spawnSync(exec,[...flags,'-c',`
import base64, io, json, stat, sys, zipfile
target = io.BytesIO()
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for name, content, kind in json.load(sys.stdin):
        entry = zipfile.ZipInfo(name)
        entry.create_system = 3
        entry.external_attr = ((stat.S_IFLNK if kind == "link" else stat.S_IFREG) | 0o644) << 16
        archive.writestr(entry, content, compress_type=zipfile.ZIP_DEFLATED)
sys.stdout.write(base64.b64encode(target.getvalue()).decode("ascii"))`],{
    input:JSON.stringify(entries.map(([name,content,kind])=>[name,content,kind??'file'])),encoding:'utf8',
  });
  assert.equal(result.status,0,result.stderr);
  return result.stdout;
}
const zipFiles=(id,extra,prefix='')=>[
  [prefix+'plugin.json',manifest(id,extra)],[prefix+'runtime.mjs','export default {};'],
];

try{
  const server=await launch();
  await request(server,api+'settings',{settings:{firstRunDone:true}});
  const builtins=await list(server);
  assert.ok(builtins.some(e=>e.manifest.id==='dungeon'&&e.enabled&&e.source==='builtin'));
  assert.match((await manage(server,'dungeon','disable',403)).error,/内置插件/);
  assert.match((await manage(server,'kart','uninstall',403)).error,/内置插件/);
  assert.match((await request(server,api+'settings',{settings:{pluginEnabled:{kart:false}}}))
    .results.pluginEnabled.reason,/内置插件/);
  assert.match((await request(server,plugins+'/install',{folder:source},403,{Origin:'https://invalid.example'})).error,/跨站/);
  const folder=await install(server,{folder:source});
  assert.deepEqual(folder,{ok:true,id:'fireflies',enabled:true});
  assert.equal(fs.readFileSync(path.join(source,'plugin.json'),'utf8'),fs.readFileSync(path.join(pluginDir,'fireflies/plugin.json'),'utf8'));
  assert.match((await install(server,{folder:source},409)).error,/ID 已存在.*fireflies/);
  assert.match((await install(server,{zip:zip(zipFiles('dungeon'))},409)).error,/ID 已存在.*dungeon/);
  let entry=(await list(server)).find(e=>e.directory==='fireflies');
  assert.equal(entry.source,'user');assert.equal(entry.enabled,true);assert.deepEqual(entry.errors,[]);
  assert.match(await request(server,'/plugins/fireflies/runtime.mjs'),/export default/);

  const companion=zip(zipFiles('zip-demo',{dependencies:[{id:'fireflies',minVersion:'1.0.0'}]},'wrapper/'));
  assert.equal((await install(server,{zip:companion})).id,'zip-demo');
  const unsafeCases=[
    [['../escaped.mjs','export default {};'],/不安全的路径/],
    [['C:\\escaped.mjs','export default {};'],/不安全的路径/],
    [['bad.exe','file'],/非法文件类型/],
    [['link.mjs','runtime.mjs','link'],/符号链接/],
    [['RUNTIME.mjs','export default {};'],/冲突路径/],
  ];
  for(const [entry,message] of unsafeCases){
    assert.match((await install(server,{zip:zip([...zipFiles('bad'),entry])},422)).error,message);
    assert.equal(fs.existsSync(path.join(pluginDir,'bad')),false);
  }
  assert.equal(fs.existsSync(path.join(pluginDir,'escaped.mjs')),false);
  assert.equal(fs.existsSync(path.join(dir,'escaped.mjs')),false);
  assert.match((await install(server,{zip:'!!!'},422)).error,/Base64/);
  const wrongVersion=await install(server,{zip:zip(zipFiles('bad',{apiVersion:2}))},422);
  assert.match(wrongVersion.errors.join(' '),/API 版本/);
  const badId=await install(server,{zip:zip(zipFiles('Bad'))},422);
  assert.match(badId.errors.join(' '),/插件 ID/);
  assert.deepEqual(fs.readdirSync(pluginDir).sort(),['fireflies','zip-demo']);
  const badFolder=path.join(dir,'invalid-folder');
  fs.cpSync(source,badFolder,{recursive:true});
  fs.writeFileSync(path.join(badFolder,'extra.exe'),'fixture');
  assert.match((await install(server,{folder:badFolder},422)).error,/非法文件类型/);

  const file=await request(server,savedProject,{project,revision:null});
  assert.ok(file.revision);
  const tracked=api+'plugin-projects';
  await request(server,tracked,{tab:'test-tab',project:{id:'active',title:'已打开的测试工程',plugins:['zip-demo']}});
  entry=(await list(server)).find(e=>e.directory==='fireflies');
  assert.deepEqual(entry.projects,[{id:'active',title:'已打开的测试工程'}]);
  await request(server,tracked,{tab:'test-tab',project:null});
  assert.deepEqual((await list(server)).find(e=>e.directory==='fireflies').projects,[]);
  await request(server,plugins+'/fireflies/disable',{},403,{Origin:'https://invalid.example'});
  assert.equal((await manage(server,'fireflies','disable')).enabled,false);
  assert.match((await request(server,'/plugins/fireflies/runtime.mjs',undefined,403)).error,/fireflies.*已停用/);
  assert.match((await request(server,savedProject,{project,revision:file.revision},422))
    .issues[0].message,/fireflies.*已停用.*启用/);
  assert.match(pluginIssues(project.plugins,await list(server)).join(' '),/fireflies.*已停用.*插件管理/);
  assert.match(pluginIssues([{id:'zip-demo',minVersion:'1.0.0'}],await list(server)).join(' '),/fireflies.*已停用/);
  assert.deepEqual((await request(server,savedProject)).project,project);
  await server.close();

  const restarted=await launch();
  assert.equal((await list(restarted)).find(e=>e.directory==='fireflies').enabled,false);
  if(args.includes('--browser')){
    const {edge}=await openBrowserTest(restarted.origin,data.battleRoot,{profileDir:path.join(dir,'edge')});
    try{
      console.log('Edge 已连接，正在启用 CDP 页面域');
      await edge.cdp.send('Page.enable');
      await edge.cdp.send('Page.navigate',{url:restarted.origin+'/?project=firefly-test'});
      for(let i=0;i<150;i++){
        const response=await edge.cdp.send('Runtime.evaluate',{expression:
          "document.body?.dataset.ready==='true'&&/fireflies.*已停用.*插件管理/.test(document.querySelector('#status').textContent)",
          returnByValue:true});
        if(response.result.value)break;
        if(i===149)throw Error('编辑器没有显示插件停用提示');
        await new Promise(r=>setTimeout(r,100));
      }
    }finally{await edge.close();}
  }
  assert.equal((await manage(restarted,'fireflies','enable')).enabled,true);
  assert.deepEqual(pluginIssues(project.plugins,await list(restarted)),[]);
  await request(restarted,savedProject,{project,revision:file.revision});
  const {trash}=await manage(restarted,'fireflies','uninstall');
  assert.equal(path.dirname(trash),path.join(pluginDir,'.plugins-trash'));
  assert.equal(fs.existsSync(path.join(pluginDir,'fireflies')),false);
  assert.deepEqual(fs.readFileSync(path.join(trash,'plugin.json')),fs.readFileSync(path.join(source,'plugin.json')));
  await request(restarted,'/plugins/fireflies/runtime.mjs',undefined,404);
  assert.match(pluginIssues(project.plugins,await list(restarted)).join(' '),/缺少插件 fireflies.*安装/);
  assert.ok((await list(restarted)).find(e=>e.directory==='zip-demo').errors.some(e=>e.includes('fireflies')));
  await restarted.close();
  const restored=await launch();
  assert.equal((await request(restored,api+'settings')).settings.pluginEnabled.value.fireflies,true);
  console.log('PASS · 文件夹与 ZIP 安装、归档校验、冲突、插件开关、工程依赖提示与回收区');
}finally{
  for(const server of servers.reverse())await server.close();
}

await import('./test-f2-regressions.mjs');
