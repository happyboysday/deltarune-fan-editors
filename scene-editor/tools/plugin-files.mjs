import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateManifest,resolvePlugins} from '../studio/plugin-manifest.mjs';

const builtin= fileURLToPath(new URL('../studio/plugins/builtin/',import.meta.url));
const trash='.plugins-trash';
function contained(root,file){
  const rel=path.relative(fs.realpathSync(root),fs.realpathSync(file));
  return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);
}
export function discover(directory){
  const entries=[],byId=new Map();
  for(const [root,isBuiltin] of [[builtin,true],[directory,false]]){
    if(!root||!fs.existsSync(root))continue;
    for(const d of fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(!d.isDirectory()||d.name.toLowerCase()===trash||d.name.startsWith('.studio-install-'))continue;
      const entry=inspectPlugin(path.join(root,d.name),isBuiltin);
      const id=entry.manifest?.id;
      if(id&&byId.has(id)){
        entry.errors.push('插件 ID 重复 '+id);
        if(entry.manageable&&byId.get(id).builtin)
          Object.assign(entry,{manageable:false,managementReason:entry.errors.at(-1)});
      }
      else if(id)byId.set(id,entry);
      entries.push(entry);
    }
  }
  for(const e of entries)if(!e.errors.length){
    resolvePlugins([{id:e.manifest.id,minVersion:'0.0.0'}],byId,msg=>e.errors.push(msg));
  }
  return entries;
}
function inspectPlugin(dir,builtin=false,checkDirectory=true){
  const name=path.basename(dir),entry={directory:name,builtin,errors:[],
    base:(builtin?'/studio/plugins/builtin/':'/plugins/')+name+'/'};
  try{
    const file=path.join(dir,'plugin.json');
    if(!fs.lstatSync(file,{throwIfNoEntry:false})?.isFile()||!contained(dir,file))
      throw Error('缺少插件目录内的普通 plugin.json 文件');
    const m=entry.manifest=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    entry.errors.push(...validateManifest(m,{builtin}));
    if(checkDirectory&&name!==m?.id)entry.errors.push('目录名必须与插件 ID 一致');
  }catch(error){entry.errors.push(error.message);}
  entry.manageable=!builtin&&!entry.errors.length;
  entry.managementReason=builtin?'内置插件始终启用，不能停用或卸载':entry.errors.join('；');
  if(!entry.errors.length){
    try{
      for(const name of [entry.manifest.runtime,entry.manifest.editor].filter(Boolean)){
        const target=path.join(dir,name);
        if(!fs.statSync(target,{throwIfNoEntry:false})?.isFile()||!contained(dir,target))throw Error('入口不可用 '+name);
      }
    }catch(error){entry.errors.push(error.message);}
  }
  return entry;
}
export async function loadLocalPlugins(project,directory,disabled=[]){
  if(project?.plugins===undefined)return;
  const {loadPlugins}=await import('../studio/plugins.mjs');
  const entries=discover(directory);
  for(const entry of entries)if(!entry.builtin&&disabled.includes(entry.manifest?.id))
    entry.errors.push('已停用。请在插件管理中启用 '+entry.manifest.id);
  const errors=await loadPlugins(project.plugins,entries,url=>{
    const file=path.join(directory,url.slice('/plugins/'.length));
    return import(pathToFileURL(file));
  });
  if(errors.length)throw Error(errors.join('，'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  console.log(JSON.stringify(['--inspect','--inspect-installed'].includes(process.argv[2])
    ?inspectPlugin(process.argv[3],false,process.argv[2]==='--inspect-installed'):{plugins:discover(process.argv[2])}));
