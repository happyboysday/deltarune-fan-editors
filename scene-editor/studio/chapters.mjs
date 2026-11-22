import {navigationPanel} from './navigation-panel.mjs';
import {nativePlayer} from './chapter-player.mjs';
import {prepareArt} from './resources.mjs';
import {drawScene} from './view.mjs';
import {api as studioApi,disableFeature,finishSetup,unavailable} from './configuration.mjs';
const $=id=>document.getElementById(id);
const labels5=[
 ['标题与新档','room_intro_ch5','obj_intro_ch5'],['卧室与笼子','room_krisroom','obj_ch5_LW01'],['早餐与烤面包机','room_torhouse','obj_ch5_LW02',{point:[595,160],plotAtLeast:10}],['城堡镇','room_dw_castle_town','obj_ch5_dw_castle_town',{plotAtLeast:50}],['城堡里的准备','room_dw_ralsei_castle_1f','obj_ch5_LW07',{plotAtLeast:60}],['离开城堡镇','room_dw_castle_area_1','obj_ch5_LW09',{point:[300,178],plotAtLeast:80}],['学校与节庆','room_schoollobby','obj_ch5_LW11',{point:[464,405],plotAtLeast:100}],['校外遇见 Noelle','room_town_school','obj_ch5_LW11A',{point:[246,207],plotAtLeast:105}],['Sans 的冰淇淋摊','room_town_mid','obj_town_mid_sans',{point:[1090,131],interact:true,plotAtLeast:150}],['海滩','room_beach','obj_ch5_LW20'],['花园入口','room_dw_garden_intro','obj_ch5_LW21_arrive',{plotAtLeast:200}],['遇见 Flowery','room_dw_garden_meetflowery','obj_ch5_DW01',{trigger:'cutscene',plotAtLeast:210}],['花园横版','room_dw_garden_aquadash_plat','obj_plat_player'],['悬崖','room_dw_cliff_cutdown_tutorial','obj_ch5_DW11'],['悬崖冲刺','room_dw_cliff_dash_runner','obj_dw_cliff_dash_runner'],['花城入口','room_dw_fcastle_entrance','obj_ch5_DW19'],['花城左翼','room_dw_fcastle_left_wing_floweryscene','obj_ch5_DWCL00'],['花城右翼','room_dw_fcastle_right_endingscene','obj_ch5_DWCR04'],['上层冲刺','room_dw_fcastle_ultradash','obj_dw_fcastle_ultradash'],['花城终局','room_dw_post_flowery_battle','obj_ch5_DW30'],['封印喷泉','room_dw_fcastle_top_fountain','obj_ch5_DW45',{point:[305,214],interact:true,plotAtLeast:550}],['返回花店','room_flowershop_2f','obj_ch5_LWF01'],['学校门前','room_schooldoor','obj_ch5_LWF_town_schooldoor'],['片尾','room_ed','obj_credits_ch5']
];
let chapter,db,overrides,revision,room,slot,positions=[],sourceSerial=0,chapterSerial=0,originalText='',editableText='',loading=false;
let capabilities={};
const option=(value,text)=>new Option(text,value);
const setStatus=text=>{$('status').textContent=text};
const nav=navigationPanel();
async function api(route,body){
 const res=await fetch('/api/studio/chapters/'+chapter+'/'+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await res.json();if(!res.ok)throw Error(data.error??res.statusText);return data;
}
let backdrop=null, mapSerial=0;
async function backdropFor(r){
 const serial=++mapSerial;backdrop=null;if(!r)return;
 const key=r.id,version=chapter;
 let map;
 if(version==='5'){
   const response=await fetch('/api/studio/layout/'+encodeURIComponent(key));
   if(response.ok)map=await response.json();
 }
 if(!map){
   const response=await fetch('/api/a/rooms/'+encodeURIComponent(key)+'?chapter=ch'+version);
   if(response.ok)map=(await response.json()).map;
 }
 if(serial!==mapSerial||!map)return;
 for(const e of map.elements){
   if(!e.source_ref?.includes('/inst/')||!Number.isInteger(e.source_index))continue;
   const instance=r.instances[e.source_index],change=overrides.instances[r.id+'/'+e.source_index];
   if(instance&&change){e.x+=change.x-instance.x;e.y+=change.y-instance.y}
 }
 const preview={viewport:{w:720,h:290},assets:{},rooms:{[key]:{w:r.w,h:r.h,view:{w:r.w,h:r.h},map,style:'flat',color:'#191823',entities:[]}}};
 const art=await prepareArt(preview);
 if(serial===mapSerial){backdrop={preview,art};draw()}
}
const chosen=()=>room?.instances[slot];
function coords(i){return overrides.instances[room.id+'/'+i]??room.instances[i]}
function listRooms(id){
 const query=$('filter').value.toLowerCase(), match=db.rooms.filter(r=>r.id.toLowerCase().includes(query));
 $('rooms').replaceChildren(...match.map(r=>option(r.id,r.id)));
 if(id&&match.some(r=>r.id===id))$('rooms').value=id;else if(match.length)$('rooms').selectedIndex=0;
 chooseRoom();
}
function chooseRoom(){
 room=db.rooms.find(r=>r.id===$('rooms').value);slot=0;
 $('roomTitle').textContent=room?room.id+' · '+room.w+' × '+room.h:'无匹配房间';
 $('instances').replaceChildren(...(room?.instances??[]).map((i,n)=>option(n,i.obj+' · '+i.id)));
 if(room?.instances.length)$('instances').selectedIndex=0;
 backdropFor(room).catch(e=>setStatus('布景预览加载失败 · '+e.message));
 selectInstance();
}
function selectInstance(){
 $('preview').hidden=!db.previews?.[room?.id];
 slot=$('instances').selectedIndex;
 const i=chosen(), p=i&&coords(slot);$('x').value=p?.x??'';$('y').value=p?.y??'';$('position').disabled=!i;
 $('objectInfo').textContent=i?[i.layer,i.obj,'#'+i.id].filter(Boolean).join(' · '):'';
 draw();events();
}
function draw(){
 const canvas=$('plan'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);positions=[];
 if(!room)return;
 const scale=Math.min(canvas.width/room.w,canvas.height/room.h),ox=(canvas.width-room.w*scale)/2,oy=(canvas.height-room.h*scale)/2;
 ctx.fillStyle='#292736';ctx.fillRect(ox,oy,room.w*scale,room.h*scale);
 if(backdrop)drawScene(ctx,backdrop.preview,room.id,backdrop.art,{camera:{x:0,y:0},hideHud:true});
 positions=room.instances.map((i,n)=>{const p=coords(n);return [ox+p.x*scale,oy+p.y*scale]});
 positions.forEach(([x,y],n)=>{ctx.fillStyle=n===slot?'#fff080':backdrop?'#bfb9dc88':'#9590b2';ctx.fillRect(x-2,y-2,4,4)});
 if(positions[slot]){const [x,y]=positions[slot];ctx.strokeStyle='#fff080';ctx.strokeRect(x-5,y-5,10,10)}
}
function events(){
 const list=new Set(),query=$('query').value.trim().toLowerCase(),i=chosen();
 if(query){for(const id of db.scripts)if(id.toLowerCase().includes(query))list.add(id)}
 else{
   for(const k of [i?.pre,i?.init,room?.creation])if(k)list.add(k);
   for(let o=i?.obj;o;o=db.objects[o]?.parent)for(const ev of db.objects[o]?.events??[])list.add(ev);
 }
 const keys=[...list];
 if(query){
   const rank=id=>{
     const base='gml_object_'+query+'_';
     const name=id.toLowerCase();
     if(name===base+'step_0')return 0;
     if(name===base+'create_0')return 1;
     return name.startsWith(base)?2:3;
   };
   keys.sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b));
 }
 $('events').replaceChildren(...keys.map(k=>option(k,k.replace(/^gml_(Object_|GlobalScript_)?/,''))));
 loadSource().catch(e=>setStatus(e.message));
}
function updateStops(){
 const text=$('source').value,lines=text.split('\n');let offset=0;
 const stops=[option('','选一处跳到源码')];
 for(const [n,line] of lines.entries()){
   const snippet=line.trim(),key=/global\.plot|scr_flag_(?:get|set)\(|scr_trigcheck\(|room_goto\(|c_roomgoto\(|scr_chapterswitch\(|c_speaker\(|scr_encounter|scr_battlestart/.test(snippet);
   if(key)stops.push(option(offset,(n+1)+' · '+snippet.slice(0,130)));
   offset+=line.length+1;
 }
 $('stops').replaceChildren(...stops);$('stops').disabled=stops.length===1;
}
$('stops').onchange=()=>{
 if(!$('stops').value)return;
 const t=$('source'),pos=Number($('stops').value),end=t.value.indexOf('\n',pos);
 t.focus();t.setSelectionRange(pos,end<0?t.value.length:end);
 const line=t.value.slice(0,pos).split('\n').length-1;t.scrollTop=Math.max(0,(line-3)*(parseFloat(getComputedStyle(t).lineHeight)||18));
};
$('source').onchange=updateStops;
async function loadSource(){
 const key=$('events').value,serial=++sourceSerial;originalText=editableText='';$('source').value='';$('source').disabled=true;updateStops();
 if(!key)return;
 const result=await api('script?id='+encodeURIComponent(key));if(serial!==sourceSerial)return;
 originalText=result.source;editableText=overrides.scripts[key]??originalText;$('source').value=editableText;$('source').disabled=false;updateStops();
}
async function loadChapter(){
 const serial=++chapterSerial;chapter=$('chapter').value;loading=true;setStatus('正在读取章节工程…');
 playButtons(true);
 const [index,edits]=await Promise.all([api('index'),api('edits')]);if(serial!==chapterSerial)return;
 db=index;overrides=edits.edits;revision=edits.revision;
 const nodes=chapter==='5'?labels5:(await import('./chapter4-nodes.mjs')).nodes;
 nav.configure(db.rooms,nodes);
 $('milestones').replaceChildren(...nodes.map(([name,r,obj])=>{const b=document.createElement('button');b.textContent=name;b.onclick=()=>{if(!discard())return;$('filter').value='';$('query').value=obj;listRooms(r);};return b}));
 $('filter').value=$('query').value='';listRooms(nodes[0][1]);$('log').textContent='';loading=false;
 playButtons();
 setStatus(edits.warning??(index.rooms.length+' 个房间 · '+index.scripts.length+' 个可读事件和脚本'));
}
function discard(){return $('source').disabled||$('source').value===editableText||confirm('离开当前脚本并放弃尚未保存的文字？')}
function guarded(f){return async()=>{try{await f()}catch(e){setStatus(e.message)}}}
$('chapter').onchange=guarded(async()=>{if(!discard()){$('chapter').value=chapter;return}await loadChapter()});
$('rooms').onchange=()=>{if(!discard()){$('rooms').value=room.id;return}$('query').value='';chooseRoom()};
$('instances').onchange=()=>{if(!discard()){$('instances').selectedIndex=slot;return}$('query').value='';selectInstance()};
$('events').onfocus=()=>{$('events').dataset.old=$('events').value};
$('events').onchange=guarded(async()=>{if(!discard()){$('events').value=$('events').dataset.old;return}await loadSource();$('events').dataset.old=$('events').value});
$('filter').onchange=()=>{if(discard())listRooms()};$('query').onchange=()=>{if(discard())events()};
$('plan').onclick=e=>{
 if(!positions.length||!discard())return;const rect=$('plan').getBoundingClientRect(),x=(e.clientX-rect.left)*$('plan').width/rect.width,y=(e.clientY-rect.top)*$('plan').height/rect.height;
 const d=positions.map(([a,b])=>Math.hypot(a-x,b-y));const min=Math.min(...d);if(min>14)return;
 $('instances').selectedIndex=d.indexOf(min);$('query').value='';selectInstance();
};
$('original').onclick=()=>{$('source').value=originalText;updateStops()};
$('save').onclick=guarded(async()=>{
 const id=$('events').value;if(!id||$('source').disabled)return;
 const text=$('source').value,res=await api('save',{type:'script',id,text,revision});revision=res.revision;editableText=text;overrides.scripts[id]=text;setStatus('已保存事件，下次试玩时生效。');
});
$('position').onclick=guarded(async()=>{
 const i=chosen(),x=$('x').valueAsNumber,y=$('y').valueAsNumber;if(!i||!Number.isInteger(x)||!Number.isInteger(y))throw Error('请输入整数坐标');
 const res=await api('save',{type:'instance',room:room.id,slot,x,y,revision});revision=res.revision;overrides.instances[room.id+'/'+slot]={x,y};draw();backdropFor(room).catch(e=>setStatus(e.message));setStatus('已保存物件位置。');
});
function playButtons(active=false){
 $('chapter').disabled=active;
 for(const [id,key] of [['build','chapterBuild'],['play','chapterPlay'],['preview','chapterPreview']]){
   const button=$(id);
   button.disabled=active;button.removeAttribute('aria-disabled');button.removeAttribute('title');
   disableFeature(button,unavailable(capabilities,key+chapter));
 }
}
const displayGame=nativePlayer($('gamePanel'),api,setStatus,()=>playButtons(),nav);
for(const action of ['build','play','preview'])$(action).onclick=guarded(async()=>{
 if(loading)return;if(!$('source').disabled&&$('source').value!==editableText){setStatus('请先保存当前脚本再生成试玩。');return}
 playButtons(true);setStatus('正在准备独立试玩…');
 try{
   const res=await api(action==='preview'?'play':action,{embed:action!=='build',preview:action==='preview'?room.id:null});
   if(action!=='build'){setStatus('方向键移动 · Z 确认 · X 取消 · C 菜单');await displayGame(chapter,res.pid)}
   else setStatus('生成完成 · '+res.rooms+' 个房间');
 }finally{playButtons();}
});
$('refresh').onclick=guarded(async()=>{$('log').textContent=(await api('route')).log.split('\n').slice(-65).join('\n')||'还没有轨迹。'});
guarded(async()=>{
 const [settings,response]=await Promise.all([studioApi('settings'),studioApi('capabilities')]);
 if(finishSetup(settings))return;
 capabilities=response.capabilities;
 const reason=unavailable(capabilities,'chapters');
 if(reason){setStatus(reason);return;}
 for(const option of $('chapter').options)disableFeature(option,unavailable(capabilities,'chapterEdit'+option.value));
 $('chapter').value=[...$('chapter').options].find(option=>!option.disabled).value;
 await loadChapter();
 $('chapterWorkspace').inert=false;
})();

$('downloadRun').onclick=guarded(async()=>{
 const record=await api('record');if(!record.started)throw Error('先从工作台开始一次试玩。');
 const url=URL.createObjectURL(new Blob([JSON.stringify(record)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=`第${record.chapter}章_${record.preview?'段落预演':'正常试玩'}_${Math.floor(record.started)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
});
