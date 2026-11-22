"""Import the placed platform collision and both edge doors of the cliff run."""
def import_cliff_run(rooms, source):
    room_id = "room_dw_cliff_dash_runner"
    room = rooms[room_id]
    room["mode"] = "platform"
    room["platform"] = {"gravity": 1.25, "jump": 20, "fallSpeed": 20, "speed": 9,
                        "acceleration": 2, "hoverTicks": 140, "dashSpeed": 11, "dashTicks": 12}
    entities = room["entities"]
    entities[:] = [e for e in entities if not e["id"].startswith("runner_")]
    for item in source["instances"]:
        name, x, y = item["name"], item["x"], item["y"]
        if name in ("obj_plat_block", "obj_plat_floor"):
            width = round(40 * item["sx"])
            height = round((6 if name == "obj_plat_floor" else 40) * item["sy"])
            left, top = max(0, x), max(y, 0)
            width = min(x+width, room["w"]) - left
            height = min(y+height, room["h"]) - top
            if width>0 and height>0:
                entities.append({"id":"runner_"+str(item["id"]), "kind":"wall", "x":left,"y":top,
                                 "w":width,"h":height,"draw":False,"oneWay":name=="obj_plat_floor"})
        elif name in ("obj_doorAnyHorz", "obj_doorAnyVert"):
            # These source triggers sit just outside the GameMaker viewport.
            horizontal = name == "obj_doorAnyHorz"
            e = {"id":"runner_"+str(item["id"]), "kind":"door","draw":False,"auto":True, "fade":12}
            if horizontal:
                e.update(x=0, y=0, w=7, h=room["h"], room="room_dw_cliff_twirlflowerplatforming", entry="entry_6")
            else:
                e.update(x=x, y=room["h"]-9, w=round(item["sx"]*40), h=9, room="room_dw_cliff_seth_miniboss", entry="entry_1")
            entities.append(e)
    room["entries"]["entry_1"].update(x=32,y=285,face="right")
    room["entries"]["arrival"].update(x=room["w"]-500,y=285,face="left")

    placed=[e for e in entities if e["id"].startswith("runner_")]
    return {e["id"]:e for e in placed}


def report_cliff_run(report, placed, source):
    by_id={i["id"]:i for i in source["instances"]}
    report["doors"]=sum(e["kind"]=="door" for e in placed.values())
    report["walls"]=sum(e["kind"]=="wall" for e in placed.values())
    report["issues"]=[v for v in report["issues"] if v["issue"]!="door mask falls outside room"]
    for key,e in placed.items():
        i=by_id[int(key.split("_")[1])]
        report["references"].append({"instance":i["id"],"kind":"platform edge door" if e["kind"]=="door" else "platform collision",
            "source":[v for v in [i.get("pre"),i.get("init"),"gml_Object_obj_plat_player_Create_0"] if v]})
