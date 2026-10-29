import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import ReviewPopup from '@/components/account/review-popup';
import { getServerSessionUser } from '@/lib/server-auth';

export const metadata: Metadata = {
  title: 'My account',
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AccountLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getServerSessionUser();

  if (!user) {
    redirect('/login');
  }

  if (user.role === 'admin') {
    redirect('/admin');
  }

  if (user.role === 'staff') {
    redirect('/admin/rentals');
  }

  return (
    <>
      {children}
      <ReviewPopup />
    </>
  );
}

