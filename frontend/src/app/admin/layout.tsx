'use client';

import {
    BarChart3,
    CalendarCheck,
    Car,
    CreditCard,
    History as HistoryIcon,
    Key,
    LayoutDashboard,
    RotateCcw,
    ShieldCheck,
    TrendingUp,
    Users,
} from 'lucide-react';
import Link from 'next/link';
import NotificationBell from '@/components/notification-bell';
import { notifyAuthChanged } from '@/components/site-chrome';
import ThemeToggle from '@/components/theme-toggle';
import { usePathname, useRouter } from 'next/navigation';
import {
    useEffect,
    useState,
    type ReactNode,
} from 'react';

import { useToast } from '@/components/toast';

import styles from './admin-layout.module.css';

// ==========================================================
// TYPES
// ==========================================================

interface AuthUser {
    id?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    role?: string;
    status?: string;
}

interface AuthResponse {
    user?: AuthUser;
    id?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    role?: string;
    status?: string;
}

// ==========================================================
// PROPS
// ==========================================================

interface AdminLayoutProps {
    children: ReactNode;
}

// ==========================================================
// NAVIGATION ADMIN
// ==========================================================

const navigation = [
    {
        href: '/admin',
        label: 'Dashboard',
        number: '01',
        icon: LayoutDashboard,
    },
    {
        href: '/admin/vehicles',
        label: 'Fleet management',
        number: '02',
        icon: Car,
    },
    {
        href: '/admin/customers',
        label: 'Customers',
        number: '03',
        icon: Users,
    },
    {
        href: '/admin/reservations',
        label: 'Reservations',
        number: '04',
        icon: CalendarCheck,
    },
    {
        href: '/admin/finance',
        label: 'Payments & Revenue',
        number: '05',
        icon: CreditCard,
    },
    {
        href: '/admin/rentals',
        label: 'Active rentals',
        number: '06',
        icon: Key,
    },
    {
        href: '/admin/returns',
        label: 'Returns & deposits',
        number: '07',
        icon: RotateCcw,
    },
    {
        href: '/admin/history',
        label: 'History & Logs',
        number: '08',
        icon: HistoryIcon,
    },
    {
        href: '/admin/security',
        label: 'Security & Passkeys',
        number: '09',
        icon: ShieldCheck,
    },
    {
        href: '/admin/pricing',
        label: 'Pricing & Intelligence',
        number: '10',
        icon: TrendingUp,
    },
];

// ==========================================================
// ADMIN LAYOUT
// ==========================================================

export default function AdminLayout({
    children,
}: AdminLayoutProps) {
    const router = useRouter();
    const pathname = usePathname();

    const [user, setUser] =
        useState<AuthUser | null>(null);

    const [checkingSession, setCheckingSession] =
        useState(true);

    const [loggingOut, setLoggingOut] =
        useState(false);

    const [mobileNavOpen, setMobileNavOpen] =
        useState(false);

    const toast = useToast();

    // Auto-close mobile navigation drawer on route change
    useEffect(() => {
        setMobileNavOpen(false);
    }, [pathname]);

    // ========================================================
    // VÉRIFIER LA SESSION ADMIN
    // ========================================================

    useEffect(() => {
        let cancelled = false;

        async function checkSession() {
            try {
                const response = await fetch(
                    '/api/auth/me',
                    {
                        method: 'GET',
                        cache: 'no-store',
                    },
                );

                // --------------------------------------------------
                // Aucun utilisateur connecté
                // --------------------------------------------------

                if (response.status === 401) {
                    router.replace('/login');
                    return;
                }

                if (!response.ok) {
                    router.replace('/login');
                    return;
                }

                const data: AuthResponse =
                    await response.json();

                // --------------------------------------------------
                // /api/auth/me peut retourner :
                //
                // { user: {...} }
                //
                // ou directement :
                //
                // { id, email, role, ... }
                // --------------------------------------------------

                const authenticatedUser: AuthUser =
                    data.user ?? data;

                // --------------------------------------------------
                // PROTECTION DU PORTAIL ADMIN
                // --------------------------------------------------

                if (
                    authenticatedUser.role !== 'admin' &&
                    authenticatedUser.role !== 'staff'
                ) {
                    router.replace('/account');
                    return;
                }

                if (authenticatedUser.role === 'staff' && pathname === '/admin') {
                    router.replace('/admin/rentals');
                    return;
                }

                if (!cancelled) {
                    setUser(authenticatedUser);
                    setCheckingSession(false);
                }
            } catch {
                router.replace('/login');
            }
        }

        void checkSession();

        return () => {
            cancelled = true;
        };
    }, [router, pathname]);

    // ========================================================
    // DÉCONNEXION
    // ========================================================

    async function logout() {
        if (loggingOut) {
            return;
        }

        setLoggingOut(true);

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
            notifyAuthChanged();
            router.replace('/login');
            router.refresh();
        }
    }

    // ========================================================
    // DÉTERMINER LE LIEN ACTIF
    // ========================================================

    function isActive(href: string): boolean {
        if (href === '/admin') {
            return pathname === '/admin';
        }
        if (href === '/admin/pricing' && (pathname.startsWith('/admin/pricing') || pathname.startsWith('/admin/analytics'))) {
            return true;
        }

        return pathname.startsWith(href);
    }

    // ========================================================
    // ÉCRAN DE VÉRIFICATION
    // ========================================================

    if (checkingSession) {
        return (
            <div className={styles.sessionScreen} suppressHydrationWarning>
                <div className={styles.sessionMark} suppressHydrationWarning>
                    LC
                </div>

                <p suppressHydrationWarning>
                    Verifying administrator session
                </p>
            </div>
        );
    }

    // ========================================================
    // INTERFACE ADMIN
    // ========================================================

    return (
        <div className={styles.shell} data-admin-portal="true" suppressHydrationWarning>

            {/* MOBILE NAV OVERLAY */}
            {mobileNavOpen && (
                <div
                    className={styles.mobileNavOverlay}
                    onClick={() => setMobileNavOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* ================================================= */}
            {/* SIDEBAR ADMIN                                   */}
            {/* ================================================= */}

            <aside className={`${styles.sidebar} ${mobileNavOpen ? styles.sidebarOpen : ''}`}>

                {/* HEADER FIXE SIDEBAR */}
                <div className={styles.sidebarTop}>
                    {/* LOGO OFFICIEL */}
                    <div className={styles.identity}>
                        <Link
                            href="/admin"
                            className={styles.logo}
                            aria-label="Luxury Cars Admin Home"
                        >
                            LC
                        </Link>

                        <div>
                            <strong>
                                LUXURY CARS
                            </strong>

                            <span>
                                ADMINISTRATION
                            </span>
                        </div>
                    </div>

                    {/* TITRE WORKSPACE */}
                    <div className={styles.workspace}>
                        <span>
                            {user?.role === 'staff' ? 'OPERATIONS' : 'PRIVATE OFFICE'}
                        </span>

                        <h1>
                            {user?.role === 'staff' ? 'Staff Portal' : 'Control Centre'}
                        </h1>
                    </div>
                </div>

                {/* NAVIGATION SCROLLABLE INDÉPENDANTE */}
                <nav className={styles.navigation} aria-label="Admin Navigation">
                    {(user?.role === 'staff'
                        ? navigation.filter((item) =>
                            ['/admin/reservations', '/admin/rentals', '/admin/returns', '/admin/security'].includes(item.href)
                        )
                        : navigation
                    ).map((item) => {
                        const Icon = item.icon;
                        const active = isActive(item.href);
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={active ? styles.activeLink : styles.navLink}
                            >
                                <span className={styles.navIconWrapper} aria-hidden="true">
                                    <Icon size={15} strokeWidth={active ? 2.2 : 1.8} />
                                </span>

                                <span className={styles.navLabel}>
                                    {item.label}
                                </span>

                                <span className={styles.navNumber}>
                                    {item.number}
                                </span>
                            </Link>
                        );
                    })}
                </nav>

                {/* BAS DE SIDEBAR ANCRÉ SANS TRONCATURE */}
                <div className={styles.sidebarFooter}>

                    <div className={styles.adminAccount}>
                        <span
                            className={styles.avatar}
                        >
                            {user?.firstName
                                ?.charAt(0)
                                .toUpperCase() ??
                                user?.email
                                    ?.charAt(0)
                                    .toUpperCase() ??
                                'A'}
                        </span>

                        <div>
                            <strong>
                                {user?.firstName ||
                                    'Administrator'}
                            </strong>

                            <span>
                                {user?.email ??
                                    'Admin account'}
                            </span>
                        </div>
                    </div>

                    <Link
                        href="/"
                        className={styles.publicLink}
                    >
                        <span>
                            ↗
                        </span>

                        View public website
                    </Link>

                    <button
                        type="button"
                        onClick={logout}
                        disabled={loggingOut}
                        className={styles.logout}
                    >
                        <span>
                            ⏻
                        </span>

                        {loggingOut
                            ? 'Signing out...'
                            : 'Sign out'}
                    </button>

                </div>

            </aside>

            {/* ================================================= */}
            {/* CONTENU ADMIN                                    */}
            {/* ================================================= */}

            <section className={styles.main}>

                {/* TOP BAR EXÉCUTIF */}
                <div className={styles.topbar}>
                    <div className={styles.topbarLeft}>
                        {/* Mobile Navigation Drawer Trigger */}
                        <button
                            type="button"
                            className={styles.mobileNavToggle}
                            onClick={() => setMobileNavOpen((prev) => !prev)}
                            aria-label="Toggle navigation menu"
                            aria-expanded={mobileNavOpen}
                        >
                            <span className={styles.hamburgerLine} />
                            <span className={styles.hamburgerLine} />
                            <span className={styles.hamburgerLine} />
                        </button>

                        <span
                            className={styles.systemStatus}
                        >
                            <i />
                            SYSTEM ONLINE
                        </span>

                        <span className={styles.topbarDivider} aria-hidden="true" />

                        <span className={styles.agencyBadge}>
                            SINGLE AGENCY · BUDAPEST HQ
                        </span>
                    </div>

                    <div className={styles.topbarActions}>
                        {/* Cloche personnelle de l’administrateur. */}
                        <NotificationBell admin />
                        <ThemeToggle />

                        <div className={styles.topbarRight}>
                            <span>
                                {user?.role === 'staff' ? 'STAFF MEMBER' : 'EXECUTIVE ADMIN'}
                            </span>

                            <strong>
                                {user?.firstName
                                    ? `${user.firstName}${user.lastName
                                        ? ` ${user.lastName}`
                                        : ''
                                    }`
                                    : user?.email ??
                                    'Admin'}
                            </strong>
                        </div>
                    </div>
                </div>

                {/* PAGES ADMIN */}

                <div className={styles.content}>
                    {children}
                </div>

            </section>

        </div>
    );
}
