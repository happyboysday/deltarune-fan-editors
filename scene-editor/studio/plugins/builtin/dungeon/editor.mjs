import {wireDungeon,dungeonControls,drawDungeonGrid} from './inspector.mjs';

export default {
  mount({root,...editor}){
    root.innerHTML=`<button type="button" id="dgEnable">切换为地下城房间</button>
   <div id="dgPanel" hidden>
    <label>编辑图层 <select id="dgLayer" size="5"><option value="collision">碰撞</option><option value="back">背景</option><option value="actor">同层 · 按底边排序</option><option value="front">前景 · 遮挡角色</option><option value="objects">敌人与物件</option></select></label>
    <label><input type="checkbox" id="dgSolo"> 只看当前层</label>
    <div class="inline"><button id="dgTile">新建方块零件</button><button id="dgAtlas">从官方瓦片集新建方块</button></div>
    <details><summary>角色动作与敌人类型</summary>
     <label>房间角色 <select id="dgFighter"></select></label>
     <div class="inline"><button id="dgEditFighter">编辑角色动作</button><button id="dgNewFighter">新建角色</button><button id="dgKris">从官方 Kris 新建角色</button></div>
     <label>敌人类型 <select id="dgEnemy"></select></label>
     <div class="inline"><button id="dgEditEnemy">编辑敌人</button><button id="dgNewEnemy">新建敌人类型</button><button id="dgEnemies">官方敌人</button></div>
    </details>
   </div>`;
    wireDungeon({...editor,commit(...args){editor.commit(...args);editor.status('已应用地下城设置');}});
  },
  layer:({room,layer})=>room.mode==='dungeon'?layer??'collision':undefined,
  controls:({project,room,layer})=>dungeonControls(project,room,layer),
  grid:({ctx,project,room,model,layer,paint})=>drawDungeonGrid(ctx,project,room,model,layer,document.getElementById('dgSolo').checked,paint),
  entityPanel({entity:e,field,numberField,eventOpts,dropdown,update}){
    if((e.kind??e.type)!=='actionEnemy')return;
    numberField(e,'hp','动作 HP',1,999);
    field('击败事件',dropdown(eventOpts(),e.onDefeat,v=>update(e,'onDefeat',v)),true);
  }
};
