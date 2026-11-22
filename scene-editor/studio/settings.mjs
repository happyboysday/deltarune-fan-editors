import {api,labels,unavailable} from './configuration.mjs';

const $=id=>document.getElementById(id), fields=new Map(), toggles=[];
const element=(tag,text,className)=>Object.assign(document.createElement(tag),{textContent:text??''},className?{className}:{});
const sources={cli:'命令行',settings:'设置文件',default:'默认值'};
const pluginChanges=typeof BroadcastChannel==='function'?new BroadcastChannel('studio-plugin-settings'):null;
const params=new URLSearchParams(location.search);
let report,setup;
const returnTarget=params.get('return');
if(returnTarget&&/^\/(?:\?|$|studio\/(?:index|chapters)\.html(?:\?|$))/.test(returnTarget))
  $('returnEditor').href=returnTarget;

// One status per field: locked by the command line, unusable, not set, or usable; a pending value wins the pill.
function fieldState(row){
  if(row.pending)return ['pending','下次启动生效'];
  if(row.source==='cli')return ['lock','命令行锁定'];
  if(row.value==null||row.value==='')return ['empty','未设置'];
  return row.valid===false?['bad','不可用']:['ok','可用'];
}
// An edited (or detected) value that is not saved yet overrides the saved status.
function showState(key){
  const {input,box,pill}=fields.get(key);
  const [state,label]=input.value!==input.defaultValue?['pending','待保存']:fieldState(report.settings[key]);
  box.dataset.state=state;pill.className='pill '+state;pill.textContent=label;
}
function describe(report,results={}){
  $('data').textContent='数据目录 · '+report.data;
  $('data').title=report.data;
  $('warning').textContent=report.warning??'';
  $('warning').hidden=!report.warning;
  $('version').textContent='设置格式 v'+report.version;
  for(const [key,{detail,result}] of fields){
    const row=report.settings[key];
    showState(key);
    detail.textContent=[sources[row.source]+' · '+row.reason,
      row.pending?'下次启动 '+(row.pending.value??'未设置'):null].filter(Boolean).join(' · ');
    if(result&&results[key])result.textContent=results[key].reason;
  }
}
function setFields(){
  for(const [key,name] of Object.entries(labels)){
    const row=report.settings[key];
    if(!row)continue;
    const box=element('div','','field'),head=element('div','','field-head'),line=element('div','','field-row');
    const label=element('label',name),input=element('input'),pill=element('span','','pill');
    const detail=element('p','','detail');
    input.id='setting-'+key;label.htmlFor=input.id;
    input.value=row.pending?row.pending.value??'':row.value??'';
    input.defaultValue=input.value;input.disabled=row.source==='cli';
    input.placeholder=key==='port'?'':'未设置时使用默认位置';
    head.append(label,element('code',key),pill);line.append(input);box.append(head,line,detail);
    // Every field, the port included, can go back to following the default (saved as null).
    if(key==='port'){input.type='number';input.min=0;input.max=65535;input.placeholder='默认端口';}
    else{input.className='path';input.spellcheck=false;}
    const reset=element('button','恢复默认','ghost'),result=element('p','','result');
    reset.type='button';reset.disabled=input.disabled;reset.onclick=()=>{input.value='';showState(key);input.focus();};
    line.append(reset);box.append(result);
    fields.set(key,{input,detail,result,box,pill});
    input.addEventListener('input',()=>showState(key));
    $('fields').append(box);
  }
}
function changes(){
  const updates={};
  for(const [key,{input}] of fields)if(!input.disabled&&input.value!==input.defaultValue)
    updates[key]=input.value.trim()===''?null:key==='port'?input.valueAsNumber:input.value.trim();
  const states=Object.fromEntries(toggles.filter(({input})=>input.checked!==input.defaultChecked)
    .map(({id,input})=>[id,input.checked]));
  if(Object.keys(states).length)updates.pluginEnabled=states;
  if(setup||$('firstRun').checked!==report.firstRunDone)updates.firstRunDone=setup||$('firstRun').checked;
  return updates;
}
function guarded(task){
  return async event=>{
    event?.preventDefault();
    const buttons=[$('save'),$('restart'),$('detect')];
    if(buttons.some(b=>b.disabled))return;
    buttons.forEach(b=>b.disabled=true);
    try{await task();}catch(error){$('status').textContent=error.message;}
    finally{buttons.forEach(b=>b.disabled=false);}
  };
}
async function save(restart){
  if(!$('settings').reportValidity()||restart&&!confirm('确认保存设置并重启服务？其他标签页可能有尚未保存的改动。'))return;
  const updates=changes();
  const result=Object.keys(updates).length?await api('settings',{settings:updates}):{ok:true,results:{},...report};
  report=result;
  describe(report,result.results);
  for(const [key,{input}] of fields)if(result.results[key]?.ok)input.defaultValue=input.value;
  for(const key of fields.keys())showState(key);
  if(result.results.pluginEnabled?.ok){
    for(const {input} of toggles)input.defaultChecked=input.checked;
    pluginChanges?.postMessage({ids:Object.keys(updates.pluginEnabled)});
  }
  if(!result.ok){
    $('status').textContent=Object.entries(result.results).filter(([,row])=>!row.ok)
      .map(([key,row])=>(labels[key]??key)+' · '+row.reason).join('；');
    return;
  }
  if(setup&&report.firstRunDone){
    setup=false;
    $('heading').textContent='设置';$('welcome').hidden=true;
    $('save').textContent='保存';$('firstRun').disabled=false;
  }
  if(restart){
    await api('restart',{});
    $('status').textContent='已请求重启。使用 launch-v1.cmd 启动时会自动重新打开编辑器；直接启动的实例请重新运行。';
  }else $('status').textContent='设置已保存。路径和端口在下次启动时生效。';
}

function capabilityTile(capabilities,key,row){
  const metadata=row.gameChapters?' · '+Object.entries(row.chapters).map(([n,available])=>
    '第 '+n+' 章'+(available?'可编辑':'缺少工程')+(row.gameChapters[n]?'，有真实游戏':'，缺真实游戏')).join('；'):'';
  const tile=element('li','','cap');tile.dataset.ok=String(!!row.available);
  tile.append(element('strong',row.label),element('span',(unavailable(capabilities,key)||row.reason)+metadata));
  return tile;
}
function pluginToggle(id,row){
  const label=element('label','','toggle'),input=element('input'),text=element('span');
  input.type='checkbox';input.className='switch';input.checked=input.defaultChecked=row.enabled;
  input.disabled=!!row.builtin||!/^[a-z][a-z0-9-]{0,63}$/.test(id);
  text.append(element('strong',row.manifest?.name??(row.directory?id:'已保存启用状态')),
    element('small',id+(row.builtin?' · 内置，始终启用':row.directory?'':' · 插件目录中已不存在')));
  label.append(input,text);
  toggles.push({id,input});
  return label;
}

async function initialize(){
  const [settings,{capabilities}]=await Promise.all([api('settings'),api('capabilities')]);
  report=settings;setup=!report.firstRunDone;
  $('heading').textContent=setup?'首次启动引导':'设置';
  $('welcome').hidden=!setup;
  $('save').textContent=setup?'完成引导并保存':'保存';
  $('firstRun').checked=setup||report.firstRunDone;
  $('firstRun').disabled=setup;
  setFields();describe(report);
  for(const [key,row] of Object.entries(capabilities))$('capabilities').append(capabilityTile(capabilities,key,row));
  $('detect').onclick=guarded(async()=>{
    const {results}=await api('settings/detect');
    let found=0;
    for(const [key,row] of Object.entries(results)){
      const field=fields.get(key);
      if(!field?.result||key==='port')continue;
      field.result.textContent='检测 · '+row.reason+(row.value?' · '+row.value:'');
      if(row.value&&!field.input.disabled&&field.input.value!==row.value){field.input.value=row.value;showState(key);found++;}
    }
    $('status').textContent=found?'已填入 '+found+' 项检测结果，确认后保存。':'没有检测到新的素材位置。';
  });
  $('settings').onsubmit=guarded(()=>save(false));
  $('restart').onclick=guarded(()=>save(true));
  const entries=new Map();
  try{
    const {plugins}=await api('plugins');
    for(const row of plugins)entries.set(row.directory,row);
  }catch(error){$('plugins').append(element('p',error.message));}
  for(const [id,enabled] of Object.entries(report.settings.pluginEnabled.value))
    if(!entries.has(id))entries.set(id,{enabled});
  for(const [id,row] of entries)$('plugins').append(pluginToggle(id,row));
}
initialize().catch(error=>{$('status').textContent=error.message;});
