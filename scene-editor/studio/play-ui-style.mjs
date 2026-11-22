/* Injected by the player. Exported HTML embeds this module with the game. */
export const PLAY_UI_CSS = `
.play-savebar.play-developer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 6px 8px;
  background: #000;
  color: #fff;
}
.play-savebar.play-developer > button {
  padding: 4px 8px;
  border: 1px solid #696969;
  border-radius: 0;
  background: #000;
  color: #fff;
  font: 12px "Microsoft YaHei UI", monospace;
}
.play-savebar.play-developer > button:not(:disabled):hover { border-color: #fff; }
.play-savebar.play-developer > button:focus-visible { outline-color: #fff; }
`;
