/**
 * Build importable/bulk-upload-shopify-metafields/metafields-apparel-basics.xlsx (XLS-1208).
 *
 * The demo file for the metafields hub page. Its whole job is to look like a spreadsheet a
 * real apparel merchant already keeps — NOT like a template we handed them. So every
 * header is the merchant's own wording, and not one of them is in Shopify's metafield
 * syntax:
 *
 *   Fabric Content · Wash Instructions · Fits Like · Ingredients · Tech Specs
 *
 * Those five are the page's claim: no strict-format wall. They map to
 * `product.metafields.custom.{material,care_instructions,size_and_fit,ingredients,
 * specifications}` on MEANING, through the same header mapper the whole engine uses.
 *
 * Three more columns exist to make the OTHER half of the ledger real, because a
 * what-I-mapped list nobody can check is just a claim:
 *   - `Product Title`  — a real product field, not a metafield. Not in the import file.
 *   - `Related Styles` — product REFERENCES. A hard type; it has its own page.
 *   - `Lookbook PDF`   — a file REFERENCE. Also a hard type, also its own page.
 * A visitor who uploads this sees those three under "what I couldn't", with the reason —
 * which is the honest answer and the reason the spoke pages exist.
 *
 * Blank cells are deliberate and load-bearing: garments have no ingredient deck, and the
 * two care products have no fit notes. A blank cell must produce NO import row at all
 * (a blank value on a metafield write is a clear), so the demo proves that too.
 *
 * Regenerate: node scripts/make-metafields-apparel-basics.mjs
 */

import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(
  ROOT,
  'importable',
  'bulk-upload-shopify-metafields',
  'metafields-apparel-basics.xlsx',
);

/** The merchant's own headers — deliberately none of them Shopify's syntax. */
const HEADERS = [
  'Product Handle',
  'Product Title',
  'Fabric Content',
  'Wash Instructions',
  'Fits Like',
  'Ingredients',
  'Tech Specs',
  'Related Styles',
  'Lookbook PDF',
];

/**
 * Ten products from one small apparel label: eight garments plus the two care products
 * such a label actually sells — which is where the `Ingredients` column comes from, and
 * why it is blank on the other eight.
 */
const PRODUCTS = [
  {
    handle: 'heritage-flannel-shirt',
    title: 'Heritage Flannel Shirt',
    fabric: '100% brushed cotton flannel, 210gsm',
    wash: 'Machine wash warm on gentle. Tumble dry low. Warm iron on the reverse.',
    fit: 'Relaxed through the body. Size down for a closer cut; the shoulder runs generous.',
    ingredients: '',
    specs: 'Weight 210gsm · Woven in Portugal · Corozo buttons · Body length 74cm (M)',
    related: 'waxed-canvas-tote, recycled-wool-scarf',
    lookbook: 'https://cdn.example-apparel.test/lookbook/heritage-flannel.pdf',
  },
  {
    handle: 'merino-crew-knit',
    title: 'Merino Crew Knit',
    fabric: '100% extra-fine merino wool (19.5 micron)',
    wash: 'Hand wash cool with wool detergent, or machine wool cycle. Dry flat in shape. Do not tumble dry.',
    fit: 'True to size, slim through the chest. Model is 183cm and wears M.',
    ingredients: '',
    specs: 'Weight 12gg knit · Knitted in Scotland · Ribbed cuffs and hem · Machine washable wool',
    related: 'heritage-flannel-shirt',
    lookbook: 'https://cdn.example-apparel.test/lookbook/merino-crew.pdf',
  },
  {
    handle: 'selvedge-denim-jean',
    title: 'Selvedge Denim Jean',
    fabric: '98% cotton, 2% elastane — 13.5oz Japanese selvedge',
    wash: 'Wash cold inside out, sparingly. Hang dry. Expect the indigo to fade with wear.',
    fit: 'Straight leg, mid rise. Raw denim: allow 1–2cm of stretch after the first wear.',
    ingredients: '',
    specs: '13.5oz · Milled in Okayama, Japan · Sewn in Portugal · Inseam 82cm (32)',
    related: 'heritage-flannel-shirt, waxed-canvas-tote',
    lookbook: '',
  },
  {
    handle: 'waxed-canvas-tote',
    title: 'Waxed Canvas Tote',
    fabric: '100% waxed cotton canvas, 18oz, with bridle leather handles',
    wash: 'Do not wash. Sponge clean with cold water. Re-wax annually with a canvas wax bar.',
    fit: 'One size. Holds a 15" laptop with room to spare.',
    ingredients: '',
    specs: '18oz canvas · 42cm x 38cm x 14cm · Made in England · Vegetable-tanned leather handles',
    related: 'leather-balm-tin',
    lookbook: 'https://cdn.example-apparel.test/lookbook/waxed-canvas.pdf',
  },
  {
    handle: 'recycled-wool-scarf',
    title: 'Recycled Wool Scarf',
    fabric: '70% recycled wool, 30% recycled polyamide',
    wash: 'Dry clean only. Do not wash, do not tumble dry.',
    fit: 'One size, 180cm x 32cm. Long enough to double-loop.',
    ingredients: '',
    specs: '180cm x 32cm · Woven in Yorkshire · GRS-certified recycled yarn',
    related: 'merino-crew-knit',
    lookbook: '',
  },
  {
    handle: 'organic-cotton-tee',
    title: 'Organic Cotton Tee',
    fabric: '100% GOTS-certified organic cotton, 180gsm',
    wash: 'Machine wash cold with like colours. Tumble dry low. Do not bleach.',
    fit: 'Classic fit, straight body. Between sizes? Take the larger.',
    ingredients: '',
    specs: '180gsm single jersey · GOTS certified · Made in Portugal · Pre-shrunk',
    related: '',
    lookbook: '',
  },
  {
    handle: 'linen-camp-shirt',
    title: 'Linen Camp Shirt',
    fabric: '100% European flax linen, 165gsm, garment-washed',
    wash: 'Machine wash cool on gentle. Line dry. Iron damp if you want it crisp — creasing is normal.',
    fit: 'Boxy, cropped at the hip. The camp collar sits open; size up for a fully relaxed look.',
    ingredients: '',
    specs: '165gsm · Flax grown in Normandy · Woven and made in Portugal · Coconut shell buttons',
    related: 'organic-cotton-tee',
    lookbook: 'https://cdn.example-apparel.test/lookbook/linen-camp.pdf',
  },
  {
    handle: 'rain-shell-parka',
    title: 'Rain Shell Parka',
    fabric: '100% recycled nylon face with a PFC-free DWR finish; 100% polyester mesh lining',
    wash: 'Machine wash warm, zip closed. Tumble dry low to reactivate the water repellency. No fabric softener.',
    fit: 'Roomy enough to layer a knit under. Size as normal.',
    ingredients: '',
    specs: '10k/10k waterproof-breathable · PFC-free DWR · Fully taped seams · Made in Vietnam',
    related: 'recycled-wool-scarf',
    lookbook: '',
  },
  {
    handle: 'wool-wash-concentrate',
    title: 'Wool Wash Concentrate',
    fabric: '',
    wash: 'One capful per hand-wash basin. Do not dilute before adding to the machine drawer.',
    fit: '',
    ingredients:
      'Aqua, Sodium Coco-Sulfate, Cocamidopropyl Betaine, Glycerin, Lanolin, Citric Acid, Lavandula Angustifolia Oil, Tocopherol',
    specs: '250ml · pH 6.5 · Made in the UK · Bottle is 100% post-consumer recycled HDPE',
    related: 'merino-crew-knit, recycled-wool-scarf',
    lookbook: '',
  },
  {
    handle: 'leather-balm-tin',
    title: 'Leather Balm Tin',
    fabric: '',
    wash: 'Apply a thin coat with a soft cloth, leave 20 minutes, buff off. Test on a hidden area first.',
    fit: '',
    ingredients:
      'Cera Alba (Beeswax), Prunus Amygdalus Dulcis Oil, Butyrospermum Parkii Butter, Lanolin, Tocopherol',
    specs: '100ml tin · Unscented · Made in the UK · Suitable for vegetable-tanned leather',
    related: 'waxed-canvas-tote',
    lookbook: '',
  },
];

const workbook = new ExcelJS.Workbook();
workbook.creator = 'xlsx-for-ai';
workbook.created = new Date('2026-08-30T00:00:00Z');
workbook.modified = new Date('2026-08-30T00:00:00Z');

const sheet = workbook.addWorksheet('Products');
sheet.addRow(HEADERS);
sheet.getRow(1).font = { bold: true };

for (const p of PRODUCTS) {
  sheet.addRow([
    p.handle,
    p.title,
    p.fabric,
    p.wash,
    p.fit,
    p.ingredients,
    p.specs,
    p.related,
    p.lookbook,
  ]);
}

sheet.columns = HEADERS.map((h) => ({ width: Math.max(16, Math.min(42, h.length + 12)) }));
sheet.getColumn(4).alignment = { wrapText: true, vertical: 'top' };
sheet.getColumn(5).alignment = { wrapText: true, vertical: 'top' };
sheet.getColumn(6).alignment = { wrapText: true, vertical: 'top' };
sheet.getColumn(7).alignment = { wrapText: true, vertical: 'top' };

await workbook.xlsx.writeFile(OUT);
console.log(`wrote ${OUT} — ${PRODUCTS.length} products, ${HEADERS.length} columns`);
