"""Chapter-specific ports assembled from local source facts. IDs stay inspectable."""
import json, re
from ch5_gml import Node, dialogue, messages, parse, serialize

def add(c,k,e,ops,src,kind,keys=()):
    key=e["id"]+"_event"
    c.events[key]=ops
    e["event"]=key
    c.outputs[k]["entities"].append(e)
    c.report[k]["custom"]+=1
    c.reference(k,kind,src,instance=e["id"],localized=list(keys))

def text_pages(c,source,state):
    for node in parse(c.source(source)):
        if re.match(rf"if con == {state}(?: |$)",node.code):
            data=[x for child in node.children if 'msg' in child.code and 'choicemsg' not in child.code
                  for x in messages(child.code,c.lang)]
            return [p for p,_ in data],[k for _,k in data]
    return [],[]

def clamp_box(r,x,y,w,h):
    a,b=max(0,x),max(0,y)
    w,h=min(r["w"],x+w)-a,min(r["h"],y+h)-b
    if w<1 or h<1:return None
    return {"x":a,"y":b,"w":w,"h":h}

def readables_and_bed(c):
    k="room_krisroom"
    r=c.outputs[k]
    step="gml_Object_obj_room_krisroom_Step_0"
    create="gml_Object_obj_room_krisroom_Create_0"
    source=c.source(create)
    # Preserve the construction coordinates as well as the room controller's tags.
    coords={
        "window":(148,80,33,19,10,"Window"),
        "bedsheets":(132,139,60,8,30,"Bedsheets"),
        "bed":(235,108,41,39,40,"Kris's bed"),
        "bed_brother":(42,98,44,52,70,"Asriel's bed"),
        "cage":(190,166,10,8,50,"Cage"),
        "computer":(42,183,48,20,80,"Computer"),
        "wagon":(247,175,20,20,90,"Wagon"),
        "drawer":(196,99,28,20,95,"Drawer"),
    }
    for label,(x,y,w,h,state,title) in coords.items():
        assert f'"krisroom_{label}"' in source,(label,create)
        pages,ids=text_pages(c,step,state)
        if not pages:continue
        ops=[{"op":"say","pages":pages}]
        if label=="bed":
            pre,pids=text_pages(c,step,42)
            wake,wids=text_pages(c,step,48)
            # The two options use the actual localized keys from the original choice.
            yes="obj_room_krisroom_slash_Step_0_gml_67_0"
            no="obj_room_krisroom_slash_Step_0_gml_68_0"
            alt="obj_room_krisroom_slash_Step_0_gml_98_0"
            sleep=[{"op":"wait","ticks":100},{"op":"say","pages":wake},
                   {"op":"flag","id":"gml_f_1767","value":1},{"op":"flag","id":"gml_plot","value":190},
                   {"op":"goto","room":"room_dw_garden_intro","entry":"arrival","fade":20}]
            no_=[{"op":"say","pages":[dialogue(c.lang[alt])]}]
            condition={"all":[{"flag":"gml_ch5_completed"},{"not":{"flag":"gml_side_b"}},{"flag":"gml_plot","compare":"lt","is":60}]}
            ops=[{"op":"branch","if":condition,"then":[{"op":"say","pages":pre[:-1]},
                     {"op":"choose","question":pre[-1],"options":[
                       {"text":c.lang[yes].strip().lstrip("#").strip(),"actions":sleep},{"text":c.lang[no].strip().lstrip("#").strip(),"actions":no_}]}],
                     "else":ops}]
            ids=ids+pids+wids+[yes,no,alt]
        add(c,k,{"id":"krisroom_"+label,"kind":"prop","x":x,"y":y,"w":w,"h":h,
                 "name":title,"draw":False},ops,[create,step],"bed choice" if label=="bed" else "runtime-readable",ids)

def asset_frame(c,sprite,index,scale=2):
    frames=c.frame_arts(sprite,scale)
    if not frames:return None
    key=f"a_{sprite}_{scale}_{index}"
    c.assets[key]={"src":frames[index%len(frames)],"anchor":"feet"}
    return key

def extflag(c,i):
    raw="\n".join(c.source(i[key]) for key in ("pre","init"))
    m=re.search(r'\bextflag\s*=\s*("(?:\\.|[^"\\])*")\s*;',raw)
    return json.loads(m[1]) if m else None

def water(c):
    room_set=set()
    flowers=("obj_waterable_flower_small","obj_waterable_flower_2x2","obj_waterable_grass")
    splash="watering_feedback"
    frames=c.frame_arts("spr_wateringcanspray_ground",2)
    if frames:c.assets[splash]={"frames":frames,"anchor":"center","ticks":3}
    for k,r in c.outputs.items():
        if not k.startswith(("room_dw_garden_","room_dw_cliff_","room_dw_fcastle_","room_dw_dogballoon")):continue
        meta=c.meta[k]
        source_entities=[i for i in meta["instances"] if i["name"] in flowers or i["name"]=="obj_wateringcan_pedestal"]
        if not source_entities:continue
        room_set.add(k)
        r["tool"]={"item":"watering_can","range":56,"width":38,"ticks":3,
            "variants":[{"when":{"flag":"gml_can_size","is":2},"range":96,"width":78},
                        {"when":{"flag":"gml_can_size","is":4},"range":166,"width":150}]}
        if frames:r["tool"]["sprite"]=splash
        for i in source_entities:
            box=c.shape(meta,i)
            if not box:continue
            typ=i["name"]
            iid=i["id"]
            sid=f"water_{iid}"
            if typ=="obj_wateringcan_pedestal":
                pre=c.source(i["pre"])
                m=re.search(r'\bheld_item_index\s*=\s*(\d+)\s*;',pre)
                types={1010:1,1112:2,1528:4}
                raw=int(m[1]) if m else 1010
                if raw not in types:
                    c.issue(k,"pedestal holds a different tool",instance=iid,source=i["pre"])
                    continue
                flag=next((m[1] for m in re.finditer(r'\bheld_item_flag\s*=\s*(\d+)\s*;',pre)),None)
                index=next((int(m[1]) for m in re.finditer(r'\bheld_item_flag_index\s*=\s*(\d+)\s*;',pre)),0)
                p=r["entities"]
                p[:]=[e for e in p if e["id"]!=f"g{iid}"]
                can_size=types[raw]
                take=[{"op":"item","id":"watering_can","delta":1},
                      {"op":"flag","id":"gml_f_1332","value":1},{"op":"flag","id":"gml_can_size","value":can_size}]
                leave=[{"op":"item","id":"watering_can","delta":-1},{"op":"flag","id":"gml_f_1332","value":0}]
                available=True
                if flag:
                    if k=="room_dw_garden_wateringcan_aqua":
                        available={"flag":"gml_f_"+flag,"compare":"eq","is":index}
                    leave.append({"op":"flag","id":"gml_f_"+flag,"value":index})
                choice=take if available is True else [{"op":"branch","if":available,"then":take}]
                ops=[{"op":"branch","if":{"item":"watering_can"},"then":leave,"else":choice}]
                add(c,k,{"id":sid,"kind":"prop","name":"浇水壶架",**box,"draw":False},
                    ops,["gml_Object_obj_wateringcan_pedestal_Other_10",i["pre"]],"watering can stand")
                art=asset_frame(c,"spr_wateringcan_big" if can_size==4 else "spr_wateringcan",0)
                if art:
                    show={"not":{"item":"watering_can"}}
                    if available is not True:show={"all":[show,available]}
                    p.append({"id":sid+"_can","kind":"prop","name":"浇水壶","x":box["x"],"y":box["y"],"w":box["w"],
                             "h":max(1,round(box["h"]/2)),"sprite":art,"activeWhen":show})
                continue
            sp=c.objects[typ]["sprite"]["name"]
            prep=c.source(i["pre"])
            if re.search(r'\bstarts_active\s*=\s*(?:true|1)\s*;',prep):continue
            if typ=="obj_waterable_grass":
                palette=re.search(r'\bpalette\s*=\s*(\d+)\s*;',prep)
                sp=["spr_growgrass_pink","spr_growgrass_dark","spr_growgrass_darker"][max(0,min(2,int(palette[1]) if palette else 0))]
                at=1
            else:
                style=re.search(r'\bstyle\s*=\s*(\d+)\s*;',prep)
                at=(int(style[1]) if style else 0)*3+2
            grown=asset_frame(c,sp,at)
            if not grown:continue
            # The original remains a wall/ground prop until watered. The added
            # asset draws on top only once its source growth event fires.
            p={"id":sid,"kind":"prop","name":"可浇水植物",**box,"once":True,"toolTarget":True}
            ops=[{"op":"sprite","actor":sid,"sprite":grown}]
            src="gml_Object_obj_waterable_grass_Create_0" if typ=="obj_waterable_grass" else "gml_Object_obj_waterable_flower_small_Create_0"
            add(c,k,p,ops,[src,i["pre"]],"directional watering")
    return room_set

def simple_cutscene(c,k,controller,command_states):
    src=controller+"_Step_0"
    nodes=parse(c.source(src))
    speaker=None; next_speaker=None; pages=[];groups=[];loc=[]
    for node in nodes:
        if not any(re.match(rf'if con == {v}(?: |$)',node.code) for v in command_states):continue
        for a in node.children:
            stmt=a.code
            m=re.match(r'c_speaker\s*\(\s*"([^"]+)"',stmt)
            if m:speaker=m[1].removesuffix("_noface").title();continue
            m=re.match(r'c_facenext\s*\(\s*"([^"]+)"',stmt)
            if m:
                next_speaker=m[1].removesuffix("_noface").title()
                continue
            if stmt.startswith(("c_msgsetloc ","c_msgnextloc ")):
                for t,i in messages(stmt.replace("c_msg","msg",1),c.lang):
                    effective=next_speaker or speaker
                    if next_speaker:speaker=next_speaker;next_speaker=None
                    pages.append({"text":t,"speaker":effective} if effective else {"text":t})
                    loc.append(i)
                continue
            if stmt.startswith(("c_talk_wait ","c_talk ")):
                if pages:groups.append({"op":"say","pages":pages});pages=[]
    if pages:groups.append({"op":"say","pages":pages})
    return groups,loc,src

def flower_castle_intro(c):
    k="room_dw_fcastle_entrance"
    controller="gml_Object_obj_ch5_DW19"
    meta=c.meta[k];room=c.outputs[k]
    goes=[i for i in meta["instances"] if i["name"]=="obj_trigger" and extflag(c,i)=="dw19"]
    if len(goes)!=1:return
    trigger=goes[0]
    box=c.shape(meta,trigger)
    layer=next(a for a in c.asset_layers[k] if a["layer"]=="CUTSCENE_ASSETS")
    locations=layer["sprites"]
    def point(name,color=None):
        return next(e for e in locations if e["sprite"]==name and (color is None or e["color"]==color))
    white=0xffffffff; red=0xff0000ff
    kr=point("spr_debug_krmarker")
    fl=point("spr_flowery_walk_downright",white)
    asg=point("spr_asgore_armor_walk_down",white)
    dest=point("spr_asgore_armor_walk_down",red)
    chars=[
        ("dw19_flowery","spr_flowery_condescend",fl),
        ("dw19_asgore","spr_asgore_armor_walk_down_lookleft",asg),
    ]
    for id,sp,spot in chars:
        asset=c.as_asset(sp,2)
        if not asset:return
        body=clamp_box(room,round(spot["x"]),round(spot["y"]),20,28)
        if body is None:return
        room["entities"].append({"id":id,"kind":"prop","name":id.split("_")[-1].title(),
                                 **body,"sprite":asset,"hidden":True})
    groups,keys,code=simple_cutscene(c,k,controller,[2])
    if not groups:return
    ops=[{"op":"camera","x":kr["x"],"y":kr["y"],"ticks":30},
         {"op":"move","actor":"player","x":kr["x"]+18,"y":kr["y"]+62,"ticks":28,"face":"left"}]
    for j,group in enumerate(groups):
        pages=group["pages"]
        sense=' '.join(p.get("speaker","") for p in pages)
        if j==1:
            ops.extend([{"op":"show","actor":"dw19_flowery","value":True},{"op":"wait","ticks":15}])
        if "Asgore" in sense and not any(v.get("actor")=="dw19_asgore" and v["op"]=="show" for v in ops):
            ops.extend([{"op":"show","actor":"dw19_asgore","value":True},
                        {"op":"move","actor":"dw19_asgore","x":dest["x"],"y":dest["y"],"ticks":60}])
        ops.append(group)
    ops.extend([{"op":"show","actor":"dw19_flowery","value":False},{"op":"show","actor":"dw19_asgore","value":False},
                {"op":"camera","follow":True}])
    add(c,k,{"id":"dw19_zone","kind":"zone",**box,"once":True,"auto":True,"draw":False,
             "activeWhen":{"flag":"gml_plot","compare":"lt","is":390}},
        ops,[trigger["pre"],controller+"_Create_0",code],"cutscene dialogue and staging",keys)
    c.issue(k,"cutscene uses simplified actor staging; native throw, layer swap and exact lip sync not ported",
            source=code)

def apply_authored(c):
    from ch5_platform import import_cliff_run, report_cliff_run
    key="room_dw_cliff_dash_runner"
    report_cliff_run(c.report[key],import_cliff_run(c.outputs,c.meta[key]),c.meta[key])
    readables_and_bed(c)
    water(c)
    flower_castle_intro(c)

