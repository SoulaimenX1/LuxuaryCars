import { describe, expect, it } from 'vitest';
import {
    escapeHtml,
    renderLuxuarEmailHtml,
    renderLuxuarEmailText,
} from './luxuar-email-template.js';

describe('LuxuarEmailTemplate', () => {
    it('escapes dangerous HTML characters to prevent XSS injection', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe(
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
        );
        expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
    });

    it('renders identical LUXUAR cancellation email matching user reference screenshot with car image', () => {
        const html = renderLuxuarEmailHtml({
            kicker: 'RESERVATION UPDATE',
            heading: 'Your reservation has been cancelled.',
            customerName: 'Soulaimen Bensalah',
            introMessage:
                'Your reservation has been cancelled because the payment deadline expired without a verified payment.',
            detailsTitle: 'RESERVATION DETAILS',
            vehicleName: 'Mercedes-AMG ONE',
            vehiclePhotoUrl:
                'http://localhost:3000/vehicles/lc-0046-image-1792253049840.png',
            rows: [
                { label: 'Reference', value: 'RES-2026-000066' },
                {
                    label: 'Status',
                    value: 'Cancelled — Unpaid',
                    isStatus: true,
                },
            ],
            postMessage:
                'You are welcome to explore our collection and submit a new reservation request.',
            ctaButton: {
                label: 'EXPLORE THE COLLECTION →',
                url: 'http://localhost:3000/vehicles',
            },
            signoff: 'Kind regards, The LUXUAR Team',
            year: 2026,
        });

        // Brand header & footer
        expect(html).toContain('L U X U A R');
        expect(html).toContain('P R E M I U M C A R R E N T A L');
        expect(html).toContain('Excellence in every journey.');
        expect(html).toContain('Premium Car Rental · Customer Support');
        expect(html).toContain('luxurycarsrentcars@gmail.com');
        expect(html).toContain('© 2026 LUXUAR');

        // Content
        expect(html).toContain('RESERVATION UPDATE');
        expect(html).toContain('Your reservation has been cancelled.');
        expect(html).toContain('Dear Soulaimen Bensalah,');
        expect(html).toContain(
            'Your reservation has been cancelled because the payment deadline expired without a verified payment.',
        );

        // Vehicle details card & car photo
        expect(html).toContain('RESERVATION DETAILS');
        expect(html).toContain('Mercedes-AMG ONE');
        expect(html).toContain(
            'src="http://localhost:3000/vehicles/lc-0046-image-1792253049840.png"',
        );
        expect(html).toContain('Reference');
        expect(html).toContain('RES-2026-000066');
        expect(html).toContain('Status');
        expect(html).toContain('Cancelled — Unpaid');

        // Action button
        expect(html).toContain('EXPLORE THE COLLECTION →');
        expect(html).toContain('href="http://localhost:3000/vehicles"');
        expect(html).toContain('Kind regards, The LUXUAR Team');
    });

    it('renders cleanly when vehicle photo is omitted', () => {
        const html = renderLuxuarEmailHtml({
            heading: 'Booking Confirmed',
            customerName: 'Valued Client',
            introMessage: 'Thank you for choosing LUXUAR.',
            vehicleName: 'Ferrari Roma',
            rows: [{ label: 'Reference', value: 'RES-2026-000001' }],
        });

        expect(html).toContain('Ferrari Roma');
        expect(html).toContain('RES-2026-000001');
        expect(html).not.toContain('<img');
    });

    it('renders accessible, well-structured plain-text alternative matching the HTML template', () => {
        const text = renderLuxuarEmailText({
            kicker: 'RESERVATION UPDATE',
            heading: 'Your reservation has been approved.',
            customerName: 'Sophia Laurent',
            introMessage:
                'Your reservation request RES-2026-000088 has been approved by LUXUAR Concierge!',
            detailsTitle: 'RESERVATION SUMMARY',
            vehicleName: 'Aston Martin DBS Superleggera',
            rows: [
                { label: 'Reference', value: 'RES-2026-000088' },
                { label: 'Rental Price', value: 'EUR 3,200.00' },
                { label: 'Security Deposit', value: 'EUR 2,500.00' },
                { label: 'Status', value: 'Awaiting Payment' },
            ],
            postMessage:
                'PAYMENT DEADLINE: You have exactly 24 hours to complete your secure payment.',
            ctaButton: {
                label: 'COMPLETE SECURE PAYMENT',
                url: 'http://localhost:3000/account/payments/RES-2026-000088',
            },
            signoff: 'Kind regards, The LUXUAR Concierge Team',
            year: 2026,
        });

        expect(text).toContain('LUXUAR · PRESTIGE FLEET');
        expect(text).toContain('[RESERVATION UPDATE]');
        expect(text).toContain('Your reservation has been approved.');
        expect(text).toContain('Dear Sophia Laurent,');
        expect(text).toContain('RESERVATION SUMMARY');
        expect(text).toContain('Vehicle: Aston Martin DBS Superleggera');
        expect(text).toContain('• Reference: RES-2026-000088');
        expect(text).toContain('• Rental Price: EUR 3,200.00');
        expect(text).toContain('• Security Deposit: EUR 2,500.00');
        expect(text).toContain('• Status: Awaiting Payment');
        expect(text).toContain('COMPLETE SECURE PAYMENT:');
        expect(text).toContain('http://localhost:3000/account/payments/RES-2026-000088');
        expect(text).toContain('Kind regards, The LUXUAR Concierge Team');
        expect(text).toContain('Customer Support: luxurycarsrentcars@gmail.com');
        expect(text).toContain('© 2026 LUXUAR. All rights reserved.');
    });

    it('renders branded invoice template with accurate financial breakdown', () => {
        const html = renderLuxuarEmailHtml({
            kicker: 'FINANCIAL STATEMENT',
            heading: 'Final Invoice Issued',
            customerName: 'Sophia Laurent',
            introMessage:
                'Your final invoice for rental contract CNT-2026-000012 (Porsche 911 GT3) has been finalized.',
            detailsTitle: 'INVOICE SUMMARY',
            vehicleName: 'Porsche 911 GT3',
            rows: [
                { label: 'Invoice Number', value: 'INV-2026-000005' },
                { label: 'Rental Contract', value: 'CNT-2026-000012' },
                { label: 'Total Invoiced Amount', value: 'EUR 3,750.00' },
                { label: 'Status', value: 'Issued', isStatus: true },
            ],
            ctaButton: {
                label: 'VIEW MY RENTALS & INVOICES →',
                url: 'http://localhost:3000/account/rentals',
            },
        });

        expect(html).toContain('FINANCIAL STATEMENT');
        expect(html).toContain('Final Invoice Issued');
        expect(html).toContain('INV-2026-000005');
        expect(html).toContain('CNT-2026-000012');
        expect(html).toContain('EUR 3,750.00');
        expect(html).toContain('VIEW MY RENTALS &amp; INVOICES →');
    });
});
