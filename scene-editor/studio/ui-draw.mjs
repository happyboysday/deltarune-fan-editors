// Web-play UI shared drawing helpers. The scene editor canvas also uses these.
export const tile=(ctx,c,x,y,w,h)=>{ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),w,h);};
export function displayName(ctx,t,x,y,c='#f4ecff',font='12px'){
  ctx.font=font+' "Microsoft YaHei UI", "Segoe UI", sans-serif';
  ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillStyle=c;ctx.fillText(t,Math.round(x),Math.round(y));
}
export function icon(ctx,kind,x,y,size,color){
  ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.font=size+'px "Segoe UI Symbol","Microsoft YaHei UI",sans-serif';
  ctx.fillText(kind,Math.round(x),Math.round(y));
}
export function artAt(img,ctx,x,y,w,h){if(img?.naturalWidth)ctx.drawImage(img,Math.round(x),Math.round(y),w??img.naturalWidth,h??img.naturalHeight);}
export function firstSprite(a){
  if(typeof a==='string')return a;
  const value=a?.src??a?.idle_down??a?.idle??a?.frames??Object.entries(a??{}).find(([k])=>k.startsWith('idle_')||k.startsWith('walk_'))?.[1];
  return Array.isArray(value)?value[0]:value;
}

const tints=new WeakMap();
function tinted(img,color){
  if(typeof document==='undefined')return img;
  let colors=tints.get(img);
  if(!colors){colors=new Map();tints.set(img,colors);}
  if(!colors.has(color)){
    const mask=document.createElement('canvas');
    mask.width=img.naturalWidth;mask.height=img.naturalHeight;
    const ctx=mask.getContext('2d');
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(img,0,0);
    ctx.globalCompositeOperation='source-in';
    ctx.fillStyle=color;ctx.fillRect(0,0,mask.width,mask.height);
    colors.set(color,mask);
  }
  return colors.get(color);
}
export function actorArt(ctx,art,assets,id,face,walking,tick,x,y,tint=null){
  if(!id)return false;
  const a=assets[id];
  const state=walking?'walk':'idle';
  const frames=typeof a==='string'?a:a?.[state+'_'+face]??a?.[state]??a?.['idle_'+face]??a?.idle??a?.frames??a?.src??Object.entries(a??{}).find(([k])=>k.startsWith('idle_')||k.startsWith('walk_'))?.[1];
  const src=Array.isArray(frames)?frames[Math.floor(tick/(a.ticks??6))%frames.length]:frames;
  const img=art.images.get(src);
  if(!img?.naturalWidth)return false;
  const anchor=a?.anchor??'feet';
  const drawImg=tint?tinted(img,tint):img;
  if(a?.flipLeft&&face==='left'){
    ctx.save();
    ctx.translate(Math.round(x),Math.round(y));
    ctx.scale(-1,1);
    const ox=anchor==='center'?-img.naturalWidth/2:anchor==='feet'?-img.naturalWidth/2:0;
    const oy=anchor==='center'?-img.naturalHeight/2:anchor==='feet'?-img.naturalHeight:0;
    ctx.drawImage(drawImg,Math.round(ox),Math.round(oy));
    ctx.restore();
    return true;
  }
  if(anchor==='center'){x-=img.naturalWidth/2;y-=img.naturalHeight/2;}
  else if(anchor==='feet'){x-=img.naturalWidth/2;y-=img.naturalHeight;}
  ctx.drawImage(drawImg,Math.round(x),Math.round(y));return true;
}
// Which original UI family a room uses: 'dark' (Dark World, fnt_mainbig box) or 'light' (Light World, fnt_main box).
// Room setting wins over the project setting; default is dark.
export function sceneWorld(project,room){
  const w=room?.world??project?.world;
  return w==='light'?'light':'dark';
}
