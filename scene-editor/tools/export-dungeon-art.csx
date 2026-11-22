// Run from the editor root with chapter5_windows/data.win and stdin redirected from NUL.
using System;
using System.IO;
using System.Linq;
using UndertaleModLib.Util;

EnsureDataLoaded();
var output = Path.GetFullPath("studio/art/dungeon-ch5");
var names = new[] {
    "spr_forange_largeglove", "spr_forange_glove", "spr_shinobeetle_hurt",
    "spr_fyellow_gun", "spr_faqua_small", "spr_faqua_spin", "spr_faqua_blur"
};
var sprites = names.Select(name => Data.Sprites.Single(s => s.Name.Content == name)).ToArray();
Directory.CreateDirectory(output);
using (var worker = new TextureWorker()) {
    foreach (var sprite in sprites) {
        for (var i = 0; i < sprite.Textures.Count; i++) {
            var frame = sprite.Textures[i].Texture;
            var path = Path.Combine(output, $"{sprite.Name.Content}_{i:D3}.png");
            worker.ExportAsPNG(frame, path, null, true);
        }
        Console.WriteLine($"{sprite.Name.Content}: {sprite.Textures.Count} frames");
    }
}
