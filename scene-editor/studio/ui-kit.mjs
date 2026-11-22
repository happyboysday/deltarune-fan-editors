export const UI_WIDTH = 640;
export const UI_HEIGHT = 480;
export const UI_ASSET_ROOT = '/ui-assets/';
export const UI_COLORS = Object.freeze({
  black: '#000000', white: '#ffffff', yellow: '#ffff00', red: '#ff0000',
  gray: '#808080', inactiveSave: '#444444'
});
export const UI_VOICES = Object.freeze({
  narrator: 'snd_text', susie: 'snd_txtsus', ralsei: 'snd_txtral',
  noelle: 'snd_txtnoe', toriel: 'snd_txttor', asgore: 'snd_txtasg',
  berdly: 'snd_txtber', sans: 'snd_txtsans', lancer: 'snd_txtlan',
  queen: 'snd_txtq_2', spamton: 'snd_txtspam2', king: 'snd_dadtxt',
  rudy: 'snd_txtrud', alphys: 'snd_txtal'
});
export const UI_SOUNDS = Object.freeze({
  select: 'snd_select', move: 'snd_menumove', save: 'snd_save', error: 'snd_error',
  cancel: 'snd_smallswing', savePoint: 'snd_power', hurt: 'snd_hurt1',
  crack: 'snd_break1', shatter: 'snd_break2', revive: 'snd_dtrans_lw'
});

const uiFontDefaults = {
  fnt_main: [12, 16, 8], fnt_mainbig: [24, 32, 16], fnt_dotumche: [12, 16, 9],
  fnt_comicsans: [10, 19, 8], fnt_tinynoelle: [7, 9, 6], fnt_8bit: [12, 16, 16],
  fnt_legend: [12, 18, 8]
};
const uiFontPath = (name, file) => UI_ASSET_ROOT + 'fonts/' + name + '/' + file;
const uiSpritePath = (name, frame) => UI_ASSET_ROOT + 'sprites/' + name + '/' + frame + '.png';
const uiSoundPath = name => UI_ASSET_ROOT + 'sounds/' + name;
const uiFontNames = manifest => manifest.fonts.flatMap(name => [name, name + '@zh']);
const uiEmptyManifest = {fonts: [], sprites: {}, sounds: []};
const uiFallbackStack = '"SimSun", "Microsoft YaHei UI", monospace';

export function listUiAssets(manifest) {
  return [
    ...uiFontNames(manifest).flatMap(name => [uiFontPath(name, 'glyphs.json'), uiFontPath(name, 'glyphs.png')]),
    ...Object.entries(manifest.sprites).flatMap(([name, count]) =>
      Array.from({length: count}, (_, frame) => uiSpritePath(name, frame))),
    ...manifest.sounds.map(uiSoundPath)
  ];
}

export function uiViewport(width, height) {
  const scale = Math.min(width / UI_WIDTH, height / UI_HEIGHT);
  const w = UI_WIDTH * scale, h = UI_HEIGHT * scale;
  return {scale, x: (width - w) / 2, y: (height - h) / 2, w, h};
}

export function withUiViewport(ctx, draw, {x = 0, y = 0, width = ctx.canvas.width, height = ctx.canvas.height} = {}) {
  const viewport = uiViewport(width, height);
  if (!(viewport.scale > 0)) return;
  ctx.save();
  try {
    ctx.setTransform(viewport.scale, 0, 0, viewport.scale, x + viewport.x, y + viewport.y);
    ctx.imageSmoothingEnabled = false;
    const clip = new Path2D();
    clip.rect(0, 0, UI_WIDTH, UI_HEIGHT);
    ctx.clip(clip);
    return draw(ctx);
  } finally {
    ctx.restore();
  }
}

export function drawPanel(ctx, x, y, width, height, {
  border = 6, borderColor = UI_COLORS.white, fill = UI_COLORS.black
} = {}) {
  if (!(width > 0 && height > 0)) return;
  const edge = Math.max(0, Math.min(border, width / 2, height / 2));
  ctx.save();
  if (edge) {
    ctx.fillStyle = borderColor;
    ctx.fillRect(x, y, width, edge);
    ctx.fillRect(x, y + height - edge, width, edge);
    ctx.fillRect(x, y + edge, edge, height - edge * 2);
    ctx.fillRect(x + width - edge, y + edge, edge, height - edge * 2);
  }
  ctx.fillStyle = fill;
  ctx.fillRect(x + edge, y + edge, width - edge * 2, height - edge * 2);
  ctx.restore();
}

// The original writer counts halfwidth and fullwidth glyphs in different cells in the Chinese patch.
export function uiWriterAdvance(glyph, cellWidth, lang = 'zh') {
  const cp = glyph.codePointAt(0);
  return lang === 'zh' && (cp > 505 || cp === 183) ? Math.floor(cellWidth * 7 / 4) : cellWidth;
}

export function createTypewriter(text, {
  ticksPerGlyph = 1, voice = UI_VOICES.narrator, onVoice,
  shouldVoice = glyph => !/[\s!.,?:*\/\\^|]/u.test(glyph)
} = {}) {
  const glyphs = Array.from(String(text ?? ''));
  if (!Number.isFinite(ticksPerGlyph) || ticksPerGlyph <= 0) {
    throw new RangeError('ticksPerGlyph 必须是正数');
  }
  let index = 0, elapsed = 0, visible = '';
  return {
    get visible() { return visible; },
    get done() { return index === glyphs.length; },
    advance(ticks = 1) {
      if (!Number.isFinite(ticks) || ticks <= 0 || index === glyphs.length) return visible;
      elapsed += ticks;
      while (elapsed >= ticksPerGlyph && index < glyphs.length) {
        const current = index++;
        const glyph = glyphs[current];
        visible += glyph;
        elapsed -= ticksPerGlyph;
        if (voice && onVoice && shouldVoice(glyph, current)) onVoice({name: voice, glyph, index: current});
      }
      return visible;
    },
    skip() {
      visible += glyphs.slice(index).join('');
      index = glyphs.length;
      return visible;
    }
  };
}

async function readUiAsset(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法读取试玩 UI 素材：' + path);
  return response;
}

export async function loadUiKit(uiPack = null) {
  const manifestPath = UI_ASSET_ROOT + 'manifest.json';
  const manifest = uiPack ? (uiPack.manifest ?? uiEmptyManifest) :
    await (await readUiAsset(manifestPath, manifestPath)).json();
  const resolve = path => uiPack ? uiPack.files?.[path] : path;
  const missing = new Set();
  const fonts = new Map(), sprites = new Map(), sounds = new Map();
  async function load(path, decode) {
    try {
      const url = resolve(path);
      if (!url) throw new Error('缺少内嵌素材');
      return await decode(await readUiAsset(url, path));
    } catch {
      missing.add(path);
      return null;
    }
  }
  const bitmap = async response => createImageBitmap(await response.blob());
  await Promise.all([
    ...uiFontNames(manifest).map(async name => {
      const [data, image] = await Promise.all([
        load(uiFontPath(name, 'glyphs.json'), response => response.json()),
        load(uiFontPath(name, 'glyphs.png'), bitmap)
      ]);
      if (data?.glyphs && image) fonts.set(name, {...data, image});
      else if (data && !data.glyphs) missing.add(uiFontPath(name, 'glyphs.json'));
    }),
    ...Object.entries(manifest.sprites).map(async ([name, count]) => {
      sprites.set(name, await Promise.all(Array.from({length: count}, (_, frame) => load(uiSpritePath(name, frame), bitmap))));
    })
  ]);
  for (const name of manifest.sounds) {
    const path = uiSoundPath(name), url = resolve(path);
    if (url) sounds.set(name, url);
    else missing.add(path);
  }
  return makeUiKit(fonts, sprites, sounds, [...missing].sort());
}

function makeUiKit(fonts, sprites, sounds, missing) {
  const tinted = new Map();
  function tint(key, image, x, y, w, h, color) {
    const cacheKey = key + ':' + color;
    if (tinted.has(cacheKey)) return tinted.get(cacheKey);
    const tile = new OffscreenCanvas(w, h), ctx = tile.getContext('2d');
    ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    if (tinted.size >= 512) tinted.delete(tinted.keys().next().value);
    tinted.set(cacheKey, tile);
    return tile;
  }

  function layout(value, {
    font = 'fnt_mainbig', lang = 'zh', scale = 1, lineHeight, advance = 'font', cellWidth
  } = {}) {
    if (font.endsWith('@zh')) {
      font = font.slice(0, -3);
      lang = 'zh';
    }
    const [defaultSize, defaultHeight, defaultCell] = uiFontDefaults[font] ?? uiFontDefaults.fnt_mainbig;
    const english = fonts.get(font);
    const primary = (lang === 'zh' && fonts.get(font + '@zh')) || english;
    const size = primary?.emSize ?? defaultSize;
    const rows = String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => {
      let width = 0;
      const cells = Array.from(line, ch => {
        const code = ch.codePointAt(0);
        const face = primary?.glyphs[code] ? primary : english;
        const glyph = face?.glyphs[code];
        const x = width;
        const shift = advance === 'writer' ? uiWriterAdvance(ch, cellWidth ?? defaultCell, lang) :
          (glyph?.shift ?? (code >= 0x2e80 ? size : size * 0.6));
        width += shift * scale;
        return {ch, code, face, glyph, x};
      });
      return {cells, width};
    });
    const step = (lineHeight ?? primary?.lineHeight ?? defaultHeight) * scale;
    return {size, scale, rows, lineHeight: step,
      width: Math.max(...rows.map(row => row.width)), height: rows.length * step};
  }

  function measureText(value, opts) {
    const {width, height, lineHeight, rows} = layout(value, opts);
    return {width, height, lineHeight, lineWidths: rows.map(row => row.width)};
  }

  function drawText(ctx, value, x, y, opts = {}) {
    const {color = UI_COLORS.white, align = 'left', baseline = 'top', alpha = 1} = opts;
    const {rows, width, height, lineHeight, size, scale} = layout(value, opts);
    const top = y - (baseline === 'middle' ? height / 2 : baseline === 'bottom' ? height : 0);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha *= alpha;
    ctx.font = (size * scale) + 'px ' + uiFallbackStack;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = color;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const left = x - (align === 'right' ? row.width : align === 'center' ? row.width / 2 : 0);
      const y0 = Math.round(top + i * lineHeight);
      for (const {ch, code, face, glyph, x: offset} of row.cells) {
        if (/\s/u.test(ch)) continue;
        const x0 = left + offset;
        if (!glyph) {
          ctx.fillText(ch, Math.round(x0), y0);
        } else if (glyph.w > 0 && glyph.h > 0) {
          // GameMaker Glyph.Offset is the horizontal bearing. The texture already includes vertical padding.
          const dx = Math.round(x0 + glyph.offset * scale);
          if (color === UI_COLORS.white || color === '#fff' || color === 'white') {
            ctx.drawImage(face.image, glyph.x, glyph.y, glyph.w, glyph.h, dx, y0, glyph.w * scale, glyph.h * scale);
          } else {
            const tile = tint(face.name + '/' + code, face.image, glyph.x, glyph.y, glyph.w, glyph.h, color);
            ctx.drawImage(tile, dx, y0, glyph.w * scale, glyph.h * scale);
          }
        }
      }
    }
    ctx.restore();
    return width;
  }

  // The shared sprites use top-left origins. Negative axes mirror around that origin.
  function blit(ctx, image, x, y, w, h) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(x, y);
    ctx.scale(Math.sign(w), Math.sign(h));
    ctx.drawImage(image, 0, 0, Math.abs(w), Math.abs(h));
    ctx.restore();
  }

  function drawSprite(ctx, name, x, y, {frame = 0, scale = 1, color, alpha = 1} = {}) {
    const image = sprites.get(name)?.[frame];
    if (!image || !(scale > 0)) return false;
    const tile = color ? tint(name + '/' + frame, image, 0, 0, image.width, image.height, color) : image;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha *= alpha;
    ctx.drawImage(tile, Math.round(x), Math.round(y), image.width * scale, image.height * scale);
    ctx.restore();
    return true;
  }

  function drawHeart(ctx, x, y, {
    sprite = 'spr_heart', frame = 0, scale = 1, alpha = 1,
    color = sprite === 'spr_heartsmall_white' ? UI_COLORS.red : undefined
  } = {}) {
    return drawSprite(ctx, sprite, x, y, {frame, scale, color, alpha});
  }

  function drawDarkBox(ctx, x, y, w, h, {frame = 0} = {}) {
    const top = sprites.get('spr_textbox_top')?.[0], left = sprites.get('spr_textbox_left')?.[0];
    const corners = sprites.get('spr_textbox_topleft');
    const corner = corners?.[frame] ?? corners?.[0];
    if (!top || !left || !corner || w < 64 || h < 64) {
      drawPanel(ctx, x, y, w, h);
      return false;
    }
    drawPanel(ctx, x + 20, y + 20, w - 40, h - 40, {border: 0});
    if (w > 64) {
      blit(ctx, top, x + 32, y, w - 64, 32);
      blit(ctx, top, x + 32, y + h, w - 64, -32);
    }
    if (h > 64) {
      blit(ctx, left, x, y + 32, 32, h - 64);
      blit(ctx, left, x + w, y + 32, -32, h - 64);
    }
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        blit(ctx, corner, sx > 0 ? x : x + w, sy > 0 ? y : y + h, 32 * sx, 32 * sy);
      }
    }
    return true;
  }

  return {drawText, measureText, drawSprite, drawHeart, drawDarkBox, missing,
    createAudio: options => makeUiAudio(sounds, options)};
}

function makeUiAudio(sounds, {getContext, isMuted = () => false} = {}) {
  let muted = false, disposed = false, context;
  const clips = new Map(), playing = new Set();

  function getUiContext() {
    if (disposed) return null;
    context ??= getContext ? getContext() : (globalThis.AudioContext ? new AudioContext() : null);
    return context;
  }

  function load(name) {
    if (clips.has(name)) return clips.get(name).ready;
    const url = sounds.get(name), ctx = url && getUiContext();
    if (!ctx) return Promise.resolve(false);
    const clip = {buffer: null};
    clip.ready = readUiAsset(url, name).then(response => response.arrayBuffer())
      .then(bytes => ctx.decodeAudioData(bytes)).then(buffer => {
        clip.buffer = disposed ? null : buffer;
        return !disposed;
      }).catch(() => false);
    clips.set(name, clip);
    return clip.ready;
  }

  function stop(name) {
    for (const shot of playing) {
      if (name == null || shot.name === name) {
        shot.source.stop();
        playing.delete(shot);
      }
    }
  }

  return {
    async unlock() {
      if (muted || isMuted()) return false;
      const ctx = getUiContext();
      try {
        if (ctx?.state === 'suspended') await ctx.resume();
        return ctx?.state === 'running';
      } catch { return false; }
    },
    preload(names = [...sounds.keys()]) {
      return Promise.all(names.map(load));
    },
    play(name, {volume = 1, rate = 1, restart = false} = {}) {
      if (disposed || muted || isMuted() || !sounds.has(name)) return false;
      const buffer = clips.get(name)?.buffer;
      if (!buffer) {
        void load(name);
        return false;
      }
      if (context.state !== 'running') return false;
      if (restart) stop(name);
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffer;
      source.playbackRate.value = Number.isFinite(rate) && rate > 0 ? rate : 1;
      gain.gain.value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
      source.connect(gain).connect(context.destination);
      const shot = {name, source};
      source.onended = () => {
        playing.delete(shot);
        source.disconnect();
        gain.disconnect();
      };
      source.start();
      playing.add(shot);
      return true;
    },
    stop,
    setMuted(value) {
      muted = Boolean(value);
      if (muted) stop();
    },
    dispose() {
      disposed = true;
      stop();
      clips.clear();
      if (!getContext && context && context.state !== 'closed') void context.close().catch(() => {});
    }
  };
}
