// Berth block-arrow launch mark, drawn from the exact 16x16 sprite used in the product.
// '#' = filled cell. Rendered as crisp SVG rects so it is pixel-exact at any scale.
window.BERTH_MARK = [
  "................",
  ".......##.......",
  "......####......",
  ".....######.....",
  "....########....",
  "...##########...",
  "..############..",
  "..##..####..##..",
  "......####......",
  "......####......",
  "......####......",
  "................",
  "................",
  ".######..######.",
  ".######..######.",
  "................",
];
window.markSvg = function (size, color) {
  const rows = window.BERTH_MARK;
  let rects = "";
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x] === "#") rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="${color}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
};
