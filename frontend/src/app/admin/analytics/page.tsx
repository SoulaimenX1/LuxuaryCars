'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Backward-compatible redirect from /admin/analytics
 * to the Insights section of the canonical /admin/pricing page.
 */
export default function AnalyticsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/admin/pricing#insights');
  }, [router]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '40vh',
        gap: '1rem',
        color: 'var(--muted-text)',
      }}
    >
      <div
        style={{
          width: '28px',
          height: '28px',
          border: '2px solid var(--gold-text)',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <p style={{ fontSize: '0.92rem', letterSpacing: '0.02em' }}>
        Redirecting to Pricing &amp; Intelligence…
      </p>
    </div>
  );
}
