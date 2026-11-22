import {builtinPlugins} from './plugins/builtin/catalog.mjs';
import {groups,validateManifest,resolvePlugins} from './plugin-manifest.mjs';

const catalog=new Map(),reported=new Set();
let revision=0;
export function pluginError(id,hook,error){
  const name=catalog.get(id)?.manifest.name;
  const message='插件 '+(name&&name!==id?name+'（'+id+'）':id)+' · '+hook+'：'+(error?.message??String(error));
  if(!reported.has(message)){
    reported.add(message);console.error(message);
    if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('scene-plugin-error',{detail:message}));
  }
  return message;
}
// A failed third-party paint must unwind even its own nested saves.
function isolatedPaint(fn,context){
  const canvas=context.ctx;
  let depth=0;
  const ctx=new Proxy(canvas,{get(target,key){
    if(key==='save')return ()=>{target.save();depth++;};
    if(key==='restore')return ()=>{if(depth){target.restore();depth--;}};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  },set(target,key,value){target[key]=value;return true;}});
  canvas.save();
  try{return fn({...context,ctx});}
  finally{while(depth>0){canvas.restore();depth--;}canvas.restore();}
}
export function invoke(extension,hook,context){
  try{
    const fn=extension?.hooks[hook];
    if(!fn)return;
    const isolated=context.ctx&&hook.startsWith('draw')&&!catalog.get(extension.id)?.builtin;
    const result=isolated?isolatedPaint(fn,context):fn(context);
    if(result&&typeof result.then==='function'){
      Promise.resolve(result).catch(error=>pluginError(extension.id,hook,error));
      throw Error('此扩展点需要同步返回');
    }
    return result;
  }
  catch(error){const msg=pluginError(extension.id,hook,error);context.error?.(context.path??'plugins',msg);}
}
export function registerPlugin(manifest,runtime,{builtin=false,base='/plugins/'+manifest?.id+'/',editor=null}={}){
  const errors=validateManifest(manifest,{builtin});
  if(errors.length)throw Error(errors.join('，'));
  if(!runtime||typeof runtime!=='object')throw Error(manifest.id+' 的运行时入口需要默认导出对象');
  if(catalog.has(manifest.id))throw Error('重复的插件 '+manifest.id);
  for(const group of groups){
    const declared=manifest.provides[group],hooks=runtime?.[group]??{};
    if(Object.keys(hooks).length!==declared.length||declared.some(k=>!Object.hasOwn(hooks,k)||!hooks[k]||typeof hooks[k]!=='object'))
      throw Error(manifest.id+' 的实现与 provides.'+group+' 不一致');
  }
  catalog.set(manifest.id,{manifest,runtime,editor,builtin,base});revision++;
}
for(const entry of builtinPlugins)registerPlugin(entry.manifest,entry.runtime,{builtin:true,base:entry.base});
export const installedPlugins=()=>new Map(catalog);
export function attachEditor(id,editor){catalog.get(id).editor=editor;revision++;}
const defaultRequests=builtinPlugins.map(({manifest})=>({id:manifest.id,minVersion:'0.0.0'}));
let last;
export function projectPlugins(project={}){
  const requested=project.plugins===undefined?defaultRequests:project.plugins;
  const key=JSON.stringify(requested);
  if(last?.key===key&&last.revision===revision)return last;
  const errors=[],entries=resolvePlugins(requested,catalog,msg=>errors.push(msg));
  const result={entries,errors,key,revision,extensions:[],editors:[],editorErrors:[],modes:new Map(),entities:new Map(),actions:new Map()};
  for(const {manifest,runtime,editor,editorError} of entries){
    const id=manifest.id;
    result.extensions.push({id,hooks:runtime});
    if(editor)result.editors.push({id,hooks:editor});
    if(editorError)result.editorErrors.push(editorError);
    for(const group of groups)for(const k of manifest.provides[group])result[group].set(k,{id,hooks:runtime[group][k]});
  }
  last=result;return result;
}
export function resolveEntity(plugins,project,entity){
  for(const ext of plugins.extensions)if(ext.hooks.entityDefaults)
    entity=invoke(ext,'entityDefaults',{project,entity})??entity;
  return invoke(plugins.entities.get(entity.kind??entity.type),'resolve',{project,entity})??entity;
}
export function missingPlugin(group,key){
  const owner=[...catalog.values()].find(e=>e.manifest.provides[group].includes(key));
  return '缺少插件 '+(owner?.manifest.id??String(key).split('.')[0])+'（'+key+'）';
}
export async function loadPluginEntries(requested,discovered,importModule,{editor=false}={}){
  const available=new Map([...catalog].filter(([,e])=>e.builtin)),runtimeErrors=[],editorErrors=[];
  const seen=new Set();
  for(const entry of discovered){
    const id=entry.manifest?.id;
    if(!id||seen.has(id)||!!entry.builtin!==!!catalog.get(id)?.builtin)continue;
    seen.add(id);
    available.set(id,{...entry,errors:[...(entry.errors??[]),...validateManifest(entry.manifest,{builtin:entry.builtin}),
      ...(entry.enabled===false?['已停用，请先启用插件']:[])]});
  }
  const loaded=new Set();
  for(const e of resolvePlugins(requested,available,msg=>runtimeErrors.push(msg))){
    const {manifest:m,base}=e;
    try{
      const missing=m.dependencies?.find(r=>!loaded.has(r.id));
      if(missing)throw Error('缺少插件 '+missing.id);
      if(!catalog.has(m.id)){
        const runtime=(await importModule(base+m.runtime)).default;
        if(!catalog.has(m.id))registerPlugin(m,runtime,{base});
      }
      const version=catalog.get(m.id).manifest.version;
      if(version!==m.version)
        throw Error('版本已从 '+version+' 变为 '+m.version+'，请重新打开页面或重新运行校验');
      loaded.add(m.id);
    }catch(error){runtimeErrors.push(pluginError(m.id,'运行时入口 '+m.runtime,error));continue;}
    const entry=catalog.get(m.id);
    if(editor&&m.editor&&!entry.editor){
      try{
        const panel=(await importModule(base+m.editor)).default;
        if(!panel||typeof panel!=='object'||Array.isArray(panel))throw Error('需要默认导出编辑器面板对象');
        entry.editorError=null;attachEditor(m.id,panel);
      }catch(error){
        entry.editorError=pluginError(m.id,'编辑器入口 '+m.editor,error);
        revision++;
        editorErrors.push(entry.editorError);
      }
    }
  }
  return {runtimeErrors,editorErrors};
}
export async function loadPlugins(requested,discovered,importModule,options){
  const {runtimeErrors,editorErrors}=await loadPluginEntries(requested,discovered,importModule,options);
  return [...runtimeErrors,...editorErrors];
}
