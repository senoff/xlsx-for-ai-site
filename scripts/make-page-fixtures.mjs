#!/usr/bin/env node
/*
 * make-page-fixtures.mjs — mint the fixtures the page-DoD walk uploads.
 *
 * Every fixture here exists to make ONE page's check able to go RED. A generic
 * "valid workbook" cannot do that: a page that renders, spins, and hands back an
 * empty file passes any check whose fixture carries nothing the tool must find.
 * So each fixture carries the defect its own tool is supposed to see — real
 * duplicate rows, a real #REF!, real PII, a real macro payload, a real dangling
 * external link. If the tool silently no-ops, the assertion drawn from the
 * fixture's content fails, and that is the whole point.
 *
 * Outputs are TRACKED binaries under test/fixtures/pages/. This generator is
 * tracked with them so they are reproducible from a clean clone rather than
 * being mystery bytes someone once made.
 *
 * Run: npm run fixtures
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "pages");
mkdirSync(OUT, { recursive: true });

const written = [];
async function emit(name, buf) {
  writeFileSync(join(OUT, name), buf);
  written.push(`${name} (${buf.length} bytes)`);
}
async function book(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- rows.xlsx — the plain known-content workbook -------------------------
// Used by the pages whose job is to faithfully carry data through (convert →
// CSV, summarize's total, see-inside's preview grid, run-any-tool). The QTY
// column sums to 20 and the PRICE column to 40.50 — a page that hands back an
// empty or wrong file cannot print those.
await emit("rows.xlsx", await book({
  Sheet1: [
    ["sku", "qty", "price"],
    ["A-1", 3, 9.5],
    ["B-2", 7, 14.25],
    ["C-3", 1, 2],
    ["D-4", 9, 14.75],
  ],
  Notes: [["ignored"]],
}));

// --- duplicates.xlsx — for remove-duplicates (xlsx_data_clean) -------------
// DUP-1 appears three times and DUP-2 twice; UNIQ-1/UNIQ-2 appear once. The
// assertion is two-sided: the uniques must SURVIVE and the duplicate rows must
// COLLAPSE (6 data rows in, 4 out). A no-op passes neither half.
await emit("duplicates.xlsx", await book({
  Sheet1: [
    ["sku", "qty"],
    ["DUP-1", 5],
    ["UNIQ-1", 1],
    ["DUP-1", 5],
    ["DUP-2", 8],
    ["DUP-1", 5],
    ["DUP-2", 8],
    ["UNIQ-2", 2],
  ],
}));

// --- compare-a / compare-b — for compare (xlsx_diff) ----------------------
// Exactly three known deltas, one of each kind the differ must name:
//   B-2 qty 7 -> 70 (changed) · C-3 removed · E-5 added.
// A-1 is identical in both and must NOT be reported as a change.
await emit("compare-a.xlsx", await book({
  Sheet1: [["sku", "qty"], ["A-1", 3], ["B-2", 7], ["C-3", 1]],
}));
await emit("compare-b.xlsx", await book({
  Sheet1: [["sku", "qty"], ["A-1", 3], ["B-2", 70], ["E-5", 5]],
}));

// --- formula-errors.xlsx — for fix-formula-errors (xlsx_formulas) ---------
// Real broken formulas: a #REF! (deleted range), a #DIV/0! (divide by an empty
// cell), and a #NAME? (unknown function). Row 5 holds a HEALTHY formula that
// must NOT be reported — that is what stops "flags everything" from passing.
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["label", "value"]);
  ws.addRow(["broken-ref", null]);
  ws.addRow(["broken-div", null]);
  ws.addRow(["broken-name", null]);
  ws.addRow(["healthy", null]);
  ws.addRow(["divisor", 0]);
  ws.getCell("B2").value = { formula: "SUM(#REF!)", result: { error: "#REF!" } };
  ws.getCell("B3").value = { formula: "10/B6", result: { error: "#DIV/0!" } };
  ws.getCell("B4").value = { formula: "NOTAFUNCTION(1)", result: { error: "#NAME?" } };
  ws.getCell("B5").value = { formula: "1+1", result: 2 };
  await emit("formula-errors.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
}

// --- pii.xlsx — for remove-personal-data + get-ready-safely (xlsx_redact) --
// The sharpest red arm we have: assert these strings are ABSENT from the
// downloaded output. If redaction silently no-ops, they come back and the check
// goes red.
//
// Every value must be VALID by the detector's rules, or the fixture tests
// nothing. pii_frisk validates, it doesn't just pattern-match: an SSN with area
// 000/666/9xx is rejected (the SSA never issued those), and a bare 7-digit phone
// isn't a phone. A first draft of this fixture used 000-00-1234 and 555-0100 and
// sailed through un-redacted — the fixture was wrong, not the product. So: real
// area codes, SSNs outside the invalid blocks, Luhn-valid card numbers. The
// values are still synthetic (example.com, the 555-01xx reserved-fiction range,
// the standard test card numbers), so the fixture carries no real personal data.
await emit("pii.xlsx", await book({
  Sheet1: [
    ["name", "email", "phone", "ssn", "card", "note"],
    ["Ada L", "ada.lovelace@example.com", "(415) 555-0100", "123-45-6789", "4111 1111 1111 1111", "keep-this-cell"],
    ["Alan T", "alan.turing@example.com", "415-555-0101", "234-56-7890", "4012888888881881", "keep-this-too"],
  ],
}));

// --- broken-links.xlsx — for fix-broken-links (xlsx_healer_diagnose) ------
// A genuinely dangling external link: the workbook declares an externalLink
// part whose target is an absolute path to a file that does not exist, and a
// formula that references it. ExcelJS cannot author external links, so we
// ZIP-inject the parts — the same technique the product's own write path uses.
{
  const base = await book({ Sheet1: [["label", "value"], ["from-missing-book", null]] });
  const zip = await JSZip.loadAsync(base);

  const MISSING = "file:///Volumes/NoSuchVolume/missing-source-book.xlsx";
  zip.file(
    "xl/externalLinks/externalLink1.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<externalBook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1">' +
      '<sheetNames><sheetName val="Sheet1"/></sheetNames>' +
      '<sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1"><v>1</v></cell></row></sheetData></sheetDataSet>' +
      "</externalBook></externalLink>"
  );
  zip.file(
    "xl/externalLinks/_rels/externalLink1.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="${MISSING}" TargetMode="External"/>` +
      "</Relationships>"
  );

  // Register the part, then hang it off the workbook and point a formula at it.
  const ct = await zip.file("[Content_Types].xml").async("string");
  zip.file(
    "[Content_Types].xml",
    ct.replace(
      "</Types>",
      '<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>'
    )
  );
  const wbRels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  zip.file(
    "xl/_rels/workbook.xml.rels",
    wbRels.replace(
      "</Relationships>",
      '<Relationship Id="rIdExt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>'
    )
  );
  const wbXml = await zip.file("xl/workbook.xml").async("string");
  zip.file(
    "xl/workbook.xml",
    wbXml.replace(
      "</workbook>",
      '<externalReferences><externalReference r:id="rIdExt1"/></externalReferences></workbook>'
    )
  );
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  zip.file(
    "xl/worksheets/sheet1.xml",
    sheet.replace(
      /<c r="B2"[^>]*\/>|<c r="B2"[^>]*>.*?<\/c>/,
      '<c r="B2"><f>[1]Sheet1!A1</f><v>1</v></c>'
    )
  );

  await emit("broken-links.xlsx", await zip.generateAsync({ type: "nodebuffer" }));
}

// --- macros.xlsm — for check-for-macros (xlsx_macros) ---------------------
// A macro-bearing workbook: a vbaProject.bin part, the macroEnabled content
// type, and module names the detector surfaces. The .bin is synthetic (a CFB
// magic header plus UTF-16LE module names) — enough to be genuinely detected
// and named, while carrying no executable VBA. Same recipe the server's own
// xlsx_macros test uses.
{
  const base = await book({ Sheet1: [["x"]] });
  const zip = await JSZip.loadAsync(base);

  const chunks = [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)];
  for (const name of ["ThisWorkbook", "Module1", "Module2", "Sheet1", "Class1"]) {
    const utf16 = Buffer.alloc(name.length * 2);
    for (let i = 0; i < name.length; i++) utf16[i * 2] = name.charCodeAt(i);
    chunks.push(utf16, Buffer.alloc(16));
  }
  zip.file("xl/vbaProject.bin", Buffer.concat(chunks));

  const ct = await zip.file("[Content_Types].xml").async("string");
  zip.file(
    "[Content_Types].xml",
    ct
      .replace(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
      )
      .replace(
        "</Types>",
        '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'
      )
  );

  await emit("macros.xlsm", await zip.generateAsync({ type: "nodebuffer" }));
}

// --- shopify-products-messy.csv — for fix-shopify-products ----------------
// A real-world-shaped export with none of Shopify's canonical column names
// ("product name" not "Title", "url-slug" not "Handle"), variant rows whose
// parent fields are blank, and a leading-zero SKU that a spreadsheet would eat.
// The fix tool's whole job is to map this onto Shopify's import format, so the
// assertion is that the canonical headers come back — a page that hands the
// source file straight through cannot produce them.
await emit(
  "shopify-products-messy.csv",
  Buffer.from(
    [
      "product name,url-slug,description,brand,item-type,tags,active,color option,size option,sku-code,weight-grams,stock-qty,price-usd,compare-price,requires-ship,taxable,photo-url,seo-heading,seo-blurb,product-status",
      'Café Mug,cafe-mug,A ceramic mug for your morning brew.,Acme,Mugs,"coffee,mugs",TRUE,Black,S,0001234,350,50,12.99,15.99,TRUE,TRUE,https://cdn.example.com/mug-black-s.jpg,Café Mug - Acme,A great mug for coffee lovers.,active',
      "Café Mug,cafe-mug,,Acme,,,TRUE,Black,M,0001235,360,30,14.99,,TRUE,TRUE,,,,active",
      "Trail Cap,trail-cap,A cap for the trail.,Acme,Hats,hats,TRUE,Green,OS,0002001,120,15,24.50,,TRUE,TRUE,,,,active",
      "",
    ].join("\n"),
    "utf8"
  )
);

console.log(`fixtures -> ${OUT}`);
for (const w of written) console.log(`  ${w}`);
