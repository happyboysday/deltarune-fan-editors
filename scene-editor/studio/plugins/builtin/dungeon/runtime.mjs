import {createDungeon,stepDungeon,clearDungeonMotion} from './simulation.mjs';
import {enemySpec,dungeonBox} from './data.mjs';
import {drawActionEnemy} from './view.mjs';
import {validation} from './validation.mjs';
import {drawing} from './drawing.mjs';
import {preload} from './assets.mjs';
import {defaults} from './defaults.mjs';

export default {
  entityDefaults:({project,entity})=>enemySpec(project,entity),
  validation,validateRoom:ctx=>ctx.schema.room(ctx),preload,
  roomAssets({room,needs}){
    const c=room.dungeonConfig;
    for(const src of [c?.waveSprite,c?.parrySprite,...(c?.slashSprites??[])])if(src)needs.add(src);
  },
  modes:{dungeon:{
    label:'动作地下城',platform:defaults,layeredGrid:true,platformLabel:'地下城移动',customDash:true,face:'right',toolKey:true,
    help:'← → 移动 · ↑ 跳跃 · Z 攻击/互动 · 按住 X 奔跑 · Shift/V 闪避 · C/F/Q/E 技能 · Esc 回检查点',
    keys:{KeyX:'run',KeyC:'skill1',KeyF:'skill2',KeyQ:'skill3',KeyE:'skill4'},
    debug:({local:d})=>({hp:d.hp,combo:d.combo,stage:d.comboStage,kills:d.kills,hits:d.hits,hitstop:d.hitstop,
        afterimages:d.trail.length,grazes:d.grazes,waves:d.wavesCast,parries:d.parries,deflected:d.deflected}),
    enter:({room,project})=>createDungeon(room,project),
    step({local,player,input,room,project,state,radius,active,platformMove,interact,retry,shake,run}){
      stepDungeon(local,player,input,{room,active,radius,move:platformMove,interact,shake,
        retry:()=>{retry();state.dungeon=createDungeon(room,project);},defeated:enemy=>run(enemy.onDefeat)});
    },
    retry:({local})=>clearDungeonMotion(local),
    playerBox:({local,player,radius})=>dungeonBox(local,player,radius),
    movementProfile:({local})=>local?.fighter,...drawing
  }},
  entities:{actionEnemy:{
    label:'动作敌人',ignoreSolid:true,customEvents:true,validate:ctx=>ctx.schema.enemy(ctx),
    pose:({state,entity})=>state.dungeon?.enemies.get(entity.id),
    draw:({ctx,entity,state,tick,art,assets})=>drawActionEnemy(ctx,entity,state.dungeon,tick,art,assets)
  }}
};
