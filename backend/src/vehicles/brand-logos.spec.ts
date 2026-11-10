import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
    validateAndSanitizeSvg,
    validateLogoContent,
    slugifyBrandName,
} from './brand-logos.storage.js';

describe('Brand Logo Storage & Security Validation', () => {
    it('accepts a safe SVG file and preserves vector content', () => {
        const safeSvg = Buffer.from(
            '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="gold"/></svg>',
            'utf-8',
        );

        const sanitized = validateAndSanitizeSvg(safeSvg);
        expect(sanitized.toString('utf-8')).toContain('<svg');
        expect(sanitized.toString('utf-8')).toContain('circle');
    });

    it('strictly rejects SVG containing <script> tags (Anti-XSS)', () => {
        const maliciousSvg = Buffer.from(
            '<svg viewBox="0 0 100 100"><script>alert(1)</script><circle cx="50" cy="50" r="40"/></svg>',
            'utf-8',
        );

        expect(() => validateAndSanitizeSvg(maliciousSvg)).toThrow(BadRequestException);
    });

    it('strictly rejects SVG containing inline event handlers like onload= or onclick=', () => {
        const maliciousSvg = Buffer.from(
            '<svg viewBox="0 0 100 100" onload="alert(1)"><circle cx="50" cy="50" r="40"/></svg>',
            'utf-8',
        );

        expect(() => validateAndSanitizeSvg(maliciousSvg)).toThrow(BadRequestException);
    });

    it('strictly rejects SVG with javascript: URIs', () => {
        const maliciousSvg = Buffer.from(
            '<svg viewBox="0 0 100 100"><a href="javascript:alert(1)"><circle cx="50" cy="50" r="40"/></a></svg>',
            'utf-8',
        );

        expect(() => validateAndSanitizeSvg(maliciousSvg)).toThrow(BadRequestException);
    });

    it('strictly rejects SVG with XXE entity declarations', () => {
        const maliciousSvg = Buffer.from(
            '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>',
            'utf-8',
        );

        expect(() => validateAndSanitizeSvg(maliciousSvg)).toThrow(BadRequestException);
    });

    it('validates genuine PNG binary files with magic numbers', () => {
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
        const validFile = {
            originalname: 'ferrari.png',
            mimetype: 'image/png',
            size: pngHeader.length,
            buffer: pngHeader,
        };

        const res = validateLogoContent(validFile);
        expect(res).toBeDefined();
    });

    it('rejects fake PNG files that do not have PNG magic bytes', () => {
        const fakePng = Buffer.from('NOT A REAL PNG FILE HEADER');
        const invalidFile = {
            originalname: 'fake.png',
            mimetype: 'image/png',
            size: fakePng.length,
            buffer: fakePng,
        };

        expect(() => validateLogoContent(invalidFile)).toThrow(BadRequestException);
    });

    it('slugifies brand names cleanly into safe filename fragments', () => {
        expect(slugifyBrandName('Aston Martin')).toBe('aston-martin');
        expect(slugifyBrandName('Mercedes-AMG')).toBe('mercedes-amg');
        expect(slugifyBrandName('Rolls-Royce')).toBe('rolls-royce');
    });
});
