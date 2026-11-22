// Follow only animation-bearing fields. Names, sounds and event IDs are not image paths.
function collectDungeonArt(value,assets,needs,assetsIn){
  function add(ref){
    if(!ref)return;
    const asset=typeof ref==='string'?assets?.[ref]??ref:ref;
    for(const src of assetsIn(asset))needs.add(src);
  }
  for(const ref of Object.values(value.anims??{}))add(ref);
  for(const attack of [...(value.attacks??[]),value.airAttack]){
    add(attack?.anim);add(attack?.effect);
  }
  for(const skill of value.skills??[]){add(skill.anim);add(skill.sprite);}
  add(value.dodge?.anim);add(value.shoot?.sprite);add(value.sprite);
}
export function preload({project,rooms,needs,assetsIn}){
  for(const table of [project.fighters,project.enemyTypes,project.tileParts]){
    for(const value of Object.values(table??{}))collectDungeonArt(value,project.assets,needs,assetsIn);
  }
  for(const r of rooms){
    for(const e of r.entities??[])if(e.enemyType)collectDungeonArt(e,project.assets,needs,assetsIn);
    for(const t of r.tiles??[])if(t.sprite)collectDungeonArt(t,project.assets,needs,assetsIn);
  }
}
