"""Walk through GameMaker rooms using observed collision masks and ordinary key input."""
from __future__ import annotations
from collections import deque
from pathlib import Path
import hashlib, heapq, json, math, os, re, tempfile, threading, time, uuid, zipfile
from tools.ch5_gml import parse, flatten

ROOT = Path(__file__).resolve().parent
TOOL = ROOT / "tools"


def companion(chapter):
    """Keep the audited chapter build intact; derive a separate observable runner."""
    from chapter_host import utmt
    base = chapter.stage / "data.win"
    sources = ("chapter-navigator.csx", "chapter-nav-observe.gml", "chapter-observe.gml")
    with base.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256")
    checksum.update(b"".join((TOOL/p).read_bytes() for p in sources))
    key = checksum.hexdigest()
    dest = chapter.stage/"director-navigation.win"
    stamp = chapter.stage.parent/"navigation-build.txt"
    if dest.is_file() and stamp.is_file() and stamp.read_text().strip()==key:
        return dest
    with tempfile.TemporaryDirectory(dir=chapter.workspace) as tmp:
        out=Path(tmp)/"navigation.win"
        utmt(base,"chapter-navigator.csx",Path(tmp),out)
        out.replace(dest)
        mark=Path(tmp)/"revision"
        mark.write_text(key,encoding="ascii")
        mark.replace(stamp)
    return dest


def resolve_expr(expr, pos, names):
    expr=re.sub(r"\s+","",expr)
    if expr in names: return expr
    if expr=="room": return names[pos]
    m=re.fullmatch(r"room_(next|previous)\((.*)\)",expr)
    if m:
        prev=resolve_expr(m[2],pos,names)
        if prev in names:
            i=names.index(prev)+(1 if m[1]=="next" else -1)
            if 0<=i<len(names): return names[i]
    m=re.fullmatch(r"room([+-])(ROOM_INITIALIZE|room_battletest|room_cutscene_tester|\d+)",expr)
    if m:
        d={"ROOM_INITIALIZE":1,"room_battletest":2,"room_cutscene_tester":3}.get(m[2],int(m[2]) if m[2].isdigit() else 0)
        i=pos+(d if m[1]=="+" else -d)
        if 0<=i<len(names): return names[i]


def make_graph(chapter,edits=None):
    index=chapter.index
    rooms=index["rooms"]; names=[r["id"] for r in rooms]; objects=index["objects"]
    if edits is None:edits=chapter.edits()
    out={r:[] for r in names}
    with zipfile.ZipFile(chapter.home/"scripts.zip") as archive:
        def code(key):
            if key in edits["scripts"]:return edits["scripts"][key]
            return archive.read(key+".gml").decode("utf8")
        def alarm(obj):
            while obj:
                events=objects[obj]["events"]
                for e in events:
                    if e.endswith("_Alarm_2"): return e
                obj=objects[obj]["parent"]
        for pos,r in enumerate(rooms):
            name=r["id"]
            for slot,inst in enumerate(r["instances"]):
                obj=inst["obj"]
                if not obj.startswith("obj_door") and obj!="obj_darkdoor": continue
                xy=edits["instances"].get(name+"/"+str(slot),inst)
                ctx={"room":name,"x":xy["x"],"y":xy["y"],"global . chapter":chapter.number}
                anydoor=obj.startswith("obj_doorAny")
                target=names[pos+1] if anydoor and pos+1<len(names) else None
                entry=1 if anydoor else 0
                for script in filter(None,(None if anydoor else alarm(obj),inst["pre"],inst["init"])):
                    for guard,node,safe in flatten(parse(code(script)),ctx):
                        if guard is not True or not safe: continue
                        word=node.code
                        if match:=re.fullmatch(r'(?:doorEntrance|global \. entrance) = (\d+|"[a-zA-Z]")',word):
                            val=match[1]
                            entry=int(val) if val.isdigit() else ord(val[1].upper())-64
                        if word.startswith("doorRoom = "): target=resolve_expr(word[11:],pos,names)
                        elif re.fullmatch(r"room_goto_(?:next|previous)\s*\(\s*\)",word):
                            target=resolve_expr("room_"+("next" if "_next" in word else "previous")+"(room)",pos,names)
                        elif m:=re.fullmatch(r"room_goto\s*\((.*)\)",word):
                            target=resolve_expr(m[1],pos,names)
                if obj=="obj_darkdoor" and name=="room_schooldoor": target="room_dw_castle_area_1"
                out[name].append(dict(obj=obj,x=xy["x"],y=xy["y"],to=target,entry=entry,act=obj=="obj_darkdoor"))
    return out


def match_exits(room, live, graph):
    """Actual bounds/destinations supersede authored instance coordinates."""
    candidates=graph.get(room,[]); exits=[]
    for obj,x,y,l,t,r,b,dest in live:
        same=[e for e in candidates if e["obj"]==obj]
        src=min(same,key=lambda e:abs(x-e["x"])+abs(y-e["y"])) if same else {}
        # Several door classes inherit a default doorRoom which their Alarm never uses.
        target=dest if obj.startswith("obj_doorAny") and dest else src.get("to")
        if not target or target==room:continue
        exits.append(dict(to=target,box=(l,t,r,b),act=src.get("act",False),key=(room,obj,round(x),round(y)),x=x,y=y))
    return exits


def room_route(start, goals, graph, live, banned, seen=None):
    """BFS through rooms; only existing, unblocked exits may leave the current room."""
    first=[e for e in live if e["key"] not in banned]
    q=deque([(start,[])]); done={start}; targets=set(goals)
    while q:
        room,path=q.popleft()
        if path and (room in targets if seen is None else room not in seen):return path
        steps=([e["to"] for e in first] if room==start else
               [e["to"] for e in graph.get(room,[]) if (room,e["obj"],round(e["x"]),round(e["y"])) not in banned])
        for dest in steps:
            if dest and dest not in done:
                done.add(dest);q.append((dest,path+[dest]))
    return []


def astar(grid,p,door,omit=(),others=()):
    """Path of foot centres, sampled with the player's own live collision mask."""
    rows=grid["rows"]; step=grid["cell"]; w=len(rows[0]); h=len(rows)
    x,y,hw,hh=p; l,t,r,b=door["box"]
    allow=set(); banned=set(omit)
    # The entrance behind Kris is often only one step from the arrival marker.
    # Other triggers are hazards, even when their floors are physically walkable.
    for other in others:
        if other["key"]==door["key"] or other["to"]==door["to"]:continue
        a,b0,c,d=other["box"]
        for xx in range(max(0,math.ceil((a-hw-4)/step)),min(w,math.floor((c+hw+4)/step)+1)):
            for yy in range(max(0,math.ceil((b0-hh-4)/step)),min(h,math.floor((d+hh+4)/step)+1)):
                banned.add((xx,yy))
    def around(value,limit):return max(0,min(limit-1,round(value/step)))
    def clear(q):return 0<=q[0]<w and 0<=q[1]<h and rows[q[1]][q[0]]=="." and q not in banned
    sx,sy=around(x,w),around(y,h)
    near=[(xx,yy) for xx in range(sx-2,sx+3) for yy in range(sy-2,sy+3) if clear((xx,yy))]
    if not near:return None
    initial=min(near,key=lambda q:(q[0]*step-x)**2+(q[1]*step-y)**2)
    # Intersect the trigger, or stand facing it for an interactable/edge door.
    pad=12 if door["act"] else 0
    for yy in range(max(0,around(t-hh-pad,h)-2),min(h,around(b+hh+pad,h)+3)):
        for xx in range(max(0,around(l-hw-pad,w)-2),min(w,around(r+hw+pad,w)+3)):
            if clear((xx,yy)) and l-hw-pad<=xx*step<=r+hw+pad and t-hh-pad<=yy*step<=b+hh+pad:allow.add((xx,yy))
    if not allow:
        # Off-room triggers (or collision barriers) need a reachable approach cell.
        cx=around((l+r)/2,w);cy=around((t+b)/2,h)
        edge=[(xx,yy) for xx in range(cx-5,cx+6) for yy in range(cy-5,cy+6) if clear((xx,yy))]
        if not edge:return None
        def gap(q):
            xx,yy=q[0]*step,q[1]*step
            return max(l-hw-xx,0,xx-r-hw)+max(t-hh-yy,0,yy-b-hh)
        best=min(map(gap,edge)); allow={q for q in edge if gap(q)<=best+step/2}
    xmin=min(q[0] for q in allow);xmax=max(q[0] for q in allow);ymin=min(q[1] for q in allow);ymax=max(q[1] for q in allow)
    def heuristic(q):return max(xmin-q[0],0,q[0]-xmax)+max(ymin-q[1],0,q[1]-ymax)
    front=[(heuristic(initial),0,initial)]; prev={initial:None};cost={initial:0}
    while front:
        _,g,q=heapq.heappop(front)
        if g!=cost[q]:continue
        if q in allow:
            path=[]
            while q is not None:path.append((q[0]*step,q[1]*step));q=prev[q]
            return path[::-1]
        for dx,dy in ((0,1),(1,0),(0,-1),(-1,0)):
            n=(q[0]+dx,q[1]+dy); ng=g+1
            if clear(n) and ng<cost.get(n,1<<30):
                cost[n]=ng;prev[n]=q;heapq.heappush(front,(ng+heuristic(n),ng,n))
    # A thin doorway may only overlap the character between two sampled cells.
    # Approach it from THIS reachable component, then take ordinary small steps.
    def separation(q):
        xx,yy=q[0]*step,q[1]*step
        return max(l-hw-xx,0,xx-r-hw)+max(t-hh-yy,0,yy-b-hh)
    best=min(prev,key=lambda q:(separation(q),cost[q]))
    if separation(best)<=step*2+pad:
        path=[]
        while best is not None:path.append((best[0]*step,best[1]*step));best=prev[best]
        return path[::-1]
    return None


class Navigator:
    """An interruptible controller. All state changes and key transitions hold the game's lock."""
    def __init__(self,ch):
        self.ch=ch
        self.running=False
        self.state="idle";self.note="未启动";self.trace=[]
        self.session=""; self.room="";self.route=[];self.goals=[];self.visits=[]
        self.thread_id=0

    def bind(self,session):
        self.__init__(self.ch)
        self.session=session
        self.compiled_edits=self.ch.edits();self.base_graph=None;self.metrics={}
        self.files=Path(os.environ["LOCALAPPDATA"])/self.ch.route_prefix
        self.base=self.files/session

    def file(self,kind): return self.base.with_suffix("."+kind)

    def view(self):
        return dict(state=self.state,active=self.running,note=self.note,room=self.room,route=self.route,
                    goals=list(self.goals),visited=list(self.visits),canResume=self.state in ("paused","needsHelp") and hasattr(self,"mode"),events=self.trace[-16:])

    def report(self):
        return {**self.view(),"events":list(self.trace),"walks":dict(getattr(self,"metrics",{}))}

    def log(self,text):
        self.note=text
        self.trace.append([round((time.monotonic()-self.ch.run_clock)*1000),text])

    def stop(self,note="已暂停，可以手动操作。",state="paused"):
        was=self.running
        if not was:return self.view()
        self.running=False;self.thread_id+=1
        if self.session:self.file("on").unlink(missing_ok=True)
        try:self.ch.send_controls([],"ai")
        except (ValueError,OSError):pass
        self.state=state;self.log(note)
        return self.view()

    def cleanup(self):
        if self.running:self.stop("本次试玩已结束。","ended")
        if self.session:
            for kind in ("on","state","grid","refresh"):
                self.file(kind).unlink(missing_ok=True)

    def start(self,request):
        mode=request.get("mode");goals=request.get("goals",[])
        if mode not in ("target","explore","route") or not isinstance(goals,list) or len(goals)>128:
            raise ValueError("跑图模式或路线无效")
        rooms={r["id"] for r in self.ch.index["rooms"]}
        if mode!="explore" and not goals:raise ValueError("请选择目的地")
        steps=[]
        for goal in goals:
            spec={"room":goal} if isinstance(goal,str) else goal
            if not isinstance(spec,dict) or not isinstance(spec.get("room"),str) or spec["room"] not in rooms:
                raise ValueError("请选择工程中存在的目的地")
            point=spec.get("point");threshold=spec.get("plotAtLeast")
            if point is not None and (not isinstance(point,list) or len(point)!=2 or any(type(v) not in (float,int) or not math.isfinite(v) or abs(v)>100000 for v in point)):
                raise ValueError("走位目标需要两个有效坐标")
            if threshold is not None and (type(threshold) not in (float,int) or not math.isfinite(threshold)):
                raise ValueError("剧情门槛必须是数值")
            if "trigger" in spec and (not isinstance(spec["trigger"],str) or not spec["trigger"] or len(spec["trigger"])>160 or point is not None):
                raise ValueError("请指定一个触发区标签或一组坐标")
            if "name" in spec and (not isinstance(spec["name"],str) or len(spec["name"])>180):raise ValueError("节点名称无效")
            if "interact" in spec and not isinstance(spec["interact"],bool):raise ValueError("互动开关必须为布尔值")
            steps.append(dict(spec))
        if not self.session:raise ValueError(self.note if self.state=="unavailable" else "本次试玩尚未接入跑图，请重新打开工作台内试玩")
        if self.running:self.stop("更换路线")
        # Manual input or a decision may resume a partially completed itinerary.
        self.unexpected={};self.mode=mode;self.steps=steps;self.goals=[g["room"] for g in steps];self.point_started=False;self.objective_seen=False;self.room="";self.route=[];self.visits=[]
        self.banned=set();self.seen=set();self.walk=[];self.door=None;self.known_grid=None
        self.autochoice=request.get("firstChoice") is True;self.dialogue=request.get("dialogue",True) is True
        if self.base_graph is None:self.base_graph=make_graph(self.ch,self.compiled_edits)
        self.graph={r:list(exits) for r,exits in self.base_graph.items()}
        self.thread_id+=1;ticket=self.thread_id;self.running=True;self.state="running"
        self.last_error_check=0;self.last_tick=None;self.last_state=time.monotonic();self.wait_from=self.last_state;self.wait_kind=""
        self.files.mkdir(parents=True,exist_ok=True)
        for kind in ("state","grid"):self.file(kind).unlink(missing_ok=True)
        self.file("refresh").touch();self.file("on").touch()
        self.ch.send_controls([],"ai");self.log("开始自动探索" if mode=="explore" else "目的地："+self.goals[0])
        def worker():
            while True:
                with self.ch.lock:
                    if not self.running or ticket!=self.thread_id:return
                    if not self.ch.running:self.stop("试玩窗口已关闭","ended");return
                    try:self.tick()
                    except Exception as error:
                        self.stop("自动跑图停止："+str(error),"error");return
                time.sleep(.035)
        threading.Thread(target=worker,daemon=True,name="DirectorNavigator").start()
        return self.view()

    def resume(self,request):
        if self.state not in ("paused","needsHelp") or not hasattr(self,"mode"):
            raise ValueError("没有可继续的跑图任务")
        seen=set(self.seen);visits=list(self.visits)
        self.start(dict(mode=self.mode,goals=list(self.steps),
                        firstChoice=request.get("firstChoice",self.autochoice),
                        dialogue=request.get("dialogue",self.dialogue)))
        self.seen.update(seen);self.visits=visits
        self.log("从当前位置继续剩余路线。")
        return self.view()

    def read(self,kind):
        try:
            packet=json.loads(self.file(kind).read_bytes())
            names=("room","cell","rows","tick") if kind=="grid" else ("room","tick","plot","w","h","lock","dialog","choice","battle","platform","player","doors","grounded","vx","terrain")
            if kind=="state":names+=("special","triggers","movement","cutsceneStep")[:max(0,len(packet)-len(names))]
            return dict(zip(names,packet,strict=True))
        except (FileNotFoundError,PermissionError,json.JSONDecodeError):return None

    def keys(self,*keys):self.ch.send_controls(list(keys),"ai")
    def wait(self,kind,text,timeout):
        now=time.monotonic()
        if self.wait_kind!=kind:self.wait_kind=kind;self.wait_from=now;self.log(text)
        if now-self.wait_from>timeout:
            self.stop(text+"；长时间未变化，已交还操作。","needsHelp");return False
        return True

    def reset_walk(self):
        self.walk=[];self.door=None;self.retries=0;self.omit=set()
        self.last_progress=time.monotonic();self.checkpoint=None;self.press_since=None;self.grid_tick=None
        self.last_direction=None

    def blocked(self,why):
        self.keys()
        if self.door:self.banned.add(self.door["key"])
        self.last_barrier=why
        self.log(why+"，正在查找其它入口。")
        self.route=[];self.reset_walk()

    def tick(self):
        st=self.read("state");now=time.monotonic()
        if not st or st["tick"]==self.last_tick:
            if now-self.last_state>1:
                self.keys()
                if now-self.last_error_check>1:
                    self.last_error_check=now
                    error=self.ch.window.runtime_error()
                    if error:
                        self.stop("GameMaker 运行错误："+error,"error");return
            if now-self.last_state>12:self.stop("收不到本次试玩的位置；已松开按键。","needsHelp")
            return
        self.last_state=now;self.last_tick=st["tick"]
        step=st.get("cutsceneStep")
        if step and getattr(self,"cutscene_step",None)!=step:
            self.cutscene_step=step
            if self.wait_kind in ("scene","dialog","story"):self.wait_from=now
        room=st["room"]
        if room!=self.room:
            if self.door and self.room and self.door["to"]!=room:
                edge=(self.room,room,self.door["to"])
                self.unexpected[edge]=self.unexpected.get(edge,0)+1
                if self.unexpected[edge]>=3:
                    self.stop("多次误入同一出口，已交还操作。","needsHelp");return
            self.room=room;self.last_barrier="";self.seen.add(room)
            if not self.visits or self.visits[-1]!=room:self.visits.append(room)
            self.known_grid=None;self.reset_walk()
            self.platform_best=None;self.platform_falls=0;self.forward_pos=None;self.jump_time=-10;self.jump_phase="idle"
            self.route=[];self.wait_kind="";self.log("进入 "+room)
        if st["player"]:
            px,py=st["player"][:2]
            m=self.metrics.setdefault(room,dict(first=[px,py],last=[px,py],minX=px,maxX=px,jumps=0))
            m.update(last=[px,py],minX=min(m["minX"],px),maxX=max(m["maxX"],px))
        objective=None
        while self.goals:
            target=self.steps[0];need=target.get("plotAtLeast")
            if room==self.goals[0]:self.objective_seen=True
            elif not (self.objective_seen and need is not None and st["plot"]>=need):break
            if need is not None and st["plot"]<need:
                objective=target;break
            if need is None and ("point" in target or "trigger" in target):
                at_point=False
                if st["player"]:
                    x,y,hw,hh=st["player"]
                    if "point" in target:at_point=math.dist((x,y),target["point"])<7
                    else:at_point=any(tag==target["trigger"] and l-hw<=x<=r+hw and t-hh<=y<=b+hh for tag,l,t,r,b in st.get("triggers",[]))
                confirmed=self.point_started and (st["dialog"] or st["lock"] or st["choice"])
                if not (confirmed if target.get("interact") else at_point):
                    objective=target;break
            self.goals.pop(0);self.steps.pop(0);self.point_started=False;self.objective_seen=False
            if not self.goals:self.stop("已抵达 "+room,"arrived");return
            self.log("下一站："+self.goals[0]);self.route=[];self.reset_walk()
        if st["battle"]:
            self.stop("已进入战斗，请接管；战斗结束后可以继续。","needsHelp");return
        special=st.get("special")
        if special and special[0]=="motionCue":
            if self.wait("motionCue","剧情在等待方向输入。",9):self.keys(special[1])
            return
        if special and special[0]=="outfit":
            if not self.autochoice:
                self.stop("进入了服装选择界面，等待你完成搭配。","needsHelp");return
            if self.wait("outfit","保留当前搭配，选择 END 并确认。",25):
                _,page,column,row,last,answer=special
                if page==2:key="cancel"
                elif page==3:key="act" if answer==0 else "left"
                elif column!=1:key="right"
                elif row!=last:key="up" if row==0 else "down"
                else:key="act"
                self.keys(*([key] if int(now*5)%2 else []))
            return
        if st["choice"]:
            if not self.autochoice:self.stop("遇到剧情选项，等待你选择。","needsHelp");return
            if self.wait("choice","按设置选择第一项。",12):
                self.keys(*(["left","act"] if int(now*4)%2 else ["left"]))
            return
        if st["dialog"]:
            if not self.dialogue:self.stop("到达对话，等待你阅读。","needsHelp");return
            if self.wait("dialog","正在用确认键推进对话。",100):
                self.keys(*(["act"] if int(now*4)%2 else []))
            return
        move=st.get("movement") or []
        if move and move[0]=="climb" and not st["lock"]:
            self.stop("当前由攀爬角色控制，需要选择抓点、松手或跳壁。","needsHelp");return
        if not st["player"] or st["lock"]:
            self.keys()
            if room=="PLACE_MENU" or room.startswith("room_intro_ch"):
                self.stop("请手动选择存档；进入可行走场景后再开始跑图。","needsHelp")
            else:self.wait("scene","等待演出交还控制。",100)
            return
        if objective is not None and "point" not in objective and "trigger" not in objective:
            self.keys()
            self.wait("story","等待本节点的剧情条件；如需特定互动请接管。",15);return
        if self.wait_kind:
            self.wait_kind="";self.reset_walk()
        live=match_exits(room,st["doors"],self.graph)
        # Remember real transitions exposed by running scripts for subsequent rooms.
        for e in live:
            if not any(v["to"]==e["to"] and v["obj"]==e["key"][1] for v in self.graph[room]):
                self.graph[room].append(dict(to=e["to"],obj=e["key"][1],x=e["x"],y=e["y"]))
        if objective is not None:
            boxes=[]
            if "point" in objective:
                x,y=objective["point"];boxes=[(x-1,y-1,x+1,y+1)]
            else:
                boxes=[(l,t,r,b) for tag,l,t,r,b in st.get("triggers",[]) if tag==objective["trigger"]]
            opts=[]
            for l,t,r,b in boxes:
                x,y=(l+r)/2,(t+b)/2;key=(room,objective.get("trigger","互动点"),x,y)
                if key not in self.banned:opts.append(dict(to=room,key=key,x=x,y=y,box=(l,t,r,b),act=bool(objective.get("interact"))))
            if not opts:
                self.stop("当前房间没有可用的目标触发区，或触及后剧情条件仍未满足。","needsHelp");return
            self.route=[objective.get("name") or room]
        else:
            if not self.route:
                self.route=room_route(room,self.goals[:1],self.graph,live,self.banned,
                                      self.seen if self.mode=="explore" else None)
                if not self.route:
                    self.stop(("当前可见出口没有通往目的地的已知路线；"+(self.last_barrier or "可能需要互动或机关。")) if self.mode!="explore" else
                              "可达且已知的出口已探索完；隐藏门或机关需要接管。","needsHelp" if self.mode!="explore" else "explored")
                    return
            opts=[e for e in live if e["to"]==self.route[0] and e["key"] not in self.banned]
        if not opts:
            self.route=[];self.reset_walk();self.keys();return
        if self.door and not any(e["key"]==self.door["key"] for e in opts):
            self.door=None;self.walk=[]
        p=st["player"];x,y=p[:2]
        if move and move[0]=="laneDash":
            if not self.door:
                self.door=min(opts,key=lambda e:abs(y-e["y"]));self.log("正在自动冲刺，选择可通行的纵向路线。")
            if move[1]:
                self.keys();return
            target=(self.door["box"][1]+self.door["box"][3])/2
            prefers=0 if abs(y-target)<14 else (1 if y<target else -1)
            if self.checkpoint is None or math.dist(self.checkpoint,(x,y))>7:
                self.checkpoint=(x,y);self.last_progress=now
            if now-self.last_progress>4:
                self.stop("冲刺角色未能继续前进，需要接管。","needsHelp");return
            choices=[n for n in (-1,0,1) if move[2][n+1]]
            selected=min(choices,key=lambda n:(abs(n-prefers),abs(n))) if choices else prefers
            self.keys(*(["down" if selected>0 else "up"] if selected else []))
            return
        if st["platform"]:
            self.platform_step(st,opts,now,live);return
        if self.known_grid is None or self.file("refresh").exists() or self.retries and not self.walk:
            g=self.read("grid")
            if g and g["room"]==room:self.known_grid=g
        g=self.known_grid
        if not g:
            self.keys()
            if now-self.last_progress>6:self.stop("没有取得此房间的碰撞图。","needsHelp")
            return
        if not self.door:
            paths=[]
            for e in opts:
                path=astar(g,p,e,others=live)
                if path is not None:paths.append((len(path),e,path))
            if not paths:
                for e in opts:self.banned.add(e["key"])
                self.blocked("出口被障碍隔开");return
            _,self.door,self.walk=min(paths,key=lambda v:v[0])
            self.log("前往 "+self.route[0]+"（"+self.door["key"][1]+"）")
            self.last_progress=now;self.checkpoint=(x,y);self.press_since=None
            self.door_deadline=now+max(12,len(self.walk)*g["cell"]/25+9)
        if now>self.door_deadline:self.blocked("在预计时间内没有通过入口");return
        if self.walk is None:
            self.walk=astar(g,p,self.door,self.omit,live)
            if now>self.door_deadline:self.blocked("在预计时间内没有通过入口");return
        if self.walk is None:self.blocked("重新规划后仍无法到达");return
        # Keep corners; skip intermediate collinear cells. Follow actual feedback instead of timings.
        while self.walk and max(abs(self.walk[0][0]-x),abs(self.walk[0][1]-y))<=4.5:
            self.walk.pop(0);self.last_progress=now
        if len(self.walk)>1:
            a=self.walk[0]
            if abs(a[0]-x)<=3 and self.walk[1][0]==a[0] and (self.walk[1][1]-a[1])*(a[1]-y)>=0:
                while len(self.walk)>1 and self.walk[1][0]==a[0]:self.walk.pop(0)
            elif abs(a[1]-y)<=3 and self.walk[1][1]==a[1] and (self.walk[1][0]-a[0])*(a[0]-x)>=0:
                while len(self.walk)>1 and self.walk[1][1]==a[1]:self.walk.pop(0)
        if self.walk:
            tx,ty=self.walk[0];dist=abs(tx-x)+abs(ty-y)
            if self.checkpoint is None or math.dist((x,y),self.checkpoint)>5:
                self.checkpoint=(x,y);self.last_progress=now
            if now-self.last_progress>1.2:
                if self.retries>=2:self.blocked("在同一障碍前连续受阻");return
                self.retries+=1;self.file("refresh").touch();self.known_grid=None
                if self.last_direction:
                    dx,dy={"left":(-1,0),"right":(1,0),"up":(0,-1),"down":(0,1)}[self.last_direction]
                    self.omit.add((round(x/g["cell"])+dx,round(y/g["cell"])+dy))
                self.walk=None;self.last_progress=now;self.keys();self.log("受阻，重新检查碰撞图。");return
        else:
            l,t,r,b=self.door["box"];tx,ty=(l+r)/2,(t+b)/2
            if self.press_since is None:self.press_since=now
            if now-self.press_since>2.4:self.blocked("触及门口但没有切换房间");return
        dx,dy=tx-x,ty-y
        d=("right" if dx>0 else "left") if abs(dx)>abs(dy) else ("down" if dy>0 else "up")
        self.last_direction=d
        if not self.walk and self.door["act"] and int(now*5)%2:
            if objective is not None:self.point_started=True
            self.keys(d,"act")
        else:self.keys(d)


    def platform_step(self,st,opts,now,live):
        x,y,hw,hh=st["player"];terrain=st["terrain"]
        if not self.door:
            def approach(e):
                l,t,r,b=e["box"]
                return max(l-x,0,x-r)+1.6*max(t-y,0,y-b)
            self.door=min(opts,key=approach);self.log("横版：前往 "+self.door["to"])
        l,t,r,b=self.door["box"];tx=(l+r)/2;direction=1 if tx>x else -1
        forward="right" if direction>0 else "left"
        # In stacked platform rooms two exits can share x but lead to different rooms.
        # Do not charge into the nearer floor's exit while targeting another storey.
        if max(t-y,0,y-b)>max(70,hh*3):
            ahead=x+direction*(hw+max(12,abs(st["vx"])*3))
            low,high=sorted((x,ahead))
            for other in live:
                if other["to"]==self.door["to"]:continue
                ol,ot,orr,ob=other["box"]
                if ol-hw<=high and low<=orr+hw and ot-hh<=y<=ob+hh:
                    self.stop("同侧出口通往 "+other["to"]+"；目标在另一层，需要先换层。","needsHelp");return
        if self.platform_best is None:self.platform_best=abs(tx-x);self.last_progress=now
        gap=abs(tx-x)
        if gap<self.platform_best-6:self.platform_best=gap;self.last_progress=now
        if self.forward_pos is not None and gap-self.forward_pos>350:
            self.platform_falls+=1;self.platform_best=gap;self.last_progress=now
            self.log("横版：回到检查点，第 "+str(self.platform_falls)+" 次重试。")
        self.forward_pos=gap
        if now-self.last_progress>9 or self.platform_falls>=3:
            self.stop("横版机关或落坑重试未通过，已停在当前试玩。","needsHelp");return
        # A door below the floor is a deliberate drop, not a gap to jump over.
        drop=(t>y+hh+45 and l-hw-45<=x<=r+hw+45)
        if drop:
            if l+hw<x<r-hw:self.keys("down")
            else:self.keys(forward)
            return
        ground,wall=terrain[1 if direction>0 else 0]
        jump="cancel" if not terrain[2] else "act"
        if st["grounded"] and self.jump_phase not in ("idle","launch"):
            self.jump_phase="idle"
        if st["grounded"] and terrain[4] and (not ground or wall) and now-self.jump_time>.5:
            self.jump_time=now;self.jump_phase="launch";self.metrics[self.room]["jumps"]+=1
            self.log("横版：在 x="+str(round(x))+(" 跨上高台。" if wall else " 越过断层。"))
        if self.jump_phase=="launch" and not st["grounded"]:self.jump_phase="rise"
        if self.jump_phase=="rise" and terrain[3]>=-2:
            self.jump_phase="release";self.hover_since=st["tick"]
        elif self.jump_phase=="release" and st["tick"]-self.hover_since>=100:self.jump_phase="hover"
        if self.jump_phase in ("launch","rise","hover"):self.keys(forward,jump)
        else:self.keys(forward)
