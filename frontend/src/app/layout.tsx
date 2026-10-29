import type {
  Metadata,
} from 'next';

import SiteChrome from '@/components/site-chrome';
import { CurrencyProvider } from '@/components/currency-provider';
import { ConfirmProvider } from '@/components/confirm-dialog';
import { ToastProvider } from '@/components/toast';
import ScrollExperience from '@/components/scroll/scroll-experience';
import { getServerSessionUser } from '@/lib/server-auth';

import { Inter, Playfair_Display, Cormorant_Garamond } from 'next/font/google';

import './globals.css';

// 1. Inter: corps de texte, navigation, boutons, labels, prix, formulaires, tableaux et dashboards
const interFont = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

// 2. Playfair Display: titres de sections, grands en-têtes et noms de véhicules
const playfairFont = Playfair_Display({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-serif',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

const cormorantFont = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-cormorant',
  display: 'swap',
  fallback: ['Cormorant', 'Georgia', 'Times New Roman', 'serif'],
});

// ==========================================================
// TYPOGRAPHIE — police sans-serif normale et claire.
// Une seule famille lisible est utilisée pour tout le site
// (titres et texte courant). Elle est définie dans globals.css
// via les variables CSS --sans et --serif.
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
      className={`${interFont.variable} ${playfairFont.variable} ${cormorantFont.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body>
        {/* Applique le thème enregistré avant la peinture du
            contenu, afin d'éviter tout flash clair/sombre. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('luxury-theme');if(t!=='dark'&&t!=='light'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`,
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