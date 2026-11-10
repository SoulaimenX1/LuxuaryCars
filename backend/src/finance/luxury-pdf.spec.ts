import { describe, expect, it } from 'vitest';
import {
  createLuxuryPdf,
  createLuxuryInvoicePdf,
  createLuxuryContractPdf,
  createLuxuryReceiptPdf,
} from './luxury-pdf.js';
import * as zlib from 'node:zlib';

/**
 * Helper to construct a minimal valid 2x2 RGBA PNG buffer for testing image decoding.
 */
function createMinimalPng(): Buffer {
  const width = 2;
  const height = 2;
  // Raw uncompressed scanlines: filter byte (0) + RGBA pixels
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      rawData[pxOffset] = 200; // R
      rawData[pxOffset + 1] = 160; // G
      rawData[pxOffset + 2] = 100; // B
      rawData[pxOffset + 3] = 255; // A
    }
  }
  const idat = zlib.deflateSync(rawData);

  // Build PNG signature + IHDR + IDAT + IEND
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrChunk = Buffer.alloc(25);
  ihdrChunk.writeUInt32BE(13, 0); // length
  ihdrChunk.write('IHDR', 4, 'ascii');
  ihdrChunk.writeUInt32BE(width, 8);
  ihdrChunk.writeUInt32BE(height, 12);
  ihdrChunk[16] = 8; // bit depth
  ihdrChunk[17] = 6; // color type: RGBA
  ihdrChunk[18] = 0; // compression
  ihdrChunk[19] = 0; // filter
  ihdrChunk[20] = 0; // interlace
  ihdrChunk.writeUInt32BE(0x12345678, 21); // dummy CRC

  const idatChunk = Buffer.alloc(12 + idat.length);
  idatChunk.writeUInt32BE(idat.length, 0);
  idatChunk.write('IDAT', 4, 'ascii');
  idat.copy(idatChunk, 8);
  idatChunk.writeUInt32BE(0x87654321, 8 + idat.length); // dummy CRC

  const iendChunk = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

describe('LUXUAR Luxury PDF Generator', () => {
  describe('Official Rental Contract (Strictly 2 Pages A4)', () => {
    it('generates a 2-page agreement with embedded vehicle image and LUXUAR branding', () => {
      const pngBuffer = createMinimalPng();
      const pdf = createLuxuryPdf(
        'OFFICIAL RENTAL AGREEMENT',
        'Official Custody & High-Performance Vehicle Hire Agreement',
        ['Protocol 1: Handover check', 'Protocol 2: Insurance coverage'],
        {
          contractNumber: 'CTR-2026-TEST01',
          reservationNumber: 'RES-2026-TEST01',
          customerName: 'Alexander Vance',
          customerEmail: 'alex.vance@example.com',
          vehicleName: 'Rolls-Royce Ghost Black Badge',
          licensePlate: 'RR-777-BB',
          pickupLocation: 'Budapest Flagship Showroom',
          dropoffLocation: 'Budapest Flagship Showroom',
          imageBuffer: pngBuffer,
          pickupAt: '2026-11-10T10:00:00Z',
          returnAt: '2026-11-13T10:00:00Z',
          dailyPrice: '3200.00',
          totalAmount: '9600.00',
          depositAmount: '12000.00',
          rentalDays: 3,
          paymentStatus: 'Active & In Custody',
        },
      );

      const pdfString = pdf.toString('latin1');
      expect(pdfString).toMatch(/^%PDF-1\.4/);
      expect(pdfString).toContain('/Kids [3 0 R 4 0 R] /Count 2');
      expect(pdfString).toContain('(L U X U A R)');
      expect(pdfString).toContain('(OFFICIAL RENTAL AGREEMENT)');
      expect(pdfString).toContain('(CTR-2026-TEST01)');
      expect(pdfString).toContain('(RES-2026-TEST01)');
      expect(pdfString).toContain('(ROLLS-ROYCE GHOST BLACK BADGE)');
      expect(pdfString).toContain('(Alexander Vance)');
      expect(pdfString).toContain('EUR 9600.00');
      expect(pdfString).toContain('EUR 12000.00');
      expect(pdfString).toContain('/XObject << /Im1 9 0 R >>');
      expect(pdfString).toContain('(Page 1 of 2)');
      expect(pdfString).toContain('(Page 2 of 2)');
      expect(pdfString).toContain('(TERMS OF CUSTODY, VEHICLE CARE & SIGNATURES)');
      expect(pdfString).toContain('1. VEHICLE CUSTODY');
      expect(pdfString).toContain('2. OPERATING RESTRICTIONS');
      expect(pdfString).toContain('3. INSURANCE & LIABILITY');
      expect(pdfString).toContain('4. SECURITY DEPOSIT');
      expect(pdfString).toContain('5. FUEL & BATTERY');
      expect(pdfString).toContain('6. TRAFFIC FINES');
      expect(pdfString).toContain('(SHOWROOM)');
      expect(pdfString).toContain('(VALIDATION)');
      expect(pdfString).toContain('trailer');
      expect(pdfString).toContain('%%EOF');
    });

    it('renders a valid 2-page agreement gracefully when no vehicle image is provided', () => {
      const pdf = createLuxuryPdf(
        'OFFICIAL RENTAL AGREEMENT',
        'Demonstration Contract',
        ['Stipulation line without photo'],
        {
          contractNumber: 'CTR-NO-IMG',
          reservationNumber: 'RES-NO-IMG',
          customerName: 'Elena Rostova',
          vehicleName: 'Ferrari 296 GTB',
          dailyPrice: '2800.00',
          totalAmount: '5600.00',
          depositAmount: '8000.00',
          rentalDays: 2,
        },
      );

      const pdfString = pdf.toString('latin1');
      expect(pdfString).toMatch(/^%PDF-1\.4/);
      expect(pdfString).toContain('/Count 2');
      expect(pdfString).toContain('(FERRARI 296 GTB)');
      expect(pdfString).toContain('(Elena Rostova)');
      expect(pdfString).not.toContain('/Im1');
      expect(pdfString).toContain('(Page 1 of 2)');
      expect(pdfString).toContain('(Page 2 of 2)');
      expect(pdfString).toContain('%%EOF');
    });

    it('creates contract via createLuxuryContractPdf helper', () => {
      const pdf = createLuxuryContractPdf({
        contractNumber: 'CTR-HELPER-01',
        customerName: 'Maximilian Sterling',
        vehicleName: 'Aston Martin DBS',
        totalAmount: '4500.00',
        depositAmount: '7000.00',
      });
      const pdfString = pdf.toString('latin1');
      expect(pdfString).toContain('/Count 2');
      expect(pdfString).toContain('(CTR-HELPER-01)');
      expect(pdfString).toContain('(Maximilian Sterling)');
    });
  });

  describe('Commercial Rental Invoice (Strictly ONE Page A4)', () => {
    it('generates a strict 1-page commercial rental invoice with dedicated security deposit box', () => {
      const pngBuffer = createMinimalPng();
      const pdf = createLuxuryInvoicePdf({
        invoiceNumber: 'INV-2026-0089',
        contractNumber: 'CTR-2026-0089',
        reservationNumber: 'RES-2026-0089',
        customerName: 'Marcus Aurelius',
        customerEmail: 'm.aurelius@atelier.hu',
        customerPhone: '+36 30 123 4567',
        customerAddress: 'Andrássy út 12, 1061 Budapest, Hungary',
        vehicleName: 'Porsche 911 GT3 RS',
        brandName: 'Porsche',
        modelName: '911 GT3 RS',
        licensePlate: 'P-911-GT',
        vin: 'WP0AF2A99PS123456',
        vehicleCategory: 'Track-Bred Supercar',
        pickupLocation: 'Budapest Flagship Showroom',
        dropoffLocation: 'Budapest Flagship Showroom',
        imageBuffer: pngBuffer,
        pickupAt: '2026-11-10T10:00:00Z',
        returnAt: '2026-11-13T10:00:00Z',
        dailyPrice: '1450.00',
        rentalDays: 3,
        subtotalAmount: '3425.20',
        taxRate: '27.00',
        taxAmount: '924.80',
        totalAmount: '4350.00',
        amountPaid: '4350.00',
        balanceDue: '0.00',
        depositAmount: '6000.00',
        paymentStatus: 'PAID & RECONCILED',
        paymentMethod: 'Card Online (Stripe)',
        paymentReference: 'pi_3Qy987654321',
      });

      const pdfString = pdf.toString('latin1');
      // Must be strictly 1 page
      expect(pdfString).toMatch(/^%PDF-1\.4/);
      expect(pdfString).toContain('/Count 1');
      expect(pdfString).not.toContain('/Count 2');
      expect(pdfString).toContain('(Page 1 of 1)');
      expect(pdfString).not.toContain('(Page 1 of 2)');

      // Branding & Crest
      expect(pdfString).toContain('(L U X U A R)');
      expect(pdfString).toContain('(COMMERCIAL RENTAL INVOICE)');

      // Invoice Reference & Client Details
      expect(pdfString).toContain('(INV-2026-0089)');
      expect(pdfString).toContain('(Marcus Aurelius)');
      expect(pdfString).toContain('(PORSCHE 911 GT3 RS)');
      expect(pdfString).toContain('PLATE: P-911-GT');

      // Itemized Financial Rows
      expect(pdfString).toContain('EUR 3425.20');
      expect(pdfString).toContain('27.00%');
      expect(pdfString).toContain('EUR 924.80');
      expect(pdfString).toContain('EUR 4350.00');
      expect(pdfString).toContain('EUR 0.00');

      // Dedicated Separate Security Deposit Box
      expect(pdfString).toContain('SECURITY DEPOSIT GUARANTEE');
      expect(pdfString).toContain('(NOT RENTAL REVENUE)');
      expect(pdfString).toContain('EUR 6000.00');
      expect(pdfString).toContain('NOT rental income');

      // Embedded Image
      expect(pdfString).toContain('/XObject << /Im1');
      expect(pdfString).toContain('%%EOF');
    });

    it('renders single-page invoice with promotional discounts and delivery charges', () => {
      const pdf = createLuxuryPdf(
        'COMMERCIAL RENTAL INVOICE',
        'Official Commercial Rental Invoice',
        [],
        {
          invoiceNumber: 'INV-DISC-01',
          reservationNumber: 'RES-DISC-01',
          customerName: 'Victoria Secret',
          vehicleName: 'Lamborghini Revuelto',
          dailyPrice: '3500.00',
          rentalDays: 2,
          deliveryFee: '150.00',
          discountAmount: '500.00',
          promotionCode: 'VIPAUTUMN',
          extrasAmount: '200.00',
          subtotalAmount: '5000.00',
          taxRate: '27.00',
          taxAmount: '1350.00',
          totalAmount: '6350.00',
          amountPaid: '6350.00',
          balanceDue: '0.00',
          depositAmount: '10000.00',
        },
      );

      const pdfString = pdf.toString('latin1');
      expect(pdfString).toContain('/Count 1');
      expect(pdfString).toContain('(INV-DISC-01)');
      expect(pdfString).toContain('VIPAUTUMN');
      expect(pdfString).toContain('EUR 6350.00');
      expect(pdfString).toContain('(Page 1 of 1)');
      expect(pdfString).toContain('%%EOF');
    });
  });

  describe('Official Payment Receipt (Strictly ONE Page A4)', () => {
    it('generates a single-page receipt with treasury stamp', () => {
      const pdf = createLuxuryReceiptPdf({
        reservationNumber: 'RES-PAY-99',
        customerName: 'Sophia Laurent',
        vehicleName: 'Bentley Continental GT',
        totalAmount: '4500.00',
        depositAmount: '5000.00',
        paymentMethod: 'Stripe Gateway',
        paymentStatus: 'RENTAL PAYMENT',
      });

      const pdfString = pdf.toString('latin1');
      expect(pdfString).toMatch(/^%PDF-1\.4/);
      expect(pdfString).toContain('/Count 1');
      expect(pdfString).toContain('(OFFICIAL PAYMENT RECEIPT)');
      expect(pdfString).toContain('(Sophia Laurent)');
      expect(pdfString).toContain('EUR 4500.00');
      expect(pdfString).toContain('(TREASURY)');
      expect(pdfString).toContain('(RECONCILED)');
      expect(pdfString).toContain('(Page 1 of 1)');
      expect(pdfString).toContain('%%EOF');
    });
  });
});
