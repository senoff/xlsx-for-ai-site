/**
 * Build importable/import-shopify-metafields/metafields-safe-roundtrip.xlsx (XLS-1207).
 *
 * The demo file for the safe re-import page. It is a real export → edit → re-import
 * workbook, not a screenshot of one, so a visitor can run the page's own tool on it and
 * watch both footguns get caught.
 *
 * Sheet 1 "Metafields" is the edited sheet the tool reads: some values edited, several
 * cells deliberately left blank, and one row that changes a metafield's type. Sheet 2
 * "Store values before" is the state those rows are edited against — the reference a
 * reader (or the DoD check) compares against to see that a blank cell changed nothing.
 * Its headers share no name with the row-mode schema so the sheet selector can never
 * pick it as the import sheet.
 *
 * Regenerate: node scripts/make-metafields-roundtrip-demo.mjs
 */

import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'importable', 'import-shopify-metafields', 'metafields-safe-roundtrip.xlsx');

/** The pinned row-mode metafields columns, in export order. */
const IMPORT_HEADERS = [
  'Owner Type',
  'Owner ID',
  'Owner Handle',
  'Owner Parent Handle',
  'Variant SKU',
  'Namespace',
  'Key',
  'Type',
  'Value',
  'Command',
];

/**
 * The edited sheet. `value: null` is a genuinely empty cell — the whole point of the
 * demo: on re-import those metafields must be left exactly as they are.
 */
const EDITED_ROWS = [
  // Edited: a new care instruction for the tee.
  { handle: 'summer-tee', ns: 'custom', key: 'care', type: 'single_line_text_field', value: 'Machine wash cold, tumble dry low' },
  // Edited: a re-measured chest.
  { handle: 'summer-tee', ns: 'custom', key: 'chest_cm', type: 'number_decimal', value: '52.5' },
  // Left blank: the merchant did not touch the coat's care text.
  { handle: 'winter-coat', ns: 'custom', key: 'care', type: 'single_line_text_field', value: null },
  // Left blank: nor its chest measurement.
  { handle: 'winter-coat', ns: 'custom', key: 'chest_cm', type: 'number_decimal', value: null },
  // Left blank: nor the jacket's care text.
  { handle: 'rain-jacket', ns: 'custom', key: 'care', type: 'single_line_text_field', value: null },
  // Edited: a re-measured chest.
  { handle: 'rain-jacket', ns: 'custom', key: 'chest_cm', type: 'number_decimal', value: '58' },
  // Edited: a longer care instruction.
  { handle: 'wool-scarf', ns: 'custom', key: 'care', type: 'single_line_text_field', value: 'Hand wash in cool water, dry flat' },
  // THE TYPE FOOTGUN: chest_cm is a number everywhere else in this file. Writing
  // "one size" as text would be rejected store-side — a scarf has no chest measurement,
  // so the honest fix is a different key, not a retyped one.
  { handle: 'wool-scarf', ns: 'custom', key: 'chest_cm', type: 'single_line_text_field', value: 'one size' },
  // A metafield the scarf does not have yet — a create, not an update.
  { handle: 'wool-scarf', ns: 'custom', key: 'length_cm', type: 'number_decimal', value: '180' },
  // Left blank on a metafield that has no value either: still nothing to write.
  { handle: 'summer-tee', ns: 'custom', key: 'season', type: 'single_line_text_field', value: null },
];

/** What the store holds right now — the "before" half of the comparison. */
const BEFORE_ROWS = [
  ['summer-tee', 'custom.care', 'single_line_text_field', 'Machine wash warm'],
  ['summer-tee', 'custom.chest_cm', 'number_decimal', '52'],
  ['summer-tee', 'custom.season', 'single_line_text_field', '(not set)'],
  ['winter-coat', 'custom.care', 'single_line_text_field', 'Dry clean only'],
  ['winter-coat', 'custom.chest_cm', 'number_decimal', '61'],
  ['rain-jacket', 'custom.care', 'single_line_text_field', 'Rinse and hang dry'],
  ['rain-jacket', 'custom.chest_cm', 'number_decimal', '57'],
  ['wool-scarf', 'custom.care', 'single_line_text_field', 'Hand wash'],
  ['wool-scarf', 'custom.chest_cm', 'number_decimal', '43'],
  ['wool-scarf', 'custom.length_cm', '(no definition yet)', '(not set)'],
];

const workbook = new ExcelJS.Workbook();
workbook.creator = 'xlsx-for-ai';
workbook.created = new Date(Date.UTC(2026, 0, 1));
workbook.modified = new Date(Date.UTC(2026, 0, 1));

const sheet = workbook.addWorksheet('Metafields');
sheet.addRow(IMPORT_HEADERS);
for (const row of EDITED_ROWS) {
  sheet.addRow([
    'PRODUCT',
    null,
    row.handle,
    null,
    null,
    row.ns,
    row.key,
    row.type,
    row.value,
    null,
  ]);
}
sheet.getRow(1).font = { bold: true };
sheet.columns.forEach((column, index) => {
  column.width = index === 8 ? 38 : 20;
});

const before = workbook.addWorksheet('Store values before');
before.addRow(['Product handle', 'Metafield name', 'Current type', 'Current value']);
for (const row of BEFORE_ROWS) before.addRow(row);
before.getRow(1).font = { bold: true };
before.columns.forEach((column) => {
  column.width = 26;
});

await workbook.xlsx.writeFile(OUT);
console.log(`wrote ${OUT} — ${EDITED_ROWS.length} edited rows, ${BEFORE_ROWS.length} before rows`);
