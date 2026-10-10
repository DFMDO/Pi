// Gibt die Zuschnitte (shared/wall.js: tileCrop) für die Testfälle von tools/wall-experiment4.py als JSON aus.
import { tileCrop } from '../shared/wall.js';
const out = {};
for (const [cols, rows] of [[4, 1], [2, 2], [2, 1], [3, 1]]) {
  out[`${cols}x${rows}`] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out[`${cols}x${rows}`].push(tileCrop({ cols, rows, col: c, row: r, aspect: 16 / 9 }));
}
console.log(JSON.stringify(out));
