
import {testCondition} from './world.mjs';
import {projectPlugins,invoke} from './plugins.mjs';
import {UI_ASSET_ROOT,listUiAssets,loadUiKit} from './ui-kit.mjs';

export async function json(url,body){
  const response=await fetch(url,body===undefined?undefined:{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const value=await response.json();
  if(!response.ok||value.ok===false)
    throw Object.assign(new Error(value.error??('HTTP '+response.status)),{issues:value.issues});
  return value;
}
const assetsIn=a=>typeof a==='string'?[a]:Object.entries(a??{}).filter(([k])=>['src','frames','idle','walk'].includes(k)||/^(idle|walk)_/.test(k)).flatMap(([,v])=>v);
function clipFor(e,m){
  if(m?.animated===true){
    const w=m.frame_width??m.width,h=m.frame_height??m.height,n=m.frame_count??1;
    const index=((Math.floor(e.preview_frame??e.frame??0)%n)+n)%n;
    return {x:index*w,y:0,w,h,index};
  }
  if(e.kind==='tile'&&e.source_rect)return e.source_rect;
  return null;
}
function imageFrom(src){
  return new Promise((resolve,reject)=>{
    const image=new Image();
    image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('无法载入图片：'+src.slice(0,100)));
    image.src=src;
  });
}
async function pool(values,work,concurrency=12){
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(values.length,concurrency)},async()=>{
    while(cursor<values.length){const i=cursor++;await work(values[i],i);}
  }));
}
export function roomArtSources(room,project={}){
  const needs=new Set([room.scenery,room.foreground,...(room.parallax??[]).map(layer=>layer.src)].filter(Boolean));
  for(const ext of projectPlugins(project).extensions)invoke(ext,'roomAssets',{room,needs,project});
  return [...needs];
}

export function projectArtSources(project,rooms=Object.values(project.rooms)){
  const needs=new Set();
  for(const a of Object.values(project.assets??{}))for(const src of assetsIn(a))needs.add(src);
  for(const r of rooms)for(const src of roomArtSources(r,project))needs.add(src);
  for(const ext of projectPlugins(project).extensions)invoke(ext,'preload',{project,rooms,needs,assetsIn});
  return needs;
}

export async function loadRoomLayout(room){
  return room.map??(room.layout?await json('/api/studio/layout/'+encodeURIComponent(room.layout)):null);
}
export async function prepareArt(project,pack=null,{roomKeys=null,shared=null}={}){
  const files=pack?.files??Object.create(null),maps=pack?.maps??Object.create(null);
  const activeRooms=Object.entries(project.rooms).filter(([key])=>!roomKeys||roomKeys.includes(key));
  const needs=projectArtSources(project,activeRooms.map(([,room])=>room));
  const unresolved=[],metaByChapter=new Map(),images=shared?.images??new Map();
  const layouts=new Map();
  if(!pack)await pool(activeRooms.filter(([,r])=>r.map||r.layout),async([key,r])=>{
    layouts.set(key,await loadRoomLayout(r));
  });
  for(const [key,r] of activeRooms){
    if(!r.map&&!r.layout)continue;
    if(!pack){
      const map=layouts.get(key);
      const chapter=map.chapter,layers=new Map((map.layers??[]).map((l,i)=>[l.id,{...l,index:i}]));
      const visible=map.elements.filter(e=>e.visible!==false&&layers.get(e.layer)?.visible!==false&&layers.has(e.layer));
      const registry=metaByChapter.get(chapter)??new Map();
      metaByChapter.set(chapter,registry);
      const names=[...new Set(visible.filter(e=>!e.url).map(e=>e.asset))].filter(k=>!registry.has(k));
      for(let i=0;i<names.length;i+=500){
        const {assets}=await json('/api/assets/resolve',{chapter,ids:names.slice(i,i+500)});
        for(const a of assets){if(a.url)registry.set(a.asset,a);}
        for(const key of names.slice(i,i+500))if(!registry.has(key)){
          const alias=assets.find(a=>a.name===key);
          if(alias?.url)registry.set(key,alias);
        }
      }
      const ordered=visible.map((e,i)=>({e,i,l:layers.get(e.layer)}))
        .sort((a,b)=>(b.l.depth??0)-(a.l.depth??0)||a.l.index-b.l.index||a.i-b.i);
      const back=[],front=[];
      for(const {e,l} of ordered){
        const m=registry.get(e.asset),url=e.url??m?.url,crop=clipFor(e,m);
        const w=crop?.w??m?.width??e.width??32,h=crop?.h??m?.height??e.height??32;
        const ox=e.origin_x??(e.kind==='tile'?0:m?.origin_x??0),oy=e.origin_y??(e.kind==='tile'?0:m?.origin_y??0);
        const anim=e.animation??{},defaults=m?.animation_defaults??m?.defaults??{};
        const alias=m?.aliases?.find(a=>a.character===e.sequence_action?.character&&a.action===e.sequence_action?.action)?.defaults;
        const frames=crop&&m?.animated&&(anim.playing??defaults.playing)?{
          n:m.frame_count??1,base:crop.index,fps:Math.max(1,Math.min(60,anim.fps??alias?.fps??defaults.fps??10)),
          loop:anim.loop??alias?.loop??defaults.loop??true}:null;
        const sx=e.scale_x??1,sy=e.scale_y??1,rot=-(e.rotation??0)*Math.PI/180;
        const radius=Math.abs(sx)*Math.max(Math.abs(ox),Math.abs(w-ox))+Math.abs(sy)*Math.max(Math.abs(oy),Math.abs(h-oy))+2;
        if(url)needs.add(url);else unresolved.push({room:key,asset:e.asset});
        (l.kind==='foreground'||r.frontLayers?.includes(l.id)?front:back).push({url,x:e.x,y:e.y,w,h,ox,oy,crop,frames,sx,sy,rot,radius,alpha:e.alpha??1});
      }
      maps[key]={back,front};
    }else{
      for(const e of [...(maps[key]?.back??[]),...(maps[key]?.front??[])])if(e.url)needs.add(e.url);
    }
  }
  await pool([...needs],async(src)=>{
    if(images.has(src))return;
    const path=pack?(files[src]??(src.startsWith('data:')?src:null)):src;
    if(!path){unresolved.push({asset:src});return;}
    try{images.set(src,await imageFrom(path));}catch{unresolved.push({asset:src});}
  });
  let uiKit;
  return {images,maps,needs,unresolved,test:testCondition,
    loadUiKit:()=>uiKit??=loadUiKit(pack?(pack.ui??{}):null).catch(error=>{uiKit=null;throw error;})};
}
function toDataURL(blob){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);
  });
}
export async function packUiAssets({origin='',encode=toDataURL}={}){
  const manifest=await json(origin+UI_ASSET_ROOT+'manifest.json');
  const paths=listUiAssets(manifest);
  const entries=new Array(paths.length);
  await pool(paths,async(path,index)=>{
    const response=await fetch(origin+path);
    if(response.status===404)return; // A local installation may only have some of the shared assets.
    if(!response.ok)throw new Error('读取试玩 UI 素材失败：'+path);
    entries[index]=[path,await encode(await response.blob())];
  },4);
  return {manifest,files:Object.fromEntries(entries.filter(Boolean))};
}
export async function preparePlayArt(project,shared){
  if(!Object.values(project.rooms).some(r=>r.layout))return prepareArt(project,null,{shared});
  const start=project.start.room;
  const art=await prepareArt(project,null,{roomKeys:[start],shared});
  art.loadedRooms=new Set([start]);
  art.loadRoom=async key=>{
    const next=await prepareArt(project,null,{roomKeys:[key],shared:{images:art.images}});
    Object.assign(art.maps,next.maps);
    art.loadedRooms.add(key);
    art.unresolved.push(...next.unresolved);
  };
  return art;
}
export async function packArt(art){
  if(art.unresolved.length)throw new Error('有未解析的图片，无法离线导出：'+[...new Set(art.unresolved.map(u=>u.asset))].slice(0,5).join('、'));
  const files=Object.create(null);
  let bytes=0;
  const [,ui]=await Promise.all([pool([...art.needs],async src=>{
    if(src.startsWith('data:'))return;
    const r=await fetch(src);
    if(!r.ok)throw new Error('读取素材失败：'+src);
    const blob=await r.blob();
    if(!/^image\/(?:png|webp|gif|jpeg)$/.test(blob.type))throw new Error('不支持嵌入的图片：'+src);
    bytes+=blob.size;
    if(bytes>128*1024*1024)throw new Error('图片总量超过 128 MiB，请分成多个工程。');
    files[src]=await toDataURL(blob);
  }),packUiAssets()]);
  // Keep the export byte-for-byte stable across fetch completion order.
  return {files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0)),maps:art.maps,ui};
}
