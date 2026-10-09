# Tier 3: how a document looks (advisory only)

Tier 3 asks one question: **does this picture look like the one that was issued?** It cannot say whether a document is genuine.
Nothing in `phash.js` can return "approved". The strongest answer it gives is `CONSISTENT`, and the useful one is `REVIEW`.

## What is computed

| What | How | Stored |
|---|---|---|
| Page | 64-bit DCT perceptual hash of the whole normalised page | MongoDB (`visual`), never on chain |
| 16 tiles | the same hash for each tile of a 4x4 grid | MongoDB |
| Photo | the same hash for the photo's own region (the template says where it is) | MongoDB |

Every capture is first flattened, straightened, contrast-stretched and **cropped to its printed content** (`imaging.flatPage`), then
scaled to a fixed size, so two captures of one document line up. A tile that is blank is marked *flat* instead of hashed: the hash of a
uniform area is numerical noise.

## How it decides (`compareVisual`, thresholds in `config/tier3.json`)

- `CLOSE` nothing stands out -> advice `CONSISTENT`
- `LOCALISED` a few tiles, or the photo, changed while the rest held -> advice `REVIEW` (a pasted-over region or a swapped photo looks like this)
- `GLOBAL` many tiles differ (a very different capture, crop or document) -> advice `UNCLEAR`. It is deliberately **not** read as "just a re-capture, so fine".

## Regions that cannot be judged (found by driving the real UI)

A photo region is only worth judging if its hash is **stable under ordinary re-capture**. When a document is issued, each named region is
hashed again after JPEG q60, a half-size JPEG q70 copy and a 1px blur; the largest change is stored as `stability`.

| Photo box holds | `stability` (of 64) | judged? |
|---|---|---|
| a textured photograph (12 procedural photos) | 0 to 6 | yes |
| a flat, hard-edged graphic (the placeholder portraits) | 28 and 30 | **no** |

Why not just raise `regionFar`: for a flat graphic the re-capture distances reach 30 while a different picture starts at 16, so no single
threshold separates them (blurring before hashing did not fix it either, measured at sigma 1 to 4). `regionStableMax` (12) sits between the
two groups. A region above it is reported in `unreliableRegions`, never in `changedRegions`, and the verdict says the photo area "was not
checked". Before this, a JPEG copy of such a certificate was wrongly reported as `TAMPERED_VISUAL`. The cost is honest: on such a certificate a
photo swap is not detected by Tier 3 at all. Records issued before this was measured have no `stability` and are judged as before.

## Measured, on simulated captures (`npm run calibrate-tier3`)

| | result |
|---|---|
| 22 ordinary re-captures (JPEG, shrunk, rotated, dim, blurred, six different noise samples, photographed at an angle) | largest tile distance 8, photo region 6 (of 64) |
| 6 other photos in the photo box | photo region 24 to 34, photo tile 12 to 22, every other tile 0 |
| at the committed thresholds | 22 of 22 re-captures `CONSISTENT`, 6 of 6 swaps `REVIEW` |

## What it cannot see (known limitations)

- **A different person's card on the same template looks `CONSISTENT`** (largest tile 12, photo region 0 when only the text differs). Every card of one
  template looks alike once it is shrunk to a 32x32 hash. This is the overlap the issue warned about, measured.
- **Edits to printed text are invisible** (a changed date of birth: largest tile 0). Catching those is Tier 2's job.
- **The whole-page distance cannot see a photo swap** (2 to 6, the same as ordinary captures), so no decision uses it.
- A swap is caught only because the template tells us where the photo is. Another template needs its region measured.
- A strong disturbance (heavy blur, a very bad angle) can push many tiles over the threshold and produce `UNCLEAR`, which is the safe answer.

## What is NOT yet known

All numbers come from **simulated** captures of **one synthetic** certificate with **procedural** photos (and two flat placeholder portraits). Real phones, real cards and real
photo-swap forgeries have not been measured. The thresholds must be re-calibrated on a real sample (`npm run calibrate-tier3`) before anyone
relies on them.
