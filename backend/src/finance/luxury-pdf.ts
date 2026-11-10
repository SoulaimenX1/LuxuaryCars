// ==============================================================
// LUXUAR — BESPOKE LUXURY AUTOMOTIVE PDF GENERATOR
// Zero-dependency native PDF 1.4 engine supporting:
// 1. One-Page Luxury Commercial Invoice (A4 print-ready)
// 2. Two-Page Luxury Rental Contract & Covenants (A4 print-ready)
// 3. One-Page Official Payment Receipt (A4 print-ready)
// Embedded FlateDecode PNG photography, vector emblems,
// precise financial tables, and verified LUXUAR luxury identity.
// ==============================================================

import { Buffer } from 'node:buffer';
import * as zlib from 'node:zlib';

export interface LuxuryDocumentOptions {
  contractNumber?: string;
  reservationNumber?: string;
  invoiceNumber?: string;
  issuedAt?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  vehicleName?: string;
  brandName?: string;
  modelName?: string;
  licensePlate?: string;
  vin?: string;
  vehicleCategory?: string;
  pickupLocation?: string;
  dropoffLocation?: string;
  imageBuffer?: Buffer | null;
  pickupAt?: string;
  returnAt?: string;
  dailyPrice?: string;
  rentalDays?: number;
  subtotalAmount?: string;
  taxRate?: string;
  taxAmount?: string;
  totalAmount?: string;
  amountPaid?: string;
  balanceDue?: string;
  depositAmount?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  paymentReference?: string;
  paidAt?: string;
  deliveryFee?: string;
  discountAmount?: string;
  extrasAmount?: string;
  promotionCode?: string;
  mileageAllowance?: string;
  fuelPolicy?: string;
  departureInspection?: string;
  returnInspection?: string;
  handoverCondition?: string;
  authorizedDrivers?: string;
  signatureStatus?: string;
  terms?: string[];
  footerNote?: string;
  isDemo?: boolean;
}

interface DecodedPng {
  width: number;
  height: number;
  rgbDeflated: Buffer;
  alphaDeflated: Buffer;
}

/**
 * Parses and de-filters raw PNG bytes to extract deflated RGB and Alpha streams
 * for native PDF /FlateDecode image embedding without external binaries.
 */
function decodePngSafe(buf: Buffer): DecodedPng | null {
  try {
    if (!buf || buf.length < 24) return null;
    // Standard PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      return null;
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = 6;
    let bitDepth = 8;
    const idatChunks: Buffer[] = [];

    while (offset < buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.slice(offset + 4, offset + 8).toString('ascii');
      if (type === 'IHDR') {
        width = buf.readUInt32BE(offset + 8);
        height = buf.readUInt32BE(offset + 12);
        bitDepth = buf[offset + 16];
        colorType = buf[offset + 17];
        // Support standard 8-bit RGBA (6) and RGB (2)
        if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
          return null;
        }
      } else if (type === 'IDAT') {
        idatChunks.push(buf.slice(offset + 8, offset + 8 + len));
      }
      offset += 12 + len;
    }

    if (!width || !height || idatChunks.length === 0) return null;

    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const bpp = colorType === 6 ? 4 : 3;
    const rowLen = 1 + width * bpp;
    if (raw.length < height * rowLen) return null;

    const rgb = Buffer.alloc(width * height * 3);
    const alpha = Buffer.alloc(width * height);
    let prevRow = Buffer.alloc(width * bpp);
    let currRow = Buffer.alloc(width * bpp);

    function paeth(a: number, b: number, c: number): number {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    }

    for (let y = 0; y < height; y++) {
      const filter = raw[y * rowLen];
      const scan = raw.slice(y * rowLen + 1, (y + 1) * rowLen);

      for (let x = 0; x < width * bpp; x++) {
        const left = x >= bpp ? currRow[x - bpp] : 0;
        const up = prevRow[x];
        const upLeft = x >= bpp ? prevRow[x - bpp] : 0;
        let val = scan[x];

        if (filter === 1) val = (val + left) & 0xff;
        else if (filter === 2) val = (val + up) & 0xff;
        else if (filter === 3) val = (val + Math.floor((left + up) / 2)) & 0xff;
        else if (filter === 4) val = (val + paeth(left, up, upLeft)) & 0xff;

        currRow[x] = val;
      }

      for (let x = 0; x < width; x++) {
        const outPx = y * width + x;
        if (bpp === 4) {
          const px = x * 4;
          rgb[outPx * 3] = currRow[px];
          rgb[outPx * 3 + 1] = currRow[px + 1];
          rgb[outPx * 3 + 2] = currRow[px + 2];
          alpha[outPx] = currRow[px + 3];
        } else {
          const px = x * 3;
          rgb[outPx * 3] = currRow[px];
          rgb[outPx * 3 + 1] = currRow[px + 1];
          rgb[outPx * 3 + 2] = currRow[px + 2];
          alpha[outPx] = 255;
        }
      }

      const temp = prevRow;
      prevRow = currRow;
      currRow = temp;
    }

    return {
      width,
      height,
      rgbDeflated: zlib.deflateSync(rgb),
      alphaDeflated: zlib.deflateSync(alpha),
    };
  } catch {
    return null;
  }
}

function esc(value: string | number | undefined | null): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u20AC/g, 'EUR')
    .replace(/\u00B7/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[()\\]/g, '\\$&')
    .trim();
}

function truncate(str: string | undefined | null, maxChars: number): string {
  if (!str) return '';
  const s = String(str).trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 3) + '...';
}

function fmtMoney(amount: string | number | undefined | null): string {
  if (amount === undefined || amount === null || amount === '') return '0.00';
  const num = typeof amount === 'number' ? amount : parseFloat(String(amount).replace(/[^0-9.-]/g, ''));
  if (isNaN(num)) return '0.00';
  return num.toFixed(2);
}

function cleanShowroom(loc: string | undefined | null): string {
  if (!loc) return 'Budapest Flagship Showroom';
  let cleaned = String(loc).replace(/^LuxuryCars\s*(Showroom)?\s*[-–—]?\s*/i, '').trim();
  if (!cleaned) cleaned = String(loc);
  return truncate(cleaned, 28);
}

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return 'Scheduled Handover';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

function fmtDateOnly(iso: string | undefined | null): string {
  if (!iso) return 'Confirmed Date';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return String(iso);
  }
}

// ==============================================================
// 1. LUXURY COMMERCIAL INVOICE — STRICTLY ONE PAGE (A4)
// ==============================================================
function buildLuxuryInvoicePage(
  options?: LuxuryDocumentOptions,
  decodedImage?: DecodedPng | null,
): string[] {
  const p: string[] = [
    // Top Obsidian Banner (Height 96 pt: y = 746 to 842)
    '0.065 0.072 0.085 rg 0 746 595 96 re f',
    // Double Champagne Gold Rule
    '0.78 0.65 0.42 rg 0 744 595 2 re f',
    '0.38 0.32 0.22 rg 0 741 595 0.5 re f',

    // Vector Emblem: Diamond Crest
    '0.78 0.65 0.42 RG 1 w',
    '50 796 m 60 808 l 70 796 l 60 784 l h S',
    '55 796 m 60 802 l 65 796 l 60 790 l h S',
    '60 808 m 60 784 l S',
    '50 796 m 70 796 l S',

    // Brand Wordmark
    'BT /F2 15 Tf 0.85 0.72 0.48 rg 78 798 Td (L U X U A R) Tj ET',
    'BT /F1 7 Tf 0.72 0.68 0.60 rg 79 786 Td (P R E M I U M   A U T O M O T I V E   A T E L I E R) Tj ET',

    // Document Title & Subtitle
    'BT /F2 13.5 Tf 0.98 0.96 0.92 rg 40 763 Td (COMMERCIAL RENTAL INVOICE) Tj ET',
    `BT /F1 7.5 Tf 0.78 0.65 0.42 rg 40 750 Td (${
      options?.isDemo
        ? 'DEMONSTRATION FISCAL INVOICE - NOT A TAX-CERTIFIED DOCUMENT'
        : 'OFFICIAL COMMERCIAL RENTAL DOSSIER & SETTLEMENT RECORD'
    }) Tj ET`,
  ];

  // Top Right Reference Plaque (y = 748, w = 175, h = 86)
  p.push(
    '0.095 0.105 0.125 rg 380 748 175 86 re f',
    '0.78 0.65 0.42 rg 380 748 175 86 re S',
    '0.78 0.65 0.42 rg 380 830 4 4 re f 551 830 4 4 re f 380 748 4 4 re f 551 748 4 4 re f',
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 392 822 Td (INVOICE NUMBER:) Tj ET',
    `BT /F2 10 Tf 1 1 1 rg 392 810 Td (${esc(options?.invoiceNumber || 'INV-2026-000001')}) Tj ET`,
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 392 793 Td (ISSUANCE DATE / DOSSIER:) Tj ET',
    `BT /F1 8 Tf 0.92 0.92 0.92 rg 392 782 Td (${esc(fmtDateOnly(options?.issuedAt || options?.pickupAt))} · Ref: ${esc(
      truncate(options?.reservationNumber || 'RES-OFFICIAL', 12),
    )}) Tj ET`,
  );

  const status = options?.paymentStatus || 'PAID IN FULL';
  const isPaid = status.toUpperCase().includes('PAID') || status.toUpperCase().includes('SETTLED');
  p.push(
    `BT /F2 7.5 Tf ${isPaid ? '0.15 0.52 0.28' : '0.85 0.55 0.15'} rg 392 760 Td (STATUS: ${esc(
      status.toUpperCase(),
    )}) Tj ET`,
  );

  // -------------------------------------------------------------
  // CLIENT IDENTIFICATION & RENTAL LOGISTICS ROW (y = 665, h = 68)
  // -------------------------------------------------------------
  p.push(
    // Left Box: Bill To
    '0.975 0.968 0.955 rg 40 665 250 68 re f',
    '0.84 0.80 0.72 rg 40 665 250 68 re S',
    '0.92 0.89 0.84 rg 40 717 250 16 re f',
    '0.78 0.65 0.42 rg 40 717 4 16 re f',
    'BT /F2 8 Tf 0.14 0.15 0.18 rg 50 722 Td (01 · BILL TO / CLIENT IDENTIFICATION) Tj ET',
    `BT /F2 9.5 Tf 0.12 0.13 0.16 rg 50 702 Td (${esc(truncate(options?.customerName || 'Valued Private Client', 32))}) Tj ET`,
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 50 689 Td (${esc(truncate(options?.customerEmail || 'Verified Client Profile', 34))}) Tj ET`,
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 50 676 Td (${esc(options?.customerPhone || 'Showroom Concierge Handover')} · Account Verified) Tj ET`,

    // Right Box: Hire Period
    '0.975 0.968 0.955 rg 305 665 250 68 re f',
    '0.84 0.80 0.72 rg 305 665 250 68 re S',
    '0.92 0.89 0.84 rg 305 717 250 16 re f',
    '0.78 0.65 0.42 rg 305 717 4 16 re f',
    'BT /F2 8 Tf 0.14 0.15 0.18 rg 315 722 Td (02 · HIRE PERIOD & LOGISTICS) Tj ET',
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 315 702 Td (Collection: ${esc(fmtDate(options?.pickupAt))}) Tj ET`,
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 315 689 Td (Scheduled Return: ${esc(fmtDate(options?.returnAt))}) Tj ET`,
    `BT /F2 8 Tf 0.78 0.65 0.42 rg 315 676 Td (Duration: ${options?.rentalDays || 1} Days · Location: ${esc(
      cleanShowroom(options?.pickupLocation),
    )}) Tj ET`,
  );

  // -------------------------------------------------------------
  // VEHICLE SHOWCASE STAGE (y = 525, h = 130)
  // -------------------------------------------------------------
  if (decodedImage) {
    p.push(
      '0.05 0.055 0.065 rg 40 525 515 130 re f',
      '0.20 0.19 0.17 rg 40 525 515 130 re S',
      '0.78 0.65 0.42 rg 40 651 8 1.5 re f 40 644.5 1.5 8 re f',
      '0.78 0.65 0.42 rg 547 651 8 1.5 re f 553.5 644.5 1.5 8 re f',
      '0.78 0.65 0.42 rg 40 525 8 1.5 re f 40 525 1.5 8 re f',
      '0.78 0.65 0.42 rg 547 525 8 1.5 re f 553.5 525 1.5 8 re f',
    );

    const maxW = 320;
    const maxH = 96;
    const ratio = Math.min(maxW / decodedImage.width, maxH / decodedImage.height);
    const renderW = Math.round(decodedImage.width * ratio);
    const renderH = Math.round(decodedImage.height * ratio);
    const renderX = Math.round(40 + (515 - renderW) / 2);
    const renderY = Math.round(550 + (100 - renderH) / 2);

    p.push(`q ${renderW} 0 0 ${renderH} ${renderX} ${renderY} cm /Im1 Do Q`);

    // Bottom banner inside stage
    p.push(
      '0.08 0.09 0.11 rg 40 525 515 24 re f',
      '0.78 0.65 0.42 rg 40 548 515 1 re f',
      `BT /F2 9.5 Tf 0.95 0.90 0.80 rg 52 533 Td (${esc((options?.vehicleName || 'OFFICIAL FLEET ASSET').toUpperCase())}) Tj ET`,
      `BT /F1 7.5 Tf 0.78 0.65 0.42 rg 360 533 Td (PLATE: ${esc(options?.licensePlate || 'LC-OFFICIAL')} · VIN: ${esc(
        options?.vin || 'VERIFIED ON FILE',
      )}) Tj ET`,
    );
  } else {
    // Sleek fallback banner when photo not on disk
    p.push(
      '0.05 0.055 0.065 rg 40 615 515 40 re f',
      '0.78 0.65 0.42 rg 40 615 515 40 re S',
      `BT /F2 11 Tf 0.95 0.90 0.80 rg 52 630 Td (${esc((options?.vehicleName || 'REGISTERED LUXURY ASSET').toUpperCase())}) Tj ET`,
      `BT /F1 8 Tf 0.78 0.65 0.42 rg 370 630 Td (PLATE: ${esc(options?.licensePlate || 'LC-OFFICIAL')} · VIN: ${esc(
        options?.vin || 'VERIFIED',
      )}) Tj ET`,
    );
  }

  // -------------------------------------------------------------
  // ITEMIZED FINANCIAL TABLE (y = 210, h = 300)
  // -------------------------------------------------------------
  const tableY = decodedImage ? 210 : 255;
  const tableH = decodedImage ? 302 : 345;

  p.push(
    // Table container
    `0.985 0.980 0.970 rg 40 ${tableY} 515 ${tableH} re f`,
    `0.84 0.80 0.72 rg 40 ${tableY} 515 ${tableH} re S`,

    // Table Header Bar (Obsidian with gold text)
    `0.065 0.072 0.085 rg 40 ${tableY + tableH - 20} 515 20 re f`,
    `0.78 0.65 0.42 rg 40 ${tableY + tableH - 20} 515 1 re f`,
    `BT /F2 8 Tf 0.88 0.75 0.50 rg 52 ${tableY + tableH - 14} Td (ITEM / SERVICE DESCRIPTION) Tj ET`,
    `BT /F2 8 Tf 0.88 0.75 0.50 rg 315 ${tableY + tableH - 14} Td (DAILY RATE) Tj ET`,
    `BT /F2 8 Tf 0.88 0.75 0.50 rg 400 ${tableY + tableH - 14} Td (TERM / QTY) Tj ET`,
    `BT /F2 8 Tf 0.88 0.75 0.50 rg 490 ${tableY + tableH - 14} Td (AMOUNT EUR) Tj ET`,
  );

  // Line 1: Main Vehicle Hire
  let rowY = tableY + tableH - 40;
  const rentalDays = options?.rentalDays || 1;
  const dailyRate = options?.dailyPrice ? parseFloat(options.dailyPrice) : 0;
  const baseTotal = dailyRate > 0 ? dailyRate * rentalDays : parseFloat(options?.totalAmount || '0');

  p.push(
    `BT /F2 8.5 Tf 0.12 0.13 0.16 rg 52 ${rowY} Td (Luxury Fleet Hire - ${esc(options?.vehicleName || 'Vehicle Hire')}) Tj ET`,
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 52 ${rowY - 11} Td (Authoritative hire quote · Chassis: ${esc(options?.licensePlate || 'Fleet Asset')}) Tj ET`,
    `BT /F1 8 Tf 0.25 0.25 0.25 rg 315 ${rowY} Td (EUR ${fmtMoney(options?.dailyPrice)}) Tj ET`,
    `BT /F1 8 Tf 0.25 0.25 0.25 rg 400 ${rowY} Td (${rentalDays} Days) Tj ET`,
    `BT /F2 8.5 Tf 0.12 0.13 0.16 rg 480 ${rowY} Td (EUR ${fmtMoney(baseTotal)}) Tj ET`,
  );
  rowY -= 26;

  // Line 2: Delivery (if present)
  if (options?.deliveryFee && parseFloat(options.deliveryFee) > 0) {
    p.push(
      `BT /F2 8.5 Tf 0.12 0.13 0.16 rg 52 ${rowY} Td (White-Glove Delivery & Chauffeur Transfer) Tj ET`,
      `BT /F1 8 Tf 0.25 0.25 0.25 rg 315 ${rowY} Td (Included) Tj ET`,
      `BT /F1 8 Tf 0.25 0.25 0.25 rg 400 ${rowY} Td (1 Transfer) Tj ET`,
      `BT /F2 8.5 Tf 0.12 0.13 0.16 rg 480 ${rowY} Td (EUR ${fmtMoney(options.deliveryFee)}) Tj ET`,
    );
    rowY -= 20;
  }

  // Line 3: Extras (if present)
  if (options?.extrasAmount && parseFloat(options.extrasAmount) > 0) {
    p.push(
      `BT /F2 8.5 Tf 0.12 0.13 0.16 rg 52 ${rowY} Td (Tailored Concierge Extras & Vehicle Protection) Tj ET`,
      `BT /F1 8 Tf 0.25 0.25 0.25 rg 315 ${rowY} Td (Per Dossier) Tj ET`,
      `BT /F1 8 Tf 0.25 0.25 0.25 rg 400 ${rowY} Td (Active Term) Tj ET`,
      `BT /F2 8.5 Tf 0.12 0.13 0.16 rg 480 ${rowY} Td (EUR ${fmtMoney(options.extrasAmount)}) Tj ET`,
    );
    rowY -= 20;
  }

  // Line 4: Discount (if present)
  if (options?.discountAmount && parseFloat(options.discountAmount) > 0) {
    p.push(
      `BT /F2 8.5 Tf 0.15 0.52 0.28 rg 52 ${rowY} Td (Promotional Privilege - Code: ${esc(options.promotionCode || 'DIRECT')}) Tj ET`,
      `BT /F1 8 Tf 0.15 0.52 0.28 rg 315 ${rowY} Td (Special Rate) Tj ET`,
      `BT /F1 8 Tf 0.15 0.52 0.28 rg 400 ${rowY} Td (1 Cycle) Tj ET`,
      `BT /F2 8.5 Tf 0.15 0.52 0.28 rg 480 ${rowY} Td (-EUR ${fmtMoney(options.discountAmount)}) Tj ET`,
    );
    rowY -= 20;
  }

  // Divider above financial summary
  p.push(`0.84 0.80 0.72 rg 40 ${tableY + 112} 515 1 re f`);

  // Subtotal row
  const subtotal = options?.subtotalAmount || options?.totalAmount || '0.00';
  p.push(
    `BT /F1 8 Tf 0.45 0.43 0.40 rg 300 ${tableY + 96} Td (Rental Subtotal \\(Excl. VAT\\):) Tj ET`,
    `BT /F2 8.5 Tf 0.12 0.13 0.16 rg 476 ${tableY + 96} Td (EUR ${fmtMoney(subtotal)}) Tj ET`,
  );

  // VAT row
  const taxRate = options?.taxRate ? `${options.taxRate}%` : '0.00% Standard Rate';
  const taxAmount = options?.taxAmount || '0.00';
  p.push(
    `BT /F1 8 Tf 0.45 0.43 0.40 rg 300 ${tableY + 80} Td (Value Added Tax \\(${esc(taxRate)}\\):) Tj ET`,
    `BT /F1 8.5 Tf 0.25 0.25 0.25 rg 476 ${tableY + 80} Td (EUR ${fmtMoney(taxAmount)}) Tj ET`,
  );

  // Final Total Bar (Obsidian Gold Banner)
  p.push(
    `0.065 0.072 0.085 rg 40 ${tableY + 44} 515 26 re f`,
    `0.78 0.65 0.42 rg 40 ${tableY + 44} 515 1 re f`,
    `0.78 0.65 0.42 rg 40 ${tableY + 69} 515 1 re f`,
    `BT /F2 9.5 Tf 0.88 0.75 0.50 rg 52 ${tableY + 54} Td (FINAL COMMERCIAL INVOICE TOTAL) Tj ET`,
    `BT /F2 11.5 Tf 1 1 1 rg 450 ${tableY + 53} Td (EUR ${fmtMoney(options?.totalAmount)}) Tj ET`,
  );

  // Settlement & Balance row
  const amountPaid = options?.amountPaid || options?.totalAmount || '0.00';
  const balance = options?.balanceDue || '0.00';
  const payMethod = options?.paymentMethod || 'Stripe Gateway (Card)';
  p.push(
    `BT /F2 8 Tf 0.15 0.52 0.28 rg 52 ${tableY + 28} Td (AMOUNT SETTLED: EUR ${fmtMoney(amountPaid)}) Tj ET`,
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 230 ${tableY + 28} Td (Method: ${esc(payMethod)}) Tj ET`,
    `BT /F2 8 Tf 0.12 0.13 0.16 rg 420 ${tableY + 28} Td (OUTSTANDING BALANCE: EUR ${fmtMoney(balance)}) Tj ET`,
    `BT /F1 7 Tf 0.55 0.52 0.48 rg 52 ${tableY + 14} Td (* Payment confirmed and reconciled in full with authoritative bank and card gateway ledgers.) Tj ET`,
  );

  // -------------------------------------------------------------
  // DEDICATED SECURITY DEPOSIT BOX (y = 105, h = 95)
  // CRITICAL REQUIREMENT: SHOWN SEPARATELY FROM RENTAL REVENUE
  // -------------------------------------------------------------
  p.push(
    '0.975 0.968 0.955 rg 40 105 515 95 re f',
    '0.78 0.65 0.42 rg 40 105 515 95 re S',
    '0.92 0.89 0.84 rg 40 182 515 18 re f',
    '0.78 0.65 0.42 rg 40 182 4 18 re f',
    'BT /F2 8 Tf 0.14 0.15 0.18 rg 52 187 Td (04 · SECURITY DEPOSIT GUARANTEE · PRE-AUTHORIZED HOLD (NOT RENTAL REVENUE)) Tj ET',
    'BT /F1 8 Tf 0.45 0.43 0.40 rg 52 168 Td (Pre-Authorized Deposit Amount:) Tj ET',
    `BT /F2 10.5 Tf 0.78 0.65 0.42 rg 52 154 Td (EUR ${fmtMoney(options?.depositAmount || '0.00')}) Tj ET`,
    'BT /F1 7.5 Tf 0.15 0.52 0.28 rg 195 156 Td (Status: Pre-Authorized Guarantee Active in Escrow) Tj ET',
    'BT /F1 7.5 Tf 0.35 0.35 0.35 rg 52 138 Td (Important Notice: The security deposit is held as an independent temporary pre-authorization guarantee and is NOT rental income.) Tj ET',
    'BT /F1 7.5 Tf 0.35 0.35 0.35 rg 52 126 Td (It is completely excluded from commercial taxable invoice revenue and is released immediately following vehicle return inspection.) Tj ET',
    'BT /F1 7 Tf 0.55 0.52 0.48 rg 52 113 Td (Card Pre-authorization Reference: Verified on Booking Dossier · Concierge Support: luxurycarsrentcars@gmail.com) Tj ET',
  );

  // -------------------------------------------------------------
  // FOOTER (y = 20 to 52)
  // -------------------------------------------------------------
  p.push(
    '0.78 0.65 0.42 rg 40 54 515 1.5 re f',
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 40 40 Td (${esc(
      options?.footerNote ||
        'LUXUAR AUTOMOTIVE ATELIER KFT. · Showroom: Budapest Flagship Showroom · Concierge: luxurycarsrentcars@gmail.com',
    )}) Tj ET`,
    'BT /F2 8 Tf 0.78 0.65 0.42 rg 505 40 Td (Page 1 of 1) Tj ET',
    'BT /F1 6.5 Tf 0.65 0.62 0.58 rg 40 28 Td (OFFICIAL COMMERCIAL INVOICE DOSSIER · FISCAL RECORD · ALL RIGHTS RESERVED) Tj ET',
  );

  return p;
}

// ==============================================================
// 2. LUXURY RENTAL CONTRACT — STRICTLY TWO PAGES (A4)
// PAGE 1: RENTAL AGREEMENT
// PAGE 2: TERMS OF CUSTODY, VEHICLE CARE & SIGNATURES
// ==============================================================
function buildLuxuryContractPages(
  options?: LuxuryDocumentOptions,
  decodedImage?: DecodedPng | null,
): { page1: string[]; page2: string[] } {
  // -------------------------------------------------------------
  // CONTRACT PAGE 1: RENTAL AGREEMENT
  // -------------------------------------------------------------
  const p1: string[] = [
    // Top Obsidian Banner (Height 107 pt: y = 735 to 842)
    '0.065 0.072 0.085 rg 0 735 595 107 re f',
    // Double Champagne Gold Rule
    '0.78 0.65 0.42 rg 0 733 595 2 re f',
    '0.38 0.32 0.22 rg 0 730 595 0.5 re f',

    // Vector Emblem: Diamond Crest
    '0.78 0.65 0.42 RG 1 w',
    '50 792 m 60 804 l 70 792 l 60 780 l h S',
    '55 792 m 60 798 l 65 792 l 60 786 l h S',
    '60 804 m 60 780 l S',
    '50 792 m 70 792 l S',

    // Brand Wordmark
    'BT /F2 15 Tf 0.85 0.72 0.48 rg 78 794 Td (L U X U A R) Tj ET',
    'BT /F1 7 Tf 0.72 0.68 0.60 rg 79 782 Td (P R E M I U M   A U T O M O T I V E   A T E L I E R) Tj ET',

    // Document Title & Subtitle
    'BT /F2 13.5 Tf 0.98 0.96 0.92 rg 40 756 Td (OFFICIAL RENTAL AGREEMENT) Tj ET',
    'BT /F1 7.5 Tf 0.78 0.65 0.42 rg 40 742 Td (Official Custody & High-Performance Vehicle Hire Agreement) Tj ET',
  ];

  // Top Right Reference Plaque
  p1.push(
    '0.095 0.105 0.125 rg 380 742 175 88 re f',
    '0.78 0.65 0.42 rg 380 742 175 88 re S',
    '0.78 0.65 0.42 rg 380 826 4 4 re f 551 826 4 4 re f 380 742 4 4 re f 551 742 4 4 re f',
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 392 816 Td (CONTRACT REFERENCE:) Tj ET',
    `BT /F2 10 Tf 1 1 1 rg 392 804 Td (${esc(options?.contractNumber || 'CTR-2026-OFFICIAL')}) Tj ET`,
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 392 786 Td (BOOKING DOSSIER REF:) Tj ET',
    `BT /F2 9.5 Tf 0.92 0.92 0.92 rg 392 774 Td (${esc(options?.reservationNumber || 'RES-OFFICIAL')}) Tj ET`,
    `BT /F1 7.5 Tf 0.68 0.64 0.58 rg 392 754 Td (STATUS: ${esc((options?.paymentStatus || 'ACTIVE IN CUSTODY').toUpperCase())}) Tj ET`,
  );

  // Vehicle Showcase Stage (y = 562, h = 158)
  let nextY = 718;
  if (decodedImage) {
    p1.push(
      '0.05 0.055 0.065 rg 40 562 515 158 re f',
      '0.20 0.19 0.17 rg 40 562 515 158 re S',
      '0.78 0.65 0.42 rg 40 716 8 1.5 re f 40 709.5 1.5 8 re f',
      '0.78 0.65 0.42 rg 547 716 8 1.5 re f 553.5 709.5 1.5 8 re f',
      '0.78 0.65 0.42 rg 40 562 8 1.5 re f 40 562 1.5 8 re f',
      '0.78 0.65 0.42 rg 547 562 8 1.5 re f 553.5 562 1.5 8 re f',
    );

    const maxW = 330;
    const maxH = 120;
    const ratio = Math.min(maxW / decodedImage.width, maxH / decodedImage.height);
    const renderW = Math.round(decodedImage.width * ratio);
    const renderH = Math.round(decodedImage.height * ratio);
    const renderX = Math.round(40 + (515 - renderW) / 2);
    const renderY = Math.round(590 + (122 - renderH) / 2);

    p1.push(`q ${renderW} 0 0 ${renderH} ${renderX} ${renderY} cm /Im1 Do Q`);

    // Bottom Plaque Banner inside the stage
    p1.push(
      '0.08 0.09 0.11 rg 40 562 515 26 re f',
      '0.78 0.65 0.42 rg 40 587 515 1 re f',
      `BT /F2 10.5 Tf 0.95 0.90 0.80 rg 52 571 Td (${esc((options?.vehicleName || 'OFFICIAL FLEET ASSET').toUpperCase())}) Tj ET`,
      `BT /F1 7.5 Tf 0.78 0.65 0.42 rg 360 571 Td (PLATE: ${esc(options?.licensePlate || 'LC-OFFICIAL')} · VIN: ${esc(
        options?.vin || 'VERIFIED ON FILE',
      )}) Tj ET`,
    );

    nextY = 550;
  } else {
    p1.push(
      '0.05 0.055 0.065 rg 40 678 515 42 re f',
      '0.78 0.65 0.42 rg 40 678 515 42 re S',
      `BT /F2 11 Tf 0.95 0.90 0.80 rg 52 694 Td (${esc((options?.vehicleName || 'REGISTERED LUXURY ASSET').toUpperCase())}) Tj ET`,
      `BT /F1 8 Tf 0.78 0.65 0.42 rg 360 694 Td (PLATE: ${esc(options?.licensePlate || 'LC-OFFICIAL')} · VIN: ${esc(
        options?.vin || 'VERIFIED ON FILE',
      )}) Tj ET`,
    );
    nextY = 665;
  }

  // Section 01: Client Identification & Authorized Drivers (y = 460, h = 80)
  const sec1H = 80;
  const sec1Y = nextY - sec1H;
  p1.push(
    `0.975 0.968 0.955 rg 40 ${sec1Y} 515 ${sec1H} re f`,
    `0.84 0.80 0.72 rg 40 ${sec1Y} 515 ${sec1H} re S`,
    `0.92 0.89 0.84 rg 40 ${sec1Y + sec1H - 18} 515 18 re f`,
    `0.78 0.65 0.42 rg 40 ${sec1Y + sec1H - 18} 4 18 re f`,
    `BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 ${sec1Y + sec1H - 13} Td (01 · CLIENT IDENTIFICATION & AUTHORIZED DRIVERS) Tj ET`,

    // Col 1: Hirer
    `BT /F1 8 Tf 0.45 0.43 0.40 rg 52 ${sec1Y + 46} Td (Primary Registered Hirer:) Tj ET`,
    `BT /F2 9.5 Tf 0.12 0.13 0.16 rg 52 ${sec1Y + 33} Td (${esc(options?.customerName || 'Valued Private Client')}) Tj ET`,
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 52 ${sec1Y + 20} Td (${esc(truncate(options?.customerEmail || 'Verified Profile', 32))}) Tj ET`,
    `BT /F1 7.5 Tf 0.15 0.52 0.28 rg 52 ${sec1Y + 8} Td (Licence Credentials: Verified on File \\(EU/Int'l\\)) Tj ET`,

    // Col 2: Authorized Drivers & Contact
    `BT /F1 8 Tf 0.45 0.43 0.40 rg 280 ${sec1Y + 46} Td (Authorized Vehicle Operators:) Tj ET`,
    `BT /F2 9 Tf 0.12 0.13 0.16 rg 280 ${sec1Y + 33} Td (${esc(options?.authorizedDrivers || options?.customerName || 'Primary Hirer Only')}) Tj ET`,
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 280 ${sec1Y + 20} Td (Contact Telephone: ${esc(options?.customerPhone || '+36 Showroom Concierge')}) Tj ET`,
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 280 ${sec1Y + 8} Td (Operating Scope: Single Agency Custody \\(Budapest Showroom\\)) Tj ET`,
  );

  // Section 02: Handover Schedule & Policy (y = 368, h = 82)
  const sec2H = 82;
  const sec2Y = sec1Y - 10 - sec2H;
  p1.push(
    `0.975 0.968 0.955 rg 40 ${sec2Y} 515 ${sec2H} re f`,
    `0.84 0.80 0.72 rg 40 ${sec2Y} 515 ${sec2H} re S`,
    `0.92 0.89 0.84 rg 40 ${sec2Y + sec2H - 18} 515 18 re f`,
    `0.78 0.65 0.42 rg 40 ${sec2Y + sec2H - 18} 4 18 re f`,
    `BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 ${sec2Y + sec2H - 13} Td (02 · HANDOVER LOGISTICS, MILEAGE & FUEL POLICY) Tj ET`,

    // Col 1: Collection
    `BT /F1 8 Tf 0.45 0.43 0.40 rg 52 ${sec2Y + 48} Td (Collection Handover:) Tj ET`,
    `BT /F2 9 Tf 0.12 0.13 0.16 rg 52 ${sec2Y + 35} Td (${esc(fmtDate(options?.pickupAt))}) Tj ET`,
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 52 ${sec2Y + 22} Td (Location: ${esc(cleanShowroom(options?.pickupLocation))}) Tj ET`,
    `BT /F2 7.5 Tf 0.78 0.65 0.42 rg 52 ${sec2Y + 9} Td (Mileage: ${esc(options?.mileageAllowance || '250 km/day included')}) Tj ET`,

    // Col 2: Return
    `BT /F1 8 Tf 0.45 0.43 0.40 rg 280 ${sec2Y + 48} Td (Scheduled Return:) Tj ET`,
    `BT /F2 9 Tf 0.12 0.13 0.16 rg 280 ${sec2Y + 35} Td (${esc(fmtDate(options?.returnAt))}) Tj ET`,
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 280 ${sec2Y + 22} Td (Location: ${esc(cleanShowroom(options?.dropoffLocation))}) Tj ET`,
    `BT /F2 7.5 Tf 0.78 0.65 0.42 rg 280 ${sec2Y + 9} Td (Fuel Policy: ${esc(options?.fuelPolicy || 'Full-to-Full (98 Octane RON)')}) Tj ET`,
  );

  // Section 03: Financial Settlement & Security Deposit (y = 276, h = 82)
  const sec3H = 82;
  const sec3Y = sec2Y - 10 - sec3H;
  p1.push(
    `0.975 0.968 0.955 rg 40 ${sec3Y} 515 ${sec3H} re f`,
    `0.84 0.80 0.72 rg 40 ${sec3Y} 515 ${sec3H} re S`,
    `0.92 0.89 0.84 rg 40 ${sec3Y + sec3H - 18} 515 18 re f`,
    `0.78 0.65 0.42 rg 40 ${sec3Y + sec3H - 18} 4 18 re f`,
    `BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 ${sec3Y + sec3H - 13} Td (03 · FINANCIAL SETTLEMENT & SECURITY GUARANTEE) Tj ET`,

    // 4 Columns
    `BT /F1 8 Tf 0.45 0.43 0.40 rg 52 ${sec3Y + 48} Td (Daily Hire Rate:) Tj ET`,
    `BT /F2 10.5 Tf 0.12 0.13 0.16 rg 52 ${sec3Y + 34} Td (EUR ${fmtMoney(options?.dailyPrice)}) Tj ET`,
    `BT /F1 7 Tf 0.55 0.52 0.48 rg 52 ${sec3Y + 22} Td (per 24-hour cycle) Tj ET`,

    `BT /F1 8 Tf 0.45 0.43 0.40 rg 180 ${sec3Y + 48} Td (Total Rental Hire:) Tj ET`,
    `BT /F2 10.5 Tf 0.12 0.13 0.16 rg 180 ${sec3Y + 34} Td (EUR ${fmtMoney(options?.totalAmount)}) Tj ET`,
    `BT /F1 7 Tf 0.55 0.52 0.48 rg 180 ${sec3Y + 22} Td (inclusive of agreed VAT) Tj ET`,

    `BT /F1 8 Tf 0.45 0.43 0.40 rg 315 ${sec3Y + 48} Td (Security Deposit Hold:) Tj ET`,
    `BT /F2 10.5 Tf 0.78 0.65 0.42 rg 315 ${sec3Y + 34} Td (EUR ${fmtMoney(options?.depositAmount)}) Tj ET`,
    `BT /F1 7 Tf 0.55 0.52 0.48 rg 315 ${sec3Y + 22} Td (card pre-authorization) Tj ET`,

    `BT /F1 8 Tf 0.45 0.43 0.40 rg 440 ${sec3Y + 48} Td (Settlement Status:) Tj ET`,
    `BT /F2 9.5 Tf 0.15 0.52 0.28 rg 440 ${sec3Y + 34} Td (${esc(options?.paymentStatus || 'Reconciled')}) Tj ET`,
    `BT /F1 7 Tf 0.55 0.52 0.48 rg 440 ${sec3Y + 22} Td (escrow verified) Tj ET`,

    `BT /F1 7 Tf 0.50 0.48 0.45 rg 52 ${sec3Y + 8} Td (* Security deposit is pre-authorized on file and reconciled immediately upon formal vehicle return inspection.) Tj ET`,
  );

  // Section 04: Handover Condition & Departure Protocol (y = 184, h = 82)
  const sec4H = 82;
  const sec4Y = sec3Y - 10 - sec4H;
  p1.push(
    `0.975 0.968 0.955 rg 40 ${sec4Y} 515 ${sec4H} re f`,
    `0.84 0.80 0.72 rg 40 ${sec4Y} 515 ${sec4H} re S`,
    `0.92 0.89 0.84 rg 40 ${sec4Y + sec4H - 18} 515 18 re f`,
    `0.78 0.65 0.42 rg 40 ${sec4Y + sec4H - 18} 4 18 re f`,
    `BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 ${sec4Y + sec4H - 13} Td (04 · OPERATIONAL HANDOVER PROTOCOL & DEPARTURE INSPECTION) Tj ET`,

    `BT /F2 8.5 Tf 0.78 0.65 0.42 rg 52 ${sec4Y + 48} Td (>) Tj ET`,
    `BT /F1 8 Tf 0.25 0.25 0.25 rg 64 ${sec4Y + 48} Td (Handover condition, mileage, and fuel status are recorded via digital photographic inspection.) Tj ET`,

    `BT /F2 8.5 Tf 0.78 0.65 0.42 rg 52 ${sec4Y + 32} Td (>) Tj ET`,
    `BT /F1 8 Tf 0.25 0.25 0.25 rg 64 ${sec4Y + 32} Td (Only the registered hirer possessing verified credentials may operate this high-performance vehicle.) Tj ET`,

    `BT /F2 8.5 Tf 0.78 0.65 0.42 rg 52 ${sec4Y + 16} Td (>) Tj ET`,
    `BT /F1 8 Tf 0.25 0.25 0.25 rg 64 ${sec4Y + 16} Td (Standard vehicle damage protection and 24/7 concierge support apply per agreed covenants on Page 2.) Tj ET`,
  );

  // Page 1 Footer
  p1.push(
    '0.78 0.65 0.42 rg 40 54 515 1.5 re f',
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 40 40 Td (${esc(
      options?.footerNote || 'LUXUAR · MAISON DE LOCATION HAUTE PERFORMANCE · OFFICIAL RENTAL CONTRACT',
    )}) Tj ET`,
    'BT /F2 8 Tf 0.78 0.65 0.42 rg 505 40 Td (Page 1 of 2) Tj ET',
    'BT /F1 6.5 Tf 0.65 0.62 0.58 rg 40 28 Td (OFFICIAL LUXUAR RENTAL RECORD · CONCIERGE: luxurycarsrentcars@gmail.com · ALL RIGHTS RESERVED) Tj ET',
  );

  // -------------------------------------------------------------
  // CONTRACT PAGE 2: TERMS OF CUSTODY, VEHICLE CARE & SIGNATURES
  // -------------------------------------------------------------
  const p2: string[] = [
    // Top Obsidian Banner (Height 78 pt: y = 764 to 842)
    '0.065 0.072 0.085 rg 0 764 595 78 re f',
    '0.78 0.65 0.42 rg 0 762 595 2 re f',
    'BT /F2 13 Tf 0.85 0.72 0.48 rg 40 806 Td (L U X U A R   ·   R E N T A L   C O V E N A N T S) Tj ET',
    'BT /F2 15 Tf 0.98 0.96 0.92 rg 40 786 Td (TERMS OF CUSTODY, VEHICLE CARE & SIGNATURES) Tj ET',
    'BT /F1 8 Tf 0.75 0.72 0.65 rg 40 770 Td (Binding legal covenants governing high-performance vehicle custody, operations and return.) Tj ET',
  ];

  let y2 = 736;
  const contractTerms = [
    '1. VEHICLE CUSTODY & HANDOVER INSPECTION: The vehicle is delivered in immaculate aesthetic and mechanical condition. A photographic condition record of bodywork, wheel rims, mileage, and fuel level is logged at departure and serves as authoritative benchmark.',
    '2. OPERATING RESTRICTIONS & TRACK USE PROHIBITION: The vehicle may only be operated on public roads by verified drivers listed on the rental dossier. Track days, competitive trials, sub-leasing, and off-road driving are strictly prohibited and immediately void coverage.',
    '3. INSURANCE & LIABILITY LIMITS: The vehicle is protected under comprehensive luxury fleet insurance with agreed client deductible liability. Coverage strictly excludes gross negligence, driving under the influence, unauthorized operators, or track use.',
    '4. SECURITY DEPOSIT PRE-AUTHORIZATION & DEDUCTION: The security deposit hold remains pre-authorized on the client payment card throughout custody. Following return inspection, the hold is released in full or adjusted for any damage, missing accessories, or excess wear.',
    '5. FUEL & BATTERY RECHARGING CONDITIONS: The vehicle must be returned with the equivalent fuel level (minimum 98 Octane RON) or electric charge (80%+ SOC) recorded at collection. Deficits are reconciled against the security deposit at official showroom tariffs.',
    '6. TRAFFIC FINES, TOLLS & RETURN PUNCTUALITY: The hirer assumes complete legal and financial liability for any traffic, speeding, parking, or environmental infractions committed throughout custody. Delayed returns exceeding 60 minutes are subject to standard daily hire surcharges.',
  ];

  const termsToRender = options?.terms?.length ? options.terms : contractTerms;

  for (const term of termsToRender) {
    const parts = term.match(/.{1,98}(?:\s|$)/g) ?? [term];
    let first = true;
    for (const part of parts) {
      if (y2 < 235) break;
      if (first) {
        p2.push(`BT /F2 8.5 Tf 0.12 0.13 0.16 rg 40 ${y2} Td (${esc(part.trim())}) Tj ET`);
        first = false;
      } else {
        p2.push(`BT /F1 8 Tf 0.32 0.32 0.32 rg 40 ${y2} Td (${esc(part.trim())}) Tj ET`);
      }
      y2 -= 13;
    }
    y2 -= 5;
  }

  // Formal Acknowledgement Card (y = 168, h = 48)
  p2.push(
    '0.975 0.968 0.955 rg 40 168 515 48 re f',
    '0.78 0.65 0.42 rg 40 168 515 48 re S',
    '0.92 0.89 0.84 rg 40 200 515 16 re f',
    '0.78 0.65 0.42 rg 40 200 4 16 re f',
    'BT /F2 8 Tf 0.14 0.15 0.18 rg 52 205 Td (FORMAL CUSTODY ACKNOWLEDGEMENT & EXECUTION) Tj ET',
    'BT /F1 7.5 Tf 0.25 0.25 0.25 rg 52 188 Td (I hereby acknowledge receipt of the vehicle in the agreed condition and confirm that I have read, understood,) Tj ET',
    'BT /F1 7.5 Tf 0.25 0.25 0.25 rg 52 176 Td (and accept all covenants, insurance deductibles, deposit authorization terms, and operating stipulations herein.) Tj ET',
  );

  // Dual Signatures & Validation Block (y = 65, h = 95)
  p2.push(
    '0.985 0.980 0.970 rg 40 65 515 95 re f',
    '0.84 0.80 0.72 rg 40 65 515 95 re S',

    // Left Column: Client
    'BT /F2 8 Tf 0.15 0.15 0.18 rg 52 144 Td (AUTHORIZED HIRER / CLIENT:) Tj ET',
    `BT /F2 9.5 Tf 0.78 0.65 0.42 rg 52 131 Td (${esc(options?.customerName || 'Valued Client')}) Tj ET`,
    'BT /F1 7 Tf 0.15 0.52 0.28 rg 52 118 Td (Status: Electronically Signed on Booking Dossier) Tj ET',
    '0.55 0.55 0.55 rg 52 92 185 1 re f',
    'BT /F1 7 Tf 0.50 0.50 0.50 rg 52 82 Td (Client Signature & Date of Handover) Tj ET',

    // Right Column: Showroom Desk
    'BT /F2 8 Tf 0.15 0.15 0.18 rg 285 144 Td (SHOWROOM HANDOVER DESK:) Tj ET',
    'BT /F2 9 Tf 0.12 0.13 0.16 rg 285 131 Td (Showroom Handover Agent · Atelier Budapest) Tj ET',
    'BT /F1 7 Tf 0.15 0.52 0.28 rg 285 118 Td (Handover verification recorded and approved) Tj ET',
    '0.55 0.55 0.55 rg 285 92 135 1 re f',
    'BT /F1 7 Tf 0.50 0.50 0.50 rg 285 82 Td (Agent Signature & Showroom Seal) Tj ET',

    // Vector Showroom Stamp
    '0.78 0.65 0.42 rg 436 80 75 42 re S',
    '0.78 0.65 0.42 rg 438 82 71 38 re S',
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 444 108 Td (SHOWROOM) Tj ET',
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 440 98 Td (VALIDATION) Tj ET',
    'BT /F1 6 Tf 0.55 0.52 0.48 rg 440 88 Td (HANDOVER DESK) Tj ET',
  );

  // Page 2 Footer
  p2.push(
    '0.78 0.65 0.42 rg 40 54 515 1.5 re f',
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 40 40 Td (${esc(
      options?.footerNote || 'LUXUAR · MAISON DE LOCATION HAUTE PERFORMANCE · OFFICIAL RENTAL CONTRACT',
    )}) Tj ET`,
    'BT /F2 8 Tf 0.78 0.65 0.42 rg 505 40 Td (Page 2 of 2) Tj ET',
    'BT /F1 6.5 Tf 0.65 0.62 0.58 rg 40 28 Td (OFFICIAL LUXUAR RENTAL RECORD · CONCIERGE: luxurycarsrentcars@gmail.com · ALL RIGHTS RESERVED) Tj ET',
  );

  return { page1: p1, page2: p2 };
}

// ==============================================================
// 3. OFFICIAL PAYMENT RECEIPT — ONE PAGE (A4)
// ==============================================================
function buildLuxuryReceiptPage(
  title: string,
  subtitle: string,
  lines: string[],
  options?: LuxuryDocumentOptions,
  _decodedImage?: DecodedPng | null,
): string[] {
  const p: string[] = [
    // Top Obsidian Banner
    '0.065 0.072 0.085 rg 0 746 595 96 re f',
    '0.78 0.65 0.42 rg 0 744 595 2 re f',
    '0.38 0.32 0.22 rg 0 741 595 0.5 re f',

    // Vector Emblem: Diamond Crest
    '0.78 0.65 0.42 RG 1 w',
    '50 796 m 60 808 l 70 796 l 60 784 l h S',
    '55 796 m 60 802 l 65 796 l 60 790 l h S',
    '60 808 m 60 784 l S',
    '50 796 m 70 796 l S',

    // Brand Wordmark
    'BT /F2 15 Tf 0.85 0.72 0.48 rg 78 798 Td (L U X U A R) Tj ET',
    'BT /F1 7 Tf 0.72 0.68 0.60 rg 79 786 Td (P R E M I U M   A U T O M O T I V E   A T E L I E R) Tj ET',

    // Title & Subtitle
    `BT /F2 13.5 Tf 0.98 0.96 0.92 rg 40 763 Td (${esc(title)}) Tj ET`,
    `BT /F1 7.5 Tf 0.78 0.65 0.42 rg 40 750 Td (${esc(subtitle)}) Tj ET`,

    // Top Right Reference Plaque
    '0.095 0.105 0.125 rg 380 748 175 86 re f',
    '0.78 0.65 0.42 rg 380 748 175 86 re S',
    '0.78 0.65 0.42 rg 380 830 4 4 re f 551 830 4 4 re f 380 748 4 4 re f 551 748 4 4 re f',
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 392 822 Td (RECEIPT REFERENCE:) Tj ET',
    `BT /F2 9.5 Tf 1 1 1 rg 392 810 Td (${esc(truncate(options?.contractNumber || options?.reservationNumber || 'REC-OFFICIAL', 22))}) Tj ET`,
    'BT /F2 7.5 Tf 0.78 0.65 0.42 rg 392 793 Td (TRANSACTION DATE:) Tj ET',
    `BT /F1 8 Tf 0.92 0.92 0.92 rg 392 782 Td (${esc(fmtDateOnly(options?.pickupAt || options?.issuedAt))}) Tj ET`,
    'BT /F2 7.5 Tf 0.15 0.52 0.28 rg 392 760 Td (STATUS: SETTLED & RECONCILED) Tj ET',
  ];

  // Section 01: Client & Payment Reconciliation
  p.push(
    '0.975 0.968 0.955 rg 40 645 515 88 re f',
    '0.84 0.80 0.72 rg 40 645 515 88 re S',
    '0.92 0.89 0.84 rg 40 715 515 18 re f',
    '0.78 0.65 0.42 rg 40 715 4 18 re f',
    'BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 720 Td (01 · CLIENT IDENTIFICATION & PAYMENT RECONCILIATION) Tj ET',

    // Col 1: Client
    'BT /F1 8 Tf 0.45 0.43 0.40 rg 52 698 Td (Client Full Name:) Tj ET',
    `BT /F2 9.5 Tf 0.12 0.13 0.16 rg 52 685 Td (${esc(options?.customerName || 'Valued Client')}) Tj ET`,
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 52 672 Td (${esc(truncate(options?.customerEmail || 'Verified Profile', 26))}) Tj ET`,
    'BT /F1 7.5 Tf 0.15 0.52 0.28 rg 52 658 Td (Credentials: Verified on File) Tj ET',

    // Col 2: Reservation & Vehicle
    'BT /F1 8 Tf 0.45 0.43 0.40 rg 220 698 Td (Reservation Dossier:) Tj ET',
    `BT /F2 9 Tf 0.12 0.13 0.16 rg 220 685 Td (${esc(options?.reservationNumber || 'Official Rental Dossier')}) Tj ET`,
    'BT /F1 7.5 Tf 0.45 0.43 0.40 rg 220 672 Td (Vehicle Asset:) Tj ET',
    `BT /F2 8.5 Tf 0.78 0.65 0.42 rg 220 658 Td (${esc(truncate(options?.vehicleName || 'Registered Showroom Asset', 26))}) Tj ET`,

    // Col 3: Payment Ref
    'BT /F1 8 Tf 0.45 0.43 0.40 rg 385 698 Td (Payment Method & Gateway:) Tj ET',
    `BT /F2 9 Tf 0.12 0.13 0.16 rg 385 685 Td (${esc(options?.paymentMethod || 'Stripe Gateway')}) Tj ET`,
    'BT /F1 7.5 Tf 0.45 0.43 0.40 rg 385 672 Td (Settlement Timestamp:) Tj ET',
    `BT /F1 7.5 Tf 0.45 0.43 0.40 rg 385 658 Td (${esc(fmtDate(options?.pickupAt))}) Tj ET`,
  );

  // Section 02: Financial Settlement Metrics
  p.push(
    '0.975 0.968 0.955 rg 40 545 515 88 re f',
    '0.84 0.80 0.72 rg 40 545 515 88 re S',
    '0.92 0.89 0.84 rg 40 615 515 18 re f',
    '0.78 0.65 0.42 rg 40 615 4 18 re f',
    'BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 620 Td (02 · FINANCIAL SETTLEMENT & TRANSACTION BREAKDOWN) Tj ET',

    'BT /F1 8 Tf 0.45 0.43 0.40 rg 52 595 Td (Total Amount Settled:) Tj ET',
    `BT /F2 11 Tf 0.12 0.13 0.16 rg 52 581 Td (EUR ${fmtMoney(options?.totalAmount)}) Tj ET`,
    'BT /F1 7 Tf 0.15 0.52 0.28 rg 52 569 Td (reconciled & verified) Tj ET',

    'BT /F1 8 Tf 0.45 0.43 0.40 rg 180 595 Td (Transaction Classification:) Tj ET',
    `BT /F2 9.5 Tf 0.78 0.65 0.42 rg 180 581 Td (${esc(truncate(options?.paymentStatus || 'PAYMENT SETTLE', 20))}) Tj ET`,
    'BT /F1 7 Tf 0.55 0.52 0.48 rg 180 569 Td (official fiscal entry) Tj ET',

    'BT /F1 8 Tf 0.45 0.43 0.40 rg 330 595 Td (Security Deposit Status:) Tj ET',
    `BT /F2 9.5 Tf 0.12 0.13 0.16 rg 330 581 Td (EUR ${fmtMoney(options?.depositAmount || '0.00')}) Tj ET`,
    'BT /F1 7 Tf 0.55 0.52 0.48 rg 330 569 Td (card pre-authorization hold) Tj ET',

    'BT /F1 8 Tf 0.45 0.43 0.40 rg 450 595 Td (Settlement Status:) Tj ET',
    'BT /F2 9.5 Tf 0.15 0.52 0.28 rg 450 581 Td (SETTLED) Tj ET',
    'BT /F1 7 Tf 0.55 0.52 0.48 rg 450 569 Td (audit ledger confirmed) Tj ET',

    'BT /F1 7 Tf 0.50 0.48 0.45 rg 52 552 Td (* Official financial transaction record generated and signed by LUXUAR treasury and concierge desk.) Tj ET',
  );

  // Section 03: Transaction Audit Ledger Notes
  p.push(
    '0.975 0.968 0.955 rg 40 380 515 152 re f',
    '0.84 0.80 0.72 rg 40 380 515 152 re S',
    '0.92 0.89 0.84 rg 40 514 515 18 re f',
    '0.78 0.65 0.42 rg 40 514 4 18 re f',
    'BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 519 Td (03 · TRANSACTION AUDIT LEDGER & RECONCILIATION NOTES) Tj ET',
  );

  let noteY = 496;
  const items = lines.length > 0 ? lines : [
    `Customer: ${options?.customerName || 'Valued Client'}`,
    `Vehicle: ${options?.vehicleName || 'Registered Fleet Asset'}`,
    `Reservation: ${options?.reservationNumber || 'Dossier Ref'}`,
    `Transaction type: ${options?.paymentStatus || 'SETTLEMENT'}`,
    `Amount: EUR ${fmtMoney(options?.totalAmount)}`,
    'Status: Officially Settled and Reconciled in Ledger',
  ];

  for (const line of items.slice(0, 7)) {
    p.push(
      `BT /F2 8.5 Tf 0.78 0.65 0.42 rg 52 ${noteY} Td (>) Tj ET`,
      `BT /F1 8 Tf 0.25 0.25 0.25 rg 64 ${noteY} Td (${esc(line.slice(0, 92))}) Tj ET`,
    );
    noteY -= 15;
  }

  // Official Treasury Stamp on Receipt
  p.push(
    '0.78 0.65 0.42 rg 426 392 95 44 re S',
    '0.78 0.65 0.42 rg 428 394 91 40 re S',
    'BT /F2 7 Tf 0.78 0.65 0.42 rg 445 420 Td (TREASURY) Tj ET',
    'BT /F2 7.5 Tf 0.15 0.52 0.28 rg 437 408 Td (RECONCILED) Tj ET',
    'BT /F1 6.5 Tf 0.55 0.52 0.48 rg 439 398 Td (AUDIT CLEARED) Tj ET',
  );

  // Section 04: Official Treasury Attestation
  p.push(
    '0.965 0.958 0.945 rg 40 185 515 180 re f',
    '0.84 0.80 0.72 rg 40 185 515 180 re S',
    '0.92 0.89 0.84 rg 40 347 515 18 re f',
    '0.78 0.65 0.42 rg 40 347 4 18 re f',
    'BT /F2 8.5 Tf 0.14 0.15 0.18 rg 52 352 Td (04 · OFFICIAL TREASURY ATTESTATION & COMPLIANCE) Tj ET',
    'BT /F1 7.5 Tf 0.35 0.35 0.35 rg 52 330 Td (This document serves as definitive official payment verification for the aforementioned client reservation dossier.) Tj ET',
    'BT /F1 7.5 Tf 0.35 0.35 0.35 rg 52 316 Td (All transactions are reconciled through the LUXUAR private office treasury in full compliance with European financial standards.) Tj ET',
    'BT /F1 7.5 Tf 0.35 0.35 0.35 rg 52 302 Td (For audit inquiries, deposit escrow release, or tax statements, please contact concierge: luxurycarsrentcars@gmail.com) Tj ET',
    '0.78 0.65 0.42 rg 52 270 220 1 re f',
    'BT /F1 7 Tf 0.50 0.48 0.45 rg 52 258 Td (Authorized Concierge Desk Financial Seal & Electronic Clearance) Tj ET',
    'BT /F2 8 Tf 0.15 0.52 0.28 rg 360 270 Td (STATUS: VERIFIED & CLEARED) Tj ET',
  );

  // Receipt Footer
  p.push(
    '0.78 0.65 0.42 rg 40 54 515 1.5 re f',
    `BT /F1 7.5 Tf 0.50 0.48 0.45 rg 40 40 Td (${esc(
      options?.footerNote || 'LUXUAR · OFFICIAL PAYMENT RECEIPT · CONCIERGE: luxurycarsrentcars@gmail.com',
    )}) Tj ET`,
    'BT /F2 8 Tf 0.78 0.65 0.42 rg 505 40 Td (Page 1 of 1) Tj ET',
    'BT /F1 6.5 Tf 0.65 0.62 0.58 rg 40 28 Td (OFFICIAL PAYMENT TRANSACTION RECORD · ALL RIGHTS RESERVED) Tj ET',
  );

  return p;
}

// ==============================================================
// 4. MAIN DISPATCHER & PDF OBJECT COMPOSER
// ==============================================================
export function createLuxuryPdf(
  title: string,
  subtitle: string,
  lines: string[] = [],
  options?: LuxuryDocumentOptions,
): Buffer {
  const isInvoice = title.toUpperCase().includes('INVOICE');
  const isReceipt = title.toUpperCase().includes('RECEIPT');

  const image = options?.imageBuffer ? decodePngSafe(options.imageBuffer) : null;

  let page1Commands: string[] = [];
  let page2Commands: string[] | null = null;

  if (isInvoice) {
    page1Commands = buildLuxuryInvoicePage(options, image);
  } else if (isReceipt) {
    page1Commands = buildLuxuryReceiptPage(title, subtitle, lines, options, image);
  } else {
    const { page1, page2 } = buildLuxuryContractPages(options, image);
    page1Commands = page1;
    page2Commands = page2;
  }

  const p1Buf = Buffer.from(page1Commands.join('\n') + '\n', 'latin1');
  const p2Buf = page2Commands ? Buffer.from(page2Commands.join('\n') + '\n', 'latin1') : null;

  const isMultiPage = Boolean(p2Buf);

  // -------------------------------------------------------------
  // BUILD PDF 1.4 OBJECT STRUCTURE
  // -------------------------------------------------------------
  const objects: Buffer[] = [];

  if (isMultiPage && p2Buf) {
    objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>\n', 'latin1'));
    objects.push(Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\n', 'latin1'));

    if (image) {
      objects.push(
        Buffer.from(
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Im1 9 0 R >> >> /Contents 7 0 R >>\n',
          'latin1',
        ),
      );
      objects.push(
        Buffer.from(
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 8 0 R >>\n',
          'latin1',
        ),
      );
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n', 'latin1'));
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n', 'latin1'));
      objects.push(
        Buffer.concat([
          Buffer.from(`<< /Length ${p1Buf.length} >>\nstream\n`, 'latin1'),
          p1Buf,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
      objects.push(
        Buffer.concat([
          Buffer.from(`<< /Length ${p2Buf.length} >>\nstream\n`, 'latin1'),
          p2Buf,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
      objects.push(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 10 0 R /Length ${image.rgbDeflated.length} >>\nstream\n`,
            'latin1',
          ),
          image.rgbDeflated,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
      objects.push(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alphaDeflated.length} >>\nstream\n`,
            'latin1',
          ),
          image.alphaDeflated,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
    } else {
      objects.push(
        Buffer.from(
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 7 0 R >>\n',
          'latin1',
        ),
      );
      objects.push(
        Buffer.from(
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 8 0 R >>\n',
          'latin1',
        ),
      );
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n', 'latin1'));
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n', 'latin1'));
      objects.push(
        Buffer.concat([
          Buffer.from(`<< /Length ${p1Buf.length} >>\nstream\n`, 'latin1'),
          p1Buf,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
      objects.push(
        Buffer.concat([
          Buffer.from(`<< /Length ${p2Buf.length} >>\nstream\n`, 'latin1'),
          p2Buf,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
    }
  } else {
    // Single-page document (Invoices, Receipts)
    objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>\n', 'latin1'));
    objects.push(Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n', 'latin1'));

    if (image) {
      objects.push(
        Buffer.from(
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 6 0 R >>\n',
          'latin1',
        ),
      );
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n', 'latin1'));
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n', 'latin1'));
      objects.push(
        Buffer.concat([
          Buffer.from(`<< /Length ${p1Buf.length} >>\nstream\n`, 'latin1'),
          p1Buf,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
      objects.push(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 8 0 R /Length ${image.rgbDeflated.length} >>\nstream\n`,
            'latin1',
          ),
          image.rgbDeflated,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
      objects.push(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alphaDeflated.length} >>\nstream\n`,
            'latin1',
          ),
          image.alphaDeflated,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
    } else {
      objects.push(
        Buffer.from(
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\n',
          'latin1',
        ),
      );
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n', 'latin1'));
      objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n', 'latin1'));
      objects.push(
        Buffer.concat([
          Buffer.from(`<< /Length ${p1Buf.length} >>\nstream\n`, 'latin1'),
          p1Buf,
          Buffer.from('\nendstream\n', 'latin1'),
        ]),
      );
    }
  }

  // Cross-reference table & trailer
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets: number[] = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(chunks.reduce((sum, c) => sum + c.length, 0));
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    chunks.push(objects[i]);
    chunks.push(Buffer.from('endobj\n', 'latin1'));
  }

  const xrefOffset = chunks.reduce((sum, c) => sum + c.length, 0);
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, 'ascii'));

  for (const off of offsets.slice(1)) {
    chunks.push(Buffer.from(`${String(off).padStart(10, '0')} 00000 n \n`, 'ascii'));
  }

  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'ascii',
    ),
  );

  return Buffer.concat(chunks);
}

export function createLuxuryInvoicePdf(options: LuxuryDocumentOptions): Buffer {
  return createLuxuryPdf('COMMERCIAL RENTAL INVOICE', 'Commercial Rental Invoice & Settlement Record', [], options);
}

export function createLuxuryContractPdf(options: LuxuryDocumentOptions): Buffer {
  return createLuxuryPdf('OFFICIAL RENTAL AGREEMENT', 'Official Custody & High-Performance Vehicle Hire Agreement', [], options);
}

export function createLuxuryReceiptPdf(options: LuxuryDocumentOptions): Buffer {
  return createLuxuryPdf('OFFICIAL PAYMENT RECEIPT', 'Verified Payment Transaction Record', [], options);
}
