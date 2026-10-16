// Generates test/fixtures/cropped.pdf: a page whose CropBox clips part of
// the content. One text line sits inside the crop region (visible), one
// outside it (present in the content stream, clipped by every viewer).
// Used by the Phase C browser/mapping tests. Run: npx tsx test/gen-cropped.mts
import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);
page.drawText('CROPPED visible text', { x: 160, y: 620, size: 14, font });
page.drawText('OUTSIDE hidden text', { x: 40, y: 60, size: 14, font });
// CropBox: x in [100, 550], y in [150, 650] — line 1 inside, line 2 outside.
page.setCropBox(100, 150, 450, 500);
const bytes = await doc.save();
await writeFile(new URL('./fixtures/cropped.pdf', import.meta.url), bytes);
console.log(`wrote test/fixtures/cropped.pdf (${bytes.length} bytes)`);
