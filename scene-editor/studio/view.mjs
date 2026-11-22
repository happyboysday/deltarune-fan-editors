
import {roomTiles,drawAnim} from './room-art.mjs';
import {projectPlugins,invoke,resolveEntity} from './plugins.mjs';
import {cameraFor,roomTransform} from './world.mjs';
import {entityKind,rectOf} from './format.mjs';
import {drawDirector,shakeOffset} from './trailer-fx.mjs';
import {drawTrailerBackdrop,drawTrailerForeground} from './room-backdrop.mjs';
import {tile,displayName,icon,artAt,actorArt,firstSprite,sceneWorld} from './ui-draw.mjs';
import {drawDialogue,drawChoice} from './ui-dialogue.mjs';
import {drawSystemHud,drawSaveRequest,drawFade} from './ui-system.mjs';
import {drawRhythm,drawKeypad,drawToolMarker} from './ui-minigame.mjs';
export {firstSprite};

const palettes={
  workshop:['#151527','#201f35','#2a2841','#403954','#a891ff','#543c70'],
  canal:['#10263b','#183951','#1e475f','#315971','#79d7ea','#366a88'],
  theatre:['#241828','#302039','#3c2443','#563257','#ed87ca','#773967'],
  garden:['#142331','#1a3542','#24414d','#356054','#93db9c','#406f65']
};
const pixelPatterns={
  down:['...1111...','..122221..','..122221..','.11222211.','.11333311.','..344443..','...5555...','..455554..','..466664..','..446644..','...4..4...','..77..77..'],
  up:['...1111...','..122221..','..122221..','.11222211.','.11222211.','..322223..','...5555...','..455554..','..466664..','..446644..','...4..4...','..77..77..'],
  left:['....111...','...12221..','..122221..','..122221..','..333211..','..344411..','...5555...','...55554..','..466664..','...4664...','...4..4...','..77..77..'],
  npc:['...1111...','..122221..','.11111111.','..133331..','..131131..','..133331..','...5555...','..455554..','..466664..','..446644..','...4..4...','..77..77..']
};
function person(ctx,x,y,face,tick,walking,accent,npc=false,tint=null){
  const rows=pixelPatterns[npc?'npc':face==='right'?'left':face]??pixelPatterns.down;
  const colors=npc?['','#1b1325','#ce94db','#f0c385','#3a2945','#ffe6ac',accent??'#915396','#e7a67a']:
    ['','#101525','#5a85b4','#d5e5f0','#2c375b','#e882bd',accent??'#6aa9ea','#b1d3f3'];
  const step=walking?[0,-1,0,1][Math.floor(tick/4)%4]:0;
  if(!tint)tile(ctx,'#0005',x-8,y-1,16,4);
  for(let j=0;j<rows.length;j++)for(let i=0;i<rows[j].length;i++){
    const v=Number(rows[j][i]);if(!v)continue;
    const ix=face==='right'&&!npc?9-i:i;
    tile(ctx,tint??colors[v],x-10+ix*2,y-24+j*2+(j>8?(i<5?step:-step):Math.abs(step)*-1),2,2);
  }
}
function scenery(ctx,r,cam,v,tick){
  tile(ctx,r.color??'#121220',0,0,r.w,r.h);
  const p=palettes[r.style];if(!p)return;
  const startX=Math.max(0,Math.floor(cam.x/32)*32),startY=Math.max(0,Math.floor(cam.y/32)*32),
    endX=Math.min(r.w,cam.x+v.w+32),endY=Math.min(r.h,cam.y+v.h+32);
  tile(ctx,p[0],0,0,r.w,r.h);
  for(let y=startY;y<endY;y+=32)for(let x=startX;x<endX;x+=32){
    const i=Math.floor(x/32),j=Math.floor(y/32);
    tile(ctx,(i+j)%2===0?p[1]:p[2],x,y,32,32);
    tile(ctx,p[0],x,y,32,1);tile(ctx,p[0],x,y,1,32);
    if((i*7+j*13)%11<3){tile(ctx,p[3],x+9,y+19,3,1);tile(ctx,p[3],x+13,y+17,1,1);}
    if(r.style==='canal'){
      const offset=(Math.floor(tick/4)+i*9)%25;
      if(j%2===0){tile(ctx,p[3],x+offset,y+24,7,1);tile(ctx,p[3],x+offset+4,y+27,3,1);}
    }
  }
  tile(ctx,p[3],0,4,r.w,4);tile(ctx,p[3],0,r.h-6,r.w,3);
  for(let x=24;x<r.w;x+=56){
    if(x<cam.x-8||x>cam.x+v.w+8)continue;
    tile(ctx,p[5],x-4,8,8,11);tile(ctx,p[4],x-2,10,4,6);tile(ctx,p[3],x-6,20,12,2);
    if(r.style==='garden'){
      for(let i=0;i<5;i++){
        tile(ctx,p[5],x+i*3-5,26-(i%3)*4,3,6);tile(ctx,p[4],x+i*3-5,24-(i%3)*4,3,2);
      }
    }
  }
}
function mapLayer(ctx,rows,art,cam,v,tick){
  if(!rows)return;
  for(const e of rows){
    if(e.x+e.radius<cam.x||e.y+e.radius<cam.y||e.x-e.radius>cam.x+v.w||e.y-e.radius>cam.y+v.h)continue;
    const img=art.images.get(e.url);
    if(!img?.naturalWidth){tile(ctx,'#743264',e.x,e.y,8,8);continue;}
    ctx.save();ctx.globalAlpha*=e.alpha??1;ctx.translate(Math.round(e.x),Math.round(e.y));ctx.rotate(e.rot);ctx.scale(e.sx,e.sy);
    if(e.crop){
      const f=e.frames;
      const index=f?f.base+Math.floor(tick*f.fps/30):null;
      const x=f?(f.loop?index%f.n:Math.min(index,f.n-1))*e.crop.w:e.crop.x;
      ctx.drawImage(img,x,e.crop.y,e.crop.w,e.crop.h,-e.ox,-e.oy,e.w,e.h);
    }else ctx.drawImage(img,-e.ox,-e.oy,e.w,e.h);
    ctx.restore();
  }
}
function drawObject(ctx,e,s,art,assets,styled){
  if(e.draw===false)return;
  const x=e.x,y=e.y,w=e.w,h=e.h,c=e.color??'#baa8f1';
  if(actorArt(ctx,art,assets,e.sprite,'down',false,s.tick,x+w/2,y+h))return;
  switch(e.kind){
    case 'wall':
      if(styled){tile(ctx,'#19192c',x,y,w,h);tile(ctx,'#45445d',x+1,y,w-2,3);tile(ctx,'#302e46',x+1,y+4,w-2,Math.max(1,h-6));}
      break;
    case 'door':{
      const available=!!e.room&&art.test(e.when,s);
      const accent=e.color??(available?'#88e1bf':'#cc829e');
      tile(ctx,'#12131d',x,y,w,h);tile(ctx,'#655d86',x,y,w,2);tile(ctx,'#534a6d',x,y,3,h);
      tile(ctx,'#534a6d',x+w-3,y,3,h);
      tile(ctx,accent,x+Math.round(w/2)-3,y+3,6,3);
      tile(ctx,available?'#243e4c':'#403147',x+4,y+h-4,w-8,3);
      if(e.name)displayName(ctx,e.name,x,y-8,accent,'9px');
      break;
    }
    case 'enemy':{
      const cx=x+w/2,cy=y+h/2,pulse=Math.floor(s.tick/11)%2;
      tile(ctx,'#0006',cx-8,cy+9,16,4);
      tile(ctx,'#281c2a',cx-7,cy-9,14,18);
      tile(ctx,e.color??'#df927d',cx-5,cy-11,10,20);
      tile(ctx,'#ffe6a7',cx-4,cy-8,8,2);
      tile(ctx,'#382130',cx-3,cy-3,6,4+pulse);
      tile(ctx,'#181322',cx-6,cy+8,4,4);tile(ctx,'#181322',cx+2,cy+8,4,4);
      break;
    }
    case 'npc':person(ctx,x+w/2,y+h,'down',s.tick,false,c,true);break;
    case 'block':
      tile(ctx,'#121722',x,y,w,h);tile(ctx,c,x+2,y+2,w-4,h-4);tile(ctx,'#233046',x+5,y+5,w-10,h-10);
      tile(ctx,c,x+w/2-3,y+h/2-3,6,6);break;
    case 'switch':{
      const pressed=s.flags[e.flag];
      tile(ctx,'#1b222e',x,y,w,h);tile(ctx,pressed?'#a1f1b4':'#736a98',x+1,y+1,w-2,h-2);
      tile(ctx,pressed?'#338e6f':'#3c3b54',x+4,y+4,w-8,h-8);break;
    }
    case 'savepoint':{
      const cy=y+h/2+(Math.floor(s.tick/8)%3)-1,cx=x+w/2;
      tile(ctx,'#3f3249',cx-10,y+h-4,20,3);
      icon(ctx,'✦',cx,cy,24,'#ffe69a');icon(ctx,'✦',cx,cy,15,'#fff8d7');break;
    }
    case 'checkpoint':
      tile(ctx,'#24243b',x,y+h-4,w,4);
      icon(ctx,'✦',x+w/2,y+h/2+(Math.floor(s.tick/8)%3)-1,22,'#ffe994');break;
    case 'hold':
      tile(ctx,'#182737',x,y,w,h);tile(ctx,'#688775',x+1,y+2,w-2,h-4);
      icon(ctx,'✿',x+w/2,y+h/2,21,art.test(e.when,s)?'#a4e7a6':'#ada4ca');break;
    case 'prop':
      if(e.name){
        tile(ctx,'#181524',x,y,w,h);tile(ctx,c,x,y,w,2);
        const name=[...e.name].slice(0,14).join('');
        displayName(ctx,name,x+4,y+h/2,'#ede4f4','10px');
      }else {tile(ctx,c,x+3,y+3,w-6,h-6);}
      break;
    case 'mode':
      if(e.mode==='climb'){
        for(let k=4;k<h;k+=11){tile(ctx,'#396061',x+3,y+k,w-6,2);tile(ctx,'#78927c',x+5+(k%17),y+k,w>23?13:6,2);}
      }
      break;
  }
}
function drawTile(ctx,t,art,assets,tick){
  const a=typeof t.sprite==='string'?assets[t.sprite]??t.sprite:t.sprite;
  const idleFrames=a?.idle_down??a?.idle;
  const ref=idleFrames&&!a.frames&&!a.src?{...a,frames:[idleFrames].flat()}:t.sprite;
  if(drawAnim(ctx,art,assets,ref,tick,1,t.x,t.y,true,t))return;
  if(t.color)tile(ctx,t.color,t.x,t.y,t.w,t.h);
}
let lightCanvas=null;
function drawDarkness(ctx,r,s,entities,logical,cam){
  if(!(r.darkness>0))return;
  const w=Math.max(1,Math.ceil(logical.v.w)),h=Math.max(1,Math.ceil(logical.v.h));
  if(!lightCanvas&&typeof document!=='undefined')lightCanvas=document.createElement('canvas');
  if(!lightCanvas)return;
  if(lightCanvas.width!==w||lightCanvas.height!==h){lightCanvas.width=w;lightCanvas.height=h;}
  const lc=lightCanvas.getContext('2d');
  lc.globalCompositeOperation='source-over';
  lc.clearRect(0,0,w,h);
  lc.fillStyle=r.darkColor??'#050412';
  lc.globalAlpha=r.darkness;
  lc.fillRect(0,0,w,h);
  lc.globalAlpha=1;
  lc.globalCompositeOperation='destination-out';
  const punch=(wx,wy,rad)=>{
    const sx=wx-cam.x,sy=wy-cam.y;
    if(sx+rad<0||sy+rad<0||sx-rad>w||sy-rad>h)return;
    const g=lc.createRadialGradient(sx,sy,rad*0.18,sx,sy,rad);
    g.addColorStop(0,'rgba(0,0,0,1)');
    g.addColorStop(0.68,'rgba(0,0,0,0.82)');
    g.addColorStop(1,'rgba(0,0,0,0)');
    lc.fillStyle=g;
    lc.beginPath();lc.arc(sx,sy,rad,0,Math.PI*2);lc.fill();
  };
  if(s.player&&(r.playerLight??0)>0)punch(s.player.x,s.player.y-12,r.playerLight);
  if(s.tool&&s.tool.age>0){
    const a=s.tool.area;
    punch(a.x+a.w/2,a.y+a.h/2,Math.max(a.w,a.h)*0.85+24);
  }
  for(const e of entities){
    if(e.hidden||!e.light)continue;
    const fl=e.light.flicker?(Math.sin(s.tick*0.45+e.x)*0.5+0.5)*e.light.flicker*14:0;
    punch(e.x+(e.w??20)/2,e.y+(e.h??20)/2,Math.max(8,e.light.r-fl));
  }
  for(const b of s.beams??[]){
    if(b.pts.length<3)continue;
    lc.fillStyle='rgba(0,0,0,0.92)';
    lc.beginPath();
    lc.moveTo(b.pts[0][0]-cam.x,b.pts[0][1]-cam.y);
    for(let i=1;i<b.pts.length;i++)lc.lineTo(b.pts[i][0]-cam.x,b.pts[i][1]-cam.y);
    lc.closePath();lc.fill();
  }
  ctx.drawImage(lightCanvas,Math.round(cam.x),Math.round(cam.y));
}
export function drawScene(ctx,project,roomKey,art,{state,camera,edit=false,hideHud=false}={}){
  const r=project.rooms[roomKey],v={w:ctx.canvas.width,h:ctx.canvas.height};
  const s=state??{tick:0,flags:project.flags??{},inventory:project.inventory??{},player:null,fade:0};
  const cam=camera??s.camera??cameraFor(project,r,r.w/2,r.h/2);
  const rooms=art.maps[roomKey];
  ctx.imageSmoothingEnabled=false;
  tile(ctx,'#0d0c16',0,0,v.w,v.h);
  const logical=roomTransform(project,r);
  ctx.save();ctx.translate(logical.x,logical.y);ctx.scale(logical.scale,logical.scale);
  ctx.beginPath();ctx.rect(0,0,logical.v.w,logical.v.h);ctx.clip();
  const assets=project.assets??{}, viewport=logical.v;
  const ui={kit:art.ui??null,art,assets,project,room:r,roomKey,world:sceneWorld(project,r),logical};
  const [dx,dy]=shakeOffset(s.director,s.tick);
  const plugins=projectPlugins(project),mode=plugins.modes.get(s.mode??r.mode);
  const draw={ctx,project,room:r,state:s,local:s[s.mode],art,assets,cam,viewport,edit,hideHud};
  ctx.save();ctx.translate(dx,dy);
  if(!edit&&mode?.hooks.drawWorld){
    invoke(mode,'drawWorld',draw);invoke(mode,'drawForeground',draw);
  }
  else drawRoom(ctx,project,r,s,art,rooms,cam,ui,{edit,hideHud,v,plugins,mode,draw});
  ctx.restore();
  if(!edit&&!hideHud)invoke(mode,'drawHud',draw);
  ctx.restore();
  if(edit||hideHud)return;
  drawSystemHud(ctx,s.prompt?.hold?{...s,prompt:null,hold:null}:s,v,ui);
  if(s.dialogue)drawDialogue(ctx,s.dialogue,v,ui);
  if(s.choice)drawChoice(ctx,s.choice,v,ui);
  if(s.saveRequest)drawSaveRequest(ctx,s.saveRequest,v,ui);
  if(s.rhythm)drawRhythm(ctx,s.rhythm,v,ui);
  if(s.keypad)drawKeypad(ctx,s.keypad,v,ui);
  drawFade(ctx,s,v,ui);
  drawDirector(ctx,s.director,s.tick,v.w,v.h);
  invoke(mode,'drawOverlay',{...draw,viewport:v});
}

function drawRoom(ctx,project,r,s,art,rooms,cam,ui,{edit,hideHud,v,plugins,mode,draw}){
  const {assets,logical}=ui;
  const backdrop=!!(r.skyGradient||r.parallax?.length||r.sunbeams);
  if(backdrop)drawTrailerBackdrop(ctx,r,art,cam,logical.v.w,logical.v.h);
  ctx.translate(-Math.round(cam.x),-Math.round(cam.y));
  ctx.beginPath();ctx.rect(0,0,r.w,r.h);ctx.clip();
  if(!backdrop)scenery(ctx,r,cam,v,s.tick);
  artAt(art.images.get(r.scenery),ctx,0,0,r.w,r.h);
  invoke(mode,'drawBackground',draw);
  mapLayer(ctx,rooms?.back,art,cam,logical.v,s.tick);
  const entities=s.entities??(r.entities??[]).map(e=>resolveEntity(plugins,project,e)).map(e=>({...e,...rectOf(e),kind:entityKind(e)}));
  const tiles=roomTiles(project,r).filter(t=>edit||!t.activeWhen||art.test(t.activeWhen,s));
  for(const t of tiles)if(t.layer==='back')drawTile(ctx,t,art,assets,s.tick);
  const groundKinds=plugins.modes.get(r.mode)?.hooks.groundKinds??['wall','zone','mode','switch','checkpoint','door'];
  const styled=!!r.style&&r.style!=='flat';
  const tick=invoke(mode,'animationTick',draw)??s.tick;
  function drawEntity(entity){
    const ext=plugins.entities.get(entity.kind);
    if(ext?.hooks.draw)invoke(ext,'draw',{...draw,entity,tick});
    else drawObject(ctx,entity,s,art,assets,styled);
  }
  for(const e of entities)if(!e.hidden&&groundKinds.includes(e.kind))drawEntity(e);
  // Render sweeping shadow-occluded spotlight beams under actors
  if(!edit&&s.beams?.length){
    for(const b of s.beams){
      if(b.pts.length<3)continue;
      ctx.save();ctx.globalAlpha=0.34;ctx.fillStyle=b.color??'#ffe078';
      ctx.beginPath();ctx.moveTo(b.pts[0][0],b.pts[0][1]);
      for(let i=1;i<b.pts.length;i++)ctx.lineTo(b.pts[i][0],b.pts[i][1]);
      ctx.closePath();ctx.fill();
      ctx.globalAlpha=0.72;ctx.strokeStyle='#fff4c4';ctx.lineWidth=1.5;ctx.stroke();
      ctx.restore();
    }
  }
  const actors=entities.filter(e=>!e.hidden&&!groundKinds.includes(e.kind));
  if(s.player)actors.push(...(s.followers??[]).map(a=>({kind:'player',...a,h:0})),{kind:'player',...s.player,h:0,lead:true});
  // Stable sort: at identical foot depth, draw the tile before the actor.
  actors.unshift(...tiles.filter(t=>t.layer==='actor').map(t=>({...t,kind:'tile'})));
  const feet=invoke(mode,'feet',draw)??r.playerFeetOffset??4;
  function bottom(e){
    const ext=plugins.entities.get(e.kind);
    const pos=(ext?.hooks.pose&&invoke(ext,'pose',{...draw,entity:e}))??e;
    return pos.y+(e.kind==='player'&&mode?.hooks.feet&&draw.local?feet:pos.h??0)+(e.depth??0);
  }
  actors.sort((a,b)=>bottom(a)-bottom(b));
  function drawPlayer(e,sprite=e.sprite,tint=null){
    if(mode?.hooks.drawSprite&&invoke(mode,'drawSprite',{...draw,entity:e,sprite,tick,feet}))return;
    if(!actorArt(ctx,art,assets,sprite,e.face,e.walking,tick,e.x,e.y+feet,tint))
      person(ctx,e.x,e.y+feet,e.face,tick,e.walking,project.player?.color,false,tint);
  }
  invoke(mode,'drawTrail',{...draw,drawPlayer});
  for(const e of actors){
    if(e.kind==='tile'){drawTile(ctx,e,art,assets,s.tick);continue;}
    if(e.kind==='player'){
      if(!invoke(mode,'drawPlayer',{...draw,entity:e,drawPlayer}))drawPlayer(e);
      ctx.globalAlpha=1;
    }else drawEntity(e);
  }
  invoke(mode,'drawEffects',draw);
  for(const t of tiles)if(t.layer==='front')drawTile(ctx,t,art,assets,s.tick);
  mapLayer(ctx,rooms?.front,art,cam,logical.v,s.tick);
  artAt(art.images.get(r.foreground),ctx,0,0,r.w,r.h);
  drawTrailerForeground(ctx,r,art,cam,logical.v.w,logical.v.h);
  invoke(mode,'drawForeground',draw);
  if(!edit)drawDarkness(ctx,r,s,entities,logical,cam);
  if(!edit&&!hideHud&&(s.tool||s.hold))drawToolMarker(ctx,s,ui);
}
