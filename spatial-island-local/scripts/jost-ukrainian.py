"""Builds the two small Jost supplements that give the island its Ukrainian letters.

Jost's Cyrillic (Google Fonts / Fontsource, identical files) has no і ї є (І Ї Є) or ґ, so those letters fell back to
the system sans in the middle of Jost words. Jost already draws the shapes elsewhere:
  - і І ї Ї are the Latin i I ï Ï: the first file copies those glyphs (variable, with their weight deltas) and maps
    them to U+0456 U+0406 U+0457 U+0407;
  - є Є are э Э mirrored: the second file reflects those outlines across their advance at the default master and
    rewrites every gvar delta the same way (x' = advance - x, so dx' = d_advance - dx), reversing contour order so the
    winding stays clockwise.
ґ Ґ are left to the fallback (the island's copy has none). Both outputs are OFL-1.1 like Jost (public/fonts/jost/OFL.txt).

Usage (fonttools + brotli): python -I scripts/jost-ukrainian.py public/fonts/jost
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(sys.argv[1])
DROP = ['GPOS', 'GSUB', 'GDEF', 'STAT']  # kerning and features would describe the source letters, not these


def trim(font: TTFont, family: str) -> None:
    for tag in DROP:
        if tag in font:
            del font[tag]
    for record in font['name'].names:
        if record.nameID in (1, 4, 16):
            record.string = family
        elif record.nameID == 6:
            record.string = family.replace(' ', '')


def subset_font(source: Path, glyphs: list[str]) -> TTFont:
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = []
    options.notdef_outline = False
    options.name_IDs = ['*']
    options.drop_tables += DROP
    font = TTFont(source)
    subsetter = subset.Subsetter(options)
    subsetter.populate(glyphs=glyphs)
    subsetter.subset(font)
    return font


def remap(font: TTFont, mapping: dict[int, str]) -> None:
    for table in font['cmap'].tables:
        if table.isUnicode():
            table.cmap = dict(mapping)


# і І ї Ї from the Latin file.
latin = subset_font(root / 'jost-latin.woff2', ['i', 'I', 'idieresis', 'Idieresis'])
remap(latin, {0x456: 'i', 0x406: 'I', 0x457: 'idieresis', 0x407: 'Idieresis'})
trim(latin, 'Jost Ukrainian I')
latin.flavor = 'woff2'
latin.save(root / 'jost-ukrainian-i.woff2')

# є Є: э Э mirrored.
cyrillic = subset_font(root / 'jost-cyrillic.woff2', ['uni044D', 'uni042D'])
glyf, gvar, hmtx = cyrillic['glyf'], cyrillic['gvar'], cyrillic['hmtx']
for name in ('uni044D', 'uni042D'):
    glyph = glyf[name]
    assert not glyph.isComposite(), name
    advance, _ = hmtx[name]
    points = len(glyph.coordinates)
    ends = list(glyph.endPtsOfContours)
    # New order: each contour keeps its first point and runs backwards (same quadratic curve, opposite direction).
    order, start = [], 0
    for end in ends:
        order += [start] + list(range(end, start, -1))
        start = end + 1
    original = [tuple(c) for c in glyph.coordinates]
    flags = list(glyph.flags)
    glyph.coordinates = type(glyph.coordinates)([(advance - original[i][0], original[i][1]) for i in order])
    glyph.flags = type(glyph.flags)([flags[i] for i in order])
    phantom = [(0, 0), (advance, 0), (0, 0), (0, 0)]
    for variation in gvar.variations.get(name, []):
        variation.calcInferredDeltas(original + phantom, ends + [points, points + 1, points + 2, points + 3])
        deltas = [d if d is not None else (0, 0) for d in variation.coordinates]
        d_advance = deltas[points + 1][0] - deltas[points][0]
        mirrored = [(d_advance - deltas[i][0], deltas[i][1]) for i in order]
        variation.coordinates = mirrored + deltas[points:]
    glyph.recalcBounds(glyf)
    hmtx[name] = (advance, glyph.xMin)
remap(cyrillic, {0x454: 'uni044D', 0x404: 'uni042D'})
trim(cyrillic, 'Jost Ukrainian Ye')
# HVAR only carries advances (unchanged by the mirror); a stale LSB map would be wrong, so drop it if present.
if 'HVAR' in cyrillic and cyrillic['HVAR'].table.LsbMap is not None:
    cyrillic['HVAR'].table.LsbMap = None
cyrillic.flavor = 'woff2'
cyrillic.save(root / 'jost-ukrainian-ye.woff2')

for out in ('jost-ukrainian-i.woff2', 'jost-ukrainian-ye.woff2'):
    check = TTFont(root / out)
    print(out, (root / out).stat().st_size, 'bytes', sorted(hex(u) for u in check.getBestCmap()),
          'axes', [a.axisTag for a in check['fvar'].axes])
