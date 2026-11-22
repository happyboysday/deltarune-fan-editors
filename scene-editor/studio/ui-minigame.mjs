import {UI_COLORS,drawPanel,withUiViewport} from './ui-kit.mjs';
import {actorArt,tile} from './ui-draw.mjs';
import {clamp,KEYPAD_KEYS} from './world.mjs';

const {white,black,yellow,red,gray}=UI_COLORS;
const orange='#ffa500';
const mainFont={font:'fnt_main',lineHeight:16};
const fallbackFont='"SimSun", "Microsoft YaHei UI", monospace';
const directions={left:Math.PI/2,down:0,up:Math.PI,right:-Math.PI/2};
const lanes=['left','down','up','right','act'];

function drawText(ctx,kit,text,x,y,{color=white,scale=2}={}){
  if(kit){
    kit.drawText(ctx,text,x,y,{...mainFont,scale,color,align:'center',baseline:'middle'});
    return;
  }
  ctx.font=(12*scale)+'px '+fallbackFont;
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;
  const rows=text.split('\n');
  rows.forEach((row,i)=>ctx.fillText(row,x,y+16*scale*(i-(rows.length-1)/2)));
}

function layoutLabel(ctx,kit,value,width,maxLargeRows=2){
  const text=value.trim().replace(/\s+/gu,' ');
  if(!text)return {text,scale:2,height:0};
  ctx.font='12px '+fallbackFont;
  const measure=s=>kit?kit.measureText(s,mainFont).width:ctx.measureText(s).width;
  function wrap(limit){
    const rows=[];
    let row='';
    for(const glyph of text){
      if(row&&measure(row+glyph)>limit){
        const space=row.lastIndexOf(' ');
        const end=glyph!==' '&&space>0?space:row.length;
        rows.push(row.slice(0,end).trimEnd());
        row=row.slice(end).trimStart();
      }
      if(row||glyph!==' ')row+=glyph;
    }
    if(row)rows.push(row.trimEnd());
    return rows;
  }
  const large=wrap(width/2);
  const scale=large.length<=maxLargeRows?2:1;
  const rows=scale===2?large:wrap(width);
  return {text:rows.join('\n'),scale,height:rows.length*16*scale};
}

function drawBox(ctx,ui,x,y,w,h){
  if(ui.world==='dark'&&ui.kit)ui.kit.drawDarkBox(ctx,x,y,w,h);
  else drawPanel(ctx,x,y,w,h,{border:ui.world==='dark'?4:6});
}

function drawBeatKey(ctx,kit,key,x,y,{color=white,alpha=1}={}){
  ctx.save();ctx.globalAlpha*=alpha;
  if(key==='act'){
    drawPanel(ctx,Math.round(x)-11,Math.round(y)-11,22,22,{border:2,borderColor:color});
    drawText(ctx,kit,'Z',x,y,{color});
  }else{
    // The piano UI's 9x9 sprite points down in its unrotated frame.
    ctx.translate(Math.round(x),Math.round(y));ctx.rotate(directions[key]);
    if(!kit?.drawSprite(ctx,'spr_arrow_9x9',-9,-9,{scale:2,color:color===white?undefined:color})){
      tile(ctx,color,-3,-9,6,8);
      for(let i=0;i<5;i++)tile(ctx,color,-9+2*i,-1+2*i,18-4*i,2);
    }
  }
  ctx.restore();
}

export function drawRhythm(ctx,r,v,ui){
  withUiViewport(ctx,()=>{
    const {kit}=ui;
    const title=layoutLabel(ctx,kit,r.title,496);
    drawBox(ctx,ui,40,48,560,384);
    drawText(ctx,kit,title.text,320,76+title.height/2,title);
    if(r.done!==null){
      const color=r.passed?yellow:red;
      drawText(ctx,kit,r.passed?'通过':'重试',320,222,{color,scale:3});
      drawText(ctx,kit,r.hits+' / '+r.beats.length,320,282);
      return;
    }

    const trackX=155,trackY=84+title.height,trackW=330,bottom=344,lineY=298;
    const laneWidth=trackW/lanes.length;
    const center=lane=>trackX+(lane+.5)*laneWidth;
    const feedback=r.feedback&&r.age<r.feedback.until?r.feedback:null;
    const color=feedback?(feedback.ok?(feedback.text==='正中'?yellow:orange):red):white;
    drawPanel(ctx,trackX,trackY,trackW,bottom-trackY,{border:2});
    for(let lane=1;lane<lanes.length;lane++)tile(ctx,'#383838',trackX+lane*laneWidth,trackY+2,2,bottom-trackY-4);
    tile(ctx,feedback?color:orange,trackX+2,lineY-1,trackW-4,2);
    lanes.forEach((key,lane)=>drawBeatKey(ctx,kit,key,center(lane),359,{alpha:.65}));

    ctx.save();ctx.beginPath();ctx.rect(trackX+2,trackY+2,trackW-4,bottom-trackY-4);ctx.clip();
    const speed=Math.min(5,24/r.window);
    // Keep the earliest pending note in front if two notes in the same lane overlap.
    for(let i=r.beats.length-1;i>=r.cursor;i--){
      const beat=r.beats[i],y=lineY-(beat.at-r.age)*speed;
      if(y<trackY-12||r.results[i])continue;
      drawBeatKey(ctx,kit,beat.key,center(lanes.indexOf(beat.key)),y);
    }
    ctx.restore();
    drawText(ctx,kit,feedback?.text??'标记到线时按对应键',320,392,{color});
  },{width:v.w,height:v.h});
}

export function drawKeypad(ctx,k,v,ui){
  withUiViewport(ctx,()=>{
    const {kit}=ui;
    const title=layoutLabel(ctx,kit,k.title,412),hint=layoutLabel(ctx,kit,k.hint,412);
    const heading=title.height+(hint.height?hint.height+4:0);
    const w=480,h=Math.max(356,254+heading),y=Math.floor((480-h)/2);
    drawBox(ctx,ui,80,y,w,h);
    drawText(ctx,kit,title.text,320,y+24+title.height/2,title);
    if(hint.height)drawText(ctx,kit,hint.text,320,y+28+title.height+hint.height/2,hint);

    const slotY=y+40+heading,step=30;
    const firstSlot=320-(k.code.length-1)*step/2;
    for(let i=0;i<k.code.length;i++){
      const x=firstSlot+i*step;
      const color=k.passed?yellow:white;
      if(k.entry[i])drawText(ctx,kit,k.entry[i],x,slotY,{color});
      tile(ctx,color,x-10,slotY+15,20,2);
    }

    for(const [i,key] of KEYPAD_KEYS.entries()){
      const x=320+(i%3-1)*112,ky=slotY+50+34*Math.floor(i/3);
      const color=k.passed?gray:i===k.cursor?yellow:white;
      drawText(ctx,kit,key==='⌫'?'退格':key,x,ky,{color});
    }
    const status=k.status??'方向键选择  Z 输入  X 退格/取消';
    drawText(ctx,kit,status,320,y+h-38,{color:k.passed?yellow:k.status?red:white});
  },{width:v.w,height:v.h});
}

// Drawn in room space, after scenery and lighting and before the screen-space overlays.
export function drawToolMarker(ctx,s,{art,assets,kit,logical,room}){
  if(s.locked||s.dialogue||s.choice||s.battle||s.rhythm||s.keypad||s.saveRequest||s.defeat)return;
  if(s.tool){
    const {area:{x,y,w,h},age,sprite}=s.tool;
    const left=Math.round(x),right=Math.round(x+w),top=Math.round(y),bottom=Math.round(y+h);
    const length=Math.min(6,Math.floor((right-left)/2),Math.floor((bottom-top)/2));
    for(const [cx,dx] of [[left,1],[right-1,-1]]){
      for(const [cy,dy] of [[top,1],[bottom-1,-1]]){
        tile(ctx,white,dx>0?cx:cx-length+1,cy,length,1);
        tile(ctx,white,cx,dy>0?cy:cy-length+1,1,length);
      }
    }
    if(age&&sprite)actorArt(ctx,art,assets,sprite,'down',false,s.tick,x+w/2,y+h/2);
  }
  if(!s.prompt?.hold||!s.hold)return;
  const target=s.entities?.find(e=>e.id===s.hold.id);
  if(!target)return;
  const camX=Math.round(s.camera.x),camY=Math.round(s.camera.y),width=42;
  const x=Math.round(clamp(target.x+target.w/2,Math.max(0,camX)+25,Math.min(room.w,camX+logical.v.w)-25));
  const y=Math.round(clamp(target.y-8,Math.max(0,camY)+20,Math.min(room.h,camY+logical.v.h)-8));
  const progress=Math.round((width-4)*clamp(s.hold.progress/s.hold.ticks,0,1));
  drawPanel(ctx,x-25,y-17,50,14,{border:0,fill:black});
  drawText(ctx,kit,'长按 Z',x,y-10,{scale:1});
  drawPanel(ctx,x-width/2,y,width,6,{border:1});
  tile(ctx,white,x-width/2+2,y+2,progress,2);
}
