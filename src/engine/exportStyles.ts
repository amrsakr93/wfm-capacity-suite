import type ExcelJS from 'exceljs';

export const CNX = {
  NAVY_DARK: 'FF0B2234',
  NAVY_BRAND: 'FF003D5B',
  BLUE_PRIMARY: 'FF0088C2',
  BLUE_SOFT: 'FF38BDF8',
  BLUE_TINT: 'FFE6F4FA',
  TEAL_ACCENT: 'FF0D9488',
  TEAL_DARK: 'FF0F766E',
  TEAL_TINT: 'FFE6F7F5',
  CANVAS_BG: 'FFF4F7FA',
  CARD_BG: 'FFFFFFFF',
  ZEBRA_BG: 'FFF8FAFC',
  BORDER_LIGHT: 'FFD5E2EE',
  BORDER_MED: 'FF94B3CC',
  TEXT_DARK: 'FF0B2234',
  TEXT_MUTED: 'FF475569',
  TEXT_SUBTLE: 'FF64748B',
  WHITE: 'FFFFFFFF',
  GREEN_BG: 'FFD1FAE5',
  GREEN_FG: 'FF065F46',
  AMBER_BG: 'FFFEF3C7',
  AMBER_FG: 'FF92400E',
  ROSE_BG: 'FFFEE2E2',
  ROSE_FG: 'FF991B1B',
  SLATE_BG: 'FFF1F5F9',
  SLATE_FG: 'FF475569',
} as const;

export const EXCEL_FONT = 'Segoe UI';

export async function loadExcelJS(): Promise<typeof ExcelJS> {
  const mod = await import('exceljs');
  return ((mod as unknown as { default?: typeof ExcelJS }).default ?? mod) as typeof ExcelJS;
}

export function colLetter(colIdx1Based: number): string {
  let n = colIdx1Based;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function applyBoxBorder(
  cell: ExcelJS.Cell,
  color: string = CNX.BORDER_LIGHT,
  style: ExcelJS.BorderStyle = 'thin'
): void {
  cell.border = {
    top: { style, color: { argb: color } },
    bottom: { style, color: { argb: color } },
    left: { style, color: { argb: color } },
    right: { style, color: { argb: color } },
  };
}

export function paintDashboardBackdrop(
  ws: ExcelJS.Worksheet,
  maxRow: number,
  maxCol: number,
  bgArgb: string = CNX.CANVAS_BG
): void {
  ws.views = [{ showGridLines: false }];
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) {
      const cell = row.getCell(c);
      if (!cell.fill) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
      }
    }
  }
}

export function buildExecutiveBanner(opts: {
  ws: ExcelJS.Worksheet;
  colCount: number;
  title: string;
  subtitle: string;
  badgeText?: string;
}): void {
  const { ws, colCount, title, subtitle, badgeText } = opts;
  const splitCol = Math.max(2, colCount - 2);
  const endCol = colLetter(colCount);
  const titleEndCol = badgeText && colCount >= 4 ? colLetter(splitCol) : endCol;

  ws.mergeCells(`A1:${titleEndCol}1`);
  ws.mergeCells(`A2:${titleEndCol}2`);

  if (badgeText && colCount >= 4) {
    const badgeStart = colLetter(splitCol + 1);
    ws.mergeCells(`${badgeStart}1:${endCol}2`);
    const badgeCell = ws.getCell(`${badgeStart}1`);
    badgeCell.value = badgeText;
    badgeCell.font = { name: EXCEL_FONT, size: 9.5, bold: true, color: { argb: 'FFA5F3FC' } };
    badgeCell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
    badgeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.NAVY_DARK } };
  }

  const titleCell = ws.getCell('A1');
  titleCell.value = title;
  titleCell.font = { name: EXCEL_FONT, size: 14, bold: true, color: { argb: CNX.WHITE } };
  titleCell.alignment = { horizontal: 'left', vertical: 'bottom', indent: 1 };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.NAVY_DARK } };

  const subCell = ws.getCell('A2');
  subCell.value = subtitle;
  subCell.font = { name: EXCEL_FONT, size: 9.5, color: { argb: 'FF93C5FD' } };
  subCell.alignment = { horizontal: 'left', vertical: 'top', indent: 1 };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.NAVY_DARK } };

  ws.getRow(1).height = 24;
  ws.getRow(2).height = 19;

  // Accent bar on row 3
  ws.mergeCells(`A3:${endCol}3`);
  const barCell = ws.getCell('A3');
  barCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.BLUE_PRIMARY } };
  ws.getRow(3).height = 4;
}

export interface KpiCardSpec {
  colStart: number;
  colSpan: number;
  label: string;
  value: string | number;
  sublabel: string;
  numFmt?: string;
  accentArgb?: string;
  valueArgb?: string;
}

export function renderKpiCards(
  ws: ExcelJS.Worksheet,
  startRow: number,
  cards: KpiCardSpec[]
): number {
  const labelRow = ws.getRow(startRow);
  const valRow = ws.getRow(startRow + 1);
  const subRow = ws.getRow(startRow + 2);
  labelRow.height = 19;
  valRow.height = 28;
  subRow.height = 16;

  for (const card of cards) {
    const c1 = colLetter(card.colStart);
    const c2 = colLetter(card.colStart + card.colSpan - 1);
    const accent = card.accentArgb ?? CNX.BLUE_PRIMARY;
    const valColor = card.valueArgb ?? CNX.TEXT_DARK;

    if (card.colSpan > 1) {
      ws.mergeCells(`${c1}${startRow}:${c2}${startRow}`);
      ws.mergeCells(`${c1}${startRow + 1}:${c2}${startRow + 1}`);
      ws.mergeCells(`${c1}${startRow + 2}:${c2}${startRow + 2}`);
    }

    // Header band of KPI card
    for (let c = card.colStart; c < card.colStart + card.colSpan; c++) {
      const hCell = labelRow.getCell(c);
      hCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } };
      hCell.border = {
        top: { style: 'thin', color: { argb: accent } },
        left: c === card.colStart ? { style: 'thin', color: { argb: accent } } : undefined,
        right:
          c === card.colStart + card.colSpan - 1 ? { style: 'thin', color: { argb: accent } } : undefined,
      };
    }
    const headerTop = labelRow.getCell(card.colStart);
    headerTop.value = card.label.toUpperCase();
    headerTop.font = { name: EXCEL_FONT, size: 8.5, bold: true, color: { argb: CNX.WHITE } };
    headerTop.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    // Value band
    for (let c = card.colStart; c < card.colStart + card.colSpan; c++) {
      const vCell = valRow.getCell(c);
      vCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.CARD_BG } };
      vCell.border = {
        left: c === card.colStart ? { style: 'thin', color: { argb: CNX.BORDER_LIGHT } } : undefined,
        right:
          c === card.colStart + card.colSpan - 1
            ? { style: 'thin', color: { argb: CNX.BORDER_LIGHT } }
            : undefined,
      };
    }
    const valAnchor = valRow.getCell(card.colStart);
    valAnchor.value = card.value;
    valAnchor.font = { name: EXCEL_FONT, size: 15, bold: true, color: { argb: valColor } };
    valAnchor.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    if (card.numFmt) valAnchor.numFmt = card.numFmt;

    // Subtitle band
    for (let c = card.colStart; c < card.colStart + card.colSpan; c++) {
      const sCell = subRow.getCell(c);
      sCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.CARD_BG } };
      sCell.border = {
        bottom: { style: 'thin', color: { argb: CNX.BORDER_LIGHT } },
        left: c === card.colStart ? { style: 'thin', color: { argb: CNX.BORDER_LIGHT } } : undefined,
        right:
          c === card.colStart + card.colSpan - 1
            ? { style: 'thin', color: { argb: CNX.BORDER_LIGHT } }
            : undefined,
      };
    }
    const subAnchor = subRow.getCell(card.colStart);
    subAnchor.value = card.sublabel;
    subAnchor.font = { name: EXCEL_FONT, size: 8.5, color: { argb: CNX.TEXT_SUBTLE } };
    subAnchor.alignment = { horizontal: 'left', vertical: 'top', indent: 1 };
  }

  return startRow + 3;
}

export function renderSectionHeading(
  ws: ExcelJS.Worksheet,
  rowIdx: number,
  colStart: number,
  colEnd: number,
  title: string,
  accentArgb: string = CNX.NAVY_BRAND
): number {
  const c1 = colLetter(colStart);
  const c2 = colLetter(colEnd);
  if (colEnd > colStart) ws.mergeCells(`${c1}${rowIdx}:${c2}${rowIdx}`);
  const row = ws.getRow(rowIdx);
  row.height = 22;
  for (let c = colStart; c <= colEnd; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accentArgb } };
  }
  const anchor = row.getCell(colStart);
  anchor.value = title;
  anchor.font = { name: EXCEL_FONT, size: 10, bold: true, color: { argb: CNX.WHITE } };
  anchor.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  return rowIdx + 1;
}

export type PillTone = 'good' | 'warn' | 'bad' | 'info' | 'teal' | 'neutral';

export function stylePillCell(cell: ExcelJS.Cell, tone: PillTone, bold: boolean = true): void {
  const tones: Record<PillTone, { bg: string; fg: string }> = {
    good: { bg: CNX.GREEN_BG, fg: CNX.GREEN_FG },
    warn: { bg: CNX.AMBER_BG, fg: CNX.AMBER_FG },
    bad: { bg: CNX.ROSE_BG, fg: CNX.ROSE_FG },
    info: { bg: CNX.BLUE_TINT, fg: CNX.NAVY_BRAND },
    teal: { bg: CNX.TEAL_TINT, fg: CNX.TEAL_DARK },
    neutral: { bg: CNX.SLATE_BG, fg: CNX.SLATE_FG },
  };
  const t = tones[tone];
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: t.bg } };
  cell.font = { name: EXCEL_FONT, size: 9.5, bold, color: { argb: t.fg } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

export interface TableColumnSpec {
  header: string;
  align?: 'left' | 'center' | 'right';
  numFmt?: string;
  minWidth?: number;
  maxWidth?: number;
  summaryFn?: 'sum' | 'average' | 'label' | 'blank';
  summaryLabel?: string;
}

export interface StyledTableOptions {
  ws: ExcelJS.Worksheet;
  startRow: number;
  startCol?: number;
  columns: TableColumnSpec[];
  rows: (string | number | null | undefined)[][];
  headerArgb?: string;
  includeTotalsRow?: boolean;
  freezeHeader?: boolean;
  autoFilter?: boolean;
  showGridLines?: boolean;
  onCell?: (
    cell: ExcelJS.Cell,
    value: string | number | null | undefined,
    rowValues: (string | number | null | undefined)[],
    rowOffset: number,
    colOffset: number
  ) => void;
}

export function renderStyledTable(opts: StyledTableOptions): {
  headerRow: number;
  firstDataRow: number;
  lastDataRow: number;
  endRow: number;
} {
  const {
    ws,
    startRow,
    startCol = 1,
    columns,
    rows,
    headerArgb = CNX.NAVY_BRAND,
    includeTotalsRow = false,
    freezeHeader = false,
    autoFilter = false,
    showGridLines = true,
    onCell,
  } = opts;

  const colLengths = columns.map((c) => c.header.length);
  const headerRowObj = ws.getRow(startRow);
  headerRowObj.height = 28;

  columns.forEach((col, cIdx) => {
    const cell = headerRowObj.getCell(startCol + cIdx);
    cell.value = col.header;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerArgb } };
    cell.font = { name: EXCEL_FONT, size: 9.5, bold: true, color: { argb: CNX.WHITE } };
    cell.alignment = {
      horizontal: col.align ?? 'center',
      vertical: 'middle',
      wrapText: true,
    };
    cell.border = {
      top: { style: 'thin', color: { argb: headerArgb } },
      bottom: { style: 'medium', color: { argb: CNX.BLUE_PRIMARY } },
      left: { style: 'thin', color: { argb: CNX.NAVY_DARK } },
      right: { style: 'thin', color: { argb: CNX.NAVY_DARK } },
    };
  });

  const firstDataRow = startRow + 1;
  rows.forEach((rowVals, rIdx) => {
    const excelRowNum = firstDataRow + rIdx;
    const rowObj = ws.getRow(excelRowNum);
    rowObj.height = 20;
    const rowBg = rIdx % 2 === 1 ? CNX.ZEBRA_BG : CNX.CARD_BG;

    columns.forEach((col, cIdx) => {
      const val = rowVals[cIdx] ?? '';
      const cell = rowObj.getCell(startCol + cIdx);
      cell.value = val as ExcelJS.CellValue;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
      cell.font = { name: EXCEL_FONT, size: 9.5, color: { argb: CNX.TEXT_DARK } };
      cell.alignment = {
        horizontal: col.align ?? (typeof val === 'number' ? 'right' : 'left'),
        vertical: 'middle',
      };
      if (col.numFmt && typeof val === 'number') {
        cell.numFmt = col.numFmt;
      }
      cell.border = {
        bottom: { style: 'thin', color: { argb: CNX.BORDER_LIGHT } },
        left: { style: 'thin', color: { argb: 'FFEAF0F6' } },
        right: { style: 'thin', color: { argb: 'FFEAF0F6' } },
      };

      const textLen = String(val).length + (col.numFmt?.includes(',') ? 3 : 0);
      if (textLen > colLengths[cIdx]) colLengths[cIdx] = textLen;

      onCell?.(cell, val, rowVals, rIdx, cIdx);
    });
  });

  const lastDataRow = Math.max(firstDataRow, firstDataRow + rows.length - 1);
  let endRow = lastDataRow + 1;

  if (includeTotalsRow && rows.length > 0) {
    const totRowIdx = lastDataRow + 1;
    const totRow = ws.getRow(totRowIdx);
    totRow.height = 23;
    columns.forEach((col, cIdx) => {
      const colChar = colLetter(startCol + cIdx);
      const cell = totRow.getCell(startCol + cIdx);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.BLUE_TINT } };
      cell.font = { name: EXCEL_FONT, size: 9.5, bold: true, color: { argb: CNX.NAVY_DARK } };
      cell.border = {
        top: { style: 'thin', color: { argb: CNX.BLUE_PRIMARY } },
        bottom: { style: 'double', color: { argb: CNX.NAVY_BRAND } },
        left: { style: 'thin', color: { argb: CNX.BORDER_LIGHT } },
        right: { style: 'thin', color: { argb: CNX.BORDER_LIGHT } },
      };

      if (col.summaryFn === 'label') {
        cell.value = col.summaryLabel ?? 'TOTAL / AVG';
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      } else if (col.summaryFn === 'sum') {
        cell.value = { formula: `SUM(${colChar}${firstDataRow}:${colChar}${lastDataRow})` };
        if (col.numFmt) cell.numFmt = col.numFmt;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if (col.summaryFn === 'average') {
        cell.value = { formula: `AVERAGE(${colChar}${firstDataRow}:${colChar}${lastDataRow})` };
        if (col.numFmt) cell.numFmt = col.numFmt;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else {
        cell.value = '';
      }
    });
    endRow = totRowIdx + 1;
  }

  // Apply safe auto-widths (preserve existing wider width if sheet shares columns across tables)
  columns.forEach((col, cIdx) => {
    const wsCol = ws.getColumn(startCol + cIdx);
    const minW = col.minWidth ?? 12;
    const maxW = col.maxWidth ?? 42;
    const computed = Math.min(maxW, Math.max(minW, Math.ceil(colLengths[cIdx] * 1.08) + 4));
    if (!wsCol.width || computed > wsCol.width) {
      wsCol.width = computed;
    }
  });

  if (freezeHeader) {
    ws.views = [{ state: 'frozen', ySplit: startRow, showGridLines }];
  }
  if (autoFilter && rows.length > 0) {
    const c1 = colLetter(startCol);
    const c2 = colLetter(startCol + columns.length - 1);
    ws.autoFilter = `${c1}${startRow}:${c2}${lastDataRow}`;
  }

  return { headerRow: startRow, firstDataRow, lastDataRow, endRow };
}

export function addDataBar(
  ws: ExcelJS.Worksheet,
  colIdx1Based: number,
  firstRow: number,
  lastRow: number,
  argbHex: string = CNX.BLUE_PRIMARY
): void {
  if (lastRow < firstRow) return;
  const colChar = colLetter(colIdx1Based);
  const rule = {
    type: 'dataBar',
    priority: 1,
    gradient: true,
    cfvo: [{ type: 'num', value: 0 }, { type: 'max' }],
    color: { argb: argbHex },
  } as unknown as ExcelJS.ConditionalFormattingRule;

  ws.addConditionalFormatting({
    ref: `${colChar}${firstRow}:${colChar}${lastRow}`,
    rules: [rule],
  });
}

export function embedPngChart(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  dataUrl: string | null,
  tlCol0Based: number,
  tlRow0Based: number,
  widthPx: number,
  heightPx: number
): void {
  if (!dataUrl) return;
  const imageId = wb.addImage({ base64: dataUrl, extension: 'png' });
  ws.addImage(imageId, {
    tl: { col: tlCol0Based, row: tlRow0Based },
    ext: { width: widthPx, height: heightPx },
  });
}
