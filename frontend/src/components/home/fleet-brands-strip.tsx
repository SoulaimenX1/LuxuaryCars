'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './fleet-brands-strip.module.css';

export interface FleetBrandItem {
  name: string;
  logoUrl: string;
}

interface FleetBrandsStripProps {
  initialBrands?: FleetBrandItem[];
  className?: string;
}

export function FleetBrandsStrip({
  initialBrands = [],
  className = '',
}: FleetBrandsStripProps) {
  const [brands, setBrands] = useState<FleetBrandItem[]>(initialBrands);

  useEffect(() => {
    let mounted = true;
    fetch('/api/vehicles/brands?inFleet=true', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Array<{ name: string; logoUrl?: string | null }>) => {
        if (!mounted || !Array.isArray(data)) return;
        const valid = data
          .filter((b): b is { name: string; logoUrl: string } =>
            Boolean(b.logoUrl && typeof b.logoUrl === 'string' && b.logoUrl.trim() !== ''),
          )
          .map((b) => ({ name: b.name, logoUrl: b.logoUrl }));
        setBrands(valid);
      })
      .catch(() => {
        // En cas d'indisponibilité réseau temporaire, conserver les marques initiales
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Exigence : si aucune marque n'a de logo téléversé, omettre la bande
  if (!brands || brands.length === 0) {
    return null;
  }

  // Répéter suffisamment les logos pour garantir un défilement infini sans à-coup sur tout écran
  const repeatCount = brands.length < 6 ? 4 : 2;
  const items: FleetBrandItem[] = [];
  for (let i = 0; i < repeatCount; i++) {
    items.push(...brands);
  }

  return (
    <div
      className={`${styles.brandStrip} ${className}`}
      role="region"
      aria-label="Marques de prestige de la flotte"
      data-testid="fleet-brands-strip"
    >
      <div className={styles.brandTrack} data-testid="fleet-brands-track">
        {/* Groupe 1 (Principal) */}
        <div className={styles.brandGroup}>
          {items.map((brand, idx) => (
            <Link
              key={`g1-${brand.name}-${idx}`}
              href={`/vehicles?brand=${encodeURIComponent(brand.name)}`}
              className={styles.brandItem}
              title={brand.name}
              aria-label={brand.name}
            >
              <img
                src={brand.logoUrl}
                alt={brand.name}
                className={styles.brandLogoImg}
                loading="lazy"
              />
              <span className="sr-only">{brand.name}</span>
            </Link>
          ))}
        </div>

        {/* Groupe 2 (Duplicata identique pour défilement infini -50%) */}
        <div className={styles.brandGroup} aria-hidden="true">
          {items.map((brand, idx) => (
            <Link
              key={`g2-${brand.name}-${idx}`}
              href={`/vehicles?brand=${encodeURIComponent(brand.name)}`}
              tabIndex={-1}
              className={styles.brandItem}
              title={brand.name}
              aria-label={brand.name}
            >
              <img
                src={brand.logoUrl}
                alt={brand.name}
                className={styles.brandLogoImg}
                loading="lazy"
              />
              <span className="sr-only">{brand.name}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default FleetBrandsStrip;
