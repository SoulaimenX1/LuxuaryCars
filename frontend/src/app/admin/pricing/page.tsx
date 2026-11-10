import type { Metadata } from 'next';
import PricingIntelligenceView from './PricingIntelligenceView';

export const metadata: Metadata = {
  title: 'Pricing & Intelligence — Administration',
  description: 'Authoritative dynamic pricing engine, demand forecasting, and fleet yield management.',
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminPricingPage() {
  return (
    <main style={{ width: '100%', maxWidth: '100%', margin: '0', padding: '0', boxSizing: 'border-box', overflowX: 'hidden' }}>
      <PricingIntelligenceView />
    </main>
  );
}
