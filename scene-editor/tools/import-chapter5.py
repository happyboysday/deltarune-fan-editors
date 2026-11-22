"""Build the editable chapter 5 project from local Steam/UTMT facts and the V0.4 art library."""
import argparse, collections, hashlib, json, math, re, sys
from functools import cache
from pathlib import Path
from PIL import Image
from ch5_gml import UNKNOWN, combine, condition, flatten, messages, parse, scalar

ROOT=Path(__file__).resolve().parents[1]
EXPLICIT_EXCLUDE={
    "room_school_unusedroom":"unused room", "room_plat_lab":"platforming workbench",
    "room_legend":"legend playback", "room_legend_neo":"legend playback",
    "room_gameover":"result screen", "room_ed":"empty/system room", "room_empty":"empty/system room",
    "room_darkempty":"engine template", "room_darkbase_gms2":"engine template",
    "room_chapter_continue":"continue menu", "room_intro_ch5":"chapter opening movie",
    "room_dw_rhythm_empty":"rhythm engine template", "room_dw_rhythm_countdown":"rhythm countdown",
    "room_cc_lancer":"cutscene template", "room_cc_clover":"cutscene template", "room_cc_fountain":"cutscene template"
}
EXPERIMENT=re.compile(r'^(?:room_debug|room_gms_debug)|test(?:er|ing)?(?:_|$)|for_tiling|placeholder',re.I)
SOLID_RE=re.compile(r'^obj_(?:solidblock|solid_?dark|solid_?light|solid_diagonal|climbsolid|interactablesolid)')
HARD_SPECIAL=re.compile(r'^obj_(?:plat_game|plat_player|climb_kris|rhythmgame_event_manager|climb_controller|dw_.*battle|overworldbulletparent)')
FACES=("down","right","up","left")
RADIUS=5
ROOM_SRC="gml_Object_obj_mainchara_Create_0"
SAVE_SRC="gml_Object_obj_savepoint_Other_10"
READ_SRC="gml_Object_obj_readable_room1_Other_10"
DEBUG_ART=re.compile(r'^(?:spr_(?:marker|genmarker|trigger|doorAny|interactable|solidsmall|block_sized|soliddark|event$|musicer$|cam(?:era)?_clamp))',re.I)
MOVE=re.compile(r'\b(room_goto\w*)\s*\(\s*(.*?)\s*\)$')
ASSIGN=re.compile(r'^(?:var\s+)?(.+?)\s*=\s*(.+)$')

def read(p):return json.loads(p.read_bytes())
def dump(p,value,pretty=False):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(value,ensure_ascii=False,indent=2 if pretty else None,separators=None if pretty else (",",":"))+"\n","utf8",newline="\n")

def clip(v,lo,hi):return max(lo,min(hi,v))
def rnd(v):return round(v,3)
def unique(values):return list(dict.fromkeys(values))

def code_ctx(r,i=None):
    i=i or {}
    return {"room":r["id"],"x":i.get("x",0),"y":i.get("y",0),
            "global . chapter":5,"global . darkzone":int(r["dark"]),"image_index":i.get("frame",0),
            "true":True,"false":False}

def marker_index(s):
    if isinstance(s,str) and re.fullmatch("[a-zA-Z]",s):return ord(s.upper())-64
    if type(s) is int or isinstance(s,float) and s.is_integer():
        return int(s)
    return None

class Compiler:
    def __init__(self,args):
        self.args=args
        self.facts=read(args.facts/"facts.json")
        self.gml=args.facts/"gml"
        self.frames=args.facts/"frames"
        self.visual=read(args.facts/"visual-facts.json")
        self.asset_layers=read(args.facts/"asset-layers.json")
        self.assetsdir=args.base/"management/assets/official"
        self.basedir=args.base/"management/agents/A-assets/exports/v8/chapters/ch5/rooms"
        self.bundle=args.out
        self.lang=read(args.game/"lang/lang_en.json")
        self.instances={r["name"]:r["inst"] for r in read(self.assetsdir/"maps/ch5/rooms_instances.json")["rooms"]}
        self.meta={r["id"]:r for r in self.facts["rooms"]}
        self.order=list(self.meta)
        self.objects=self.facts["objects"]
        self.report={}
        self.outputs={}
        self.events={}
        self.assets={}
        self.links={}
        self.repaired=[]
        self.inferred=[]
        self.pose_refs={}
        self.categorized={}
        for r in self.meta.values():
            k=r["id"]
            r["dark"]=k.startswith("room_dw_") or k.startswith("room_castle_") or any(i["name"]=="obj_darkcontroller" for i in r["instances"])
            reason=None
            if not k.startswith("room_"):reason="engine state"
            elif k.lower() in EXPLICIT_EXCLUDE:reason=EXPLICIT_EXCLUDE[k.lower()]
            elif EXPERIMENT.search(k):reason="debug or authoring template"
            elif r["w"]<64 or r["h"]<64:reason="nonstandard internal room"
            mapped=self.path(k).is_file()
            self.report[k]={"excluded":reason,"layout":mapped,"instances":len(r["instances"]),"walls":0,"doors":0,
                            "saves":0,"dialogue":0,"custom":0,"issues":[],"references":[]}
            if not reason and not mapped:self.issue(k,"no legacy drawable map")
            if not reason:
                self.categorized[k]="Flower Castle" if k.startswith("room_dw_fcastle_") else "Garden" if k.startswith("room_dw_garden_") else "Cliffs" if k.startswith("room_dw_cliff_") else "Castle Town" if r["dark"] else "Hometown"
    def path(self,k):
        return self.basedir/(k+".director-map.json")
    @cache
    def source(self,key):
        if not key:return ""
        p=self.gml/(key+".gml")
        return p.read_text("utf8") if p.is_file() else ""
    @cache
    def lineage(self,k):
        return (k,*self.lineage(self.objects[k]["parent"])) if k in self.objects and self.objects[k]["parent"] else (k,)
    def event_code(self,obj,event):
        for k in self.lineage(obj):
            name=f"gml_Object_{k}_{event}"
            text=self.source(name)
            if text:return name,text
        return "", ""
    def issue(self,room,message,**info):
        self.report[room]["issues"].append({"issue":message,**info})
    def reference(self,room,kind,source,**info):
        self.report[room]["references"].append({"kind":kind,"source":source,**info})
    def named(self,k):
        return k.removeprefix("room_").removeprefix("dw_").replace("fcastle_", "flower_castle_").replace("_"," ").title()
    def entries(self,r,entities):
        entries={}
        k=r["id"]
        markers=[i for i in r["instances"] if i["name"].startswith(("obj_mainchara","obj_plat_player","obj_climb_kris"))]
        fallback=not markers
        if fallback:
            m=next((i for i in r["instances"] if re.match(r'^obj_(?:marker[A-Za-z]|climb_marker)',i["name"])),None)
            markers=[m] if m else []
        if not markers:
            markers=[{"x":r["w"]/2,"y":r["h"]/2,"frame":0,"name":"preview_center"}]
        def set_entry(e,i):
            x,y=self.safe_point(r,i["x"],i["y"],entities,top_left=i["name"]!="preview_center")
            if x is None:
                self.issue(k,"entry has no reachable collision-free point",entry=e,id=i.get("id"))
                return
            entries[e]={"x":rnd(x),"y":rnd(y),"face":"down"}
            ref=i.get("id")
            if ref is not None:self.reference(k,"entry",ROOM_SRC,instance=ref,entry=e)
        set_entry("arrival",markers[0])
        ordered=sorted(r["instances"],key=lambda i: 0 if re.fullmatch(r"obj_marker[a-z]",i["name"],re.I) else 1)
        for i in ordered:
            name=i["name"]
            match=re.fullmatch(r"obj_marker([a-z])",name,re.I)
            n=marker_index(match[1] if match else i["frame"]) if match or name in ("obj_markerAny","obj_markerAny40px","obj_climb_marker") else None
            if n is None or n<0:continue
            e=f"entry_{n}"
            if e not in entries:set_entry(e,i)
        if not entries:
            return {}
        if "arrival" not in entries:entries["arrival"]=next(iter(entries.values())).copy()
        return entries
    def safe_point(self,r,x,y,entities,top_left=False):
        if top_left:
            # Entry markers relocate Kris's sprite origin. Convert it to a floor contact.
            x+=19 if r["dark"] else 10
            y+=62 if r["dark"] else 32
        x=clip(x,RADIUS,r["w"]-RADIUS)
        y=clip(y,RADIUS,r["h"]-RADIUS)
        def free(a,b):
            return not any(a+RADIUS>e["x"] and a-RADIUS<e["x"]+e["w"] and b+RADIUS>e["y"] and b-RADIUS<e["y"]+e["h"] for e in entities if e["kind"]=="wall" or e.get("solid"))
        if free(x,y):return x,y
        for radius in range(4,161,4):
            for degrees in (270,90,0,180,225,315,45,135):
                a=clip(x+math.cos(math.radians(degrees))*radius,RADIUS,r["w"]-RADIUS)
                b=clip(y+math.sin(math.radians(degrees))*radius,RADIUS,r["h"]-RADIUS)
                if free(a,b):
                    self.repaired.append([r["id"],rnd(x),rnd(y),rnd(a),rnd(b)])
                    return a,b
        return None,None
    def shape(self,r,i,min_size=1):
        typ=self.objects[i["name"]]
        m=typ["mask"] or typ["sprite"]
        if not m:return None
        ox,oy=m["ox"],m["oy"]
        c=math.cos(math.radians(i["rotation"]));s=math.sin(math.radians(i["rotation"]))
        xy=[(i["x"]+c*x+s*y,i["y"]-s*x+c*y)
            for X in (m["l"],m["r"]+1) for Y in (m["t"],m["b"]+1)
            for x,y in [((X-ox)*i["sx"],(Y-oy)*i["sy"])]]
        a=clip(math.floor(min(x for x,_ in xy)),0,r["w"]);b=clip(math.ceil(max(x for x,_ in xy)),0,r["w"])
        c=clip(math.floor(min(y for _,y in xy)),0,r["h"]);d=clip(math.ceil(max(y for _,y in xy)),0,r["h"])
        box={"x":rnd(a),"y":rnd(c),"w":rnd(b-a),"h":rnd(d-c)}
        if min(box["w"],box["h"])<min_size:return None
        return box
    def wall(self,r,i):
        k=i["name"]
        chain=self.lineage(k)
        if not any(SOLID_RE.match(x) for x in chain):return None
        if k.lower().startswith("obj_solidblocklight") and r["dark"]:return None
        if k.lower().startswith("obj_solidblockdark") and not r["dark"]:return None
        box=self.shape(r,i)
        if not box:return None
        if i["rotation"]%90 or "diagonal" in k:
            self.issue(r["id"],"rotated or diagonal mask uses bounding rectangle",instance=i["id"],object=k)
        return {"id":f"w{i['id']}","kind":"wall",**box,"draw":False}
    def as_asset(self,sprite,scale):
        key=f"ch5a_{sprite}_{scale}"
        if key in self.assets:return key
        src=self.assetsdir/"sprites/ch5/all_sprites"/(sprite+".png")
        if not src.is_file():return None
        name=key+".png"
        file=ROOT/"studio/art/chapter5"/name
        file.parent.mkdir(parents=True,exist_ok=True)
        with Image.open(src) as im:
            im=im.convert("RGBA")
            if scale!=1:im=im.resize((im.width*scale,im.height*scale),Image.Resampling.NEAREST)
            im.save(file)
        self.assets[key]={"src":"/studio/art/chapter5/"+name,"anchor":"feet"}
        return key
    @cache
    def frame_arts(self,sprite,scale):
        files=sorted((self.frames/sprite).glob("*.png"))
        if not files:
            asset=self.as_asset(sprite,scale)
            return [self.assets[asset]["src"]] if asset else []
        urls=[]
        target=ROOT/"studio/art/chapter5"
        target.mkdir(parents=True,exist_ok=True)
        for file in files:
            name=f"{sprite}_{scale}_{file.name}"
            out=target/name
            with Image.open(file) as image:
                im=image.convert("RGBA")
                if scale!=1:
                    im=im.resize((im.width*scale,im.height*scale),Image.Resampling.NEAREST)
                im.save(out)
            urls.append("/studio/art/chapter5/"+name)
        return urls
    def art(self,dark,person="kris"):
        key=person+("_dark" if dark else "_light")
        if key in self.assets:return key
        cfg={"anchor":"feet","ticks":5}
        for face,letter in {"down":"d","up":"u","right":"r","left":"l"}.items():
            sprite="spr_ralsei_walk_"+face if person=="ralsei" else "spr_"+person+letter+("_dark" if dark else "")
            frames=self.frame_arts(sprite,2 if dark else 1)
            if frames:
                cfg["idle_"+face]=frames[0]
                cfg["walk_"+face]=frames
        if not cfg.get("idle_down"):
            raise ValueError(f"Player animation missing: {key}")
        self.assets[key]=cfg
        return key
    def static_layout(self,r,layout):
        k=r["id"]
        art_by_pose=collections.defaultdict(list)
        for i in r["instances"]:
            a=self.objects[i["name"]]["sprite"]
            if a:art_by_pose[(a["name"],round(i["x"],2),round(i["y"],2))].append(i)
        raw=self.instances.get(k,[])
        layers=self.visual["rooms"][k]["layers"]
        by_depth=collections.defaultdict(list)
        for l in layers:by_depth[l["depth"]].append(l)
        off=set()
        controllers=[i["name"] for i in r["instances"] if i["name"].startswith(("obj_dw_","obj_room_"))]
        for obj in controllers:
            _,gml=self.event_code(obj,"Create_0")
            for guard,node,safe in flatten(parse(gml),code_ctx(r),ignore_unknown=True):
                if guard is not True or not safe:continue
                m=re.match(r'(?:turnofflayers\s*\(\s*"([^"]+)"\s*\)|layer_set_visible\s*\(\s*"([^"]+)"\s*,\s*(?:false|0)\s*\))$',node.code)
                if m:off.add((m[1] or m[2]).casefold())
        def runtime_visible(name,visible):
            return bool(visible) and name.casefold() not in off and not name.casefold().startswith("debug")
        def front(name):
            return bool(re.search(r'(?:^|_)for(?:e(?:ground)?|nt)(?:_|$)|(?:^|_)front(?:_|$)',name,re.I))
        look={"bg":"Background","instances":"Instances","tiles":"Tiles"}
        for l in layout["layers"]:
            kind=look.get(l["kind"])
            matching=[q for q in by_depth[l["depth"]] if q["type"]==kind]
            if len(matching)==1:
                lm=matching[0]
                l["name"]=lm["name"]
                l["visible"]=runtime_visible(lm["name"],lm["visible"])
                if front(lm["name"]):l["kind"]="foreground"
        for row in self.asset_layers[k]:
            label=row["layer"]
            lid=f"official_asset:{row['id']}"
            layer={"id":lid,"kind":"foreground" if front(label) else "sprites","depth":row["depth"],
                   "name":label,"visible":runtime_visible(label,row["visible"])}
            layout["layers"].append(layer)
            for index,e in enumerate(row["sprites"]):
                if not e["sprite"] or e["x"] is None or e["y"] is None:continue
                el={"id":f"{lid}:{index}","kind":"sprite","asset":"ch5:"+e["sprite"],
                    "layer":lid,"x":e["x"]+(row["x"] or 0),"y":e["y"]+(row["y"] or 0),
                    "scale_x":e["sx"] if e["sx"] is not None else 1,"scale_y":e["sy"] if e["sy"] is not None else 1,
                    "rotation":e["angle"] or 0,"frame":int(e["frame"] or 0),"visible":not DEBUG_ART.match(e["sprite"]),
                    "source_ref":f"GameMaker layer {label} sprite {e['name']}"}
                if isinstance(e["color"],int):
                    el["alpha"]=(e["color"]>>24&255)/255
                layout["elements"].append(el)
        for e in layout["elements"]:
            if not e["id"].startswith("instance:"):continue
            sprite=e["asset"].rsplit(":",1)[-1]
            hits=art_by_pose.get((sprite,round(e["x"],2),round(e["y"],2)),[])
            if hits and all(not self.objects[i["name"]]["visible"] or i["name"]=="obj_mainchara" for i in hits):
                e["visible"]=False
            elif DEBUG_ART.match(sprite):
                e["visible"]=False
            else:
                match=re.search(r'/inst/(\d+)$',e.get("source_ref",""))
                if match and int(match[1])<len(raw):
                    row=raw[int(match[1])]
                    if row["s"]==sprite and round(row["x"],2)==round(e["x"],2) and round(row["y"],2)==round(e["y"],2):
                        e["frame"]=row.get("i",0)
        local_direct={"spr_pxwhite","spr_whitepx","spr_whitepixel","spr_zenpond_watermove","spr_dw_dappled_light_overlay"}
        for e in layout["elements"]:
            sprite=e["asset"].rsplit(":",1)[-1]
            if sprite not in local_direct:continue
            frames=self.frame_arts(sprite,1)
            info=self.visual["sizes"].get(sprite)
            if frames and info:
                e.update(url=frames[int(e.get("frame",0))%len(frames)],
                         width=info["w"],height=info["h"],origin_x=info["ox"],origin_y=info["oy"])
        return layout
    def make_rooms(self):
        for r in self.meta.values():
            k=r["id"]; rep=self.report[k]
            if rep["excluded"] or not rep["layout"]:continue
            layout=self.static_layout(r,read(self.path(k)))
            entities=[wall for i in r["instances"] if (wall:=self.wall(r,i))]
            entries=self.entries(r,entities)
            if not entries:continue
            bg=layout.get("background_color") or 0
            room={"title":self.named(k),"w":r["w"],"h":r["h"],
                  "style":"flat","color":"#"+"".join(f"{(bg>>shift)&255:02x}" for shift in (0,8,16)),
                  "entries":entries,"entities":entities,"official":{"chapter":"ch5","room":k},
                  "layout":k,"playerArt":self.art(r["dark"]),"playerFeetOffset":10 if r["dark"] else 5,"sourceHud":True}
            vr=self.visual["rooms"][k]
            view=next((v for v in vr["views"] if v["enabled"] and 64<=v["w"]<=1600 and 64<=v["h"]<=1200),None)
            if view:room["view"]={"w":view["w"],"h":view["h"]}
            if r["dark"] and any(i["name"]=="obj_darkcontroller" for i in r["instances"]):
                room["followers"]=[{"sprite":self.art(True,"susie"),"delay":7,"when":{"flag":"gml_party_susie","is":True}}]
                room["followers"].append({"sprite":self.art(True,"ralsei"),"delay":14,"when":{"flag":"gml_party_ralsei","is":True}})
            self.report[k]["layers"]=len(layout["layers"])
            self.report[k]["artInstances"]=sum(1 for e in layout["elements"] if e["id"].startswith("official_asset"))
            self.report[k]["walls"]=len(entities)
            if any(HARD_SPECIAL.match(i["name"]) for i in r["instances"]):
                self.issue(k,"platforming, complex climbing, or battle simulation not inferred from room layout")
            self.outputs[k]=room
            dump(self.bundle/"layouts"/(k+".json"),layout)
    def next_room(self, key, expr):
        if expr in self.meta:return expr
        norm=re.sub(r'\s+','',expr)
        if norm=="room":return key
        offs={"ROOM_INITIALIZE":1,"room_battletest":2,"room_cutscene_tester":3}
        if m:=re.fullmatch(r'room([+-])(\w+)',norm):
            delta=offs.get(m[2])
            return self.shift_room(key,(-1 if m[1]=="-" else 1)*delta) if delta else None
        if m:=re.fullmatch(r'room_(next|previous)\((.*)\)',norm):
            prior=self.next_room(key,m[2])
            return self.shift_room(prior,1 if m[1]=="next" else -1) if prior else None
        return None
    def shift_room(self, key, delta):
        i=self.order.index(key)+delta
        return self.order[i] if 0<=i<len(self.order) else None
    def door_source(self,r,i):
        name=i["name"]; k=r["id"]
        if not name.startswith("obj_door"):return None
        ctx=code_ctx(r,i)
        raw=[]
        if name.startswith("obj_doorAny"):
            raw.append("gml_Object_obj_doorparent_PreCreate_0")
            raw.append("gml_Object_obj_doorAny_PreCreate_0")
        else:
            initial,_=self.event_code(name,"Alarm_2")
            if initial:raw.append(initial)
        raw.extend(filter(None,(i["pre"],i["init"])))
        dest=None;entrance=-1;preset=-1;fade=8;face=None;has_controller=False
        for key in raw:
            s=self.source(key)
            ast=parse(s)
            for guard,node,safe in flatten(ast,ctx):
                stmt=node.code
                if not safe or guard is not True:
                    if re.search(r'\b(?:doorRoom|doorEntrance|room_goto)\b',stmt+" "+" ".join(ch.code for ch in node.children)):
                        has_controller=True
                    continue
                if m:=ASSIGN.fullmatch(stmt):
                    prop=m[1];value=scalar(m[2],ctx)
                    if prop=="doorRoom":
                        dest=self.next_room(k,m[2]);has_controller|=dest is None
                    if prop in ("doorEntrance","global . entrance"):
                        v=marker_index(value)
                        if v is not None:entrance=v
                        else:has_controller=True
                    if prop=="doorPreset" and isinstance(value,int):preset=value
                    if prop=="doorDelay" and isinstance(value,int) and value>0:fade=value
                    if prop=="doorFacing" and isinstance(value,int) and 0<=value<4:face=FACES[value]
                    if prop=="doorSpecial" and value not in (UNKNOWN,"none"):has_controller=True
                if m:=MOVE.fullmatch(stmt):
                    if m[1]=="room_goto_next":dest=self.shift_room(k,1)
                    elif m[1]=="room_goto_previous":dest=self.shift_room(k,-1)
                    elif m[1]=="room_goto":dest=self.next_room(k,m[2])
        if name.startswith("obj_doorAny") and i["frame"] in (1,2,3,4,5,6):
            n=int(i["frame"])
            dest=self.shift_room(k,((n+1)//2)*(1 if n%2 else -1));entrance=n
            raw.append("gml_Object_obj_doorAny_Step_0")
        if has_controller:
            self.issue(k,"door destination depends on unsupported code",instance=i["id"],object=name,source=raw)
            return None
        if not dest:
            self.issue(k,"door destination unavailable",instance=i["id"],object=name,source=raw)
            return None
        if preset in (1,2):fade={1:14,2:16}[preset]
        self.links[i["id"]]=(k,dest,entrance)
        return dest,entrance,fade,face,raw
    def add_link(self,r,i,spec):
        k=r["id"]
        dest,n,fade,face,sources=spec
        if dest not in self.outputs:
            self.issue(k,"linked room is outside playable import",instance=i["id"],target=dest,source=sources)
            return
        entry=f"entry_{n}" if n>0 else "arrival"
        if entry not in self.outputs[dest]["entries"]:
            self.issue(k,"target marker unavailable",instance=i["id"],target=dest,marker=n,source=sources)
            return
        box=self.shape(r,i)
        if not box:
            self.issue(k,"door mask falls outside room",instance=i["id"],target=dest)
            return
        target=self.outputs[dest]
        if face:
            faced=entry+"_"+face
            target["entries"].setdefault(faced,{**target["entries"][entry],"face":face})
            entry=faced
        self.outputs[k]["entities"].append({"id":f"g{i['id']}","kind":"door",**box,
             "name":self.named(dest),"room":dest,"entry":entry,"draw":False,"auto":True,"fade":clip(fade,0,120)})
        self.report[k]["doors"]+=1
        self.reference(k,"door",sources,instance=i["id"],target=dest,entry=entry)
    def glimpse(self,text,ctx):
        # Read the simple localized message operations in source order. Retain
        # mapped flag guards when the handler has real branches.
        leaf=[]
        for guard,node,safe in flatten(parse(text),ctx):
            if not safe:continue
            if not re.search(r'\b(?:global\s*\.\s*msg|msgsetloc|msgnextloc|mytext|msgset)',node.code):continue
            pages=messages(node.code,self.lang)
            if not pages:continue
            reset=bool(re.search(r'(?:msgsetloc\s*\(\s*0\s*,|global \. msg \[ 0 \])',node.code))
            if reset and guard is True:
                leaf=[]
            leaf.extend((guard,p,key) for p,key in pages)
        chunks=[]
        for c,p,k in leaf:
            if chunks and c==chunks[-1][0]:
                chunks[-1][1].append(p);chunks[-1][2].append(k)
            else:chunks.append((c,[p],[k]))
        out=[];keys=[]
        for c,pa,ids in chunks:
            node={"op":"say","pages":pa[:128]}
            out.append(node if c is True else {"op":"branch","if":c,"then":[node]})
            keys.extend(ids)
        return out,unique(keys)
    def add_saves_and_dialogue(self,r):
        k=r["id"]; rep=self.report[k]; room=self.outputs[k]
        ctx=code_ctx(r)
        for i in r["instances"]:
            typ=i["name"]
            if typ=="obj_savepoint":
                box=self.shape(r,i)
                if not box:continue
                # Official save gives menu and heals; the editor retains its
                # own stable save-file format and lets players navigate it.
                key=f"save_{i['id']}"
                actions,loc=self.glimpse(self.source(SAVE_SRC),ctx)
                p={"id":f"g{i['id']}","kind":"savepoint",**box,"name":room["title"],"draw":False}
                x=i["x"]+box["w"]/2;y=i["y"]+box["h"]+10
                x,y=self.safe_point(r,x,y,room["entities"])
                if x is not None:
                    room["entries"][key]={"x":rnd(x),"y":rnd(y)}
                    p["entry"]=key
                if actions:
                    self.events[key]=actions;p["beforeEvent"]=key
                room["entities"].append(p)
                rep["saves"]+=1
                self.reference(k,"savepoint",SAVE_SRC,instance=i["id"],localized=loc)
                continue
            chain=self.lineage(typ)
            if not any(v.startswith("obj_interactable") for v in chain):continue
            source,body=self.event_code(typ,"Other_10")
            if not body or source==SAVE_SRC:continue
            # Generic scripts need explicit scene selection or a known local
            # extflag, rather than repurposing their debug/default page.
            init="\n".join(map(self.source,(i["pre"],i["init"])))
            c=code_ctx(r,i)
            if m:=re.search(r'\bextflag\s*=\s*("(?:\\.|[^"\\])*"|-?\d+)\s*;',init):
                c["extflag"]=scalar(m[1],c)
            if source==READ_SRC and k not in body:continue
            acts,loc=self.glimpse(body,c)
            if not acts:continue
            box=self.shape(r,i)
            if not box:continue
            key=f"talk_{i['id']}"
            self.events[key]=acts
            room["entities"].append({"id":f"g{i['id']}","kind":"npc",**box,
                "name":typ.removeprefix("obj_").replace("_"," ").title(),"draw":False,"event":key})
            rep["dialogue"]+=1
            self.reference(k,"dialogue extract",unique([source,*filter(None,(i["pre"],i["init"]))]),instance=i["id"],localized=loc)
    def source_index(self):
        # Keep the original room/script IDs available after the temporary
        # decompilation is recycled.  No executable GML is included.
        by_name=collections.defaultdict(list)
        for n in self.facts["names"]:
            if not n.startswith("gml_Object_"):continue
            if m:=re.match(r"gml_Object_(.+)_(Create|PreCreate|Step|Alarm|Other|Collision|Draw)_(.+)$",n):
                by_name[m[1]].append(n)
        audit={}
        for k,r in self.meta.items():
            refs=self.report[k]["references"]
            seen=collections.defaultdict(list)
            for ref in refs:
                instance=ref.get("instance")
                if instance is None:continue
                m=re.search(r"(?:^|[A-Za-z_])(\d{5,})$",str(instance))
                if m:seen[int(m[1])].append(ref["kind"])
            entries=[]
            for i in r["instances"]:
                source_class=i["name"]
                chain=self.lineage(source_class)
                relevant=(i["init"] or i["pre"] or i["id"] in seen or any(
                    x.startswith(("obj_door","obj_trigger","obj_interactable","obj_savepoint","obj_plat_game","obj_climb_","obj_npc","obj_waterable","obj_enemy")) for x in chain))
                if not relevant:continue
                entries.append({"id":i["id"],"object":source_class,"x":i["x"],"y":i["y"],"creation":i["init"],"preCreation":i["pre"],
                    "events":unique(n for x in chain for n in by_name[x] if "_Draw_" not in n or x==source_class),
                    "ported":unique(seen[i["id"]])})
            audit[k]={"creation":r["creation"],"registered":entries}
        return audit
    def apply(self):
        self.make_rooms()
        for k in self.outputs:
            r=self.meta[k]
            for i in r["instances"]:
                spec=self.door_source(r,i)
                if spec:self.add_link(r,i,spec)
            self.add_saves_and_dialogue(r)
        from ch5_authored import apply_authored
        apply_authored(self)
        p={"format":"deltarune-scene/1","id":"chapter5-recreation",
           "title":"DELTARUNE 第 5 章 · 场景复刻","viewport":{"w":640,"h":480},"player":{"radius":RADIUS,"speed":4},
           "rooms":self.outputs,"events":self.events,"assets":self.assets,
           "start":{"room":"room_krisroom","entry":"arrival"},"flags":{"gml_plot":5,"gml_ch5_completed":True,"gml_party_ralsei":False,"gml_party_susie":True},
           "campaign":{"saveKey":"chapter5-recreation","party":{"kris":{"maxHp":160,"name":"Kris"},"susie":{"maxHp":200,"name":"Susie"},"ralsei":{"maxHp":140,"name":"Ralsei"}}}}
        dump(self.bundle/"chapter5.scene.json",p,True)
        incl=[k for k,v in self.report.items() if not v["excluded"]]
        mapped=set(self.outputs)
        playable={k for k in mapped if any(self.report[k][i] for i in ("doors","saves","dialogue","custom"))}
        counts={"archive":len(self.report),"inScope":len(incl),"imported":len(mapped),"withExecutableBehavior":len(playable)}
        for typ in ("doors","saves","dialogue","custom","walls"):
            counts[typ]=sum(self.report[k][typ] for k in mapped)
        dump(self.bundle/"coverage.json",{"sourceSha256":hashlib.file_digest((self.args.game/"data.win").open("rb"),"sha256").hexdigest(),
             "counts":counts,"rooms":self.report,"nudgedEntries":self.repaired,
             "categories":self.categorized,"notes":{"door":"game room destination and target marker; supported static conditions only","dialogue":"localized pages; unsupported control-flow omitted and accounted in documentation"}},True)
        dump(self.bundle/"source-index.json",{"format":"ch5-source-index/1","rooms":self.source_index()})
        print(counts)
        print("coverage by region:", dict(collections.Counter(self.categorized[k] for k in playable)))

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--base",type=Path,required=True,help="V0.4 directory")
    p.add_argument("--game",type=Path,required=True,help="Steam chapter5_windows directory")
    p.add_argument("--facts",type=Path,required=True,help="UTMT facts and local GML directory")
    p.add_argument("--out",type=Path,default=ROOT/"chapter5")
    Compiler(p.parse_args()).apply()

if __name__=="__main__":main()
