# Making the real captures

The committed corpus simulates the physical steps with code. That shows the method works; it does not show it works on photographs from real phones, which is the claim that matters. This is the procedure for replacing the simulated files with real ones. It has **not been done yet**: it needs a printer, a scanner and two phones.

Use only the synthetic documents in `files/`. Never photograph a real document, a real person, or anyone's card.

## What you need

- A printer, and either a flatbed scanner or a phone for each capture.
- **Two different phones** (the plan's A3 and A4 are different cameras) and, ideally, a third device to receive the WhatsApp transfer.
- A table, a bright lamp, and a way to make the room dim.

## Steps

Print `files/A1_original.png` once at 100 % on plain paper (A5 or a card-sized crop). Keep that sheet; every capture below is of it.

| Save as | How |
|---|---|
| `A2_scan_300dpi.png` | Flatbed scan at 300 dpi, saved as PNG. |
| `A3_photo_bright.jpg` | Phone 1, good light, held about 5° off square. No flash, no filters, default camera app. |
| `A4_photo_lowlight.jpg` | **Phone 2**, dim room, about 20° skew, auto exposure. This is the hard case: keep it if it is poor, do not retake until it passes. |
| `A5_whatsapp.jpg` | Send `A3_photo_bright.jpg` to another device through WhatsApp **as a photo (not as a document)**, then save it from the receiving device. A genuine round trip, not a re-encode. |
| `B5_laundered.png` | Print `files/B1_dob_digit.png`, then scan or photograph the printout. This is the print-scan laundering case: the edit's digital traces are gone, only the printed text remains. |
| `C3_unreadable.jpg` | Photograph the printout out of focus and in the dark until it is genuinely unreadable. |

Optionally also print and photograph `B2`, `B3` and `B4` and save them under their own names with `_photo` added; they are not in the manifest, so use them by hand on the verify page.

## Run

```bash
mkdir ../my-captures            # put only the files you made here, named exactly as above
cd backend
npm run corpus -- --dir ../my-captures
```

Each file you provide replaces the corpus file of the same name and is marked **REAL capture** in the report. Files you did not provide stay simulated. Nothing is changed in `corpus/`.

## Record what you did

A result is only meaningful with its conditions. Keep a table next to the files (copy this into `my-captures/LOG.md`):

| File | Device | Lighting (lux or description) | Distance / angle | Settings | Date |
|---|---|---|---|---|---|
| A3_photo_bright.jpg | | | | | |

## Reading the result

- **`AUTHENTIC_COPY` for A2–A5:** the method held on real captures. Say how many and on which devices; do not generalise past them.
- **`INCONCLUSIVE` for a genuine capture:** the safe failure. The text or the picture could not be compared reliably. Check which: `npm run corpus -- --json` gives the reason. Then decide whether the capture really was poor or a threshold is too strict.
- **`TAMPERED_*` for a genuine capture:** a false accusation, the worst failure. Do not loosen a threshold to hide it without understanding it. The numbers to look at are `MISMATCH_CONFIDENCE` in `backend/tier2.js` (`npm run robustness` re-measures it) and `backend/config/tier3.json` (`npm run calibrate-tier3` re-measures it).
- **A tampered sample coming back `AUTHENTIC_*`:** a missed forgery. Stop and investigate; do not publish the claim.

Whatever the outcome, report it as measured: "N real captures on these devices", and say the rest is simulated.
