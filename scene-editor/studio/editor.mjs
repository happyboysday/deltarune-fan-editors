import {createSceneNavigator} from './scene-navigator.mjs';

import {FORMAT,modeNames,DIRECTIONS,validateProject,rectOf,entityKind,isTimedInput,isPlatformMode,PLATFORM_DEFAULTS} from './format.mjs';
import {trailerRows} from './trailer-script.mjs';
import {cameraFor,clamp,roomTransform} from './world.mjs';
import {drawScene} from './view.mjs';
import {json,prepareArt,packArt,loadRoomLayout,preparePlayArt} from './resources.mjs';
import {mountPlayer,BATTLE_HELP,trailerControls} from './player.mjs';
import {prepareBattlePack,prepareBattlePlayer} from './battle-player.mjs';
import {editBattleFile,makeBattleOption,mountBattleEditor,RESULT_LABELS} from './battle-editor.mjs';
import {mountCampaignEditor} from './campaign-editor.mjs';
import {makeHtml,bundleModules} from './standalone.mjs';
import {mountEventEditor} from './event-editor.mjs';
import {handoffRead,handoffWrite} from './handoff.mjs';
import {projectPlugins,invoke,loadPluginEntries,installedPlugins,pluginError} from './plugins.mjs';
import {api,disableFeature,finishSetup,unavailable} from './configuration.mjs';
import {pluginIssues} from './plugin-availability.mjs';
import {animation,thumbnail} from './anim-preview.mjs';
import {partLayer,PARTS,PART,SIZES,DEFAULT_SIZE,gridSize,readGrid,paint as gridPaint,erase as gridErase,fill as gridFill,move as gridMove,
  editRoom,toText,fromText,writeGrid,projectIds,registry,projectParts,footprint,resize as gridResize,FREE_SYMBOLS,CUSTOM_KINDS} from './grid.mjs';

const $=id=>document.getElementById(id), canvas=$('screen'), ctx=canvas.getContext('2d');
const labels={select:'选择',entry:'入口',wall:'墙',npc:'NPC',enemy:'敌人',door:'门',zone:'触发区',switch:'踏板',
  block:'推块',mode:'移动区',checkpoint:'检查点',savepoint:'存档点',hold:'长按',prop:'物件'};
const modeLabels={walk:'步行',slide:'滑行',climb:'攀爬',platform:'横版跳跃'};
const playParams=new URLSearchParams(location.search);
const playOptions={autoplay:playParams.get('autoplay')==='1',manual:playParams.get('manual')==='1'};
const hintLabels={wall:'碰撞',door:'门',entry:'出生点',npc:'NPC',switch:'开关',mechanic:'机关'};
const app={p:null,key:null,selection:null,tool:'brush',part:'wall',snap:true,art:null,game:null,playing:false,busy:false,
  camera:null,drag:null,hints:[],catalog:[],revision:null,savedId:null,dirty:false,request:0,book:0,assetImages:new Map(),
  history:[],future:[],hover:null,stroke:null,moving:null,pan:null};
const TOOLS=[['select','✥','选择','V'],['brush','✎','画笔','B'],['eraser','⌫','橡皮','E'],['rect','▭','矩形','R']];
function status(t,bad=false){$('status').textContent=t;$('status').classList.toggle('error',bad);}
function opt(text,value){return new Option(text,value);}
let eventEditor,battleEditor,campaignEditor,capabilities={};
const lack=keys=>unavailable(capabilities,keys);
function q(){return app.p.rooms[app.key];}
function modeInfo(mode){return projectPlugins(app.p).modes.get(mode)?.hooks??{};}
function modeOptions(){return modeNames(app.p).map(k=>[k,modeLabels[k]??modeInfo(k).label??k]);}
function activeLayer(){
  if(app.p)for(const ext of projectPlugins(app.p).editors){
    const layer=invoke(ext,'layer',{room:q(),layer:app.layer});
    if(layer)return layer;
  }
}
function editorHook(hook,context){
  for(const ext of projectPlugins(app.p).editors)invoke(ext,hook,{project:app.p,room:q(),...context});
}
const tab=crypto.randomUUID();
let tabWatch,pluginCheck=0,pluginIssue='';
const pluginChanges=typeof BroadcastChannel==='function'?new BroadcastChannel('studio-plugin-settings'):null;
async function preparePlugins(p){
  const defaults=[...installedPlugins().values()].filter(e=>e.builtin).map(e=>({id:e.manifest.id,minVersion:'0.0.0'}));
  const requested=p?.plugins===undefined?defaults:p.plugins;
  const needsDiscovery=Array.isArray(requested)&&requested.some(r=>!installedPlugins().get(r?.id)?.builtin);
  const entries=needsDiscovery?(await api('plugins')).plugins:[];
  const unavailable=needsDiscovery?pluginIssues(requested,entries):[];
  if(unavailable.length)throw Error(unavailable.join('；'));
  const {runtimeErrors}=await loadPluginEntries(requested,entries,url=>import(url),{editor:true});
  if(runtimeErrors.length)throw Error(runtimeErrors.join('，'));
}
function reportProject(){
  if(!app.p)return;
  const project={id:app.savedId??app.p.id??'scene-project',title:app.p.title,
    plugins:app.p.plugins?.map(r=>r.id)??[...installedPlugins().values()].filter(e=>e.builtin).map(e=>e.manifest.id)};
  return fetch('/api/studio/plugin-projects',{method:'POST',keepalive:true,
    headers:{'Content-Type':'application/json'},body:JSON.stringify({tab,project})}).catch(()=>{});
}
function setPluginIssue(message){
  if(message===pluginIssue)return;
  pluginIssue=message;
  $('pluginIssue').hidden=!message;
  $('pluginIssueText').textContent=message;
  $('workspace').inert=!!message;
  if(message){stopGame(false);++app.request;}
}
async function checkOpenPlugins(){
  const check=++pluginCheck,p=app.p;
  void reportProject();
  if(!p?.plugins?.some(r=>!installedPlugins().get(r.id)?.builtin))return;
  try{
    const {plugins}=await api('plugins');
    if(check===pluginCheck&&p===app.p){
      const message=pluginIssues(p.plugins,plugins,installedPlugins()).join('；');
      // Loaded modules stay in the browser registry until the tab reloads.
      if(message)setPluginIssue(message+' 启用或安装插件后请重新加载页面。');
    }
  }catch{ /* Retry on focus or the next heartbeat. */ }
}
function mountEditors(){
  const root=$('pluginTools');root.replaceChildren();
  for(const reason of projectPlugins(app.p).editorErrors)root.append(mk('p',reason,{role:'alert'}));
  for(const ext of projectPlugins(app.p).editors){
    const group=mk('div');root.append(group);
    const button=(title,action)=>{
      const b=mk('button',title,{type:'button'});group.append(b);
      b.onclick=()=>Promise.resolve().then(action).catch(e=>pluginError(ext.id,'按钮',e));
      return b;
    };
    invoke(ext,'mount',{root:group,button,project:()=>app.p,room:q,status,changeLayer:l=>{
      app.layer=l;app.selection=null;app.footprint=null;buildPalette();showFields();paint();
    },commit:(next,layer,part)=>{
      const result=validate(next,false);
      if(!result.ok)throw Error(result.errors[0].path+' · '+result.errors[0].message);
      remember();app.p=next;app.dirty=true;if(layer)app.layer=layer;if(part)app.part=part;
      app.footprint=null;refresh();fillJson();
    }});
  }
}
function gridOptions(){return {project:app.p,layer:activeLayer()};}
function parts(){return projectParts(app.p);}
function visibleParts(){const layer=activeLayer();return parts().list.filter(p=>layer?partLayer(p)===layer:!p.tileKey);}
function current(){
  const [kind,id]=app.selection??[];
  if(kind==='entry')return q().entries[id];
  return q().entities?.find(e=>e.id===id);
}
function mk(tag,text,attrs={}){
  const e=document.createElement(tag);if(text!==undefined)e.textContent=text;
  Object.assign(e,attrs);return e;
}
function bounded(n,a,b){return Math.max(a,Math.min(n,b));}
const blank=()=>({format:FORMAT,id:'scene-project',title:'新场景',viewport:{w:480,h:300},
  start:{room:'lobby',entry:'arrival'},rooms:{lobby:{title:'起始房间',style:'workshop',w:640,h:360,
    entries:{arrival:{x:240,y:185,face:'down'}},entities:[]}},events:{},assets:{}});
function validate(p=app.p,display=true){
  const report=validateProject(p);
  if(report.ok){
    try{projectParts(p);}
    catch(ex){report.ok=false;report.errors.push({path:'逐格零件',message:ex.message});}
  }
  if(display){
    const errors=[...report.errors,...report.warnings];
    $('diagnostics').textContent=errors.map(e=>e.path+' · '+e.message).join('\n');
    $('diagnostics').hidden=!errors.length;
    if(!report.ok)$('jsonPanel').open=true;
    status(report.ok?(report.warnings.length?'校验通过 · '+report.warnings.length+' 条提醒':'校验通过'):report.errors[0].path+' · '+report.errors[0].message,!report.ok);
  }
  return report;
}
async function openProject(p,{id=null,rev=null,dirty=false}={}){
  await preparePlugins(p);
  if(!validate(p).ok)return false;
  stopGame(false);
  app.history=[];app.future=[];
  app.p=p;app.key=p.start.room;app.selection=null;app.savedId=id;app.revision=rev;app.dirty=dirty;app.art=null;
  setPluginIssue('');
  void reportProject();
  app.assetImages=new Map();app.camera=null;app.hints=[];app.footprint=null;
  $('title').value=p.title;$('sceneSearch').value='';
  if(q()?.official?.chapter==='ch5'&&capabilities.roomImport?.chapters.ch5)$('chapter').value='ch5';
  mountEditors();fillJson();
  refresh();eventEditor?.refresh();battleEditor?.refresh('');campaignEditor?.refresh();
  return true;
}
function fillJson(){ $('document').value=JSON.stringify(app.p,null,2); }
function changed({assets=false,rebuild=false}={}){
  app.dirty=true;
  if(rebuild) refresh(assets);
  else paint();
}
async function ask(title,fields){
  const dialog=$('dialog'),body=$('dialogBody');
  $('dialogTitle').textContent=title;body.replaceChildren();
  const inputs={};
  for(const [key,name,value,choices] of fields){
    const label=mk('label',name);let el;
    if(choices){el=mk('select');el.replaceChildren(...choices.map(([v,t])=>opt(t,v)));el.value=value;}
    else{el=mk('input',undefined,{value:value??'',required:true});}
    label.append(el);body.append(label);inputs[key]=el;
  }
  dialog.returnValue='';
  dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>{
    resolve(dialog.returnValue==='ok'?Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value.trim()])):null);
  },{once:true}));
}
async function allowReplace(){
  if(!app.dirty)return true;
  return !!await ask('当前改动尚未保存，确认替换？',[]);
}
function roomFocus(){
  const r=q(),e=Object.values(r.entries)[0];
  app.camera=cameraFor(app.p,r,e.x,e.y);
}
function setupCanvas(){
  const v=app.p.viewport??{w:640,h:480};
  canvas.width=v.w;canvas.height=v.h;
  canvas.style.setProperty('--aspect',v.w+' / '+v.h);
}
function listRooms(){
  const query=$('sceneSearch').value.trim().toLowerCase();
  $('rooms').replaceChildren(...Object.entries(app.p.rooms)
    .filter(([k,r])=>k===app.key||((r.title??'')+' '+k).toLowerCase().includes(query))
    .map(([k,r])=>opt(r.title??k,k)));
  $('rooms').value=app.key;
}
function refresh(assets=true){
  listRooms();$('dimensions').textContent=q().w+' × '+q().h;
  $('gridSize').value=String(gridSize(q()));buildPalette();updateUndo();
  $('sceneLabel').textContent=(q().title??app.key)+' · 编辑';
  setupCanvas();if(!app.camera)roomFocus();
  showFields();showLayers();paint();
  if(assets)void hydrate();
}
async function hydrate(){
  const request=++app.request,key=app.key,project=app.p;
  try{
    const art=await prepareArt(project,null,{roomKeys:[key],shared:{images:app.assetImages}});
    if(request!==app.request||app.playing)return;
    $('embedLayout').hidden=!q()?.layout;
    app.art=art;paint();
    if(art.unresolved.length)status('部分素材未解析：'+[...new Set(art.unresolved.map(u=>u.asset))].slice(0,3).join('、'),true);
  }catch(ex){if(request===app.request)status(ex.message,true);}
  try{
    const ref=project.rooms[key].official;
    const rows=ref&&!lack('officialHints')?(await json('/api/studio/official?'+new URLSearchParams(ref))).candidates:[];
    if(request!==app.request)return;
    app.hints=rows;
    $('hintTitle').textContent='物件候选 · '+rows.length;
    $('hints').replaceChildren(...rows.map((a,i)=>opt((hintLabels[a.kind]??a.kind)+' · '+a.name+(a.measured?'':'（估）'),i)));
    $('useHint').disabled=!rows.length;paint();
  }catch(ex){if(request===app.request)status(ex.message,true);}
}
function fallbackArt(){return {images:app.assetImages,maps:{},test:()=>true};}
function paint(){
  if(app.playing||!app.p||pluginIssue)return;
  const layer=activeLayer();
  const scene=layer?{...app.p,rooms:{...app.p.rooms,[app.key]:{...q(),entities:[],tiles:[]}}}:app.p;
  drawScene(ctx,scene,app.key,app.art??fallbackArt(),{edit:true,camera:app.camera});
  const c=app.camera,r=q(),{v,scale,x,y}=roomTransform(app.p,r);
  ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);
  ctx.beginPath();ctx.rect(0,0,v.w,v.h);ctx.clip();
  ctx.translate(-Math.round(c.x),-Math.round(c.y));
  ctx.beginPath();ctx.rect(0,0,r.w,r.h);ctx.clip();
  const g=gridSize(r),model=readGrid(r,gridOptions());
  const c0=Math.max(0,Math.floor(c.x/g)),c1=Math.min(model.cols,Math.ceil((c.x+v.w)/g)+1);
  const r0=Math.max(0,Math.floor(c.y/g)),r1=Math.min(model.rows,Math.ceil((c.y+v.h)/g)+1);
  const bySym=model.reg.bySym;
  if(layer)editorHook('grid',{ctx,model,layer,paint});
  if(!layer)for(let row=r0;row<r1;row++)for(let col=c0;col<c1;col++){
    const part=bySym[model.terrain[row][col]];
    if(part){ctx.fillStyle=part.color+'47';ctx.fillRect(col*g,row*g,g,g);}
  }
  if($('grid').checked){
    ctx.beginPath();ctx.strokeStyle='#d8d3f324';
    for(let col=c0;col<=c1;col++){const x=Math.min(col*g,r.w);ctx.moveTo(x+.5,Math.max(0,c.y));ctx.lineTo(x+.5,Math.min(r.h,c.y+v.h));}
    for(let row=r0;row<=r1;row++){const y=Math.min(row*g,r.h);ctx.moveTo(Math.max(0,c.x),y+.5);ctx.lineTo(Math.min(r.w,c.x+v.w),y+.5);}
    ctx.stroke();
  }
  function outline(b,c,fill,thick=1){ctx.lineWidth=thick;ctx.strokeStyle=c;ctx.fillStyle=fill;ctx.fillRect(b.x,b.y,b.w,b.h);ctx.strokeRect(b.x+.5,b.y+.5,b.w,b.h);}
  ctx.font='bold 8px Consolas,monospace';ctx.textBaseline='top';
  function badge(x,y,text,color){ctx.fillStyle=color;ctx.fillRect(x,y,8,9);ctx.fillStyle='#16131f';ctx.fillText(text,x+1.5,y+1);}
  if($('showHints').checked){
    ctx.setLineDash([3,2]);
    for(const [i,e] of app.hints.entries())outline(e,String(i)===$('hints').value?'#ffdf95':'#9e8bc68c','#a786cb18');
    ctx.setLineDash([]);
  }
  if(!layer){
  const selected=id=>app.selection?.[1]===id;
  ctx.setLineDash([2,2]);
  for(const o of model.locked)outline(rectOf(o.entity),selected(o.entity.id)?'#fee8a3':'#9ac7ff70','#85a2ff12',selected(o.entity.id)?2:1);
  ctx.setLineDash([]);
  for(const o of model.objects){
    const part=model.reg.byId[o.part],b=rectOf(o.entity);
    outline(b,selected(o.entity.id)?'#fee8a3':part.color,part.color+'26',selected(o.entity.id)?2:1);badge(b.x,b.y,part.sym,part.color);
  }
  for(const [id,e] of Object.entries(r.entries))outline({x:e.x-4,y:e.y-4,w:8,h:8},selected(id)?'#fee8a3':'#a3f2ba','#a3f2ba66',selected(id)?2:1);
  }
  // 预览：画笔显示零件落下的位置，橡皮显示要擦的格子，矩形显示要填的范围
  const part=partOf(app.part);
  if(app.drag?.cells){
    const {from,to}=app.drag.cells,eraseMode=app.drag.erase;
    const x=Math.min(from.c,to.c)*g,y=Math.min(from.r,to.r)*g;
    outline({x,y,w:(Math.abs(from.c-to.c)+1)*g,h:(Math.abs(from.r-to.r)+1)*g},eraseMode?'#ff8a9b':part.color,(eraseMode?'#ff8a9b':part.color)+'40',2);
  }else if(app.drag&&!app.snap&&app.tool!=='select')outline(dragRect(),part.color,part.color+'36',2);
  else if(app.hover&&!app.moving&&!app.pan&&(app.snap||layer)){
    const {c:hc,r:hr}=app.hover;
    if(app.tool==='brush' && app.part){
      const [cw,ch]=part.terrain||part.entry?[1,1]:app.footprint??footprint(part);
      outline({x:hc*g,y:hr*g,w:cw*g,h:ch*g},part.color,part.color+'5c',1);badge(hc*g,hr*g,part.sym,part.color);
    }else if(app.tool==='eraser'||app.tool==='rect')outline({x:hc*g,y:hr*g,w:g,h:g},app.tool==='eraser'?'#ff8a9b':part.color,'#00000000',1);
  }
  ctx.restore();
}
function partOf(id){return parts().byId[id]??PART.wall;}
function placementHelp(){
  const name='「'+partOf(app.part).label+'」';
  if(!activeLayer()&&!app.snap&&app.tool!=='select'&&app.tool!=='eraser')return '吸附已关：在画布拖出任意像素大小的'+name+'，点一下放默认大小。';
  return ({select:'点选物件，直接拖到别的格子；方向键一次挪一格，Delete 删除，Esc 取消选择。',
    brush:'点一下放一个'+name+'，按住拖动连续放。右键随时擦除，中键或空格＋拖动可移动画面。',
    eraser:'点或拖过的格子会被清空；物件整个移除。',
    rect:'拖出一块矩形，整片填上'+name+(partOf(app.part).area?'，触发区会变成一整块。':'。')})[app.tool];
}
function setTool(tool){
  app.tool=tool;
  for(const b of $('tools').children)b.setAttribute('aria-pressed',String(b.dataset.tool===tool));
  canvas.className='tool-'+tool;
  $('placementHelp').textContent=placementHelp();
  paint();
}
function setPart(id){
  if(!parts().byId[id])return;
  app.part=id;app.footprint=null;showFootprint();
  for(const b of $('palette').children)b.setAttribute('aria-pressed',String(b.dataset.part===id));
  if(app.tool==='select'||app.tool==='eraser')setTool('brush');
  else{$('placementHelp').textContent=placementHelp();paint();}
}
// —— 撤销 / 重做：每次改动前记下整个工程 ——
function snapshot(){return JSON.stringify({p:app.p,key:app.key});}
function updateUndo(){$('undo').disabled=app.playing||!app.history.length;$('redo').disabled=app.playing||!app.future.length;}
function remember(){
  app.history.push(snapshot());if(app.history.length>60)app.history.shift();
  app.future=[];updateUndo();
}
function restoreState(s){
  const {p,key}=JSON.parse(s),roomChanged=key!==app.key;
  app.p=p;app.key=Object.hasOwn(p.rooms,key)?key:p.start.room;app.dirty=true;mountEditors();
  if(app.selection&&!current())app.selection=null;
  if(roomChanged){app.camera=null;app.art=null;app.hints=[];}
  $('title').value=p.title;refresh(roomChanged);updateUndo();
}
function undo(){if(!app.history.length)return;app.future.push(snapshot());restoreState(app.history.pop());status('已撤销');}
function redo(){if(!app.future.length)return;app.history.push(snapshot());restoreState(app.future.pop());status('已重做');}
function select(kind,id){app.selection=id?[kind,id]:null;showFields();paint();}
function dropdown(options,value,cb){
  const el=mk('select');
  el.replaceChildren(...options.map(([v,label])=>opt(label,v)));
  el.value=value??'';el.onchange=()=>cb(el.value);return el;
}
function field(label,el,full=false){
  const box=mk('label',label,{className:full?'full':''});box.append(el);$('fields').append(box);return el;
}
const eventOpts=()=>[['','— 无 —'],...Object.keys(app.p.events??{}).map(k=>[k,k])];
function update(e,k,v){remember();if(v===''||v===undefined)delete e[k];else e[k]=v;changed();}
function stringField(e,k,label,full=false){
  const input=field(label,mk('input',undefined,{value:e[k]??''}),full);input.onchange=()=>update(e,k,input.value.trim());return input;
}
function numberField(e,k,label,min,max){
  const input=field(label,mk('input',undefined,{type:'number',min,max,step:'any',value:e[k]??20}));
  input.onchange=()=>{const n=input.valueAsNumber;if(!Number.isFinite(n)){input.value=e[k]??20;return;}const val=bounded(n,min,max);input.value=val;update(e,k,val);};
}
function boolField(e,k,label,defaultValue=false){
  const input=mk('input',undefined,{type:'checkbox',checked:e[k]??defaultValue});
  field(label,input);input.onchange=()=>update(e,k,input.checked);
}
function showFields(){
  const r=q(),es=r.entities??[];
  $('entities').replaceChildren(opt('— 选择物件 —',''),
    ...Object.keys(r.entries).map(k=>opt('入口 · '+k,'entry:'+k)),
    ...es.map(e=>opt((labels[entityKind(e)]??projectPlugins(app.p).entities.get(entityKind(e))?.hooks.label??entityKind(e))+' · '+(e.name??e.id),'entity:'+e.id)));
  $('entities').value=app.selection?.join(':')??'';
  $('objectCount').textContent=es.length+' 个物件';
  $('fields').replaceChildren();
  const e=current(),entry=app.selection?.[0]==='entry';
  $('remove').disabled=!e||entry&&Object.keys(r.entries).length<=1;$('setStart').disabled=!e||!entry;
  if(!e){
    field('房间名称',mk('input',undefined,{value:r.title??app.key,onchange:ev=>{r.title=ev.target.value.trim()||app.key;changed({rebuild:true});}}),true);
    field('默认移动',dropdown(modeOptions(),r.mode??'walk',v=>{remember();r.mode=v;if(modeInfo(v).platform)r.platform={...modeInfo(v).platform,...r.platform};changed({rebuild:true});}),true);
    if(isPlatformMode(r.mode,app.p)){
      const info=modeInfo(r.mode);
      const config=field(info.platformLabel??'横版 · ↑ 跳跃，V 冲刺',mk('button','编辑跳跃与落坑重试'),true);
      config.onclick=async()=>{
        const cfg=r.platform??{}, defaults=info.platform??PLATFORM_DEFAULTS.platform;
        const values=await ask('横版移动',[
          ['speed','水平速度',String(cfg.speed??defaults.speed)],['acceleration','水平加速度',String(cfg.acceleration??defaults.acceleration)],
          ['gravity','重力',String(cfg.gravity??defaults.gravity)],['jump','起跳速度',String(cfg.jump??defaults.jump)],
          ['fallSpeed','最大落速',String(cfg.fallSpeed??defaults.fallSpeed)],
          ...(info.customDash?[]:[['dashSpeed','冲刺速度（留空关闭）',String(cfg.dashSpeed??'')],['dashTicks','冲刺帧数',String(cfg.dashTicks??12)]]),
          ['hoverTicks','空中再次按住 ↑ 的悬停帧数（留空关闭）',String(cfg.hoverTicks??'')],
          ['retryEntry','落坑返回',cfg.retryEntry??'',[['','本次入场点'],...Object.keys(r.entries).map(k=>[k,k])]]
        ]);
        if(!values)return;
        const out={};
        for(const [key,value] of Object.entries(values))if(value!=='')out[key]=key==='retryEntry'?value:Number(value);
        if(!out.dashSpeed)delete out.dashTicks;
        const test={...app.p,rooms:{...app.p.rooms,[app.key]:{...r,platform:out}}};
        if(validate(test).ok){r.platform=out;changed();showFields()}
      };
    }
    field('进入房间事件',dropdown(eventOpts(),r.onEnter,v=>update(r,'onEnter',v)),true);
    editorHook('roomPanel',{field,mk,update,numberField});
    if(modeInfo(r.mode).toolKey)return;
    const tool=field('手持工具 · C',mk('button',r.tool?'编辑工具':'配置工具'),true);
    tool.onclick=async()=>{
      const cfg=r.tool??{};
      const picked=await ask('手持工具',[
        ['item','需要的道具 ID',cfg.item??'watering_can'],
        ['range','前方距离',String(cfg.range??64)],['width','横向宽度',String(cfg.width??46)],
        ['ticks','最少按住帧数',String(cfg.ticks??3)],['enabled','启用','yes',[['yes','启用'],['no','关闭']]]
      ]);
      if(!picked)return;
      const next={...r};
      if(picked.enabled==='no')delete next.tool;
      else next.tool={...cfg,item:picked.item,range:Number(picked.range),width:Number(picked.width),ticks:Number(picked.ticks)};
      const check={...app.p,rooms:{...app.p.rooms,[app.key]:next}};
      if(validate(check).ok){app.p=check;app.dirty=true;refresh();}
    };
    return;
  }
  const radius=app.p.player?.radius??6;
  numberField(e,'x','X',entry?radius:0,r.w-(entry?radius:e.w??20));
  numberField(e,'y','Y',entry?radius:0,r.h-(entry?radius:e.h??20));
  if(entry){field('朝向',dropdown(DIRECTIONS.map(k=>[k,k]),e.face??'down',v=>update(e,'face',v)),true);return;}
  numberField(e,'w','宽',1,r.w-e.x);numberField(e,'h','高',1,r.h-e.y);
  const model=readGrid(r,gridOptions()),item=model.objects.find(o=>o.entity.id===e.id);
  if(item){
    // 对齐格子的物件可以直接改「占几格」（左上角不动），大素材常用
    const cellInput=(axis,label)=>{
      const input=field(label,mk('input',undefined,{type:'number',min:1,max:64,step:1,value:axis==='w'?item.cw:item.ch}));
      input.onchange=()=>{
        const n=Math.round(input.valueAsNumber);
        remember();
        const ok=Number.isFinite(n)&&gridEdit(m=>{const it=m.objects.find(o=>o.entity.id===e.id);return gridResize(m,it,axis==='w'?n:it.cw,axis==='h'?n:it.ch);});
        if(!ok||!validate(app.p,false).ok){if(ok)restoreState(app.history.pop());else{app.history.pop();updateUndo();}status('那里放不下：旁边的格子被占了',true);}
        else status('已改成占 '+(axis==='w'?n+' 格宽':n+' 格高'));
        showFields();paint();
      };
    };
    cellInput('w','占几格宽');cellInput('h','占几格高');
  }
  stringField(e,'name','名称',true);
  if(e.kind==='wall'){boolField(e,'oneWay','横版中只挡住向下落地');return;}
  field('角色素材',dropdown([['','— 默认 —'],...Object.keys(app.p.assets??{}).map(k=>[k,k])],e.sprite,v=>update(e,'sprite',v)),true);
  editorHook('entityPanel',{entity:e,field,mk,numberField,eventOpts,dropdown,update});
  const type=projectPlugins(app.p).entities.get(entityKind(e))?.hooks;
  if(!type?.customEvents){
    field('触发事件',dropdown(eventOpts(),e.event,v=>update(e,'event',v)),true);
    field('条件不满足',dropdown(eventOpts(),e.otherwise,v=>update(e,'otherwise',v)),true);
  }
  if(e.kind==='prop')boolField(e,'toolTarget','仅手持工具触发');
  if(e.kind==='door'){
    field('目标房间',dropdown([['','— 未绑定 —'],...Object.entries(app.p.rooms).map(([k,v])=>[k,v.title??k])],e.room,v=>{
      if(v){e.room=v;e.entry=Object.keys(app.p.rooms[v].entries)[0];}
      else{delete e.room;delete e.entry;}
      changed({rebuild:true,assets:false});
    }),true);
    if(e.room)field('目标入口',dropdown(Object.keys(app.p.rooms[e.room].entries).map(k=>[k,k]),e.entry,v=>update(e,'entry',v)),true);
  }
  if(e.kind==='savepoint'){
    boolField(e,'heal','保存时恢复 HP',true);boolField(e,'confirm','保存前询问',true);
    field('存档前事件',dropdown(eventOpts(),e.beforeEvent,v=>update(e,'beforeEvent',v)),true);
    field('读档位置',dropdown([['','— 存档时的位置 —'],...Object.keys(r.entries).map(k=>[k,k])],e.entry,v=>update(e,'entry',v)),true);
  }
  if(e.kind==='enemy'){
    field('遭遇战',dropdown([['','— 仅执行触发事件 —'],...Object.entries(app.p.battles??{}).map(([k,ref])=>[k,makeBattleOption(k,ref)])],
      e.battle,v=>{update(e,'battle',v);showFields();}),true);
    if(e.battle){
      const button=mk('button','编辑此遭遇 ↗',{type:'button',className:'full'});
      button.onclick=()=>editBattleFile(app.p.battles[e.battle]).catch(ex=>status(ex.message,true));
      $('fields').append(button);
    }
  }
  if(e.kind==='mode'){
    field('切换到',dropdown(modeOptions(),e.mode,v=>update(e,'mode',v)),true);
    numberField(e,'grip','抓力步数',1,3600);boolField(e,'rest','休息台');
  }
  if(e.kind==='switch'){stringField(e,'flag','压力旗标',true);boolField(e,'latch','锁定');}
  if(e.kind==='hold'){numberField(e,'ticks','持续步数',1,3600);numberField(e,'decay','松手衰减',0,600);}
  if(['door','mode','zone','checkpoint','enemy','savepoint'].includes(e.kind))boolField(e,'auto','接触触发',['mode','zone','checkpoint','enemy'].includes(e.kind));
  if(!type?.customEvents){
    boolField(e,'once',e.kind==='enemy'&&e.battle?'胜利或饶恕后停用':'仅一次');boolField(e,'solid','固体');
  }
  const details=mk('details');details.append(mk('summary','条件和高级属性'));
  const area=mk('textarea',undefined,{value:JSON.stringify(e,null,2),spellcheck:false});
  const apply=mk('button','校验并应用');
  apply.onclick=()=>{
    try{
      const next=JSON.parse(area.value);
      if(next.id!==e.id||entityKind(next)!==entityKind(e))throw new Error('保留原 ID 和类型，避免破坏引用');
      const p=structuredClone(app.p),items=p.rooms[app.key].entities;
      items[items.findIndex(a=>a.id===e.id)]=next;
      if(validate(p).ok){q().entities=items;changed({rebuild:true});}
    }catch(ex){status(ex.message,true);}
  };
  details.append(area,apply);$('fields').append(details);
}
function showLayers(){
  const root=$('layers'),r=q();root.replaceChildren();
  if(!r.map){root.textContent=r.layout?'已引用官方分层布景。点「内嵌布景」后可调整图层。':'未导入分层布景';return;}
  root.append(mk('p','左：可见　右：放在角色前'));
  for(const l of r.map.layers??[]){
    const label=mk('label',undefined,{title:l.id});
    for(const [k,v] of [['visible',l.visible!==false],['front',r.frontLayers?.includes(l.id)||l.kind==='foreground']]){
      const input=mk('input',undefined,{type:'checkbox',checked:v,title:k==='visible'?'可见':'前景'});
      input.disabled=k==='front'&&l.kind==='foreground';
      input.onchange=()=>{
        if(k==='visible')l.visible=input.checked;
        else {const set=new Set(r.frontLayers??[]);if(input.checked)set.add(l.id);else set.delete(l.id);r.frontLayers=[...set];}
        changed();void hydrate();
      };label.append(input);
    }
    label.append(' '+l.id);root.append(label);
  }
}

function nextId(kind,ids){let i=1;while(ids.has(kind+'_'+i))++i;return kind+'_'+i;}
function entityId(kind){return nextId(kind,new Set(Object.values(app.p.rooms).flatMap(r=>(r.entities??[]).map(e=>e.id))));}
function adjustRect(raw){
  const r=q(),x=clamp(Math.round(raw.x),0,r.w-1),y=clamp(Math.round(raw.y),0,r.h-1);
  return {x,y,w:clamp(Math.round(raw.w),1,r.w-x),h:clamp(Math.round(raw.h),1,r.h-y)};
}
function addEntity(kind,raw,extra={}){
  remember();
  const r=q(),id=entityId(kind),b=adjustRect(raw);
  const props=kind==='door'?{name:'新门'}:
    kind==='switch'?{flag:id,latch:false}:kind==='mode'?{mode:'climb',grip:160}:
    kind==='savepoint'?{name:'星光存档点'}:kind==='hold'?{name:'长按机关',ticks:45,decay:1}:kind==='npc'?{name:'新角色',solid:true}:kind==='enemy'?{name:'新敌人',auto:true}:{};
  const e={kind,id,...b,...props,...extra};
  if(kind==='switch'&&!e.flag)e.flag=id;
  (r.entities??=[]).push(e);
  app.dirty=true;select('entity',id);
  status(labels[kind]+'已添加 · '+id);
}
function addEntry(x,y,face='down'){
  remember();
  const radius=app.p.player?.radius??6,r=q(),id=nextId('entry',new Set(Object.keys(r.entries)));
  r.entries[id]={x:clamp(Math.round(x),radius,r.w-radius),y:clamp(Math.round(y),radius,r.h-radius),face};
  app.dirty=true;select('entry',id);status('入口已添加 · '+id);
}
function pointer(e){
  const b=canvas.getBoundingClientRect(),scale=Math.min(b.width/canvas.width,b.height/canvas.height);
  const view=roomTransform(app.p,q());
  return {x:clamp(((e.clientX-b.left-(b.width-canvas.width*scale)/2)/scale-view.x)/view.scale+Math.round(app.camera.x),0,q().w),
    y:clamp(((e.clientY-b.top-(b.height-canvas.height*scale)/2)/scale-view.y)/view.scale+Math.round(app.camera.y),0,q().h)};
}
function dragRect(){
  const {from,to}=app.drag;
  return adjustRect({x:Math.min(from.x,to.x),y:Math.min(from.y,to.y),w:Math.abs(from.x-to.x),h:Math.abs(from.y-to.y)});
}
function targetAt(p){
  const layer=activeLayer(),model=layer?readGrid(q(),gridOptions()):null;
  if(layer && layer!=='objects' && layer!=='collision')return [];
  if(layer!=='collision')for(const [id,e] of Object.entries(q().entries))if(Math.abs(p.x-e.x)<=7&&Math.abs(p.y-e.y)<=7)return ['entry',id];
  const objectIds=model?new Set([...model.objects,...model.locked].map(o=>o.entity.id)):null;
  for(const e of [...(q().entities??[])].reverse()){
    if(layer && objectIds.has(e.id)!==(layer==='objects'))continue;
    const {x,y,w,h}=rectOf(e);
    if(p.x>=x&&p.x<=x+w&&p.y>=y&&p.y<=y+h)return ['entity',e.id];
  }
  return [];
}
// —— 画布操作 ——
function cellAt(p){const g=gridSize(q());return {c:Math.floor(Math.min(p.x,q().w-1)/g),r:Math.floor(Math.min(p.y,q().h-1)/g)};}
function gridEdit(fn){
  const next=editRoom(app.p,app.key,fn,gridOptions());
  if(!next)return false;
  app.p=next;app.dirty=true;return true;
}
function cellsBetween(a,b){ // 快速拖动时补齐中间跳过的格子
  const out=[];let {c,r}=a;const dc=Math.abs(b.c-c),dr=-Math.abs(b.r-r),sc=c<b.c?1:-1,sr=r<b.r?1:-1;let err=dc+dr;
  for(;;){out.push({c,r});if(c===b.c&&r===b.r)break;const e2=2*err;if(e2>=dr){err+=dr;c+=sc;}if(e2<=dc){err+=dc;r+=sr;}}
  return out;
}
function brushOp(){
  const size=app.footprint;
  return (m,c,r)=>gridPaint(m,c,r,app.part,size?{cw:size[0],ch:size[1]}:{});
}
function beginStroke(op){
  remember();
  app.stroke={op,last:null,changed:false,before:new Set((q().entities??[]).map(e=>e.id))};
}
function strokeTo(cell){
  const s=app.stroke;if(!s)return;
  const cells=s.last?cellsBetween(s.last,cell).slice(1):[cell];s.last=cell;
  if(!cells.length)return;
  if(gridEdit(m=>cells.reduce((any,p)=>s.op(m,p.c,p.r)||any,false))){s.changed=true;paint();}
}
function endStroke(){
  const s=app.stroke;app.stroke=null;
  if(!s)return;
  if(!s.changed){app.history.pop();updateUndo();return;}
  const report=validate(app.p,false);
  if(!report.ok){
    restoreState(app.history.pop());app.future=[];updateUndo();
    status('这样放不下：'+report.errors[0].path+' · '+report.errors[0].message,true);return;
  }
  // 刚放下一个物件（不是地形）就选中它，方便马上在检查器里取名字、绑事件
  const added=(q().entities??[]).filter(e=>!s.before.has(e.id)&&!['wall','mode'].includes(e.kind));
  if(added.length===1)app.selection=['entity',added[0].id];
  else if(app.selection&&!current())app.selection=null;
  showFields();paint();
  status(report.warnings.length?'已放置 · '+report.warnings[0].message:'已放置');
}
function itemFor(model,[kind,id]){
  if(kind==='entry')return model.entries.find(e=>e.id===id);
  return model.objects.find(o=>o.entity.id===id);
}
function canvasScale(){
  const b=canvas.getBoundingClientRect(),scale=Math.min(b.width/canvas.width,b.height/canvas.height);
  return scale*roomTransform(app.p,q()).scale;
}
function hoverInfo(p){
  const {c,r}=cellAt(p),g=gridSize(q()),model=readGrid(q(),gridOptions());
  const obj=model.objects.find(o=>c>=o.c&&c<o.c+o.cw&&r>=o.r&&r<o.r+o.ch),locked=model.locked.find(o=>c>=o.c&&c<o.c+o.cw&&r>=o.r&&r<o.r+o.ch);
  const sym=model.terrain[r]?.[c],terrain=PARTS.find(p=>p.sym===sym&&p.terrain);
  const tile=model.tiles.find(o=>o.layer===activeLayer() && c>=o.c && c<o.c+o.cw && r>=o.r && r<o.r+o.ch);
  const what=tile?(model.reg.byId[tile.part]?.label??'旧方块')+(tile.locked?'（锁定）':''):activeLayer()==='collision'?(terrain?.label??'空地'):activeLayer() && activeLayer()!=='objects'?'空地':obj?(obj.entity.name??obj.entity.id):locked?locked.entity.id+'（未对齐格子）':terrain?terrain.label:'空地';
  $('cursorInfo').textContent=`格 ${c}, ${r} · 像素 ${Math.round(p.x)}, ${Math.round(p.y)} · ${what} · 每格 ${g}`;
}
canvas.addEventListener('contextmenu',e=>{if(!app.playing)e.preventDefault();});
canvas.addEventListener('pointerdown',e=>{
  if(app.playing||app.busy)return;
  const p=pointer(e),cell=cellAt(p);canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);
  if(e.button===1||e.button===0&&app.space){app.pan={x:e.clientX,y:e.clientY,cam:{...app.camera}};canvas.classList.add('panning');return;}
  if(e.button===2){beginStroke(gridErase);strokeTo(cell);return;}
  if(e.button!==0)return;
  if(app.tool==='select'){
    const hit=targetAt(p);select(...hit);
    if(hit.length)app.moving={hit,from:p,cell,item:null,remembered:false,origin:structuredClone(current())};
    return;
  }
  if(app.tool==='eraser'){beginStroke(gridErase);strokeTo(cell);return;}
  if(!app.snap && !activeLayer()){app.drag={from:p,to:p};paint();return;}
  if(app.tool==='brush'){beginStroke(brushOp());strokeTo(cell);return;}
  if(app.tool==='rect'){app.drag={cells:{from:cell,to:cell}};paint();}
});
canvas.addEventListener('pointermove',e=>{
  if(app.playing||!app.p)return;
  if(app.pan){
    const s=canvasScale(),r=q(),{v}=roomTransform(app.p,r);
    const pan=(at,max)=>max<=0?max/2:clamp(at,0,max);
    app.camera.x=pan(app.pan.cam.x-(e.clientX-app.pan.x)/s,r.w-v.w);app.camera.y=pan(app.pan.cam.y-(e.clientY-app.pan.y)/s,r.h-v.h);
    paint();return;
  }
  const p=pointer(e),cell=cellAt(p);
  hoverInfo(p);
  const moved=!app.hover||app.hover.c!==cell.c||app.hover.r!==cell.r;app.hover=cell;
  if(app.stroke){strokeTo(cell);return;}
  if(app.moving){dragSelection(p,cell);return;}
  if(app.drag?.cells){app.drag.cells.to=cell;paint();return;}
  if(app.drag){app.drag.to=p;paint();return;}
  if(moved)paint();
});
function dragSelection(p,cell){
  const m=app.moving,e=current();if(!e)return;
  const start=()=>{if(!m.remembered){remember();m.remembered=true;}};
  const model=readGrid(q(),gridOptions()),item=itemFor(model,m.hit);
  if(app.snap&&item){
    if(!m.offset)m.offset={c:m.cell.c-item.c,r:m.cell.r-item.r};
    const c=cell.c-m.offset.c,r=cell.r-m.offset.r;
    if(c===item.c&&r===item.r)return;
    start();
    if(gridEdit(model=>gridMove(model,itemFor(model,m.hit),c,r)))paint();
    return;
  }
  // 未对齐格子的旧物件或关掉吸附时：按像素拖动
  const dx=Math.round(p.x-m.from.x),dy=Math.round(p.y-m.from.y);
  if(!dx&&!dy&&!m.remembered)return;
  start();
  const r=q(),radius=app.p.player?.radius??6,o=m.origin;
  if(m.hit[0]==='entry'){e.x=clamp(o.x+dx,radius,r.w-radius);e.y=clamp(o.y+dy,radius,r.h-radius);}
  else{const b=rectOf(o);e.x=clamp(b.x+dx,0,r.w-b.w);e.y=clamp(b.y+dy,0,r.h-b.h);}
  app.dirty=true;paint();
}
function finishPointer(){
  if(app.pan){app.pan=null;canvas.classList.remove('panning');return;}
  if(app.stroke){endStroke();return;}
  if(app.moving){
    const m=app.moving;app.moving=null;
    if(m.remembered){
      const report=validate(app.p,false);
      if(!report.ok){restoreState(app.history.pop());status('不能放在这里：'+report.errors[0].message,true);}
      else{showFields();status('已移动 '+m.hit[1]);}
    }
    return;
  }
  if(app.drag?.cells){
    const {from,to}=app.drag.cells;app.drag=null;
    remember();
    if(gridEdit(model=>gridFill(model,from.c,from.r,to.c,to.r,app.part,app.footprint??undefined))){
      const report=validate(app.p,false);
      if(!report.ok){restoreState(app.history.pop());status('这样放不下：'+report.errors[0].message,true);return;}
      showFields();status('已填充 '+(Math.abs(from.c-to.c)+1)+'×'+(Math.abs(from.r-to.r)+1)+' 格');
    }else{app.history.pop();updateUndo();}
    paint();return;
  }
  if(app.drag){
    const {from}=app.drag,b=dragRect(),part=partOf(app.part);app.drag=null;
    if(part.entry){addEntry(from.x,from.y);return;}
    if(b.w<3&&b.h<3){const g=gridSize(q()),[cw,ch]=app.footprint??footprint(part);b.x=Math.round(from.x);b.y=Math.round(from.y);b.w=cw*g;b.h=ch*g;}
    addEntity(part.kind,b,{...(part.props??{}),...(part.sprite?{sprite:part.sprite}:{})});
  }
}
canvas.addEventListener('pointerup',finishPointer);
canvas.addEventListener('pointercancel',()=>{app.drag=null;finishPointer();});
canvas.addEventListener('pointerleave',()=>{if(!app.stroke&&!app.moving&&!app.drag){app.hover=null;paint();}});
canvas.addEventListener('wheel',e=>{
  if(app.playing||!app.p)return;e.preventDefault();
  const r=q(),{v}=roomTransform(app.p,r);
  const pan=(at,delta,max)=>max<=0?max/2:clamp(at+delta,0,max);
  app.camera.x=pan(app.camera.x,e.shiftKey?e.deltaY:e.deltaX,r.w-v.w);
  app.camera.y=pan(app.camera.y,e.shiftKey?0:e.deltaY,r.h-v.h);paint();
},{passive:false});

function fromMap(map,reference){
  if(map?.format!=='director-map/1'||!Array.isArray(map.elements)||!Array.isArray(map.layers))throw new Error('需要 V0.4 director-map/1 文件');
  const w=map.width,h=map.height,radius=app.p.player?.radius??6;
  const bg=typeof map.background_color==='number'?map.background_color>>>0:0;
  const color='#'+[bg&255,(bg>>8)&255,(bg>>16)&255].map(v=>v.toString(16).padStart(2,'0')).join('');
  const safeName=String(map.id??'imported').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,55);
  if(!(Number.isInteger(w)&&Number.isInteger(h)))throw new Error('布景没有合法的宽和高');
  const key=!Object.hasOwn(app.p.rooms,safeName)&&safeName?safeName:nextId(safeName||'room',new Set(Object.keys(app.p.rooms)));
  const r={title:String(map.id??'导入房间').slice(0,120),w,h,color,style:'flat',entries:{
    arrival:{x:clamp(Math.round(w/2),radius,w-radius),y:clamp(Math.round(h/2),radius,h-radius),face:'down'}},
    entities:[],map};
  if(reference)r.official=reference;
  else if(/^ch[1-5]$/.test(map.chapter)&&/^room_[\w-]+$/.test(map.id??''))r.official={chapter:map.chapter,room:map.id};
  addRoom(key,r);
}
function addRoom(key,r){
  if(Object.hasOwn(app.p.rooms,key))throw new Error('房间 ID 已存在');
  const p={...app.p,rooms:{...app.p.rooms,[key]:r}};
  if(!validate(p).ok)return;
  app.p=p;app.key=key;app.camera=null;app.selection=null;app.hints=[];app.art=null;app.dirty=true;refresh();
  status('房间已添加 · '+key);
}
function filterCatalog(){
  const query=$('roomSearch').value.trim().toLowerCase();
  const found=app.catalog.filter(e=>e.map_available&&e.name.toLowerCase().includes(query));
  $('officialRooms').replaceChildren(...found.map(e=>opt(e.name,e.name)));
  $('importRoom').disabled=!found.length||!!lack('roomImport');
}
async function catalog(){
  if(lack('roomImport'))return;
  const rev=++app.book,chapter=$('chapter').value;
  $('officialRooms').replaceChildren(opt('读取中…',''));$('importRoom').disabled=true;
  try{
    const value=await json('/api/a/rooms?chapter='+chapter);
    if(rev!==app.book)return;
    app.catalog=value.rooms;filterCatalog();
  }catch(ex){if(rev===app.book)status(ex.message,true);}
}
function download(body,name,type){
  const url=URL.createObjectURL(new Blob([body],{type})),a=mk('a',undefined,{href:url,download:name});
  a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);
}
function filename(s){return s.replace(/[\\/:*?"<>|\u0000-\u001F]/g,'_').slice(0,100)||'scene';}
function readData(file){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);
  });
}
function editingButtons(){
  const active=app.playing||app.busy;
  for(const id of ['new','import','open','save','title','rooms','addRoom','png','chapter','roomSearch','officialRooms','useHint','entities','example','battleExample','campaignExample','openBattleEditor','applyJson'])
    $(id).disabled=active;
  for(const el of document.querySelectorAll('[data-example],#pluginTools button,#pluginTools select,#tools button,#palette button,#maker input,#snap,#gridSize,#mapApply,#fields input,#fields select,#fields button,#fields textarea,#layers input'))el.disabled=active;
  updateUndo();
  if(!active && app.p&&!pluginIssue){editorHook('controls',{layer:activeLayer()});$('snap').disabled=!!activeLayer();}
  if(!active){$('useHint').disabled=!app.hints.length;filterCatalog();}
  else $('importRoom').disabled=true;
  eventEditor?.disable(active);battleEditor?.disable(active);campaignEditor?.disable(active);
  $('validate').disabled=app.busy;
  $('play').disabled=app.busy||app.playing;$('editMode').disabled=app.busy;
  $('exportHtml').disabled=app.busy;$('restart').hidden=!app.playing;
  $('play').setAttribute('aria-pressed',String(app.playing));$('editMode').setAttribute('aria-pressed',String(!app.playing));
  $('playRoom').disabled=active;
  $('setStart').disabled=active||app.selection?.[0]!=='entry';$('remove').disabled=active||!current()||app.selection?.[0]==='entry'&&Object.keys(q().entries).length<=1;
  document.querySelector('.touch').hidden=!app.playing;$('sceneNav').hidden=!app.playing;
  document.body.classList.toggle('playing',app.playing);
  for(const el of document.querySelectorAll('[data-capability]'))disableFeature(el,lack(el.dataset.capability));
  const battleReason=lack('battle');
  if(battleReason){
    battleEditor?.disable(true);
    $('battlePanel').title=battleReason;
  }
  const requiresBattle=Object.keys(app.p?.battles??{}).length>0;
  const playReason=requiresBattle?lack('battle battleAssets'):'';
  for(const id of ['play','playRoom','exportHtml','validate']){
    const el=$(id);
    if(el.dataset.battleUnavailable){delete el.dataset.battleUnavailable;el.removeAttribute('aria-disabled');el.removeAttribute('title');}
    if(playReason){el.dataset.battleUnavailable='true';disableFeature(el,playReason);}
  }
}
async function busy(task){
  if(app.busy)return;
  app.busy=true;editingButtons();
  try{await task();}catch(ex){
    status(ex.message,true);
    if(ex.issues?.length){$('diagnostics').textContent=ex.issues.map(e=>e.path+' · '+e.message).join('\n');$('diagnostics').hidden=false;$('jsonPanel').open=true;}
  }finally{app.busy=false;editingButtons();}
}
function stopGame(repaint=true){
  if(app.nav?.active)app.nav.stop();app.nav=null;app.game?.destroy();app.game=null;app.playing=false;
  if(repaint){$('canvasHint').textContent='左键放置 · 右键擦除 · 中键拖动画面';refresh();editingButtons();}
}
async function play(start=null){
  const p=start?{...app.p,start}:app.p;
  if(app.playing||pluginIssue||Object.keys(p.battles??{}).length&&lack('battle battleAssets')||!validate(p).ok)return;
  await busy(async()=>{
    status('载入试玩素材…');
    const shared={images:app.assetImages};
    const [art,pack]=await Promise.all([
      playOptions.manual?prepareArt(p,null,{shared}):preparePlayArt(p,shared),prepareBattlePack(p)
    ]);
    const battles=await prepareBattlePlayer(pack);
    if(pluginIssue)return;
    app.playing=true;++app.request;app.hover=null;$('canvasHint').textContent='Shift＋Esc 返回编辑';$('cursorInfo').textContent='方向键 / WASD · Z · X';
    const help=trailerControls(p.rooms[p.start.room].mode,p);
    status(art.unresolved.length?'试玩中 · '+art.unresolved.length+' 张素材待修复':help?'试玩中':'试玩中 · X 回检查点',!!art.unresolved.length);
    try{
      app.nav=createSceneNavigator((msg,active)=>{$('sceneNavInfo').textContent=msg;$('sceneNavStart').disabled=active;$('sceneNavStop').disabled=!active});
      const interactiveScript=p.navScript?.some(t=>!isTimedInput(t));
      const timedScript=Object.keys(p.rooms).some(key=>trailerRows(p,key).length);
      $('sceneNavInfo').textContent=timedScript?'可重放当前房间的宣传片时间线。':interactiveScript?'已载入专属互动剧本，可选「全图剧本互动跑测」或任意房间。':'选择目的地，或探索可达的新房间。';
      $('sceneNavStart').disabled=false;$('sceneNavStop').disabled=!playOptions.autoplay;
      const navOpts=[];
      if(timedScript)navOpts.push(new Option('宣传片时间线','__trailer__'));
      if(interactiveScript)navOpts.push(new Option('★ 全图剧本互动跑测','__script__'));
      navOpts.push(new Option('探索未到过的房间',''));
      $('sceneNavTarget').replaceChildren(...navOpts,...Object.entries(p.rooms).map(([k,r])=>new Option(r.title??k,k)));
      app.game=mountPlayer(canvas,p,art,{...playOptions,nav:app.nav,controls:document.querySelector('.touch'),onExit:()=>stopGame(),battles,temporary:!!start,
        onBattle:b=>{
          $('canvasHint').textContent=b?.phase==='battle'?BATTLE_HELP:'Shift＋Esc 返回编辑';
          if(b?.phase==='loading')status('准备遭遇战…');
          else if(b?.phase==='battle')status('遭遇战 · '+b.title);
          else if(b?.phase==='result')status('已返回场景 · '+RESULT_LABELS[b.outcome.result]);
        },
        onError:ex=>status('试玩出错 · '+ex.message,true),
        onFrame:s=>{
          const r=app.p.rooms[s.room];
          $('sceneLabel').textContent=(r.title??s.room)+' · 试玩';
          $('cursorInfo').textContent=trailerControls(s.mode,app.p)??'方向键 / WASD · Z · X';
        }});
    }catch(ex){app.playing=false;throw ex;}
    canvas.focus();
  });
}
// —— 零件调色盘 ——
function buildPalette(){
  if(!app.p)return;
  const list=visibleParts(),root=$('palette'),layer=activeLayer();
  editorHook('controls',{layer});
  $('snap').disabled=!!layer;$('snap').checked=layer?true:app.snap;
  if(!list.some(p=>p.id===app.part)){app.part=list[0]?.id??null;app.footprint=null;}
  if($('mapPanel').open)$('mapText').value=toText(q(),app.key,gridOptions());
  $('placementHelp').textContent=list.length?placementHelp():'本层暂无零件，请先新建方块。';
  root.replaceChildren(...list.map((part,i)=>{
    const b=mk('button',undefined,{type:'button',title:(part.tip??part.label)+(part.custom?' · 双击修改':'')+(i<10?' （数字键 '+((i+1)%10)+'）':'')});
    b.dataset.part=part.id;b.style.setProperty('--chip',part.color);
    const chip=mk('span',part.sym,{className:'chip'});b.append(chip,mk('span',part.label));
    const a=animation(part.thumbnail??part.sprite,app.p.assets);
    if(a.frames.length){
      const icon=mk('canvas',undefined,{width:64,height:64,className:'dg-thumb'});
      const [w,h]=footprint(part),g=gridSize(q());
      thumbnail(icon,a,part.tileKey?{w:w*g,h:h*g}:null);chip.replaceChildren(icon);
    }
    if(i<10)b.append(mk('kbd',String((i+1)%10)));
    b.setAttribute('aria-pressed',String(part.id===app.part));
    b.onclick=()=>setPart(part.id);
    if(part.custom)b.ondblclick=()=>void customPartDialog(part.id);
    return b;
  }),Object.assign(mk('button','＋ 自定义零件',{type:'button',title:'用导入的图片做一个零件，可以占好几格（例如长椅）'}),{onclick:()=>void customPartDialog()}));
  if(layer && layer!=='objects')root.lastElementChild.remove();
  showFootprint();
}
function showFootprint(){
  const part=partOf(app.part),row=$('footprintRow');if(!row)return;
  row.hidden=!app.part||!!(part.terrain||part.entry);
  const [w,h]=app.footprint??footprint(part);
  $('fpW').value=w;$('fpH').value=h;
  $('fpReset').disabled=!app.footprint;
}
function assetSource(a){
  if(typeof a==='string')return a;
  if(!a||typeof a!=='object')return null;
  for(const k of ['src','idle_down','idle','idle_right','walk_down'])if(a[k])return Array.isArray(a[k])?a[k][0]:a[k];
  return Array.isArray(a.frames)?a.frames[0]:null;
}
function imageSize(src){
  return new Promise(resolve=>{if(!src)return resolve(null);const img=new Image();img.onload=()=>resolve({w:img.naturalWidth,h:img.naturalHeight});img.onerror=()=>resolve(null);img.src=src;});
}
function pickImage(){
  return new Promise(resolve=>{
    const input=mk('input',undefined,{type:'file',accept:'image/png,image/webp,image/gif,image/jpeg'});
    input.onchange=async()=>{const [f]=input.files;if(!f)return resolve(null);
      if(f.size>12*1024*1024){status('单张图片限 12 MiB',true);return resolve(null);}
      resolve({name:f.name.replace(/\.[^.]+$/,''),data:await readData(f)});};
    input.click();
  });
}
// 自定义零件：用一张图片（已在工程素材里，或现在导入）做成可以占好几格的零件
async function customPartDialog(editId){
  const old=editId?app.p.gridParts?.[editId]:null,assets=Object.keys(app.p.assets??{});
  let asset=old?.sprite;
  if(!old){
    const pick=await ask('自定义零件 · 选图片',[['asset','图片',assets[0]??'__new',[['__new','导入新图片…'],...assets.map(k=>[k,k])]]]);
    if(!pick)return;
    asset=pick.asset;
    if(asset==='__new'){
      const file=await pickImage();if(!file)return;
      const base=(file.name.replace(/[^\p{L}\p{N}_-]+/gu,'_').replace(/^_+|_+$/g,'')||'image').slice(0,60);
      asset=base;let n=2;while(Object.hasOwn(app.p.assets??{},asset))asset=base+'_'+n++;
      remember();(app.p.assets??={})[asset]=file.data;app.dirty=true;
    }
  }
  const g=gridSize(q()),size=await imageSize(assetSource(app.p.assets?.[asset]));
  const guess=old?.cells??(size?[Math.max(1,Math.ceil(size.w/g)),Math.max(1,Math.ceil(size.h/g))]:[1,1]);
  const used=new Set(parts().list.filter(part=>part.id!==editId).map(part=>part.sym));
  const letters=FREE_SYMBOLS.filter(s=>!used.has(s));
  if(!letters.length&&!old)return status('自定义零件已经用完 16 个字母',true);
  const kindNames={prop:'物件（可调查）',npc:'NPC',wall:'墙（挡路）',block:'推块',enemy:'敌人',door:'门',zone:'触发区',switch:'踏板',checkpoint:'检查点',savepoint:'存档点',hold:'长按机关'};
  const fields=[
    ['label','名称',old?.label??asset],
    ['sym','文字地图里的字母',old?.sym??letters[0],(old?[old.sym,...letters.filter(s=>s!==old.sym)]:letters).map(s=>[s,s])],
    ['kind','种类',old?.kind??'prop',CUSTOM_KINDS.map(k=>[k,kindNames[k]])],
    ['cw','占几格宽'+(size?'（图片 '+size.w+'×'+size.h+' 像素，每格 '+g+'）':''),String(guess[0])],
    ['ch','占几格高',String(guess[1])],
    ['solid','能否穿过',old?.props?.solid===false?'no':'yes',[['yes','挡住玩家（固体）'],['no','可以穿过']]],
  ];
  if(old)fields.push(['action','操作','save',[['save','保存修改'],['delete','删除这个零件（已摆的物件保留，变回普通物件）']]]);
  const v=await ask(old?'修改自定义零件':'新建自定义零件',fields);
  if(!v)return;
  const parts={...(app.p.gridParts??{})};
  if(v.action==='delete'){delete parts[editId];}
  else{
    const cw=Number(v.cw),ch=Number(v.ch);
    const props=v.kind==='wall'?{}:{solid:v.solid==='yes'};
    const id=editId??(()=>{let i=1;while(Object.hasOwn(parts,'part_'+i))i++;return 'part_'+i;})();
    parts[id]={sym:v.sym,label:v.label||asset,kind:v.kind,sprite:asset,cells:[cw,ch],props};
    if(!editId)app.part=id;
  }
  const next={...app.p,gridParts:parts};
  if(!Object.keys(parts).length)delete next.gridParts;
  if(!validate(next).ok)return;
  remember();app.p=next;app.dirty=true;
  if(!registry(next.gridParts).byId[app.part])app.part='wall';
  app.footprint=null;buildPalette();setPart(app.part);void hydrate();
  status(v.action==='delete'?'已删除自定义零件':'自定义零件「'+(v.label||asset)+'」可以用了 · 画笔点一下就放');
}
function moveSelection(dc,dr){
  if(!app.selection)return false;
  const model=readGrid(q(),gridOptions()),item=itemFor(model,app.selection);
  if(!item)return false;
  remember();
  if(!gridEdit(m=>gridMove(m,itemFor(m,app.selection),item.c+dc,item.r+dr))){app.history.pop();updateUndo();return true;}
  if(!validate(app.p,false).ok){restoreState(app.history.pop());status('那里放不下',true);return true;}
  showFields();paint();return true;
}
function wire(){
  $('tools').replaceChildren(...TOOLS.map(([tool,icon,name,key])=>{
    const b=mk('button',undefined,{type:'button',title:name+'（'+key+'）'});b.dataset.tool=tool;
    b.append(mk('b',icon),mk('span',name));b.onclick=()=>setTool(tool);return b;
  }));
  const row=mk('div',undefined,{id:'footprintRow',className:'inline maker-row'});
  row.append(mk('span','占格',{className:'subtle',title:'这个零件放下去占几格；大素材（长椅、大桌子）可以调大'}),
    mk('input',undefined,{id:'fpW',type:'number',min:1,max:64,step:1,style:'width:52px'}),mk('span','×'),
    mk('input',undefined,{id:'fpH',type:'number',min:1,max:64,step:1,style:'width:52px'}),
    mk('button','默认',{id:'fpReset',type:'button',title:'恢复这个零件的默认大小'}));
  $('palette').after(row);
  const setFoot=()=>{
    const w=Math.round($('fpW').valueAsNumber),h=Math.round($('fpH').valueAsNumber),d=footprint(partOf(app.part));
    if(!(w>=1&&w<=64&&h>=1&&h<=64)){showFootprint();return;}
    app.footprint=w===d[0]&&h===d[1]?null:[w,h];showFootprint();paint();
  };
  $('fpW').onchange=$('fpH').onchange=setFoot;
  $('fpReset').onclick=()=>{app.footprint=null;showFootprint();paint();};
  $('snap').onchange=()=>{app.snap=$('snap').checked;setTool(app.tool);};
  $('undo').onclick=undo;$('redo').onclick=redo;
  $('gridSize').replaceChildren(...SIZES.map(n=>opt(n+' 像素',String(n))));
  $('gridSize').onchange=()=>{
    const n=Number($('gridSize').value);remember();
    q().grid={size:n};app.dirty=true;refresh(false);status('这个房间改成每格 '+n+' 像素');
  };
  $('mapPanel').addEventListener('toggle',()=>{if($('mapPanel').open)$('mapText').value=toText(q(),app.key,gridOptions());});
  $('mapRead').onclick=()=>{$('mapText').value=toText(q(),app.key,gridOptions());status('已读取文字地图');};
  $('mapCopy').onclick=()=>navigator.clipboard.writeText($('mapText').value).then(()=>status('已复制文字地图'),()=>status('浏览器不允许复制，请手动全选复制',true));
  $('mapApply').onclick=()=>{
    try{
      const room=q(),opts=gridOptions();
      const out=writeGrid(room,fromText(room,$('mapText').value,opts),projectIds(app.p),{radius:app.p.player?.radius??6});
      const next={...app.p,rooms:{...app.p.rooms,[app.key]:out}};
      if(!validate(next).ok)return;
      remember();app.p=next;app.dirty=true;if(app.selection&&!current())app.selection=null;
      refresh(false);$('mapText').value=toText(q(),app.key,opts);status('文字地图已应用到 '+(q().title??app.key));
    }catch(ex){status(ex.message,true);}
  };
  const typing=(t,sel)=>t instanceof Element&&t.matches(sel);
  document.addEventListener('keydown',e=>{
    if(e.key===' '&&!typing(e.target,'input,textarea,select,button'))app.space=true;
    if(app.playing||app.busy||pluginIssue||!app.p||document.querySelector('dialog[open]')||typing(e.target,'input,textarea,select'))return;
    const k=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
    if(mod&&k==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
    if(mod&&k==='y'){e.preventDefault();redo();return;}
    if(mod||e.altKey)return;
    if(e.key===' '){e.preventDefault();return;}
    const tool={v:'select',b:'brush',e:'eraser',r:'rect'}[k];
    if(tool){setTool(tool);return;}
    if(/^[0-9]$/.test(k)){const part=visibleParts()[(Number(k)+9)%10];if(part)setPart(part.id);return;}
    if(k==='g'){$('grid').checked=!$('grid').checked;paint();return;}
    if(e.key==='Escape'){select(null);return;}
    if((e.key==='Delete'||e.key==='Backspace')&&!$('remove').disabled){e.preventDefault();$('remove').click();return;}
    const arrow={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
    if(arrow&&document.activeElement===canvas){
      e.preventDefault();
      if(app.snap&&moveSelection(...arrow))return;
      const g=gridSize(q()),r=q(),{v}=roomTransform(app.p,r),pan=(at,max)=>max<=0?max/2:clamp(at,0,max);
      app.camera.x=pan(app.camera.x+arrow[0]*g,r.w-v.w);app.camera.y=pan(app.camera.y+arrow[1]*g,r.h-v.h);paint();
    }
  });
  document.addEventListener('keyup',e=>{if(e.key===' ')app.space=false;});
  $('title').onchange=()=>{app.p.title=$('title').value.trim()||'新场景';$('title').value=app.p.title;changed();void reportProject();};
  $('rooms').onchange=()=>{app.key=$('rooms').value;app.camera=null;app.selection=null;app.art=null;app.hints=[];refresh();};
  $('entities').onchange=()=>select(...$('entities').value.split(':'));
  $('grid').onchange=$('showHints').onchange=$('hints').onchange=paint;
  $('chapter').onchange=catalog;$('roomSearch').oninput=filterCatalog;
  $('importRoom').onclick=()=>busy(async()=>{
    const ref={chapter:$('chapter').value,room:$('officialRooms').value};
    const data=await json('/api/a/rooms/'+encodeURIComponent(ref.room)+'?chapter='+ref.chapter);
    // Keep the original player instance available in the backdrop, but don't show it alongside the playable avatar.
    const playerAsset=/^(?:ch[1-5]:)?spr_kris[udlr](?:_(?:dark|bright))?$/;
    const candidates=(await json('/api/studio/official?'+new URLSearchParams(ref))).candidates;
    const spawns=candidates.filter(e=>e.kind==='entry');
    for(const e of data.map.elements)if(playerAsset.test(e.asset)&&spawns.some(v=>Math.abs(v.px-e.x)<2&&Math.abs(v.py-e.y)<2))e.visible=false;
    fromMap(data.map,ref);
  });
  $('useHint').onclick=()=>{
    if($('hints').selectedIndex<0)return status('先选中一个候选。');
    const h=app.hints[Number($('hints').value)];if(!h)return;
    if(h.kind==='entry')addEntry(h.px,h.py);
    else if(h.kind==='mechanic')addEntity('zone',h,{name:h.name,auto:false});
    else if(h.kind==='npc')addEntity('npc',h,{name:h.name});
    else addEntity(h.kind,h,h.kind==='door'?{name:h.name}:{});
    if(h.kind==='door')status('已放置门，请在检查器指定目标房间与入口。');
  };
  $('setStart').onclick=()=>{app.p.start={room:app.key,entry:app.selection[1]};changed();status('工程起点已更新。');};
  $('playRoom').onclick=()=>play({room:app.key,entry:app.selection?.[0]==='entry'?app.selection[1]:Object.keys(q().entries)[0]});
  $('remove').onclick=()=>{
    const [kind,id]=app.selection;remember();
    if(kind==='entry'){
      const p=structuredClone(app.p);delete p.rooms[app.key].entries[id];
      if(!validate(p).ok)return;
      q().entries=p.rooms[app.key].entries;
    }else{
      const p=structuredClone(app.p);p.rooms[app.key].entities=p.rooms[app.key].entities.filter(e=>e.id!==id);
      if(!validate(p).ok)return;
      q().entities=p.rooms[app.key].entities;
    }
    app.dirty=true;select(null);status('已删除 '+id);
  };
  $('new').onclick=async()=>{if(await allowReplace()){await openProject(blank());setTool(app.tool);}};
  $('layoutLink').onclick=async e=>{
    if(lack('layout')||pluginIssue){e.preventDefault();return;}
    if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
    e.preventDefault();
    if(app.busy)return;
    try{
      await handoffWrite('workspace',{project:app.p,key:app.key,rev:app.revision,id:app.savedId,dirty:app.dirty});
      app.dirty=false;location.href='/layout/';
    }catch(ex){status('无法暂存工作区：'+ex.message,true);}
  };
  async function loadExample(endpoint){
    if(await allowReplace())await busy(async()=>{await openProject(await json('/api/studio/'+endpoint));setTool(app.tool);});
  }
  $('example').onclick=()=>loadExample('example');
  $('battleExample').onclick=()=>loadExample('example-battle');
  $('campaignExample').onclick=()=>loadExample('example-campaign');
  $('openBattleEditor').onclick=()=>editBattleFile().catch(ex=>status(ex.message,true));
  $('import').onclick=()=>$('file').click();
  $('file').onchange=async e=>{
    const [file]=e.target.files;e.target.value='';if(!file)return;
    await busy(async()=>{
      if(file.size>24*1024*1024)throw new Error('JSON 超过 24 MiB');
      const d=JSON.parse((await file.text()).replace(/^\uFEFF/,''));
      if(d.format==='director-map/1')fromMap(d);
      else if(d.format==='editor-scene-snapshot/1')fromMap(d.map);
      else if(await allowReplace()){await openProject(d);setTool(app.tool);}
    });
  };
  $('addRoom').onclick=async()=>{
    const result=await ask('新建空房间',[['key','房间 ID',nextId('room',new Set(Object.keys(app.p.rooms)))],
      ['name','房间名称','新房间'],['size','尺寸（宽 × 高）','640×360']]);
    if(!result)return;
    try{
      const d=result.size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
      if(!d)throw new Error('尺寸示例：640×360');
      const w=+d[1],h=+d[2];
      addRoom(result.key,{title:result.name,w,h,style:'flat',entries:{arrival:{x:Math.floor(w/2),y:Math.floor(h/2)}},entities:[]});
    }catch(ex){status(ex.message,true);}
  };
  $('png').onclick=()=>$('image').click();
  $('image').onchange=e=>{
    const [file]=e.target.files;e.target.value='';if(!file)return;
    void busy(async()=>{
      if(file.size>12*1024*1024)throw new Error('单张背景限 12 MiB');
      if(!/^image\/(png|webp|gif|jpeg)$/.test(file.type))throw new Error('支持 PNG、WebP、JPEG、GIF');
      q().scenery=await readData(file);changed();void hydrate();status('背景图已内嵌，按房间尺寸绘制。');
    });
  };
  $('save').onclick=async()=>{
    if(!validate().ok)return;
    const result=await ask('保存工程',[['id','存档 ID（英文、数字、-、_）',app.savedId??app.p.id??'scene-project']]);
    if(!result)return;
    await busy(async()=>{
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(result.id))throw new Error('存档 ID 仅允许英文、数字、-、_');
      const save=await json('/api/studio/projects/'+result.id,{revision:result.id===app.savedId?app.revision:null,project:app.p});
      app.savedId=result.id;app.revision=save.revision;app.dirty=false;status('已保存 · '+result.id);
      void reportProject();
    });
  };
  $('open').onclick=async()=>{
    if(!await allowReplace())return;
    await busy(async()=>{
      const {projects}=await json('/api/studio/projects');
      if(!projects.length)throw new Error('还没有保存的工程。');
      const result=await ask('打开存档',[['id','存档 ID',projects[0],projects.map(k=>[k,k])]]);
      if(result){const d=await json('/api/studio/projects/'+result.id);if(await openProject(d.project,{id:result.id,rev:d.revision}))status('已打开 · '+result.id);setTool(app.tool);}
    });
  };
  $('exportJson').onclick=()=>{if(validate().ok)download(JSON.stringify(app.p,null,2),filename(app.p.title)+'.scene.json','application/json');};
  $('exportHtml').onclick=()=>{
    if(!validate().ok)return;
    void busy(async()=>{
      status('打包素材与播放器…');
      const [art,battles]=await Promise.all([prepareArt(app.p,null,{shared:{images:app.assetImages}}),prepareBattlePack(app.p,{offline:true})]);
      const pack=await packArt(art);
      const modules=await bundleModules(app.p);
      download(makeHtml(app.p,pack,modules,battles),filename(app.p.title)+'-离线试玩.html','text/html;charset=utf-8');status('离线 HTML 已导出。');
    });
  };
  $('refreshJson').onclick=fillJson;
  $('applyJson').onclick=async()=>{
    try{
      const p=JSON.parse($('document').value);
      const before=app.key;
      await preparePlugins(p);
      if(!validate(p).ok)return;
      remember();
      app.p=p;app.dirty=true;app.key=Object.hasOwn(p.rooms,before)?before:p.start.room;mountEditors();
      void reportProject();
      app.camera=null;app.selection=null;app.art=null;app.hints=[];$('title').value=p.title;refresh();eventEditor?.refresh();battleEditor?.refresh();campaignEditor?.refresh();
    }catch(ex){status(ex.message,true);}
  };
  $('validate').onclick=()=>{
    if(!validate().ok||!Object.keys(app.p.battles??{}).length)return;
    void busy(async()=>{
      status('检查遭遇文件、弹幕与素材…');
      const {warnings}=await prepareBattlePack(app.p,{checkOnly:true});
      if(warnings.length){
        $('diagnostics').hidden=false;$('diagnostics').textContent=warnings.map(w=>w.path+' · '+w.message).join('\n');
      }
      status('工程与战斗依赖校验通过'+(warnings.length?' · '+warnings.length+' 条素材提醒':''));
    });
  };
  $('editMode').onclick=()=>{if(app.playing){stopGame();status('已回到编辑。');}};
  $('play').onclick=()=>play();
  $('sceneNavStart').onclick=()=>{
    const target=$('sceneNavTarget').value;
    if(target==='__trailer__'){
      const started=app.game?.startTrailerScript();
      $('sceneNavInfo').textContent=started?'正在重放宣传片时间线。':'当前房间没有时间线。';
      $('sceneNavStop').disabled=!started;
    }else{app.game?.stopTrailerScript();app.nav?.start(target);}
    canvas.focus();
  };
  $('sceneNavStop').onclick=()=>{app.game?.stopTrailerScript();app.nav?.stop();canvas.focus()};
  $('restart').onclick=()=>{app.game?.reset();canvas.focus();};
  window.addEventListener('beforeunload',e=>{if(app.dirty){e.preventDefault();e.returnValue='';}});
}
async function openFromUrl(ref){
  const example=[...document.querySelectorAll('[data-project]')].find(el=>el.dataset.project===ref.replace(/^\//,''));
  if(example){
    const reason=lack(example.dataset.capability);
    if(reason)throw Error(reason);
    return openProject(await json('/api/studio/'+example.dataset.example));
  }
  const pluginRef=ref.match(/^\/plugins\/([a-z][a-z0-9-]*)\/[\w/-]+\.scene\.json$/);
  if(pluginRef){
    let project;
    try{project=await json(ref);}
    catch(error){
      const {plugins}=await api('plugins');
      const issues=pluginIssues([{id:pluginRef[1],minVersion:'0.0.0'}],plugins);
      throw issues.length?Error(issues.join('；')):error;
    }
    return openProject(project);
  }
  if(/^[a-z0-9_-]{1,64}$/i.test(ref)){
    const {project,revision}=await json('/api/studio/projects/'+ref);
    return openProject(project,{id:ref,rev:revision});
  }
  const prefix='/ch6-trailer-scenes/', file=ref;
  if(!file.startsWith(prefix)||!file.toLowerCase().endsWith('.scene.json')||/[\\?#]/.test(file)||
    file.slice(prefix.length).split('/').some(part=>['','.','..'].includes(part)))
    throw new Error('project 需要已保存工程 ID 或 /ch6-trailer-scenes/ 下的 .scene.json');
  const localPath=prefix+file.slice(prefix.length).split('/').map(encodeURIComponent).join('/');
  const reason=lack('trailer');
  if(reason)throw Error(reason);
  return openProject(await json(localPath));
}
async function initialize(){
  const [settings,response]=await Promise.all([api('settings'),api('capabilities')]);
  if(finishSetup(settings))return;
  capabilities=response.capabilities;
  if(!lack('roomImport')){
    const selector=$('chapter'),chapters=capabilities.roomImport.chapters;
    for(const option of selector.options)if(!chapters[option.value])
      disableFeature(option,'缺少 '+option.value+' 房间索引（A-export v8）');
    if(!chapters[selector.value])selector.value=Object.keys(chapters).find(key=>chapters[key]);
  }
  $('layoutLink').hidden=false;
  $('downloadDraft').onclick=()=>download(JSON.stringify(app.p,null,2),filename(app.p.title)+'.scene.json','application/json');
  pluginChanges?.addEventListener('message',checkOpenPlugins);
  window.addEventListener('focus',checkOpenPlugins);
  window.addEventListener('pagehide',()=>{
    clearInterval(tabWatch);
    navigator.sendBeacon('/api/studio/plugin-projects',new Blob([JSON.stringify({tab,project:null})],{type:'application/json'}));
  });
  window.addEventListener('pageshow',event=>{if(event.persisted){void checkOpenPlugins();tabWatch=setInterval(checkOpenPlugins,30000);}});
  window.addEventListener('scene-plugin-error',e=>status(e.detail,true));
  wire();$('sceneSearch').oninput=()=>{if(app.p)listRooms();};
  eventEditor=mountEventEditor($('eventEditor'),()=>app.p,key=>{app.dirty=true;showFields();battleEditor?.refreshEvents();status('事件已应用 · '+key);},ex=>status(ex,true));
  battleEditor=mountBattleEditor($('battleEditor'),{getProject:()=>app.p,
    onChange:id=>{app.dirty=true;showFields();eventEditor.refresh();editingButtons();status(id?'战斗引用已应用 · '+id:'已移除未使用的战斗引用。');},
    onError:ex=>status(ex,true)});
  campaignEditor=mountCampaignEditor($('campaignEditor'),{getProject:()=>app.p,
    onChange:p=>{app.p=p;app.dirty=true;paint();fillJson();battleEditor.refresh();status('队伍、试玩档与转场设置已应用。');},
    onError:ex=>status(ex,true)});
  for(const el of document.querySelectorAll('[data-example]'))el.onclick=async()=>{if(await allowReplace())void busy(async()=>openProject(await json('/api/studio/'+el.dataset.example)));};
  $('chapter5Example').onclick=async()=>{if(await allowReplace())void busy(async()=>openProject(await json('/api/studio/example-chapter5')));};
  $('embedLayout').onclick=()=>void busy(async()=>{
    const room=q();
    if(!room?.layout)return;
    const map=await loadRoomLayout(room);
    const {layout,...copy}=room;
    const next={...app.p,rooms:{...app.p.rooms,[app.key]:{...copy,map}}};
    if(!validate(next).ok)return;
    app.p=next;app.dirty=true;refresh();status('布景已内嵌，可在工程 JSON 中编辑元素和图层。');
  });
  const url=new URL(location.href);
  const from=url.searchParams.get('from')==='layout';
  const returning=url.searchParams.has('from');
  const requested=url.searchParams.get('project');
  let loaded=true;
  if(requested!==null){
    try{loaded=await openFromUrl(requested);if(!loaded)await openProject(blank());}
    catch(ex){loaded=false;await openProject(blank());status(ex.message,true);}
  }else if(returning){
    try{
      const work=await handoffRead('workspace');
      if(work?.project&&await openProject(work.project,{id:work.id,rev:work.rev,dirty:work.dirty})){
        if(Object.hasOwn(app.p.rooms,work.key)){app.key=work.key;app.camera=null;refresh();}
      }else await openProject(blank());
    }catch(ex){await openProject(blank());status(ex.message,true);}
  }else if(url.searchParams.has('blank'))await openProject(blank());
  else{
    const [example,feature]=({workshop:['example',''],battle:['example-battle','battle battleAssets'],
      campaign:['example-campaign','battle battleAssets']})[url.searchParams.get('example')]??['example-chapter5','chapter5'];
    try{await (lack(feature)?openProject(blank()):openProject(await json('/api/studio/'+example)));}
    catch{await openProject(blank());}
  }
  setTool(app.tool);
  await Promise.all([catalog(),lack('battle')?null:battleEditor.refreshCatalog()]);
  if(from){
    try{
      const map=await handoffRead('layout');
      if(!map)throw new Error('交接队列为空；可返回布景工作台再次发送。');
      fromMap(map);
    }catch(ex){status(ex.message,true);}
  }
  if(returning){url.searchParams.delete('from');history.replaceState(null,'',url);}
  editingButtons();
  $('workspace').inert=!!pluginIssue;
  document.querySelector('.top nav').inert=false;
  tabWatch=setInterval(checkOpenPlugins,30000);
  if(loaded&&playOptions.autoplay)await play();
  document.body.dataset.ready='true';
}
initialize().catch(ex=>status(ex.message,true));
