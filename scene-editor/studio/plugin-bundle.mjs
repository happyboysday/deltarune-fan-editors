import {projectPlugins} from './plugins.mjs';

import {parse} from './vendor/acorn.mjs';

const origin='https://scene.invalid';
function keyOf(path){
  const url=new URL(path,origin);
  const name=url.pathname.startsWith('/studio/')?'scene/'+url.pathname.slice(8,-4):'plugin/'+url.pathname.slice(9,-4);
  return name+url.search+url.hash;
}
const nameOf=node=>node.name??node.value;

// Walk expressions too: a dynamic import can live inside a template substitution.
function rejectDynamic(node){
  if(node.type==='ImportExpression')throw Error('离线插件不支持动态 import()');
  for(const child of Object.values(node)){
    if(Array.isArray(child)){for(const item of child)if(item?.type)rejectDynamic(item);}
    else if(child?.type)rejectDynamic(child);
  }
}
function bindings(node,names){
  if(node.type==='Identifier')names.push(node.name);
  else if(node.type==='ObjectPattern')for(const prop of node.properties)bindings(prop.value??prop.argument,names);
  else if(node.type==='ArrayPattern'){for(const el of node.elements)if(el)bindings(el,names);}
  else bindings(node.left??node.argument,names);
}
function moduleInfo(path,source,resolve){
  try{
    const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
    // The built-in battle host loads the engine from the separately bundled battle import map.
    if(path!=='/studio/battle-player.mjs')rejectDynamic(ast);
    const names=new Map(),imports=new Map(),stars=[],checks=[],edits=[];
    for(const node of ast.body){
      let target;
      if(node.source){
        if(node.attributes?.length||node.phase)throw Error('不支持带属性或阶段的离线模块导入');
        target=resolve(node.source.value);
        edits.push([node.source.start,node.source.end,JSON.stringify(target)]);
      }
      for(const spec of node.specifiers??[]){
        if(node.type==='ImportDeclaration'){
          const imported=spec.imported?nameOf(spec.imported):spec.type==='ImportNamespaceSpecifier'?'*':'default';
          imports.set(nameOf(spec.local),[target,imported]);
          checks.push([target,imported]);
        }else{
          const local=nameOf(spec.local);
          names.set(nameOf(spec.exported),target?[target,local]:local);
          if(target)checks.push([target,local]);
        }
      }
      if(node.type==='ExportDefaultDeclaration')names.set('default',node.declaration.id?.name??'#default');
      if(node.type==='ExportAllDeclaration'){
        if(node.exported)names.set(nameOf(node.exported),[target,'*']);
        else stars.push(target);
      }
      if(node.type==='ExportNamedDeclaration'&&node.declaration){
        const ids=[],decl=node.declaration;
        if(decl.id)ids.push(decl.id.name);
        else for(const item of decl.declarations)bindings(item.id,ids);
        for(const id of ids)names.set(id,id);
      }
    }
    for(const [start,end,quoted] of edits.reverse())source=source.slice(0,start)+quoted+source.slice(end);
    return {source,names,imports,stars,checks,path};
  }catch(error){throw Error(path+'：'+error.message);}
}
function verifyLinks(graph){
  function binding(key,name,seen){
    const id=JSON.stringify([key,name]);
    if(seen.has(id))return null;
    const mod=graph.get(key);
    if(!mod)return null;
    if(name==='*')return id;
    const branch=new Set(seen).add(id),entry=mod.names.get(name);
    if(entry!==undefined){
      const ref=Array.isArray(entry)?entry:mod.imports.get(entry);
      return ref?binding(...ref,branch):JSON.stringify([key,entry]);
    }
    if(name==='default')return null;
    const matches=new Set(mod.stars.map(star=>binding(star,name,branch)).filter(Boolean));
    if(matches.size>1)throw Error(mod.path+' 的导出有歧义：'+name);
    return matches.values().next().value??null;
  }
  for(const mod of graph.values())for(const [key,name] of mod.checks){
    if(!binding(key,name,new Set()))throw Error(mod.path+' 无法从 '+key+' 导入 '+name);
  }
}

export async function bundleModules(project,read=async path=>{
  const response=await fetch(path);
  if(!response.ok)throw Error('读取模块失败 '+path+'（'+response.status+'）');
  return response.text();
}){
  const {entries,errors}=projectPlugins(project);
  if(errors.length)throw Error(errors.join('，'));
  const graph=new Map(),queue=new Set(['/studio/player.mjs','/studio/plugins.mjs']);
  const roots=entries.map(e=>e.base);
  const bundled=[],startup=[];
  for(const [index,{manifest,base,builtin}] of entries.entries()){
    const file=base+manifest.runtime;
    queue.add(file);
    const name='runtime'+index;
    const declaration='import '+name+' from '+JSON.stringify(keyOf(file))+';\n';
    const metadata=JSON.stringify(manifest);
    if(builtin)bundled.push({declaration,row:'{manifest:'+metadata+',runtime:'+name+',base:'+JSON.stringify(base)+'}'});
    else startup.push({declaration,row:'registerPlugin('+metadata+','+name+',{base:'+JSON.stringify(base)+'});'});
  }
  for(const path of queue){
    if(!path.startsWith('/studio/')&&!roots.some(root=>path.startsWith(root)))throw Error('模块超出工程插件目录 '+path);
    if(path==='/studio/plugins/builtin/catalog.mjs'){
      const source=bundled.map(e=>e.declaration).join('')+'export const builtinPlugins=['+bundled.map(e=>e.row).join(',')+'];';
      graph.set(keyOf(path),moduleInfo(path,source,key=>key));
    }else{
      let source;
      try{source=await read(path);}catch(error){throw Error(path+'：'+error.message);}
      graph.set(keyOf(path),moduleInfo(path,source,spec=>{
        const url=new URL(spec,new URL(path,origin));
        if(!/^(?:\.\.?\/|\/(?:studio|plugins)\/)/.test(spec)||url.origin!==origin||!url.pathname.endsWith('.mjs'))
          throw Error('离线导入需要本地 .mjs 路径：'+spec);
        const target=url.pathname+url.search+url.hash;
        queue.add(target);
        return keyOf(target);
      }));
    }
  }
  const boot='import {registerPlugin} from "scene/plugins";\n'+startup.map(e=>e.declaration).join('')+
    startup.map(e=>e.row).join('\n')+'\nexport {offlinePlayer} from "scene/player";';
  graph.set('scene/boot',moduleInfo('scene/boot',boot,key=>key));
  verifyLinks(graph);
  return Object.fromEntries([...graph].map(([key,mod])=>[key,mod.source]));
}
