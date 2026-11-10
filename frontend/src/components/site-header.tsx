'use client';

import Link from 'next/link';
import {
    usePathname,
    useRouter,
} from 'next/navigation';
import {
    useState,
} from 'react';

import type { SessionUser } from '@/lib/server-auth';
import NotificationBell from './notification-bell';
import ThemeToggle from './theme-toggle';
import CurrencySelector from './currency-selector';
import { notifyAuthChanged } from './site-chrome';
import { useToast } from './toast';

import styles from './site-chrome.module.css';

const NAVIGATION = [
    { href: '/', label: 'Home' },
    { href: '/vehicles', label: 'Fleet' },
    { href: '/contact', label: 'Contact' },
];

interface SiteHeaderProps {
    user?: SessionUser | null;
    onUserChange?: (user: SessionUser | null) => void;
}

export default function SiteHeader({
    user = null,
    onUserChange,
}: SiteHeaderProps) {
    const pathname = usePathname();
    const router = useRouter();

    const [signingOut, setSigningOut] =
        useState(false);

    const toast = useToast();

    async function handleLogout() {
        setSigningOut(true);

        try {
            const response = await fetch('/api/auth/logout', {
                method: 'POST',
            });

            if (!response.ok) {
                throw new Error('Logout failed.');
            }

            toast.success('You have been signed out.', 'Session');
        } catch {
            toast.error(
                'Unable to sign out. Please try again.',
                'Session',
            );
        } finally {
            onUserChange?.(null);
            notifyAuthChanged();
            setSigningOut(false);
            router.push('/');
            router.refresh();
        }
    }

    function isActive(href: string): boolean {
        if (href === '/') {
            return pathname === '/';
        }

        return pathname?.startsWith(href) ?? false;
    }

    const isAdmin = user?.role === 'admin';
    const isStaff = user?.role === 'staff';
    const isCustomer = user?.role === 'customer';

    return (
        <header className={styles.header}>
            <div className={styles.headerInner}>

                <Link
                    href="/"
                    className={styles.brand}
                >
                    <span className={styles.brandMark}>
                        L
                    </span>

                    <span className={styles.brandText}>
                        <strong>
                            LUXURY
                            <em> CARS</em>
                        </strong>

                        <small>
                            PREMIUM CAR RENTAL
                        </small>
                    </span>
                </Link>

                <nav className={styles.navigation} aria-label="Primary navigation">
                    {NAVIGATION.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={
                                isActive(item.href)
                                    ? styles.activeLink
                                    : undefined
                            }
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>

                <div className={styles.headerActions}>
                    {user && (
                        <NotificationBell admin={isAdmin || isStaff} />
                    )}

                    {!isAdmin && !isStaff && <CurrencySelector />}
                    <ThemeToggle />

                    {isAdmin && (
                        <>
                            <Link
                                href="/admin"
                                className={styles.adminDashboardButton}
                            >
                                Admin dashboard
                            </Link>

                            <button
                                type="button"
                                className={styles.signOut}
                                onClick={handleLogout}
                                disabled={signingOut}
                            >
                                {signingOut
                                    ? 'Signing out...'
                                    : 'Sign out'}
                            </button>
                        </>
                    )}

                    {isStaff && (
                        <>
                            <Link
                                href="/admin/rentals"
                                className={styles.adminDashboardButton}
                            >
                                Operations
                            </Link>

                            <button
                                type="button"
                                className={styles.signOut}
                                onClick={handleLogout}
                                disabled={signingOut}
                            >
                                {signingOut
                                    ? 'Signing out...'
                                    : 'Sign out'}
                            </button>
                        </>
                    )}

                    {isCustomer && (
                        <>
                            <Link
                                href="/account"
                                className={
                                    pathname === '/account'
                                        ? styles.activeActionButton
                                        : styles.accountButton
                                }
                            >
                                My account
                            </Link>

                            <Link
                                href="/account/reservations"
                                className={
                                    pathname?.startsWith('/account/reservations')
                                        ? styles.activeActionButton
                                        : styles.accountButton
                                }
                            >
                                My reservations
                            </Link>

                            <Link
                                href="/account/payments"
                                className={
                                    styles.reservationsButton
                                }
                            >
                                My payments
                            </Link>

                            <button
                                type="button"
                                className={styles.signOut}
                                onClick={handleLogout}
                                disabled={signingOut}
                            >
                                {signingOut
                                    ? 'Signing out...'
                                    : 'Sign out'}
                            </button>
                        </>
                    )}

                    {!user && (
                        <>
                            <Link
                                href="/login"
                                className={styles.signIn}
                            >
                                Sign in
                            </Link>

                            <Link
                                href="/register"
                                className={
                                    styles.accountButton
                                }
                            >
                                Create account
                            </Link>
                        </>
                    )}
                </div>

            </div>
        </header>
    );
}

