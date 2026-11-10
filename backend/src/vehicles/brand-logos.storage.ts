// ==========================================================
// STOCKAGE DISQUE ET SÉCURISATION DES LOGOS DE MARQUES
// ==========================================================
//
// Les logos officiels de marques sont enregistrés dans le dossier
// public du frontend :
//
//   frontend/public/brands/<fichier>
//
// Next.js sert directement ces fichiers à l'adresse :
//
//   /brands/<fichier>
//
// Cela garantit une persistance sur disque, zéro latence proxy
// et une compatibilité directe en production.
// ==========================================================

import {
    mkdir,
    unlink,
    writeFile,
} from 'node:fs/promises';

import {
    basename,
    dirname,
    extname,
    join,
    resolve,
} from 'node:path';

import {
    fileURLToPath,
} from 'node:url';

import {
    BadRequestException,
} from '@nestjs/common';

import type { UploadedImageFile } from './vehicle-images.storage.js';

// ==========================================================
// EMPLACEMENT DU DOSSIER DES LOGOS
// ==========================================================

const MODULE_DIR = dirname(
    fileURLToPath(import.meta.url),
);

const BACKEND_ROOT = resolve(
    MODULE_DIR,
    '..',
    '..',
);

const DEFAULT_BRAND_LOGOS_DIR = resolve(
    BACKEND_ROOT,
    '..',
    'frontend',
    'public',
    'brands',
);

export function brandLogosDir(): string {
    const override = process.env.BRAND_LOGOS_DIR;
    if (override && override.trim() !== '') {
        return resolve(override);
    }
    return DEFAULT_BRAND_LOGOS_DIR;
}

// ==========================================================
// TYPES MIME ET FORMATS ACCEPTÉS
// ==========================================================

export const ALLOWED_LOGO_MIMES = [
    'image/png',
    'image/webp',
    'image/svg+xml',
    'image/svg',
];

export const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5 Mo maximum

// ==========================================================
// ASSAINISSEMENT ET VALIDATION STRICTE SVG (ANTI-XSS & XXE)
// ==========================================================

export function validateAndSanitizeSvg(buffer: Buffer): Buffer {
    const raw = buffer.toString('utf-8');

    // Vérifier la présence des balises racine SVG essentielles
    if (!/<svg[\s>]/i.test(raw) || !/<\/svg>/i.test(raw)) {
        throw new BadRequestException('Invalid SVG file: missing <svg> elements.');
    }

    // Détecter et interdire formellement les scripts et balises exécutables
    const forbiddenPatterns = [
        /<script[\s>]/i,
        /<\/script>/i,
        /javascript\s*:/i,
        /data\s*:\s*text\/html/i,
        /\bon[a-z]{3,15}\s*=/i, // ex: onload=, onclick=, onerror=, onmouseover=
        /<foreignObject[\s>]/i,
        /<iframe[\s>]/i,
        /<object[\s>]/i,
        /<embed[\s>]/i,
        /<!ENTITY[\s>]/i, // Protection contre XXE (injection d'entités XML externes)
    ];

    for (const pattern of forbiddenPatterns) {
        if (pattern.test(raw)) {
            throw new BadRequestException(
                'SVG file contains forbidden active elements, scripts, or external entities for security reasons.',
            );
        }
    }

    // Supprimer d'éventuelles déclarations DOCTYPE douteuses
    const sanitized = raw.replace(/<!DOCTYPE[\s\S]*?>/gi, '').trim();

    return Buffer.from(sanitized, 'utf-8');
}

// ==========================================================
// VALIDATION DU CONTENU BINAIRE (MAGIC BYTES)
// ==========================================================

export function validateLogoContent(file: UploadedImageFile): Buffer {
    if (!file || !file.buffer || file.buffer.length === 0) {
        throw new BadRequestException('Empty logo file received.');
    }

    if (file.size > MAX_LOGO_SIZE) {
        throw new BadRequestException(
            `Logo file exceeds maximum permitted size of ${MAX_LOGO_SIZE / (1024 * 1024)} MB.`,
        );
    }

    const mime = (file.mimetype || '').toLowerCase();
    const ext = extname(file.originalname || '').toLowerCase();

    // 1. Validation SVG
    if (mime === 'image/svg+xml' || mime === 'image/svg' || ext === '.svg') {
        return validateAndSanitizeSvg(file.buffer);
    }

    // 2. Validation PNG (Magic bytes: 89 50 4E 47 0D 0A 1A 0A)
    if (mime === 'image/png' || ext === '.png') {
        const isPng =
            file.buffer.length >= 8 &&
            file.buffer[0] === 0x89 &&
            file.buffer[1] === 0x50 &&
            file.buffer[2] === 0x4e &&
            file.buffer[3] === 0x47;

        if (!isPng) {
            throw new BadRequestException('File is not a valid PNG image.');
        }
        return file.buffer;
    }

    // 3. Validation WebP (RIFF....WEBP)
    if (mime === 'image/webp' || ext === '.webp') {
        const isWebP =
            file.buffer.length >= 12 &&
            file.buffer.toString('ascii', 0, 4) === 'RIFF' &&
            file.buffer.toString('ascii', 8, 12) === 'WEBP';

        if (!isWebP) {
            throw new BadRequestException('File is not a valid WebP image.');
        }
        return file.buffer;
    }

    throw new BadRequestException(
        'Unsupported logo format. Only PNG, WebP, and secure SVG files are accepted.',
    );
}

// ==========================================================
// GÉNÉRATION DE NOM ET ENREGISTREMENT SUR DISQUE
// ==========================================================

export function slugifyBrandName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'brand';
}

export function extensionForLogo(file: UploadedImageFile): string {
    const mime = (file.mimetype || '').toLowerCase();
    if (mime.includes('svg')) return '.svg';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('png')) return '.png';

    const ext = extname(file.originalname || '').toLowerCase();
    if (['.svg', '.png', '.webp'].includes(ext)) {
        return ext;
    }
    return '.png';
}

export async function saveBrandLogoFile(
    brandName: string,
    file: UploadedImageFile,
): Promise<{ filename: string; storagePath: string }> {
    const validatedBuffer = validateLogoContent(file);
    const ext = extensionForLogo(file);
    const slug = slugifyBrandName(brandName);
    const filename = `${slug}-${Date.now()}${ext}`;

    const dir = brandLogosDir();
    await mkdir(dir, { recursive: true });

    const fullPath = join(dir, filename);
    await writeFile(fullPath, validatedBuffer);

    return {
        filename,
        storagePath: `/brands/${filename}`,
    };
}

export async function deleteBrandLogoFile(storagePath: string | null): Promise<void> {
    if (!storagePath || !storagePath.startsWith('/brands/')) {
        return;
    }

    const filename = basename(storagePath);
    const fullPath = join(brandLogosDir(), filename);

    try {
        await unlink(fullPath);
    } catch {
        // Ignorer si le fichier n'existait pas déjà sur disque
    }
}
