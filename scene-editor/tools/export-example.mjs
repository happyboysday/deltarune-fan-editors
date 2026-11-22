import {loadLocalPlugins} from './plugin-files.mjs';

import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeHtml,bundleModules} from '../studio/standalone.mjs';
import {validateProject} from '../studio/format.mjs';
import {packUiAssets,projectArtSources} from '../studio/resources.mjs';

const [studio,projectPath,out]=process.argv.slice(2);
const project=JSON.parse(fs.readFileSync(projectPath,'utf8'));
const pluginFlag=process.argv.indexOf('--plugins');
await loadLocalPlugins(project,pluginFlag===-1?process.env.DR_PLUGINS:process.argv[pluginFlag+1]);
const result=validateProject(project);
if(!result.ok)throw new Error(JSON.stringify(result.errors));
if(Object.values(project.rooms).some(r=>r.map||r.layout))throw new Error('分层布景请从工作台导出。');
const modules=await bundleModules(project,async file=>{
  const r=await fetch(studio+file);
  if(!r.ok)throw Error('模块读取失败 '+file);
  return r.text();
});
const files={};
async function add(url){
  if(!url||url.startsWith('data:')||Object.hasOwn(files,url))return;
  const r=await fetch(studio+url);
  if(!r.ok)throw new Error('素材读取失败：'+url);
  const bytes=Buffer.from(await r.arrayBuffer());
  files[url]='data:'+r.headers.get('content-type').split(';')[0]+';base64,'+bytes.toString('base64');
}
for(const url of [...projectArtSources(project)].sort())await add(url);
const ui=await packUiAssets({origin:studio,encode:async blob=>
  'data:'+blob.type+';base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64')});
let battlePack=null;
if(Object.keys(project.battles??{}).length){
  const res=await fetch(studio+'/api/studio/battles/bundle',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({battles:project.battles,campaign:project.campaign,battleTransition:project.battleTransition,offline:true})});
  battlePack=await res.json();
  if(!res.ok)throw new Error(JSON.stringify(battlePack));
}
const html=makeHtml(project,{files,maps:{},ui},modules,battlePack);
fs.writeFileSync(out,html);
console.log(JSON.stringify({out:pathToFileURL(path.resolve(out)).href,bytes:Buffer.byteLength(html),encounters:battlePack?.entries.length??0}));
