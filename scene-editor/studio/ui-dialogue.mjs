// All positions below are in the 640 × 480 UI coordinate space.
import {artAt,firstSprite,icon} from './ui-draw.mjs';
import {UI_COLORS,drawPanel,uiWriterAdvance,withUiViewport} from './ui-kit.mjs';

export const DIALOGUE_ROWS = 3;
const WRITER_CELL = 16;
const WRITER_LINE = 36;
const WRITER_PAUSES = [0, 5, 10, 15, 20, 30, 40, 60, 90, 150];
const BOX_OFFSET = 310;
const BODY_X = 58;
const PORTRAIT_BODY_X = 174;
const BODY_Y = 30;
const SYSTEM_DIALOGUE_FONT = '24px Consolas, "Microsoft YaHei UI", monospace';
const PORTRAIT_OFFSETS = {susie: [-5, 0], ralsei: [-15, -10], noelle: [-12, -10]};
const CHOICE_CENTERS = [[155, 83], [487, 83], [321, 43], [327, 122], [155, 122], [487, 122]];

const isWriterPause = token => token.length === 2 && token[0] === '^';

// Prepare the full lines up front so already visible words never move as glyphs arrive.
export function layoutDialogue(text, portrait = false) {
  const showStar = !text.startsWith('\\m');
  const paragraphs = (showStar ? text : text.slice(2)).split(/\r\n?|\n|&/u);
  const limit = (portrait ? 26 : 33) * WRITER_CELL;
  const rows = [];
  let starred = false;
  for (let paragraph of paragraphs) {
    if (showStar && !starred && paragraph.trim()) paragraph = '* ' + paragraph.trimStart().replace(/^\*[ \t]*/u, '');
    const startsWithStar = paragraph.startsWith('*');
    if (startsWithStar) paragraph = paragraph.replace(/^\*[ \t]*/u, showStar ? '* ' : '');
    let indent = starred && !startsWithStar ? 2 * WRITER_CELL : 0;
    starred ||= showStar && startsWithStar;
    const tokens = paragraph.match(/\^[1-9]|./gu) ?? [];
    let start = 0;
    do {
      let end = start, width = indent, space = -1, previous = '';
      for (; end < tokens.length; end++) {
        const token = tokens[end];
        if (isWriterPause(token)) continue;
        if (token === ' ' && previous !== '*' && end > start) space = end;
        if (width >= limit) break;
        width += uiWriterAdvance(token, WRITER_CELL);
        previous = token;
      }
      const wrapAtSpace = end < tokens.length && space >= 0;
      const stop = wrapAtSpace ? space : end;
      const row = {text: '', indent, pauses: []};
      for (let i = start; i < stop; i++) {
        const token = tokens[i];
        if (isWriterPause(token)) row.pauses.push([row.text.length, WRITER_PAUSES[Number(token[1])]]);
        else row.text += token;
      }
      rows.push(row);
      start = wrapAtSpace ? space + 1 : end;
      indent = starred ? 2 * WRITER_CELL : 0;
    } while (start < tokens.length);
  }
  return rows;
}

function dialogueFont(world) {
  return world === 'light' ? {font: 'fnt_main', scale: 2} : {font: 'fnt_mainbig', scale: 1};
}

function drawDialoguePanel(ctx, {kit, world}, side, boxAge) {
  const offset = side * BOX_OFFSET;
  if (world === 'light') drawPanel(ctx, 32, 10 + offset, 578, 152);
  else if (kit) kit.drawDarkBox(ctx, 24, 2 + offset, 593, 167, {frame: Math.floor(boxAge / 10) % 8});
  else drawPanel(ctx, 24, 2 + offset, 593, 167);
}

function drawWriterRows(ctx, ui, rows, side, x = BODY_X, visible = Infinity) {
  const {kit, world} = ui;
  const font = dialogueFont(world);
  const style = {...font, advance: 'writer', lineHeight: WRITER_LINE / font.scale};
  ctx.font = SYSTEM_DIALOGUE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = UI_COLORS.white;
  for (const [i, row] of rows.entries()) {
    if (visible <= 0) break;
    const text = row.text.slice(0, visible);
    visible -= text.length;
    const y = BODY_Y + side * BOX_OFFSET + i * WRITER_LINE;
    let left = x + row.indent;
    if (kit) kit.drawText(ctx, text, left, y, style);
    else {
      for (const glyph of text) {
        const advance = uiWriterAdvance(glyph, WRITER_CELL);
        if (!/\s/u.test(glyph)) ctx.fillText(glyph, left, y, advance);
        left += advance;
      }
    }
  }
}

function drawDialoguePortrait(ctx, page, side, {art, assets, world}) {
  const image = art.images.get(firstSprite(assets[page.portrait]));
  if (!image?.naturalWidth) return;
  const name = page.speaker?.trim().toLowerCase();
  const [dx, dy] = Object.hasOwn(PORTRAIT_OFFSETS, name) ? PORTRAIT_OFFSETS[name] : [0, 0];
  const unit = world === 'light' ? 2 : 1;
  const x = 74 + dx * unit, y = 40 + dy * unit;
  const fit = Math.min((PORTRAIT_BODY_X - x) / image.naturalWidth, (155 - y) / image.naturalHeight);
  const scale = Math.floor(fit) || fit;
  artAt(image, ctx, x, y + side * BOX_OFFSET, image.naturalWidth * scale, image.naturalHeight * scale);
}

export function drawDialogue(ctx, d, v, ui) {
  const page = d.pages[d.page];
  withUiViewport(ctx, () => {
    drawDialoguePanel(ctx, ui, d.side, d.boxAge);
    if (page.portrait) drawDialoguePortrait(ctx, page, d.side, ui);
    drawWriterRows(ctx, ui, d.lines, d.side, page.portrait ? PORTRAIT_BODY_X : BODY_X, d.visible.length);
  }, {width: v.w, height: v.h});
}

function wrapChoiceLabel(text, width, glyphWidth) {
  const lines = [];
  for (const line of text.split('\n')) {
    let row = '', used = 0;
    for (const glyph of line) {
      const advance = glyphWidth(glyph);
      if (row && used + advance > width) {
        lines.push(row.trimEnd());
        row = '';
        used = 0;
      }
      if (!row && glyph === ' ') continue;
      row += glyph;
      used += advance;
    }
    lines.push(row);
  }
  return lines;
}

function fitChoiceLabel(text, maxWidth, maxHeight, glyphWidth, measure) {
  const label = text.replace(/\r\n?/gu, '\n').replace(/^[#\n]/u, '').replaceAll('#', '\n');
  // Labels authored outside the original slots' capacity wrap first, then shrink as needed.
  for (let scale = 1; ; scale *= 0.85) {
    const lines = wrapChoiceLabel(label, maxWidth / scale, glyphWidth);
    const content = lines.join('\n'), size = measure(content);
    if (size.height * scale <= maxHeight) {
      return {content, lines, lineHeight: size.lineHeight, scale, width: size.width * scale};
    }
  }
}

function drawChoiceLabels(ctx, c, {kit, world}) {
  const font = dialogueFont(world);
  ctx.font = SYSTEM_DIALOGUE_FONT;
  const measure = kit ? text => kit.measureText(text, font) : text => {
    const lines = text.split('\n');
    return {width: Math.max(...lines.map(line => ctx.measureText(line).width)), height: 32 * lines.length, lineHeight: 32};
  };
  const advances = new Map();
  function glyphWidth(glyph) {
    if (!advances.has(glyph)) advances.set(glyph, measure(glyph).width);
    return advances.get(glyph);
  }
  const count = c.options.length, height = count === 2 ? 112 : count > 4 ? 36 : 68;
  const fit = (text, width) => fitChoiceLabel(text, width, height, glyphWidth, measure);
  const labels = [fit(c.options[0].text, 180), fit(c.options[1].text, 192)];
  const centerWidth = count > 4 || labels.some(label => label.lines.length > 1) ? 136 : 270;
  const extraWidths = [centerWidth, centerWidth, 180, 192];
  c.options.slice(2).forEach(({text}, i) => labels.push(fit(text, extraWidths[i])));
  const offset = c.side * BOX_OFFSET;
  const centers = CHOICE_CENTERS.slice(0, count).map(([x, y], i) => [x, y + offset + (i === 2 && labels[i].lines.length > 1 ? 4 : 0)]);
  let heartX = 312, heartY = 76 + offset;
  const topLines = labels[2]?.lines.length, bottomLines = labels[3]?.lines.length;
  if (topLines > 1) heartY += 5;
  if (count >= 4) {
    if (topLines === 1 && bottomLines === 2) heartY -= 11;
    if (topLines === 2 && bottomLines === 1) heartY += 3;
    if (topLines === 2 && bottomLines === 2) heartY -= 4;
  }
  const idleX = heartX, idleY = heartY;
  for (const [i, label] of labels.entries()) {
    const [x, y] = centers[i];
    const color = c.selected && c.index === i ? UI_COLORS.yellow : UI_COLORS.white;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(label.scale, label.scale);
    if (kit) kit.drawText(ctx, label.content, 0, 0, {...font, color, align: 'center', baseline: 'middle'});
    else {
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      label.lines.forEach((line, row) => ctx.fillText(line, 0, (row - (label.lines.length - 1) / 2) * label.lineHeight));
    }
    ctx.restore();
    const weight = c.cursorWeights[i];
    heartX += weight * (x - Math.round(label.width / 2) - 22 - idleX);
    heartY += weight * (y - 8 - idleY);
  }
  if (!kit?.drawHeart(ctx, heartX, heartY, {sprite: 'spr_heartsmall_white', scale: 2})) {
    icon(ctx, '♥', heartX + 9, heartY + 9, 19, UI_COLORS.red);
  }
  return count === 2 && labels.every(label => label.lines.length === 1);
}

export function drawChoice(ctx, c, v, ui) {
  withUiViewport(ctx, () => {
    drawDialoguePanel(ctx, ui, c.side, c.boxAge);
    const hasPromptSpace = drawChoiceLabels(ctx, c, ui);
    if (!c.questionLines.length) return;
    const promptSide = hasPromptSpace && c.questionLines.length === 1 ? c.side : 1 - c.side;
    if (promptSide !== c.side) drawDialoguePanel(ctx, ui, promptSide, c.boxAge);
    drawWriterRows(ctx, ui, c.questionLines, promptSide);
  }, {width: v.w, height: v.h});
}
