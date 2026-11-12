# Liora mascot — original Figma exports

Source: https://www.figma.com/design/qPiQYnD0QfdTu2PvTyiLpU/Project_2026?node-id=10-424

Designer: Liliia Huhliak. Retrieved 2026-11-12.

- `light/*.svg`: original vector layers of sticker `118:6482`.
- `dark/*.svg`: original vector layers of sticker `118:7523`.
- `liora-light.png` and `liora-dark.png`: untouched Figma exports used before JavaScript;
  these include the source frame's background. The live component uses the vector layers.
- Website color source: palette frame `122:2`.
- Existing primary CTA matches component `104:458`; its shape and typography are retained,
  with the website colors adapted to the current palette.

Files are untouched exports from Figma. Do not recolor, apply filters, crop, or regenerate them.
The website chooses the matching illustration through `src/styles/mascot.css`.
`src/ui/mascot-layers.json` and `src/styles/mascot-layers.css` preserve the original
260 × 260 layer positions, masks and rotations from Figma's design context. `mascot.ts`
builds those layers with DOM APIs; the whole illustration scales as one unit.
