import {api,disableFeature,unavailable} from './configuration.mjs';

const $=id=>document.getElementById(id);
const element=(tag,text,className)=>Object.assign(document.createElement(tag),{textContent:text??''},className?{className}:{});
let busy=false, installReason='正在检查插件目录';
const changes=typeof BroadcastChannel==='function'?new BroadcastChannel('studio-plugin-settings'):null;
function run(action){
  return async event=>{
    event?.preventDefault();
    if(busy)return;
    busy=true;$('install').disabled=true;
    try{$('status').textContent=await action()??'';}catch(error){$('status').textContent=error.message;}
    finally{busy=false;$('install').disabled=!!installReason;}
  };
}
function button(label,action,className){
  const b=element('button',label,className);b.type='button';b.onclick=run(action);return b;
}
function pluginCard(row){
  const name=row.manifest?.name??row.directory, id=row.directory, builtin=row.source==='builtin';
  // Folders that are not valid plugins (no plugin.json, id mismatch) are listed only as diagnostics.
  const manageable=builtin||row.builtin||row.manageable!==false;
  const item=element('li','','plugin'),body=element('div'),title=element('h3',name);
  item.dataset.source=row.source;item.dataset.enabled=String(!!row.enabled);
  if(!manageable)item.dataset.diagnostic='true';
  title.append(element('code',id+(row.manifest?.version?' · v'+row.manifest.version:'')));
  body.append(title);
  if(row.manifest?.description)body.append(element('p',row.manifest.description,'desc'));
  const tags=element('div','','tags');
  if(manageable)tags.append(element('span',builtin?'内置':'用户插件','pill'+(builtin?' ok':'')),
    element('span',row.enabled?'已启用':'已停用','pill '+(row.enabled?'ok':'bad')));
  else tags.append(element('span','不是可管理的插件','pill lock'));
  body.append(tags);
  if(!manageable&&row.managementReason&&!row.errors.includes(row.managementReason))body.append(element('p',row.managementReason,'deps'));
  if(row.errors.length)body.append(element('p','校验错误 · '+row.errors.join('；'),'errors'));
  if(row.projects.length)body.append(element('p','正在打开且依赖此插件的工程 · '+
    row.projects.map(p=>p.title+'（'+p.id+'）').join('、'),'deps'));
  const glyph=element('span',[...name][0]??'?','glyph');glyph.setAttribute('aria-hidden','true');
  const ops=element('div','','ops');
  if(!builtin&&!row.builtin&&manageable){
    const action=row.enabled?'disable':'enable';
    const toggle=button(row.enabled?'停用':'启用',async()=>{
      if(row.enabled&&row.projects.length&&!confirm('确认停用 '+id+'？已打开的相关工程将暂停试玩和编辑。'))return;
      await api('plugins/'+id+'/'+action,{});
      changes?.postMessage({id});
      await refresh();
      return row.enabled?'已停用 '+id:'已启用 '+id;
    },row.enabled?'ghost':'primary');
    const remove=button('卸载',async()=>{
      if(!confirm('确认卸载 '+id+'？插件目录将移入本机回收区。'))return;
      const result=await api('plugins/'+id+'/uninstall',{});
      changes?.postMessage({id});
      await refresh();
      return '已移入 '+result.trash;
    },'danger');
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(id)){
      disableFeature(toggle,'目录名无效，请在本机修正插件目录');
      disableFeature(remove,'目录名无效，请在本机修正插件目录');
    }
    ops.append(toggle,remove);
  }
  item.append(glyph,body,ops);
  return item;
}
async function refresh(){
  const {plugins}=await api('plugins');
  // Built-in plugins first, then user plugins by name.
  const sorted=[...plugins].sort((a,b)=>(a.source==='builtin'?0:1)-(b.source==='builtin'?0:1)||
    String(a.manifest?.name??a.directory).localeCompare(String(b.manifest?.name??b.directory),'zh-CN'));
  $('plugins').replaceChildren(...sorted.map(pluginCard));
}
async function install(body){
  const result=await api('plugins/install',body);
  changes?.postMessage({id:result.id});
  await refresh();
  return '已安装 '+result.id+(result.enabled?'':'，沿用之前的停用设置');
}
async function zipData(file){
  if(file.size>20*1024*1024)throw Error('ZIP 上传上限为 20 MiB');
  const bytes=new Uint8Array(await file.arrayBuffer()), chunks=[];
  for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return btoa(chunks.join(''));
}
$('zip').onchange=()=>{$('zipName').textContent=$('zip').files[0]?.name??'选择 ZIP 文件';};
$('folderForm').onsubmit=run(async()=>install({folder:$('folder').value.trim()}));
$('zipForm').onsubmit=run(async()=>install({zip:await zipData($('zip').files[0])}));
$('refresh').onclick=run(refresh);
run(async()=>{
  const {capabilities}=await api('capabilities');
  installReason=unavailable(capabilities,'pluginInstall');
  disableFeature($('install'),installReason);
  await refresh();
  return installReason;
})();
