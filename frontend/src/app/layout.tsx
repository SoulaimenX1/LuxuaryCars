import type {
  Metadata,
} from 'next';

import SiteChrome from '@/components/site-chrome';
import { CurrencyProvider } from '@/components/currency-provider';
import { ConfirmProvider } from '@/components/confirm-dialog';
import { ToastProvider } from '@/components/toast';
import ScrollExperience from '@/components/scroll/scroll-experience';
import { getServerSessionUser } from '@/lib/server-auth';

import { Plus_Jakarta_Sans, Playfair_Display, Cinzel, Cormorant_Garamond, Manrope, Newsreader } from 'next/font/google';

import './globals.css';

// 0. Manrope: primary high-precision operational font for Admin portal UI, tables, buttons, metrics (variable font)
const manropeFont = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

// 0b. Newsreader: refined luxury serif accent for selected major admin page headings (variable font)
const newsreaderFont = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

// 1. Plus Jakarta Sans: refined, geometric luxury sans-serif for body, UI, buttons, forms, tables
const plusJakartaFont = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

// 2. Playfair Display: haute-couture high-contrast editorial serif for titles, headlines, vehicle models
const playfairFont = Playfair_Display({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  variable: '--font-serif',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

// 3. Cinzel: majestic Roman lapidary display font for brand names, monograms, hero eyebrows, badges
const cinzelFont = Cinzel({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
  variable: '--font-cinzel',
  display: 'swap',
  fallback: ['Times New Roman', 'Georgia', 'serif'],
});

// 4. Cormorant Garamond: delicate classical serif for literary callouts and quotes
const cormorantFont = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
  fallback: ['Cormorant', 'Georgia', 'Times New Roman', 'serif'],
});

// ==========================================================
// TYPOGRAPHIE DE HAUTE MAISON
// Harmonisation en 3 piliers d'exception :
// - var(--display) : Cinzel (Monogrammes, Sceaux, Marque)
// - var(--serif)   : Playfair Display (Titres éditoriaux)
// - var(--sans)    : Plus Jakarta Sans (Corps et navigation)
// ==========================================================

// ==========================================================
// MÉTADONNÉES GÉNÉRALES
// ==========================================================

export const metadata: Metadata = {
  // URL de base utilisée pour construire les URLs absolues
  // (Open Graph, sitemap, robots...).
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      'http://localhost:3000',
  ),

  title: {
    default: 'Luxury Cars | Premium Car Rental',
    template: '%s | Luxury Cars',
  },

  description:
    'Discover premium vehicles, check real-time availability and manage your luxury car reservations online.',
};

// ==========================================================
// LAYOUT PRINCIPAL
// ==========================================================

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const initialUser = await getServerSessionUser();

  return (
    <html
      lang="en"
      className={`${manropeFont.variable} ${newsreaderFont.variable} ${plusJakartaFont.variable} ${playfairFont.variable} ${cinzelFont.variable} ${cormorantFont.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        {/* Applique le thème enregistré avant la peinture du
            contenu, et protège contre les attributs injectés par les extensions (ex: bis_skin_checked). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
              try {
                var urlParams = new URLSearchParams(window.location.search);
                var t = urlParams.get('theme') || localStorage.getItem('luxury-theme');
                if (t !== 'dark' && t !== 'light') {
                  t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                }
                document.documentElement.setAttribute('data-theme', t);
              } catch(e) {}

              try {
                var cleanBis = function() {
                  var nodes = document.querySelectorAll('[bis_skin_checked]');
                  for (var i = 0; i < nodes.length; i++) {
                    nodes[i].removeAttribute('bis_skin_checked');
                  }
                };
                cleanBis();

                if (typeof MutationObserver !== 'undefined') {
                  var observer = new MutationObserver(function(mutations) {
                    for (var i = 0; i < mutations.length; i++) {
                      var m = mutations[i];
                      if (m.type === 'attributes' && m.attributeName === 'bis_skin_checked') {
                        m.target.removeAttribute('bis_skin_checked');
                      }
                    }
                  });
                  observer.observe(document.documentElement, {
                    attributes: true,
                    subtree: true,
                    attributeFilter: ['bis_skin_checked']
                  });
                }
              } catch(e) {}
            })();`,
          }}
        />

        <CurrencyProvider>
          <ConfirmProvider>
            <ToastProvider>
              <ScrollExperience />
              <SiteChrome initialUser={initialUser}>
                {children}
              </SiteChrome>
            </ToastProvider>
          </ConfirmProvider>
        </CurrencyProvider>
      </body>
    </html>
  );
}
