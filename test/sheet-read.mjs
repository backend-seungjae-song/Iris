import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { readSheet, writeSheet } from "../server/sheet.js";

test("XLSX with absolute table relationship targets still opens", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-sheet-read-"));
  const normal = path.join(dir, "normal.xlsx");
  const absolute = path.join(dir, "absolute-table-target.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("문제 목록");
    worksheet.addTable({
      name: "IssueTable",
      ref: "A1",
      headerRow: true,
      columns: [{ name: "항목" }],
      rows: [["열려야 함"]],
    });
    await workbook.xlsx.writeFile(normal);

    const zip = await JSZip.loadAsync(fs.readFileSync(normal));
    const relPath = "xl/worksheets/_rels/sheet1.xml.rels";
    const rel = await zip.file(relPath).async("string");
    assert.match(rel, /Target="\.\.\/tables\//);
    zip.file(relPath, rel.replace(/Target="\.\.\/tables\//g, 'Target="/xl/tables/'));
    fs.writeFileSync(absolute, await zip.generateAsync({ type: "nodebuffer" }));

    const data = await readSheet(absolute);
    assert.equal(data.sheets[0].name, "문제 목록");
    assert.equal(data.sheets[0].cells["2,1"][0], "열려야 함");

    await writeSheet(absolute, [{ sheet: "문제 목록", r: 2, c: 1, v: "수정 후에도 열림" }]);
    const saved = await readSheet(absolute);
    assert.equal(saved.sheets[0].cells["2,1"][0], "수정 후에도 열림");
    const savedZip = await JSZip.loadAsync(fs.readFileSync(absolute));
    assert.ok(savedZip.file("xl/tables/table1.xml"), "saving must preserve the workbook table definition");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OOXML 00-prefixed cell colors stay visible", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-sheet-color-"));
  const file = path.join(dir, "zero-alpha-colors.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("색상");
    const cell = worksheet.getCell("A1");
    cell.value = "보이는 값";
    cell.font = { color: { argb: "001F2937" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "00F8CBAD" } };
    await workbook.xlsx.writeFile(file);

    const data = await readSheet(file);
    const styleIndex = data.sheets[0].cells["1,1"][1];
    const style = data.styles[styleIndex - 1];
    assert.equal(data.sheets[0].cells["1,1"][0], "보이는 값");
    assert.equal(style.c, "#1f2937", "00RRGGBB font colors must not become fully transparent");
    assert.equal(style.bg, "#f8cbad", "00RRGGBB fill colors must not become fully transparent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
