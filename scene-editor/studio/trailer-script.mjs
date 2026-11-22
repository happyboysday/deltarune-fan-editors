import {projectPlugins} from './plugins.mjs';
import {HZ,isTimedInput} from './format.mjs';

export function hasTrailerPlayback(project){
  return (project.navScript??[]).some(isTimedInput)||Object.entries(project.rooms).some(([key,r])=>
    projectPlugins(project).modes.get(r.mode)?.hooks.toolKey||trailerRows(project,key).length);
}

export function trailerRows(project,room,mode=project.rooms[room].mode){
  const r=project.rooms[room];
  const scoped=list=>(list??[]).filter(row=>isTimedInput(row)&&(!row.room||row.room===room));
  const field=projectPlugins(project).modes.get(mode)?.hooks.scriptField;
  if(field){
    if(r[field]?.length)return r[field];
    const rows=scoped(project[field]);
    if(rows.length)return rows;
  }
  return r.navScript??scoped(project.navScript);
}

export function createTrailerTimeline(rows){
  const queue=rows.map((row,index)=>({row,index,tick:row.tick??Math.round(row.at*HZ)}))
    .sort((a,b)=>a.tick-b.tick||a.index-b.index);
  let age=0,index=0,hold=[];
  return {
    step(cue){
      const press=new Set();
      while(index<queue.length&&queue[index].tick<=age){
        const {row}=queue[index++];
        if(row.hold!==undefined)hold=row.hold;
        for(const key of row.press??[])press.add(key);
        if(row.op)cue(row);
      }
      age++;
      return {hold:new Set([...hold,...press]),press};
    },
    status:()=>({age,next:queue[index]?.tick??null,hold:[...hold],done:index===queue.length})
  };
}
