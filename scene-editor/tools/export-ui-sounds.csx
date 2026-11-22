using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using UndertaleModLib;
using UndertaleModLib.Models;

EnsureDataLoaded();
var manifest = Environment.GetEnvironmentVariable("DIRECTOR_UI_MANIFEST");
var output = Environment.GetEnvironmentVariable("DIRECTOR_UI_SOUND_OUTPUT");
var input = Path.GetDirectoryName(FilePath);
var spec = JsonDocument.Parse(File.ReadAllText(manifest));
var sounds = spec.RootElement.GetProperty("sounds").EnumerateArray()
    .Select(value => value.GetString()).ToHashSet(StringComparer.Ordinal);
spec.Dispose();
var groups = new Dictionary<int, IList<UndertaleEmbeddedAudio>>();

foreach (var sound in Data.Sounds.Where(s => sounds.Contains(s.Name.Content)))
{
    byte[] bytes = sound.AudioFile?.Data;
    if (bytes == null && sound.GroupID > 0)
    {
        if (!groups.TryGetValue(sound.GroupID, out var group))
        {
            var path = Path.Combine(input, $"audiogroup{sound.GroupID}.dat");
            if (File.Exists(path))
            {
                using (var stream = File.OpenRead(path))
                    group = UndertaleIO.Read(stream).EmbeddedAudio;
            }
            groups.Add(sound.GroupID, group);
        }
        if (group != null && sound.AudioID >= 0 && sound.AudioID < group.Count)
            bytes = group[sound.AudioID].Data;
    }
    if (bytes == null && sound.File?.Content is string file && Path.GetFileName(file) == file)
    {
        var path = Path.Combine(input, file);
        if (File.Exists(path))
            bytes = File.ReadAllBytes(path);
    }
    if (bytes == null || bytes.Length < 4)
        continue;
    var header = System.Text.Encoding.ASCII.GetString(bytes, 0, 4);
    var ext = header == "RIFF" ? ".wav" : header == "OggS" ? ".ogg" : null;
    if (ext != null)
        File.WriteAllBytes(Path.Combine(output, sound.Name.Content + ext), bytes);
}
