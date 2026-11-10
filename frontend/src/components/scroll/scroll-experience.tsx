'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import styles from './scroll-experience.module.css';

/**
 * Composant de défilement Haute Horlogerie :
 * 1. Jauge de progression chronographique supérieure avec tête de lecture bijou (diamant spéculaire).
 * 2. Orbe de retour au sommet (Ascend Orb) flottant avec verre miroir et micro-flèche biseautée.
 * 
 * Note d'architecture : Désactivé sur les routes administratives (/admin) pour garantir
 * qu'aucun élément flottant ne vienne masquer ou chevaucher les actions de tableau, menus
 * contextuels, tiroirs ou boutons de pagination.
 */
export default function ScrollExperience() {
  const pathname = usePathname();
  const isAdmin = pathname?.startsWith('/admin');

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const rafId = useRef<number | null>(null);

  const updateScroll = useCallback(() => {
    const scrollY =
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;
    const docHeight =
      document.documentElement.scrollHeight - window.innerHeight;

    if (docHeight > 0) {
      const rawProgress = Math.min(Math.max(scrollY / docHeight, 0), 1);
      setProgress(rawProgress);
    } else {
      setProgress(0);
    }

    setVisible(scrollY > 280);
  }, []);

  const handleScroll = useCallback(() => {
    if (rafId.current !== null) return;

    rafId.current = window.requestAnimationFrame(() => {
      updateScroll();
      rafId.current = null;
    });
  }, [updateScroll]);

  useEffect(() => {
    // Si nous sommes dans l'espace admin, nous ne nous abonnons à aucun écouteur
    if (isAdmin) return;

    // Écoute universelle (capture pour intercepter le défilement du document et de la fenêtre)
    window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    document.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });

    // Exécution initiale
    const initialTimer = setTimeout(updateScroll, 0);

    return () => {
      clearTimeout(initialTimer);
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
      if (rafId.current !== null) {
        window.cancelAnimationFrame(rafId.current);
      }
    };
  }, [handleScroll, updateScroll, isAdmin]);

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  };

  if (isAdmin) {
    return null;
  }

  return (
    <>
      {/* Jauge chronographique de défilement (Haut de page) */}
      <div
        className={styles.progressGauge}
        aria-hidden="true"
        role="presentation"
      >
        <div
          className={styles.progressBar}
          style={{ transform: `scaleX(${progress})` }}
        >
          {progress > 0.005 && <span className={styles.beacon} />}
        </div>
      </div>

      {/* Orbe miroir flottant "Ascend" */}
      <button
        type="button"
        className={`${styles.ascendOrb} ${visible ? styles.ascendOrbVisible : ''}`}
        onClick={scrollToTop}
        aria-label="Scroll to top of page"
        title="Ascend to top"
      >
        <span className={styles.orbIcon} aria-hidden="true">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </span>
        <span className={styles.orbLabel}>TOP</span>
      </button>
    </>
  );
}
