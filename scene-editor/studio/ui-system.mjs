import {firstSprite} from './ui-draw.mjs';
import {createTypewriter,drawPanel,UI_COLORS,UI_SOUNDS,UI_VOICES,withUiViewport} from './ui-kit.mjs';

const {black,white,yellow,red,gray}=UI_COLORS;
const lightFont={font:'fnt_main',scale:2};
const smallFont={font:'fnt_main'};
const lightTabs=['物品','状态','电话'];
const partyColors={kris:'#00ffff',susie:'#ff00ff',ralsei:'#00ff00',noelle:yellow};
const canvasKits=new WeakMap();
const defeatFrames=new WeakMap();
const defeatWriters=new WeakMap();

export function watchSystemKit(canvas,onKit){
  canvasKits.set(canvas,onKit);
  return ()=>canvasKits.delete(canvas);
}

function fillSystemRect(ctx,color,x,y,w,h){
  ctx.fillStyle=color;
  ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));
}

function systemText(ctx,kit,value,x,y,{width,...options}={}){
  let text=String(value??'');
  const {font='fnt_mainbig',scale=1,align='left',color=white,alpha=1}=options;
  ctx.save();
  ctx.font=(font==='fnt_main'?12*scale:24*scale)+'px "SimSun", "Microsoft YaHei UI", monospace';
  const measure=str=>kit?kit.measureText(str,options).width:ctx.measureText(str).width;
  if(width&&measure(text)>width){
    const glyphs=Array.from(text);
    let lo=0,hi=glyphs.length;
    while(lo<hi){
      const mid=Math.ceil((lo+hi)/2);
      if(measure(glyphs.slice(0,mid).join('')+'…')<=width)lo=mid;
      else hi=mid-1;
    }
    text=glyphs.slice(0,lo).join('')+'…';
  }
  if(kit)kit.drawText(ctx,text,x,y,options);
  else{
    ctx.textBaseline='top';ctx.textAlign=align;ctx.fillStyle=color;ctx.globalAlpha*=alpha;
    text.split('\n').forEach((line,i)=>ctx.fillText(line,x,y+i*(options.lineHeight??18)*scale));
  }
  ctx.restore();
}

function systemBox(ctx,kit,x,y,w,h,{light=false,frame=0}={}){
  if(!light&&kit)kit.drawDarkBox(ctx,x,y,w,h,{frame});
  else drawPanel(ctx,x,y,w,h);
}

const heartRows=['011000110','111101111','111111111','111111111','011111110','001111100','000111000','000010000'];
function systemHeart(ctx,kit,x,y,sprite='spr_heart',scale=1,alpha=1){
  if(kit?.drawHeart(ctx,x,y,{sprite,scale,alpha}))return;
  ctx.save();
  ctx.globalAlpha*=alpha;
  const pixel=scale*(sprite==='spr_heart'?2:1);
  heartRows.forEach((row,j)=>Array.from(row).forEach((bit,i)=>{
    if(bit==='1')fillSystemRect(ctx,red,x+i*pixel,y+j*pixel,pixel,pixel);
  }));
  ctx.restore();
}

function systemBar(ctx,x,y,w,h,progress,color){
  fillSystemRect(ctx,'#800000',x,y,w,h);
  fillSystemRect(ctx,color,x,y,w*Math.max(0,Math.min(1,progress)),h);
}

export function systemChapter(project,room){
  const source=project.chapter??room?.official?.chapter??room?.map?.chapter??/^ch(\d+)(?:[-_]|$)/i.exec(project.id)?.[1];
  const chapter=Number(String(source??'').replace(/^ch/i,''));
  return Number.isInteger(chapter)&&chapter>0?chapter:1;
}

const menuItems=state=>Object.entries(state.inventory??{}).filter(([,count])=>count>0);
function itemName(project,id){
  const name=project.campaign?.items?.[id]?.name;
  return typeof name==='string'?name:name?.zh??name?.en??id;
}

export function createSystemMenu(world){
  return {world,age:0,tab:0,page:null,cursor:0};
}

// obj_darkcontroller: ITEM, EQUIP, (TALK hidden), POWER, CONFIG. The light menu lists 物品/状态/电话.
// Only items and party status have pages here; the other buttons answer with snd_error.
const DARK_BUTTONS=[0,1,3,4];
const DARK_BUTTON_SPRITES=['spr_darkitembt','spr_darkequipbt','spr_darktalkbt','spr_darktechbt','spr_darkconfigbt'];
const menuPages=world=>world==='light'?['items','party',null]:['items',null,'party',null];

export function stepSystemMenu(menu,state,press,sound){
  if(press.has('cancel')||press.has('menu')){
    if(menu.page&&press.has('cancel')){menu.page=null;menu.cursor=0;sound(UI_SOUNDS.cancel);return menu;}
    sound(UI_SOUNDS.cancel);
    return null;
  }
  ++menu.age;
  if(!menu.page){
    const pages=menuPages(menu.world),light=menu.world==='light';
    const step=light?Number(press.has('down'))-Number(press.has('up')):Number(press.has('right'))-Number(press.has('left'));
    if(step){
      const next=Math.max(0,Math.min(pages.length-1,menu.tab+step));
      if(next!==menu.tab){menu.tab=next;sound(UI_SOUNDS.move);}
    }
    if(press.has('act')){
      const page=pages[menu.tab];
      if(page){menu.page=page;menu.cursor=0;sound(UI_SOUNDS.select);}
      else sound(UI_SOUNDS.error);
    }
    return menu;
  }
  const count=menu.page==='items'?menuItems(state).length:Object.keys(state.party).length;
  if(count<=1)return menu;
  const stride=menu.page==='items'&&menu.world==='dark'?2:1;
  const move=(Number(press.has('right'))-Number(press.has('left')))+stride*(Number(press.has('down'))-Number(press.has('up')));
  const next=((menu.cursor+move)%count+count)%count;
  if(next!==menu.cursor){
    menu.cursor=next;
    sound(UI_SOUNDS.move);
  }
  return menu;
}

function drawItemsPage(ctx,s,{kit,project},light,frame){
  const entries=menuItems(s),size=light?8:12,selected=s.menu.cursor,offset=Math.floor(selected/size)*size;
  const opts=light?lightFont:{};
  if(light){
    systemBox(ctx,kit,188,32,346,362,{light});
    ['使用','说明','丢弃'].forEach((label,i)=>systemText(ctx,kit,label,232+i*91,340,{...opts,color:gray}));
  }else{
    systemBox(ctx,kit,36,80,569,291,{frame});
    ['使用','丢弃'].forEach((label,i)=>systemText(ctx,kit,label,158+i*120,110,{color:gray}));
  }
  if(!entries.length){
    systemText(ctx,kit,'没有物品',light?232:92,light?60:152,{...opts,color:gray});
    return;
  }
  entries.slice(offset,offset+size).forEach(([id,count],i)=>{
    const active=offset+i===selected;
    const x=light?232:(i%2===0?94:356),y=light?60+i*32:152+Math.floor(i/2)*30;
    const right=light?515:(i%2===0?320:580);
    if(active)systemHeart(ctx,kit,x-23,y+8,light?'spr_heartsmall':'spr_heart',light?2:1);
    if(count>1)systemText(ctx,kit,'×'+count,right,y+7,{...smallFont,align:'right',color:active?yellow:white});
    const nameRight=right-(count>1?52:0);
    systemText(ctx,kit,itemName(project,id),x,y,{...opts,width:nameRight-x,color:active?yellow:white});
  });
  if(entries.length>size){
    const page=(1+offset/size)+'/'+Math.ceil(entries.length/size);
    systemText(ctx,kit,page,light?514:582,light?365:339,{...smallFont,align:'right'});
  }
}

function drawPartyPage(ctx,s,{kit},light,frame){
  const party=Object.values(s.party??{}),selected=s.menu.cursor,offset=Math.floor(selected/6)*6;
  const opts=light?lightFont:{};
  if(light)systemBox(ctx,kit,188,32,418,418,{light});
  else systemBox(ctx,kit,60,80,521,291,{frame});
  const x=light?216:115,y=light?64:110,right=light?580:530;
  if(!party.length){
    systemText(ctx,kit,'没有队伍数据',x,y,{...opts,color:gray});
    return;
  }
  party.slice(offset,offset+6).forEach((p,i)=>{
    const row=y+i*36,active=i+offset===selected, color=active?yellow:white;
    if(active)systemHeart(ctx,kit,x-22,row+8,light?'spr_heartsmall':'spr_heart',light?2:1);
    systemText(ctx,kit,p.name,x,row,{...opts,color,width:right-x-160});
    systemText(ctx,kit,'HP  '+p.hp+' / '+p.maxHp,right,row,{...opts,color,align:'right'});
  });
}

function drawLightMenu(ctx,s,ui){
  const {kit,logical}=ui,menu=s.menu;
  const yOffset=(s.player.y-s.camera.y)*logical.scale+logical.y>260?270:0;
  const leader=s.party.kris??Object.values(s.party)[0];
  systemBox(ctx,kit,32,32+yOffset,142,110,{light:true});
  systemText(ctx,kit,leader?.name??'Kris',46,40+yOffset,{...lightFont,width:113});
  systemText(ctx,kit,'LV  1',46,80+yOffset,smallFont);
  if(leader)systemText(ctx,kit,'HP  '+leader.hp+'/'+leader.maxHp,46,98+yOffset,smallFont);
  systemBox(ctx,kit,32,148,142,148,{light:true});
  const active=menu.tab;
  lightTabs.forEach((label,i)=>systemText(ctx,kit,label,84,168+i*36,{...lightFont,color:menuPages('light')[i]?white:gray}));
  if(!menu.page||menu.page==='party')systemHeart(ctx,kit,56,176+active*36,'spr_heartsmall',2);
  if(menu.page==='items')drawItemsPage(ctx,s,ui,true,0);
  if(menu.page==='party')drawPartyPage(ctx,s,ui,true,0);
}

function barSlide(target,age){
  let depth=0;
  for(let i=0;i<Math.min(10,age)&&depth<target;i++){
    const remaining=target-depth;
    depth+=remaining>40?30:Math.max(1,Math.round(remaining/2.5));
  }
  return depth;
}

const PARTY_SPRITES={kris:['spr_headkris','spr_bnamekris'],susie:['spr_headsusie','spr_bnamesusie'],
  ralsei:['spr_headralsei','spr_bnameralsei'],noelle:['spr_headnoelle','spr_bnamenoelle']};

// scr_charbox: 213 px chunks, a 2 px colour line, head at +13, name plate at +51, HP label at +109,
// spr_numbersfontsmall digits right-aligned at +160 / +205 around spr_hpslash, and a 75 x 9 bar at +128.
function hpDigits(ctx,kit,value,right,y,color){
  const text=String(value);
  if(!kit||![...text].every(ch=>'0123456789-+'.includes(ch)))return false;
  let x=right-text.length*8;
  for(const ch of text){
    if(!kit.drawSprite(ctx,'spr_numbersfontsmall',x,y,{frame:'0123456789-+'.indexOf(ch),color:color===white?undefined:color}))return false;
    x+=8;
  }
  return true;
}

function drawPartyStrip(ctx,s,{kit,art,assets,room},bottom){
  const members=Object.entries(s.party??{}).slice(0,3);
  const start=members.length===3?0:members.length===2?108:213;
  members.forEach(([id,p],i)=>{
    const x=start+(members.length===2?214:213)*i,y=bottom+10,color=partyColors[id]??white;
    const [head,plate]=PARTY_SPRITES[id]??[];
    fillSystemRect(ctx,color,x,bottom-3,213,2);
    if(!(head&&kit?.drawSprite(ctx,head,x+13,y))){
      const actor=id==='kris'?s.player.sprite:room.followers?.find(a=>a.id?.includes(id))?.sprite;
      const img=art.images.get(firstSprite(assets['face_'+id]??assets[actor]));
      if(img?.naturalWidth){
        const ratio=Math.min(32/img.naturalWidth,24/img.naturalHeight);
        ctx.drawImage(img,x+13,y,img.naturalWidth*ratio,img.naturalHeight*ratio);
      }
    }
    if(!(plate&&kit?.drawSprite(ctx,plate,x+51,y+3)))systemText(ctx,kit,p.name,x+51,y+1,{...smallFont,width:56});
    if(!kit?.drawSprite(ctx,'spr_hpname',x+109,y+11))systemText(ctx,kit,'HP',x+109,y+10,smallFont);
    const hpColor=p.hp<=0?red:p.hp/p.maxHp<=.25?yellow:white;
    if(!(hpDigits(ctx,kit,Math.max(0,p.hp),x+160,y-2,hpColor)&&kit.drawSprite(ctx,'spr_hpslash',x+159,y-4)
      &&hpDigits(ctx,kit,p.maxHp,x+205,y-2,white)))
      systemText(ctx,kit,p.hp+'/'+p.maxHp,x+205,y-4,{...smallFont,align:'right',color:hpColor});
    systemBar(ctx,x+128,y+11,76,9,p.hp/p.maxHp,color);
  });
}

function drawDarkMenu(ctx,s,ui){
  const {kit}=ui,menu=s.menu;
  const top=barSlide(80,menu.age),bottom=480-barSlide(60,menu.age);
  fillSystemRect(ctx,'#010000',0,0,640,top);
  fillSystemRect(ctx,'#010000',0,bottom-1,640,481-bottom);
  const coord=DARK_BUTTONS[menu.tab];
  if(top>0){
    // obj_darkcontroller_Draw_0:27-56: caption at (20, tp-56), buttons at 120+100i (TALK skipped) on tp-60, all 2x.
    if(!kit?.drawSprite(ctx,'spr_darkmenudesc',20,top-56,{frame:coord,scale:2}))
      systemText(ctx,kit,['物品','装备','交谈','能力','设置'][coord],20,top-60);
    DARK_BUTTONS.forEach(i=>{
      const frame=menu.page&&i===coord?2:i===coord?0:1,x=120+i*100-(i>=2?100:0),y=top-60;
      if(kit?.drawSprite(ctx,DARK_BUTTON_SPRITES[i],x,y,{frame,scale:2}))return;
      drawPanel(ctx,x,y,66,48,{border:2,borderColor:frame===1?'#5f5470':'#ffc90e'});
      if(frame===0)systemHeart(ctx,kit,x+8,y+16);
    });
    systemText(ctx,kit,'D$ '+(s.money??0),520,top-60);
  }
  if(bottom<480)drawPartyStrip(ctx,s,ui,bottom);
  const frame=Math.floor(s.tick/10)%8;
  if(menu.page==='items')drawItemsPage(ctx,s,ui,false,frame);
  if(menu.page==='party')drawPartyPage(ctx,s,ui,false,frame);
}

export function drawSystemHud(ctx,s,_viewport,ui){
  if(ui.kit)canvasKits.get(ctx.canvas)?.(ui.kit);
  if(s.defeat||s.dialogue||s.choice||s.rhythm||s.keypad||s.saveRequest)return;
  if(!s.menu&&!s.note&&s.mode!=='climb'&&!s.hold?.progress)return;
  withUiViewport(ctx,()=>{
    const {kit}=ui;
    if(s.menu){
      if(ui.world==='light')drawLightMenu(ctx,s,ui);
      else drawDarkMenu(ctx,s,ui);
      return;
    }
    if(s.mode==='climb'&&s.maxGrip>0){
      systemText(ctx,kit,'抓力',20,22,smallFont);
      systemBar(ctx,54,26,76,8,s.grip/s.maxGrip,s.grip<=s.maxGrip/4?'#ff5038':'#ffdc00');
    }
    if(s.hold?.progress>0&&!s.hold.complete){
      drawPanel(ctx,268,432,104,10,{border:2});
      fillSystemRect(ctx,white,272,436,96*s.hold.progress/s.hold.ticks,2);
    }
    if(s.note){
      const opts={...smallFont,width:590,align:'right'};
      systemText(ctx,kit,s.note.text,618,455,{...opts,color:black});
      systemText(ctx,kit,s.note.text,616,453,opts);
    }
  });
}

function displayPlayTime(ticks){
  const seconds=Math.floor(ticks/30);
  const pad=n=>String(n).padStart(2,'0');
  return Math.floor(seconds/3600)+':'+pad(Math.floor(seconds/60)%60)+':'+pad(seconds%60);
}

export function drawSaveRequest(ctx,request,_viewport,{kit,world,project,room,roomKey}){
  if(!request)return;
  withUiViewport(ctx,()=>{
    const light=world==='light',opts=light?lightFont:{};
    if(light)systemBox(ctx,kit,100,98,440,218,{light});
    else systemBox(ctx,kit,92,98,455,173,{frame:Math.floor((request.time??0)/10)%8});
    const color=request.saved?yellow:white;
    systemText(ctx,kit,request.playerName??'Kris',120,120,{...opts,color,width:215});
    systemText(ctx,kit,'LV '+systemChapter(project,room),400,120,{...opts,color,align:'right'});
    systemText(ctx,kit,displayPlayTime(request.time??0),522,120,{...opts,color,align:'right',width:116});
    systemText(ctx,kit,room.title??request.name??roomKey,320,170,{...opts,color,align:'center',width:360});
    if(request.saved)systemText(ctx,kit,'文件已保存',170,220,{...opts,color});
    else{
      systemHeart(ctx,kit,142+180*request.index,228,light?'spr_heartsmall':'spr_heart',light?2:1);
      systemText(ctx,kit,'保存',170,220,opts);
      systemText(ctx,kit,'返回',350,220,opts);
    }
  });
}

const failureOptions=['继续','放弃'];
const giveUpOptions=['从头开始','留在场景'];
const failureXs=[160,380];
const failureLines={
  susie:['  喂，Kris。\n  还没结束呢。','  再站起来一次。'],
  ralsei:['  Kris……\n  还能听见我吗？','  我们再试一次吧。']
};

export function createDefeatUi(battle,party){
  const speaker=Object.hasOwn(party,'susie')?'susie':Object.hasOwn(party,'ralsei')?'ralsei':null;
  return {battle,speaker,age:0,phase:'soul',page:0,line:'',phaseAge:0,index:-1,heartX:300,taps:0,action:null};
}

export function setDefeatFrame(defeat,frame){
  if(frame)defeatFrames.set(defeat,frame);
}

function defeatPhase(defeat,phase){
  defeat.phase=phase;
  defeat.phaseAge=0;
}

export function stepDefeatUi(d,press,sound){
  ++d.age;++d.phaseAge;
  const act=press.has('act'),cancel=press.has('cancel');
  if(d.phase==='soul'){
    if(d.age===50)sound(UI_SOUNDS.crack);
    if(d.age===90)sound(UI_SOUNDS.shatter);
    if(d.age>=80&&d.age<150&&act&&++d.taps===4){
      sound(UI_SOUNDS.revive);defeatPhase(d,'quick');
    }else if(d.age>=150)defeatPhase(d,'intro');
  }else if(d.phase==='intro'&&d.phaseAge>=30){
    defeatPhase(d,d.speaker?'speech':'choice');
  }else if(d.phase==='speech'){
    let writer=defeatWriters.get(d);
    if(!writer){
      writer=createTypewriter(failureLines[d.speaker][d.page],{
        ticksPerGlyph:2,voice:UI_VOICES[d.speaker],onVoice:({name})=>sound(name)
      });
      defeatWriters.set(d,writer);
    }
    if(act&&writer.done){
      defeatWriters.delete(d);d.line='';
      if(++d.page>=2)defeatPhase(d,'choice');
    }else d.line=act||cancel?writer.skip():writer.advance();
  }else if(d.phase==='choice'||d.phase==='giveUp'){
    const giveUp=d.phase==='giveUp';
    if(giveUp&&cancel){
      d.index=-1;d.heartX=300;defeatPhase(d,'choice');
      return;
    }
    if(press.has('left')||press.has('up'))d.index=0;
    if(press.has('right')||press.has('down'))d.index=1;
    const target=d.index<0?300:failureXs[d.index]+(giveUp?56:28)-20;
    d.heartX+=(target-d.heartX)*.3;
    if(act&&d.index>=0&&d.phaseAge>=10){
      if(!giveUp&&d.index===1){
        d.index=-1;d.heartX=300;defeatPhase(d,'giveUp');
      }else{
        d.action=giveUp?(d.index===0?'restart':'stay'):'continue';
        if(d.action!=='stay')sound(UI_SOUNDS.revive);
        defeatPhase(d,'exit');
      }
    }
  }else if(d.phase==='quick'&&d.phaseAge>=30){
    defeatPhase(d,'done');
    return 'continue';
  }else if(d.phase==='exit'&&d.phaseAge>=(d.action==='continue'?150:16)){
    defeatPhase(d,'done');
    return d.action;
  }
}

const shardOffsets=[[-2,0],[0,3],[2,6],[8,0],[10,3],[12,6]];
const shardAngles=[-2.85,-2.3,-1.87,-1.18,-.65,.24];

function drawDefeatSoul(ctx,kit,d){
  const age=Math.min(d.age,149),x=312,y=232;
  if(age<30){
    const frame=defeatFrames.get(d);
    if(frame)ctx.drawImage(frame,0,0,640,480);
  }else if(age<50)systemHeart(ctx,kit,x,y);
  else if(age<90){
    if(!kit?.drawSprite(ctx,'spr_heartbreak',x-2,y)){
      systemHeart(ctx,kit,x-2,y);
      fillSystemRect(ctx,black,x+5,y+1,2,12);
      fillSystemRect(ctx,black,x+7,y+5,2,6);
    }
  }else{
    const t=age-90;
    shardOffsets.forEach(([dx,dy],i)=>{
      const px=x-2+dx+Math.cos(shardAngles[i])*7*t;
      const py=y+dy+Math.sin(shardAngles[i])*7*t+.1*t*(t+1);
      if(!kit?.drawSprite(ctx,'spr_heartshards',px,py,{frame:Math.floor(t/5)%4}))
        fillSystemRect(ctx,red,px,py,4,4);
    });
    if(age>=140){
      ctx.globalAlpha=(age-139)*.08;
      fillSystemRect(ctx,black,0,0,640,480);
      ctx.globalAlpha=1;
    }
  }
}

function drawGameOver(ctx,kit,d){
  if(d.phase==='soul'||d.phase==='quick'){
    drawDefeatSoul(ctx,kit,d);
    if(d.phase==='quick'){
      ctx.globalAlpha=Math.min(1,d.phaseAge/30);
      fillSystemRect(ctx,white,0,0,640,480);
    }
    return;
  }
  const giveUp=d.phase==='giveUp'||d.phase==='exit'&&d.action!=='continue';
  if(!giveUp){
    const alpha=Math.min(1,(d.age-150)*.02);
    if(!kit?.drawSprite(ctx,'spr_gameoverbg_neo',0,40,{scale:2,alpha})){
      systemText(ctx,kit,'GAME OVER',320,94,{scale:2,align:'center',alpha});
    }
  }
  if(d.phase==='speech')systemText(ctx,kit,d.line,100,300,{...lightFont,advance:'writer',cellWidth:12,lineHeight:20});
  if(d.phase==='choice'||d.phase==='giveUp'){
    const alpha=Math.min(1,d.phaseAge/10);
    if(giveUp)systemText(ctx,kit,'要离开这次试玩吗？',100,300,lightFont);
    systemHeart(ctx,kit,d.heartX,360,'IMAGE_SOUL_BLUR',2,.6*alpha);
    (giveUp?giveUpOptions:failureOptions).forEach((label,i)=>systemText(ctx,kit,label,failureXs[i],360,{
      ...lightFont,alpha,color:i===d.index?yellow:white
    }));
  }
  if(d.phase==='exit'&&d.action==='continue'){
    ctx.globalAlpha=Math.max(0,Math.min(1,(d.phaseAge-30)*.01));
    fillSystemRect(ctx,white,0,0,640,480);
  }
}

export function drawFade(ctx,s,v,{kit}){
  if(!s.fade&&!s.defeat)return;
  ctx.save();
  ctx.globalAlpha=s.defeat?1:s.fade;
  fillSystemRect(ctx,black,0,0,v.w,v.h);
  if(s.defeat)withUiViewport(ctx,()=>drawGameOver(ctx,kit,s.defeat));
  ctx.restore();
}
