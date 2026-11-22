import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {registerPlugin,projectPlugins,invoke} from '../studio/plugins.mjs';
import {validateManifest,resolvePlugins} from '../studio/plugin-manifest.mjs';
import {validateProject} from '../studio/format.mjs';
import {createWorld} from '../studio/world.mjs';
import {projectArtSources} from '../studio/resources.mjs';
import {discover,loadLocalPlugins} from './plugin-files.mjs';
import {ROOT} from './test-env.mjs';

const directory=path.join(ROOT,'examples/plugins');
const p=JSON.parse(fs.readFileSync(path.join(directory,'fireflies/demo.scene.json')));
const entries=discover(directory),sample=entries.find(e=>e.directory==='fireflies').manifest;
assert.ok(entries.every(e=>!e.errors.length));
for(const patch of [{apiVersion:2},{version:'1.x'},{runtime:'../runtime.mjs'},{provides:{}}])
  assert.ok(validateManifest({...sample,...patch}).length);
const available=new Map(entries.map(e=>[e.manifest.id,e]));
const chain=[{id:'fireflies',minVersion:'1.0.0'}],errors=[];
const dependent={...sample,id:'second',dependencies:chain};
available.set('second',{manifest:dependent});
assert.deepEqual(resolvePlugins([{id:'second',minVersion:'1.0.0'}],available,msg=>errors.push(msg)).map(e=>e.manifest.id),['fireflies','second']);
available.set('fireflies',{manifest:{...sample,dependencies:[{id:'second',minVersion:'1.0.0'}]}});
assert.equal(resolvePlugins(chain,available,msg=>errors.push(msg)).length,0);
assert.match(errors.join(' '),/循环依赖/);
assert.ok(validateProject(p).errors.some(e=>e.message.includes('缺少插件 fireflies')));
await loadLocalPlugins(p,directory);
const w=createWorld(p,{autoplay:true});
for(let i=0;i<180;i++)w.step();
assert.equal(w.state.flags.gardenLit,true);
assert.equal(w.state['fireflies.collect'].count,3);
assert.equal(w.entities().length,0);
for(const test of [
  q=>{q.rooms.garden.timeLimit=2;},q=>{q.rooms.garden.entities[0].reach=-1;},
  q=>{q.events.finish[0].flag='';},q=>{q.plugins[0].minVersion='2.0.0';}
]){
  const q=structuredClone(p);test(q);assert.equal(validateProject(q).ok,false);
}
const disabled={...p,plugins:[]};
assert.equal(validateProject(disabled).errors.filter(e=>e.message.includes('缺少插件 fireflies')).length,5);
assert.deepEqual(projectPlugins(disabled).entries,[]);
const {default:editor}=await import('../examples/plugins/fireflies/editor.mjs');
let next,add,fields=[];
editor.mount({project:()=>p,room:()=>p.rooms.garden,button:(label,action)=>{add=action;},commit:value=>{next=value;}});
editor.roomPanel({room:p.rooms.garden,numberField:(_,key)=>fields.push(key)});
editor.entityPanel({entity:p.rooms.garden.entities[0],numberField:(_,key)=>fields.push(key)});
add();
assert.deepEqual(fields,['timeLimit','reach']);assert.equal(p.rooms.garden.entities.length,3);
assert.equal(next.rooms.garden.entities.length,4);assert.ok(validateProject(next).ok);
const calls=[];
const probe={...sample,id:'probe',name:'测试插件',provides:{modes:['probe.sim'],entities:[],actions:[]}};
registerPlugin(probe,{modes:{'probe.sim':{
  enter:({rng})=>({seed:rng()}),
  step:()=>{throw Error('预期的推进异常');},
  drawHud:({ctx})=>{ctx.save();throw Error('预期的绘制异常');},
  exit:({room,local})=>calls.push([room.title,local.seed]),
  validate(){throw Error('预期的校验异常');}
}},preload({needs}){needs.add('/plugins/probe/art.png');}});
const project={...p,rooms:{...p.rooms,garden:{...p.rooms.garden,mode:'probe.sim'}},
  plugins:[...p.plugins,{id:'probe',minVersion:'1.0.0'}]};
assert.ok(validateProject(project).errors.some(e=>/probe.*预期/.test(e.message)));
assert.ok(projectArtSources(project).has('/plugins/probe/art.png'));
const run=()=>{const world=createWorld(project,{validated:true});world.step();world.dispose();world.dispose();};
run();run();
let depth=0;
invoke(projectPlugins(project).modes.get('probe.sim'),'drawHud',{ctx:{save(){depth++;},restore(){depth--;}}});
assert.equal(depth,0);
assert.equal(calls.length,2);
assert.deepEqual(calls[0],calls[1]);
console.log('清单、依赖、工程隔离、校验、收集、事件、素材、退出清理与确定性通过');
