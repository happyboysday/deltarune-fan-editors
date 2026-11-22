import {drawLight} from './art.mjs';

export default {
  modes:{'fireflies.collect':{
    label:'萤火收集',
    validate({value:r,path,num,opt,evt}){
      opt(r,'timeLimit',path,(v,k)=>num(v,k,30,3600,true));
      opt(r,'onCollected',path,evt);
    },
    enter:({room})=>({left:room.timeLimit??300,total:(room.entities??[]).filter(e=>e.kind==='fireflies.light').length,count:0}),
    step({local,move}){
      if(local.left>0&&local.count<local.total){local.left--;move();}
    },
    drawHud({ctx,local}){
      ctx.fillStyle='#182420';ctx.fillRect(6,6,136,20);
      ctx.fillStyle='#d3ff98';ctx.font='12px sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
      ctx.fillText('萤火 '+local.count+'/'+local.total+'   '+Math.ceil(local.left/30)+' 秒',12,16);
    }
  }},
  entities:{'fireflies.light':{
    label:'萤火',
    validate({value:e,path,opt,num}){opt(e,'reach',path,(v,k)=>num(v,k,4,40));},
    step({state,entity:e,local,player,mark,room,run}){
      if(state.mode!=='fireflies.collect'||!local.left||Math.hypot(player.x-e.x-e.w/2,player.y-e.y-e.h/2)>(e.reach??16))return;
      mark(e,{hidden:true});
      if(++local.count===local.total)run(room.onCollected);
    },
    draw:drawLight
  }},
  actions:{'fireflies.finish':{
    validate({value,path,id}){id(value.flag,path+'.flag');},
    execute({state,action}){state.flags[action.flag]=true;}
  }}
};
