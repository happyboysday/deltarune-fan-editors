export default {
  roomPanel({room,numberField}){
    if(room.mode==='fireflies.collect')numberField(room,'timeLimit','收集时限（帧）',30,3600);
  },
  entityPanel({entity,numberField}){
    if(entity.kind==='fireflies.light')numberField(entity,'reach','收集半径',4,40);
  },
  mount({button,project,room,commit}){
    button('添加萤火',()=>{
      const p=structuredClone(project()),key=Object.keys(project().rooms).find(k=>project().rooms[k]===room());
      const r=p.rooms[key];
      if(r.mode!=='fireflies.collect')throw Error('先选择萤火收集模式');
      const ids=new Set(Object.values(p.rooms).flatMap(r=>(r.entities??[]).map(e=>e.id)));
      let n=1;while(ids.has('light'+n))n++;
      (r.entities??=[]).push({id:'light'+n,kind:'fireflies.light',x:Math.floor(r.w/2),y:Math.floor(r.h/2),w:12,h:12,reach:16});
      commit(p);
    });
  }
};
