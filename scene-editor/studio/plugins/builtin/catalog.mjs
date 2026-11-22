import dungeonRuntime from './dungeon/runtime.mjs';
import kartRuntime from './kart/runtime.mjs';

async function builtin(id,runtime){
  const base='/studio/plugins/builtin/'+id+'/';
  const url=new URL('./'+id+'/plugin.json',import.meta.url);
  let manifest;
  if(url.protocol==='file:'&&typeof process!=='undefined'&&process.versions?.node){
    const {readFile}=await import('node:fs/promises');
    manifest=JSON.parse(await readFile(url,'utf8'));
  }else{
    const response=await fetch(url);
    if(!response.ok)throw Error('读取内置插件清单失败 '+id+'（'+response.status+'）');
    manifest=await response.json();
  }
  return {manifest,runtime,base};
}
export const builtinPlugins=await Promise.all([builtin('dungeon',dungeonRuntime),builtin('kart',kartRuntime)]);
