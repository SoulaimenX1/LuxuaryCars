import type { ReactNode } from 'react';

interface FleetBrandIconProps {
  brandName: string;
  className?: string;
}

/**
 * Luxury fallback emblem for brands without a dedicated vector logo
 */
function FallbackBrandIcon({ brandName, className }: FleetBrandIconProps) {
  const initial = brandName.trim().charAt(0).toUpperCase() || 'L';
  return (
    <svg
      viewBox="0 0 44 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <polygon
        points="22,3 41,14 41,30 22,41 3,30 3,14"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <polygon
        points="22,8 36,16 36,28 22,36 8,28 8,16"
        stroke="currentColor"
        strokeWidth="0.8"
        opacity="0.6"
      />
      <text
        x="22"
        y="27"
        textAnchor="middle"
        fill="currentColor"
        fontSize="15"
        fontFamily="var(--serif), Georgia, serif"
        fontStyle="italic"
      >
        {initial}
      </text>
    </svg>
  );
}

/**
 * Authentic vector emblems of the luxury brands in the LUXURYCARS fleet
 */
export function FleetBrandIcon({ brandName, className }: FleetBrandIconProps): ReactNode {
  const normalized = brandName.toLowerCase().replace(/[^a-z0-9]/g, '');

  switch (normalized) {
    case 'ferrari':
      return (
        <svg
          viewBox="0 0 40 48"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Cavallino Rampante (Prancing Horse) */}
          <path d="M 23 4 C 22.5 5.5 21 6.8 20 7.2 C 20.2 6 19.5 4.8 18 4 C 17.5 5.2 17.5 6.5 17 8 C 15.5 9.5 13.5 11.2 13 13 C 12.2 14.8 12.6 16.2 14 16.8 C 15.8 17.2 16.8 16 17.2 15 C 17.5 16.2 17.8 17.5 17.2 19 C 15.8 20.2 13.8 20.6 11.8 21.2 C 9.2 21.8 7.8 20.8 6.8 19.2 L 5.8 20.2 C 7.2 22.2 9.2 23.8 11.8 24.2 C 12.2 25.8 12.8 27.2 12.8 28.8 C 11.2 29.2 9.8 28.2 8.2 27.2 L 7.2 28.8 C 8.8 30.8 10.8 31.8 13.2 31.2 C 13.8 33.2 14.2 35.2 14.8 37.2 C 13.8 38.8 12.2 40.2 10.2 41.2 L 10.8 42.8 C 13.2 42.2 15.2 40.2 16.8 37.8 C 17.5 39.2 18 41.2 18.2 43.5 L 20.5 43.5 C 19.8 40.5 19.2 38 18.2 35.5 C 19.2 34 19.8 32 19.8 30 C 20.8 31 21.8 32.5 22.8 34.5 C 23.8 36.5 25.2 39 26.8 41.5 L 28.2 40.5 C 26.2 37.5 24.8 34.5 23.8 31.5 C 24.2 30 25.2 28.5 26.2 27 C 27.8 28.5 29.2 30.5 30.8 33 L 32.2 32 C 30.2 29 28.2 26.5 26.8 24 C 27.2 22 27.2 19.5 26.8 17 C 27.8 17.5 28.8 18 29.8 19 L 30.8 17.5 C 29.2 16 27.8 14.5 26.2 14 C 26.5 12.5 26.2 10.5 25.2 9 C 25.8 8 26.2 6.5 25.8 5 C 24.8 4.2 23.8 3.8 23 4 Z" />
        </svg>
      );

    case 'astonmartin':
      return (
        <svg
          viewBox="0 0 104 36"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Aston Martin Wings */}
          <path
            d="M 52 14 C 43 14 34 11 17 4 C 11 7 5 12 1 18 C 13 18 28 17 41 18 L 41 22 C 26 21 11 22 3 25 C 9 27.5 18 28.5 27 28.5 C 36 28.5 44 25.5 52 21.5 C 60 25.5 68 28.5 77 28.5 C 86 28.5 95 27.5 101 25 C 93 22 78 21 63 22 L 63 18 C 76 17 91 18 103 18 C 99 12 93 7 87 4 C 70 11 61 14 52 14 Z"
            opacity="0.92"
          />
          <rect x="37" y="15" width="30" height="6.5" rx="1" fill="currentColor" />
          <line x1="28" y1="9" x2="38" y2="15" stroke="currentColor" strokeWidth="1.3" />
          <line x1="76" y1="9" x2="66" y2="15" stroke="currentColor" strokeWidth="1.3" />
          <line x1="20" y1="12" x2="35" y2="18" stroke="currentColor" strokeWidth="1.1" />
          <line x1="84" y1="12" x2="69" y2="18" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      );

    case 'porsche':
      return (
        <svg
          viewBox="0 0 38 46"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Porsche Stuttgart Escutcheon Shield */}
          <path
            d="M 6 4 L 32 4 L 32 21 C 32 31.5 23.5 39.5 19 42.5 C 14.5 39.5 6 31.5 6 21 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <line x1="19" y1="5" x2="19" y2="41.5" stroke="currentColor" strokeWidth="1.2" />
          <line x1="7" y1="19" x2="31" y2="19" stroke="currentColor" strokeWidth="1.2" />
          {/* Antlers Q1 & Q4 */}
          <path d="M 9 9 L 16 9 M 9 12.5 L 17 12.5 M 9 16 L 15 16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M 21 25 L 28 25 M 21 28.5 L 29 28.5 M 21 32 L 27 32" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          {/* Stripes Q2 & Q3 */}
          <rect x="21" y="7" width="8.5" height="3" fill="currentColor" />
          <rect x="21" y="13" width="8.5" height="3" fill="currentColor" />
          <rect x="8.5" y="23" width="8.5" height="3" fill="currentColor" />
          <rect x="8.5" y="29" width="8.5" height="3" fill="currentColor" />
          {/* Center Escutcheon & Horse */}
          <path d="M 15 15 L 23 15 L 23 21 C 23 24 20.5 26.5 19 27.5 C 17.5 26.5 15 24 15 21 Z" fill="currentColor" stroke="none" opacity="0.9" />
          <circle cx="19" cy="20.5" r="1.5" fill="var(--ivory, #111111)" />
        </svg>
      );

    case 'lamborghini':
      return (
        <svg
          viewBox="0 0 42 48"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Lamborghini Shield & Bull */}
          <path
            d="M 21 3 L 38 8 L 36 34 L 21 45 L 6 34 L 4 8 Z"
            stroke="currentColor"
            strokeWidth="2.2"
            fill="none"
          />
          <path
            d="M 21 15 C 22.5 13 25 12 27 12 C 26 13.8 24.8 15.5 24.8 17 C 27 16.5 29 16 31 15.5 C 29.8 17.8 28 19 25.5 19.5 C 26.5 21.2 27.5 23 28 24.5 C 25.5 24.5 23.5 23.5 21 22.2 C 18.5 23.5 16.5 24.5 14 24.5 C 14.5 23 15.5 21.2 16.5 19.5 C 14 19 12.2 17.8 11 15.5 C 13 16 15 16.5 17.2 17 C 17.2 15.5 16 13.8 15 12 C 17 12 19.5 13 21 15 Z"
            fill="currentColor"
          />
          <path d="M 18.5 24.5 C 17 27.5 15 30 13 32 L 15 33 C 17.2 31 19 28.5 20.2 25.5 Z" fill="currentColor" />
          <path d="M 23.5 24.5 C 25 27.5 27 30 29 32 L 27 33 C 24.8 31 23 28.5 21.8 25.5 Z" fill="currentColor" />
          <polygon points="17.5,33.5 21,38.5 24.5,33.5" fill="currentColor" />
        </svg>
      );

    case 'bentley':
      return (
        <svg
          viewBox="0 0 94 40"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Bentley Winged B */}
          <path d="M 42 20 C 33 15 20 12 3 12 C 9 16.5 14 23 18 29 C 27 29 35 25.5 42 22 Z" opacity="0.95" />
          <path d="M 7 13.5 C 14 10.5 25 9.5 40 15.5 C 33 12.5 22 11.5 11 11.5 Z" opacity="0.6" />
          <path d="M 52 20 C 61 15 74 12 91 12 C 85 16.5 80 23 76 29 C 67 29 59 25.5 52 22 Z" opacity="0.95" />
          <path d="M 87 13.5 C 80 10.5 69 9.5 54 15.5 C 61 12.5 72 11.5 83 11.5 Z" opacity="0.6" />
          <ellipse cx="47" cy="20" rx="12" ry="13" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path d="M 42.5 12.5 L 47.5 12.5 C 50.5 12.5 52 14 52 16.2 C 52 17.8 51 19 49.2 19.5 C 51.5 20.2 52.5 21.8 52.5 24 C 52.5 26.8 50.2 27.8 47.5 27.8 L 42.5 27.8 Z M 45.2 14.8 L 45.2 18.5 L 47.5 18.5 C 48.8 18.5 49.8 17.8 49.8 16.6 C 49.8 15.4 48.8 14.8 47.5 14.8 Z M 45.2 20.8 L 45.2 25.5 L 47.5 25.5 C 49.2 25.5 50.2 24.6 50.2 23.2 C 50.2 21.8 49.2 20.8 47.5 20.8 Z" />
        </svg>
      );

    case 'rollsroyce':
      return (
        <svg
          viewBox="0 0 36 48"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Rolls-Royce Double-R Cartouche */}
          <rect x="4" y="3" width="28" height="42" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
          {/* R1 */}
          <path d="M 12 13 L 20 13 C 22.8 13 24.5 14.5 24.5 16.8 C 24.5 18.8 23 20.2 20.5 20.5 L 15 20.5 L 15 33 L 12 33 Z M 15 15.5 L 15 18.5 L 19.8 18.5 C 21.2 18.5 22 17.8 22 16.8 C 22 15.8 21.2 15.5 19.8 15.5 Z" />
          <path d="M 19 20.5 L 24.5 33 L 21.2 33 L 16.2 20.5 Z" />
          {/* R2 */}
          <path d="M 16 16.5 L 24 16.5 C 26.8 16.5 28.5 18 28.5 20.3 C 28.5 22.3 27 23.7 24.5 24 L 19 24 L 19 36.5 L 16 36.5 Z M 19 19 L 19 22 L 23.8 22 C 25.2 22 26 21.3 26 20.3 C 26 19.3 25.2 19 23.8 19 Z" opacity="0.85" />
          <path d="M 23 24 L 28.5 36.5 L 25.2 36.5 L 20.2 24 Z" opacity="0.85" />
        </svg>
      );

    case 'mclaren':
      return (
        <svg
          viewBox="0 0 60 34"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* McLaren Speedmark Swoosh */}
          <path d="M 3 27 C 16 27 34 21 47 12.5 C 52.5 8.2 56 4.2 56 3 C 56 3 47 8.5 34 14 C 21 19.5 10 21.8 3 27 Z" />
        </svg>
      );

    case 'bugatti':
      return (
        <svg
          viewBox="0 0 64 42"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Bugatti EB Monogram inside Oval */}
          <ellipse cx="32" cy="21" rx="30" ry="18" fill="none" stroke="currentColor" strokeWidth="2.2" />
          {/* Mirrored E */}
          <path d="M 32 11.5 L 24 11.5 C 21.8 11.5 20.5 12.8 20.5 14.8 L 20.5 27.2 C 20.5 29.2 21.8 30.5 24 30.5 L 32 30.5 L 32 27.8 L 24.5 27.8 C 23.6 27.8 23.2 27.4 23.2 26.6 L 23.2 22.2 L 29.5 22.2 L 29.5 19.8 L 23.2 19.8 L 23.2 15.4 C 23.2 14.6 23.6 14.2 24.5 14.2 L 32 14.2 Z" />
          {/* B */}
          <path d="M 32 11.5 L 37.5 11.5 C 41 11.5 43 13.2 43 15.8 C 43 17.8 41.5 19.2 39.5 19.8 C 42 20.5 43.5 22.2 43.5 25 C 43.5 28.2 40.8 30.5 37.5 30.5 L 32 30.5 Z M 34.8 14.2 L 34.8 19.5 L 37.5 19.5 C 39.2 19.5 40.2 18.5 40.2 16.8 C 40.2 15.2 39.2 14.2 37.5 14.2 Z M 34.8 22.2 L 34.8 27.8 L 37.8 27.8 C 39.8 27.8 40.8 26.5 40.8 25 C 40.8 23.2 39.8 22.2 37.8 22.2 Z" />
        </svg>
      );

    case 'mercedesamg':
    case 'mercedes':
    case 'mercedesbenz':
      return (
        <svg
          viewBox="0 0 46 46"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Mercedes Three-Pointed Star in Circle */}
          <circle cx="23" cy="23" r="20.5" stroke="currentColor" strokeWidth="2.3" />
          <polygon points="23,3.8 25,21.5 23,23 21,21.5" fill="currentColor" />
          <polygon points="39.8,32.7 24.6,23.8 23,23 23.5,21.2" fill="currentColor" opacity="0.88" />
          <polygon points="6.2,32.7 22.5,21.2 23,23 21.4,23.8" fill="currentColor" opacity="0.88" />
          <polygon points="23,3.8 23,23 25,21.5" fill="currentColor" opacity="0.45" />
          <polygon points="39.8,32.7 23,23 24.6,23.8" fill="currentColor" opacity="0.45" />
          <polygon points="6.2,32.7 23,23 21.4,23.8" fill="currentColor" opacity="0.45" />
        </svg>
      );

    case 'mercedesmaybach':
    case 'maybach':
      return (
        <svg
          viewBox="0 0 50 46"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Maybach Double-M Shield */}
          <path
            d="M 25 3.5 C 38 3.5 46.5 14.5 46.5 27.5 C 46.5 35 38 42.5 25 42.5 C 12 42.5 3.5 35 3.5 27.5 C 3.5 14.5 12 3.5 25 3.5 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
          />
          <path d="M 13.5 33.5 L 18.5 13.5 L 25 24 L 31.5 13.5 L 36.5 33.5 L 33.5 33.5 L 30.2 19 L 25 28 L 19.8 19 L 16.5 33.5 Z" opacity="0.95" />
          <path d="M 10 33.5 L 15.5 18 L 25 29.5 L 34.5 18 L 40 33.5 L 37.2 33.5 L 34 22.5 L 25 32.5 L 16 22.5 L 12.8 33.5 Z" opacity="0.75" />
        </svg>
      );

    case 'maserati':
      return (
        <svg
          viewBox="0 0 40 48"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Maserati Neptune Trident */}
          <path d="M 20 3 L 23.8 15.5 L 21.2 15.5 L 21.2 33 L 18.8 33 L 18.8 15.5 L 16.2 15.5 Z" />
          <path d="M 10 10.5 C 10 18 13.5 23 17.8 25 L 17.8 22 C 14.8 20 12.5 16 12.5 10.5 L 9 10.5 L 12.5 5 L 16 10.5 Z" />
          <path d="M 30 10.5 C 30 18 26.5 23 22.2 25 L 22.2 22 C 25.2 20 27.5 16 27.5 10.5 L 31 10.5 L 27.5 5 L 24 10.5 Z" />
          <rect x="16.5" y="33" width="7" height="3" rx="0.5" />
          <path d="M 14.5 37.5 L 25.5 37.5 L 23.5 43 L 16.5 43 Z" />
        </svg>
      );

    case 'bmw':
      return (
        <svg
          viewBox="0 0 46 46"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* BMW Roundel */}
          <circle cx="23" cy="23" r="21" stroke="currentColor" strokeWidth="2.5" />
          <circle cx="23" cy="23" r="14" stroke="currentColor" strokeWidth="1.6" />
          <path d="M 23 9 A 14 14 0 0 1 37 23 L 23 23 Z" fill="currentColor" opacity="0.92" />
          <path d="M 23 37 A 14 14 0 0 1 9 23 L 23 23 Z" fill="currentColor" opacity="0.92" />
          <line x1="23" y1="9" x2="23" y2="37" stroke="currentColor" strokeWidth="1.3" />
          <line x1="9" y1="23" x2="37" y2="23" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );

    case 'audi':
      return (
        <svg
          viewBox="0 0 100 36"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Audi Four Interlocking Rings */}
          <circle cx="22" cy="18" r="14" />
          <circle cx="41" cy="18" r="14" />
          <circle cx="60" cy="18" r="14" />
          <circle cx="79" cy="18" r="14" />
        </svg>
      );

    case 'lexus':
      return (
        <svg
          viewBox="0 0 56 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={className}
          aria-hidden="true"
          focusable="false"
        >
          {/* Lexus Oval with Stylized L */}
          <ellipse cx="28" cy="20" rx="25" ry="17" stroke="currentColor" strokeWidth="2.6" />
          <path
            d="M 39 8.5 C 29.5 11.5 22 19 19 28.5 L 41 28.5 C 39 28.5 26.5 28.5 22.2 28.5 C 24.5 21 28.5 14.8 39 8.5 Z"
            fill="currentColor"
          />
        </svg>
      );

    default:
      return <FallbackBrandIcon brandName={brandName} className={className} />;
  }
}
