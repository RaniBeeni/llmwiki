import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFile } from "node:fs/promises";

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 165; i++) {
  const page = pdf.addPage([595, 842]);
  page.drawText(`KSSB Synthetic Page ${i}`, { x: 72, y: 760, size: 12, font });
  page.drawText(`GOV-1.1 Oversight Body page ${i}`, { x: 72, y: 740, size: 12, font });
}
const bytes = await pdf.save();
await writeFile("/tmp/kssb-synthetic-165.pdf", bytes);
console.log(JSON.stringify({ pages: 165, bytes: bytes.length }));
