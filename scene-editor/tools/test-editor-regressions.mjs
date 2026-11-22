import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {ROOT,workDir} from './test-env.mjs';
import {bundleModules} from '../studio/plugin-bundle.mjs';
import {installedPlugins,loadPlugins,projectPlugins,registerPlugin} from '../studio/plugins.mjs';
import {createWorld} from '../studio/world.mjs';
import {pluginIssues} from '../studio/plugin-availability.mjs';
import {drawScene} from '../studio/view.mjs';
import {parse} from '../studio/vendor/acorn.mjs';

const manifest=id=>({id,name:id,version:'1.0.0',description:'测试',author:'test',apiVersion:1,
  runtime:'runtime.mjs',provides:{modes:[],entities:[],actions:[]}});
const request=id=>[{id,minVersion:'1.0.0'}];
const source=file=>fs.readFileSync(path.join(ROOT,file),'utf8');

test('08 离线导出解析完整模块图和静态链接',async()=>{
  const m=manifest('link-test');
  registerPlugin(m,{});
  const project={plugins:request(m.id)},base='/plugins/link-test/';
  const files=new Map([
    ['runtime.mjs',[
      'const text="import(ignored)"; /* export * from "./unused.mjs" */',
      'const template=`not an import("./unused.mjs")`; const re=/import\\(/;',
      'import /* comment */ {counter} from "./bridge.mjs";',
      'export default {counter};'
    ].join('\n')],
    ['bridge.mjs','const first=true; export /* comment */ {n as counter} from "./leaf.mjs"; import "./带 空格.mjs?v=1";'],
    [encodeURI('带 空格.mjs?v=1'),'export const asset=3;'],
    ['leaf.mjs','export const n=3;']
  ]);
  const read=file=>{
    if(!file.startsWith(base))return source(file);
    const key=file.slice(base.length);
    if(!files.has(key))throw Error('缺少模块 '+key);
    return files.get(key);
  };
  const modules=await bundleModules(project,read);
  assert.ok(modules['plugin/link-test/leaf']);
  assert.match(modules['plugin/link-test/runtime'],/from "plugin\/link-test\/bridge"/);
  for(const [bad,reason] of [
    ['export const n=`value ${import("./nested.mjs")}`;',/动态 import/],
    ['export const n=;',/leaf\.mjs/],
    ['export const wrong=1;',/bridge\.mjs.*counter|bridge\.mjs.*n|runtime\.mjs.*counter/],
    ['export {x as n} from "./missing.mjs";',/missing\.mjs/],
  ]){
    files.set('leaf.mjs',bad);
    await assert.rejects(()=>bundleModules(project,read),reason);
  }
});

test('09 内置清单入口兼容 Node 20.0 的模块语法，并读取发布用清单',()=>{
  parse(source('studio/plugins/builtin/catalog.mjs'),{ecmaVersion:2023,sourceType:'module'});
  for(const id of ['dungeon','kart'])assert.deepEqual(installedPlugins().get(id).manifest,
    JSON.parse(source('studio/plugins/builtin/'+id+'/plugin.json')));
  const checked=spawnSync(process.execPath,['tools/scene.mjs','validate','examples/dungeon-demo.scene.json'],
    {cwd:ROOT,encoding:'utf8',windowsHide:true});
  assert.equal(checked.status,0,checked.stderr);
});

test('10 保存并恢复插件随机数序列，包括旧存档',()=>{
  const m=manifest('seed-test'),mode='seed-test.sim';
  m.provides.modes=[mode];
  registerPlugin(m,{modes:{[mode]:{enter:({rng})=>({initial:rng()}),
    step:({rng,state,move})=>{state.flags.roll=rng();move();}}}});
  const p={id:'rng',plugins:request(m.id),start:{room:'r',entry:'e'},rooms:{r:{w:100,h:100,mode,
    entries:{e:{x:25,y:25}},entities:[{id:'save',kind:'savepoint',x:22,y:23,w:8,h:8}]}},events:{}};
  const w=createWorld(p,{validated:true});
  for(let i=0;i<3;i++)w.step();
  w.step({press:['act']});
  assert.ok(w.resolveSave(true));
  const save=w.takeSave();
  const rolls=()=>Array.from({length:4},()=>w.step().flags.roll);
  const expected=rolls();
  w.restoreSave(save);
  assert.deepEqual(rolls(),expected);
  delete save.snapshot.rngState;
  w.restoreSave(save);
  const legacy=rolls();
  rolls();w.restoreSave(save);
  assert.deepEqual(rolls(),legacy);
});

test('11 新发现的停用、缺失、版本变化优先于已加载实现',async()=>{
  const m=manifest('refresh-test'),req=request(m.id),entry={manifest:m,base:'/plugins/refresh-test/'};
  let imports=0;
  const load=entries=>loadPlugins(req,entries,async()=>{imports++;return {default:{}};});
  assert.deepEqual(await load([entry]),[]);
  assert.deepEqual(await load([entry]),[]);
  assert.equal(imports,1);
  assert.match((await load([{...entry,enabled:false}])).join(' '),/停用/);
  assert.match((await load([])).join(' '),/缺少插件/);
  assert.match((await load([{...entry,manifest:{...m,version:'0.8.0'}}])).join(' '),/1\.0\.0/);
  assert.match((await load([{...entry,manifest:{...m,version:'2.0.0'}}])).join(' '),/2\.0\.0/);
  assert.match(pluginIssues(req,[{...entry,manifest:{...m,version:'2.0.0'}}],installedPlugins()).join(' '),/2\.0\.0/);
});

test('13 编辑器面板的诊断保留至成功重试',async()=>{
  const m={...manifest('panel-test'),editor:'panel.mjs'},req=request(m.id),entry={manifest:m,base:'/plugins/panel-test/'};
  const load=fn=>loadPlugins(req,[entry],fn,{editor:true});
  const runtimeErrors=await load(()=>{throw Error('runtime failure');});
  const errors=await load(url=>{
    if(url.endsWith('panel.mjs'))throw Error('panel failure');
    return {default:{}};
  });
  assert.deepEqual(projectPlugins({plugins:req}).editorErrors,errors);
  assert.match(errors[0],/编辑器入口.*panel\.mjs.*panel failure/);
  assert.match(runtimeErrors[0],/运行时入口.*runtime\.mjs.*runtime failure/);
  assert.deepEqual(projectPlugins({plugins:req}).editors,[]);
  assert.deepEqual(await load(()=>({default:{}})),[]);
  assert.deepEqual(projectPlugins({plugins:req}).editorErrors,[]);
});

test('14 地面和角色两层按顺序调用实体绘制钩子',()=>{
  const m=manifest('paint-test'),mode='paint-test.sim',kinds=['paint-test.ground','paint-test.actor'],calls=[];
  m.provides.modes=[mode];m.provides.entities=kinds;
  registerPlugin(m,{modes:{[mode]:{groundKinds:[kinds[0]]}},
    entities:Object.fromEntries(kinds.map(kind=>[kind,{draw:({entity,tick})=>calls.push([entity.id,tick])}]))});
  const p={plugins:request(m.id),rooms:{r:{w:80,h:80,mode,entities:[
    {id:'actor',kind:kinds[1],x:0,y:0,w:2,h:2},{id:'ground',kind:kinds[0],x:0,y:20,w:2,h:2}]}}};
  const ctx=new Proxy({canvas:{width:80,height:80}},{get:(o,k)=>o[k]??(()=>{})});
  drawScene(ctx,p,'r',{maps:{},images:new Map()},{edit:true});
  assert.deepEqual(calls,[['ground',0],['actor',0]]);
});

test('21 总入口向三组混合测试的实际子进程转发 --browser',()=>{
  const dir=workDir('runner-regression'),tools=path.join(dir,'tools');
  fs.mkdirSync(tools);
  for(const name of ['test-all.mjs','test-env.mjs'])fs.copyFileSync(path.join(ROOT,'tools',name),path.join(tools,name));
  for(const name of ['test-settings','test-native-server','test-plugin-manager']){
    const file=name+'.mjs';
    fs.writeFileSync(path.join(tools,file),'console.log(JSON.stringify(process.argv.slice(2)))');
    for(const flags of [[],['--browser']]){
      const result=spawnSync(process.execPath,[path.join(tools,'test-all.mjs'),'--only',name,...flags],
        {cwd:dir,encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr);
      const {results}=JSON.parse(fs.readFileSync(path.join(dir,'.codex-tmp/test-report.json')));
      const args=JSON.parse(fs.readFileSync(path.join(dir,results[0].log)));
      assert.deepEqual(args,flags,name);
    }
  }
});
