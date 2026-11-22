export const API_VERSION=1;
const id=/^[a-z][a-z0-9-]{0,63}$/;
const version=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const groups=['modes','entities','actions'];
export function meets(versionString,minimum){
  const a=versionString.split('.').map(Number),b=minimum.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return true;
}
export function requirements(value){
  if(!Array.isArray(value))return ['插件依赖应为数组'];
  const errors=[],seen=new Set();
  for(const [i,r] of value.entries()){
    if(!object(r)||typeof r.id!=='string'||!id.test(r.id)||typeof r.minVersion!=='string'||!version.test(r.minVersion))errors.push('第 '+(i+1)+' 项需要插件 ID 和最低版本 minVersion');
    else if(seen.has(r.id))errors.push('重复的插件 '+r.id);
    else seen.add(r.id);
  }
  return errors;
}
export function validateManifest(m,{builtin=false}={}){
  if(!object(m))return ['插件清单应为对象'];
  const errors=[];
  if(typeof m.id!=='string'||(!id.test(m.id)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(m.id)))errors.push('插件 ID 应为可用作目录名的小写字母、数字或连字符，且以字母开头');
  for(const field of ['name','description','author'])if(typeof m[field]!=='string'||!m[field].trim())errors.push('缺少 '+field);
  if(typeof m.version!=='string'||!version.test(m.version))errors.push('version 应为三段数字');
  if(m.apiVersion!==API_VERSION)errors.push('不兼容的插件 API 版本 '+m.apiVersion);
  for(const field of ['runtime',...(m.editor===undefined?[]:['editor'])])
    if(typeof m[field]!=='string'||!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mjs$/.test(m[field]))errors.push(field+' 应为目录内的 .mjs 相对路径');
  for(const group of groups){
    const list=m.provides?.[group];
    if(!Array.isArray(list)||new Set(list).size!==list.length||list.some(k=>typeof k!=='string'||
      !(builtin?/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(k):k.startsWith(m.id+'.')&&/^[a-z][a-z0-9-]*\.[a-zA-Z][\w-]*$/.test(k))))errors.push('provides.'+group+' 名称无效或重复');
  }
  errors.push(...requirements(m.dependencies??[]));
  return errors;
}

export function resolvePlugins(requested,available,report){
  const ordered=new Map(),visiting=new Set();
  function visit({id,minVersion}){
    const entry=available.get(id);
    if(!entry){report('缺少插件 '+id);return false;}
    if(entry.errors?.length){report('插件 '+id+'：'+entry.errors.join('，'));return false;}
    if(!meets(entry.manifest.version,minVersion)){report('插件 '+id+' 需要至少 '+minVersion);return false;}
    if(ordered.has(id))return true;
    if(visiting.has(id)){report('插件循环依赖 '+[...visiting,id].join(' → '));return false;}
    visiting.add(id);
    const ok=(entry.manifest.dependencies??[]).map(visit).every(Boolean);
    visiting.delete(id);
    if(ok)ordered.set(id,entry);
    return ok;
  }
  const errors=requirements(requested);
  if(errors.length)errors.forEach(report);
  else requested.forEach(visit);
  return [...ordered.values()];
}
