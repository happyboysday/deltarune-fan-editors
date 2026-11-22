
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using UndertaleModLib.Models;

EnsureDataLoaded();
var rooms = new Dictionary<string, object>();
int count=0;
foreach(var room in Data.Rooms) {
    if(room.Width < 64 || room.Height < 64) continue;
    var rows = new List<object>();
    var unique = new HashSet<uint>();
    var candidates = room.GameObjects.Where(i=>i!=null).ToList();
    if(room.Layers!=null) foreach(var layer in room.Layers) {
        if(layer.LayerType==UndertaleRoom.LayerType.Instances && layer.InstancesData?.Instances!=null)
            candidates.AddRange(layer.InstancesData.Instances.Where(i=>i!=null));
    }
    foreach(var i in candidates) {
        if(!unique.Add(i.InstanceID)) continue;
        var obj=i.ObjectDefinition;
        string name=obj?.Name?.Content??"";
        string kind=null;
        if(Regex.IsMatch(name,@"^obj_(solidblock|interactablesolid|climbsolid)",RegexOptions.IgnoreCase)) kind="wall";
        else if(Regex.IsMatch(name,@"^obj_door(?:[abcdexw]|any|parent)(?:_musfade)?$",RegexOptions.IgnoreCase)) kind="door";
        else if(Regex.IsMatch(name,@"^obj_(mainchara|maincharaspawn)(?:_|$)",RegexOptions.IgnoreCase)) kind="entry";
        else if(Regex.IsMatch(name,@"^obj_(npc_.*|interactable_|puzzlemaster)",RegexOptions.IgnoreCase)) kind="npc";
        else if(Regex.IsMatch(name,@"^obj_(floorswitch|pressureplate)",RegexOptions.IgnoreCase)) kind="switch";
        else if(Regex.IsMatch(name,@"^obj_(climb|watering|rhythmgame|board_icepuzzle)",RegexOptions.IgnoreCase)) kind="mechanic";
        if(kind==null) continue;
        double x=i.X,y=i.Y,w=16,h=16;
        bool measured=false;
        var spr=obj.Sprite;
        if(spr!=null && i.Rotation==0 && i.ScaleX!=0 && i.ScaleY!=0) {
            double x0=(spr.MarginLeft-spr.OriginX)*i.ScaleX,x1=(spr.MarginRight+1-spr.OriginX)*i.ScaleX;
            double y0=(spr.MarginTop-spr.OriginY)*i.ScaleY,y1=(spr.MarginBottom+1-spr.OriginY)*i.ScaleY;
            if(Math.Abs(x1-x0)>0 && Math.Abs(y1-y0)>0) {
                x+=Math.Min(x0,x1);y+=Math.Min(y0,y1);w=Math.Abs(x1-x0);h=Math.Abs(y1-y0);measured=true;
            }
        }
        if(!measured) {x-=8;y-=8;}
        rows.Add(new {id=i.InstanceID,kind,name,x,y,w,h,px=i.X,py=i.Y,measured});
    }
    if(rows.Count==0)continue;
    rooms[room.Name.Content]=rows;count+=rows.Count;
}
File.WriteAllText(Environment.GetEnvironmentVariable("SCENE_HINTS"),JsonSerializer.Serialize(rooms));
Console.WriteLine("ROOMS="+rooms.Count+" HINTS="+count);
