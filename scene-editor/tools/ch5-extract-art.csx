using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using UndertaleModLib.Models;
using UndertaleModLib.Util;

EnsureDataLoaded();
var target=Environment.GetEnvironmentVariable("DR_CH5_OUTPUT");
var images=Path.Combine(target,"frames");
Directory.CreateDirectory(images);
object P(object obj,string key)=>obj?.GetType().GetProperty(key)?.GetValue(obj);
string Name(object obj)=>(obj as UndertaleString)?.Content??(P(obj,"Name") as UndertaleString)?.Content;
var rules=new Regex(@"^spr_(?:kris[dlru](?:_dark)?|susie[dlru](?:_dark)?|ralsei_walk_(?:down|up|left|right)|wateringcan.*|watercan.*|growgrass.*|waterable.*|flower_.*|savepoint|pxwhite|whitepx|whitepixel|zenpond_watermove|dw_dappled_light_overlay)$",RegexOptions.IgnoreCase);
var sizes=new Dictionary<string,object>();
var candidates=Data.Sprites.Where(s=>rules.IsMatch(Name(s))).ToArray();
using(var worker=new TextureWorker()){
 foreach(var sprite in candidates) {
    if(sprite.SSpriteType!=UndertaleSprite.SpriteType.Normal||sprite.Textures.Count==0)continue;
    string name=Name(sprite);
    var folder=Path.Combine(images,name);
    Directory.CreateDirectory(folder);
    for(var i=0;i<sprite.Textures.Count;i++)
        if(sprite.Textures[i]?.Texture!=null)worker.ExportAsPNG(sprite.Textures[i].Texture,Path.Combine(folder,$"{i:D3}.png"),null,true);
    sizes[name]= new {frames=sprite.Textures.Count,ox=sprite.OriginX,oy=sprite.OriginY,w=sprite.Width,h=sprite.Height};
 }
}
var rooms=Data.Rooms.ToDictionary(r=>Name(r),r=>new {
 flags=r.Flags.ToString(),
 views=r.Views.Select(v=>new {enabled=P(v,"Enabled"),x=P(v,"ViewX"),y=P(v,"ViewY"),w=P(v,"ViewWidth"),h=P(v,"ViewHeight"),portW=P(v,"PortWidth"),portH=P(v,"PortHeight"),follow=Name(P(v,"ObjectId"))}).ToArray(),
 layers=r.Layers.Select(l=>new {name=Name(P(l,"LayerName"))??Name(l),type=l.LayerType.ToString(),depth=l.LayerDepth,id=P(l,"LayerId"),visible=P(l,"IsVisible"),x=P(l,"XOffset"),y=P(l,"YOffset")}).ToArray()
});
File.WriteAllText(Path.Combine(target,"visual-facts.json"),JsonSerializer.Serialize(new {rooms,sizes}));
var l0=Data.Rooms.SelectMany(r=>r.Layers).First();
var v0=Data.Rooms.SelectMany(r=>r.Views).First();
Console.WriteLine("Layer: "+string.Join(" ",l0.GetType().GetProperties().Select(p=>p.Name)));
Console.WriteLine("View: "+string.Join(" ",v0.GetType().GetProperties().Select(p=>p.Name)));
Console.WriteLine("Frames="+sizes.Count);

