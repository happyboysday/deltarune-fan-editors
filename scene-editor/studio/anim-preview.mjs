// 编辑器专用。判定框坐标以脚底为原点，始终按朝右存储。
export function animation(value, assets) {
  const a=typeof value==='string' ? assets?.[value] ?? value : value;
  if(typeof a==='string')return {frames:[a]};
  return {...a,frames:a?.frames ?? [a?.src ?? a?.idle ?? a?.idle_down].flat().filter(Boolean)};
}
const images=new Map();
export function frameImage(src, loaded) {
  if(!src)return null;
  let img=images.get(src);
  if(!img){
    img=new Image();images.set(src,img);img.src=src;
  }
  if(loaded && !img.complete)img.addEventListener('load',loaded,{once:true});
  return img.complete && img.naturalWidth ? img : null;
}
// Native anchor and offset scale with the sprite. The destination origin and combat boxes are room pixels.
export function spritePose(a,img,x,y,dir=1,rect=null){
  const w=rect?.w??img.naturalWidth,h=rect?.h??img.naturalHeight;
  const anchor=a.anchor??(rect?'topLeft':'feet'),scale=a.scale??1;
  const sx=dir*(a.flip?-scale:scale),[dx,dy]=a.offset??[0,0];
  const ox=anchor==='topLeft'?0:-w/2,oy=anchor==='feet'?-h:anchor==='center'?-h/2:0;
  return {x:Math.round(x-(rect?ox:0)+dir*scale*dx+sx*ox),
    y:Math.round(y-(rect?oy:0)+scale*(dy+oy)),w,h,sx,sy:scale};
}
function blit(ctx,img,p){
  ctx.save();ctx.translate(p.x,p.y);ctx.scale(p.sx,p.sy);
  ctx.drawImage(img,0,0,p.w,p.h);ctx.restore();
}
export function drawFrame(ctx,a,img,x,y,dir=1,rect=null){
  if(img)blit(ctx,img,spritePose(a,img,x,y,dir,rect));
}
export function thumbnail(canvas,a,rect){
  function draw(){
    const img=frameImage(a.frames[0],draw);if(!img)return;
    const w=rect?.w??40,h=rect?.h??40;
    const pose=spritePose(a,img,rect?0:w/2,rect?0:h,1,rect);
    const left=Math.min(0,pose.x,pose.x+pose.w*pose.sx),right=Math.max(w,pose.x,pose.x+pose.w*pose.sx);
    const top=Math.min(0,pose.y),bottom=Math.max(h,pose.y+pose.h*pose.sy);
    const zoom=Math.min(canvas.width/(right-left),canvas.height/(bottom-top)),ctx=canvas.getContext('2d');
    ctx.save();ctx.imageSmoothingEnabled=false;ctx.translate(canvas.width/2,canvas.height/2);ctx.scale(zoom,zoom);
    ctx.translate(-(left+right)/2,-(top+bottom)/2);blit(ctx,img,pose);ctx.restore();
  }
  draw();
}
export function mountPreview(root,{getAnim,getEffect,getBox,setBox,loop}) {
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  canvas.width=360;canvas.height=220;canvas.className='anim-screen';canvas.ariaLabel='动作与攻击判定预览';
  const controls=document.createElement('div');controls.className='inline';
  const info=document.createElement('output');
  let face=1,playing=true,index=0,previous=performance.now(),elapsed=0,origin,zoom=1.5,drag,raf;
  function button(label,fn){
    const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>fn(b);controls.append(b);
  }
  button('暂停',b=>{
    playing=!playing;
    if(playing && index===getAnim().frames.length-1){index=0;elapsed=0;}
    b.textContent=playing?'暂停':'播放';
  });
  button('下一帧',()=>{playing=false;elapsed=0;controls.firstChild.textContent='播放';index=(index+1)%Math.max(1,getAnim().frames.length);});
  button('朝右 →',b=>{face*=-1;b.textContent=face===1?'朝右 →':'← 朝左';});
  const magnification=document.createElement('select');
  magnification.ariaLabel='预览视图倍率';magnification.style.width='auto';
  for(const z of [.25,.5,1,1.5,2,3])magnification.add(new Option(z+'× 视图',String(z)));
  magnification.value=String(zoom);magnification.onchange=()=>{zoom=Number(magnification.value);};
  controls.append(magnification,info);root.append(canvas,controls);
  function draw(now){
    if(!canvas.isConnected)return;
    const a=getAnim(),frames=a.frames,step=Math.max(1,a.ticks??4)*1000/30;
    if(playing)elapsed+=now-previous;
    previous=now;
    if(elapsed>=step){
      const next=index+Math.floor(elapsed/step);
      index=(a.loop??loop)?next%Math.max(1,frames.length):Math.min(next,Math.max(0,frames.length-1));
      if(!(a.loop??loop) && frames.length && next>=frames.length){
        playing=false;controls.firstChild.textContent='播放';
      }
      elapsed%=step;
    }
    index=Math.min(index,Math.max(0,frames.length-1));
    const img=frameImage(frames[index]);
    origin={x:180,y:168};
    // Keep a stable room-pixel ruler between frames, directions and scale edits.
    ctx.fillStyle='#151320';ctx.fillRect(0,0,360,220);
    const grid=40*zoom;
    ctx.strokeStyle='#393447';ctx.beginPath();
    for(let x=origin.x%grid;x<canvas.width;x+=grid){ctx.moveTo(x+.5,0);ctx.lineTo(x+.5,canvas.height);}
    for(let y=origin.y%grid;y<canvas.height;y+=grid){ctx.moveTo(0,y+.5);ctx.lineTo(canvas.width,y+.5);}
    ctx.stroke();ctx.fillStyle='#c9c3d8';ctx.font='12px sans-serif';ctx.fillText('每格 40 px',8,17);
    ctx.save();ctx.translate(origin.x,origin.y);ctx.scale(zoom,zoom);ctx.imageSmoothingEnabled=false;
    drawFrame(ctx,a,img,0,0,face);
    const fx=getEffect?.();
    if(fx?.frames.length){
      const n=Math.floor((index*(a.ticks??4)+elapsed*30/1000)/(fx.ticks??4));
      drawFrame(ctx,fx,frameImage(fx.frames[fx.loop?n%fx.frames.length:Math.min(n,fx.frames.length-1)]),0,0,face);
    }
    ctx.scale(face,1);
    const box=getBox?.();
    if(box){ctx.fillStyle='#ff567c44';ctx.strokeStyle='#ff788c';ctx.lineWidth=1/zoom;ctx.fillRect(box.x,box.y,box.w,box.h);ctx.strokeRect(box.x,box.y,box.w,box.h);}
    ctx.restore();ctx.fillStyle='#ffdc90';ctx.fillRect(178,168,4,4);
    info.value=frames.length?(index+1)+' / '+frames.length+' 帧':'未选择动画';
    raf=requestAnimationFrame(draw);
  }
  function point(e){const b=canvas.getBoundingClientRect();return {x:Math.round(((e.clientX-b.left)*360/b.width-origin.x)/zoom*face),y:Math.round(((e.clientY-b.top)*220/b.height-origin.y)/zoom)};}
  if(setBox){
    canvas.onpointerdown=e=>{if(e.button!==0)return;drag=point(e);canvas.setPointerCapture(e.pointerId);};
    canvas.onpointermove=e=>{if(!drag)return;const p=point(e);setBox({x:Math.min(p.x,drag.x),y:Math.min(p.y,drag.y),w:Math.max(1,Math.abs(p.x-drag.x)),h:Math.max(1,Math.abs(p.y-drag.y))});};
    canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};
  }
  raf=requestAnimationFrame(draw);
  return ()=>cancelAnimationFrame(raf);
}
