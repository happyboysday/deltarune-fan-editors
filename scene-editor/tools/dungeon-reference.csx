using System.IO;
using System.Linq;
using System.Text.Json;
EnsureDataLoaded();
var dir = Path.GetFullPath(".research");
Directory.CreateDirectory(dir);
var prefixes = new[]{"spr_kris_plat_", "spr_kris_jump_", "spr_kris_fall", "spr_plat_kris_ball", "spr_plat_bullet_yellow", "spr_krisb_defeat", "spr_shinobeetle", "spr_forange", "spr_fyellow", "spr_faqua", "spr_jigsawry", "spr_ponman"};
var sprites = Data.Sprites.Where(s => prefixes.Any(prefix=>s.Name.Content.StartsWith(prefix)));
File.WriteAllText(Path.Combine(dir,"kris.json"), JsonSerializer.Serialize(sprites.Select(s => new {name=s.Name.Content,s.Width,s.Height,s.OriginX,s.OriginY,frames=s.Textures.Count})));
var context = new GlobalDecompileContext(Data);
var enemyObjects = new[]{"obj_plat_entity","obj_plat_shinobeetle","obj_plat_enm_gun","obj_plat_enm_aqua_small","obj_plat_enm_aqua_miniboss","obj_plat_enm_smallglove","obj_plat_enm_orange_miniboss","obj_plat_enm_glovespawner"};
var enemyEvents = enemyObjects.SelectMany(n=>new[]{"Create","Draw","Step"}.Select(ev=>"gml_Object_"+n+"_"+ev+"_0")).ToHashSet();
foreach (var code in Data.Code.Where(c => c.ParentEntry == null && (enemyEvents.Contains(c.Name.Content) || c.Name.Content.Contains("plat") && (c.Name.Content.Contains("obj_plat_player_") || c.Name.Content.Contains("slash") || c.Name.Content.Contains("mainchara"))))) {
    File.WriteAllText(Path.Combine(dir,code.Name.Content+".gml"),new Underanalyzer.Decompiler.DecompileContext(context,code,Data.ToolInfo.DecompilerSettings).DecompileToString());
}
File.WriteAllLines(Path.Combine(dir,"platform-code.txt"),Data.Code.Select(c=>c.Name.Content).Where(n=>n.Contains("plat")));
