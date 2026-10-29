'use client';

import { usePathname } from 'next/navigation';
import {
    useEffect,
    useState,
    type ReactNode,
} from 'react';

import type { SessionUser } from '@/lib/server-auth';
import SiteFooter from './site-footer';
import SiteHeader from './site-header';

export const AUTH_CHANGED_EVENT = 'luxury-auth-changed';

export function notifyAuthChanged(): void {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    }
}

function normalizeUser(raw: unknown): SessionUser | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const obj = raw as Record<string, unknown>;
    const candidate = (obj.user && typeof obj.user === 'object'
        ? obj.user
        : obj) as Record<string, unknown>;

    const role = candidate.role;
    if (
        typeof candidate.id === 'string' &&
        typeof candidate.email === 'string' &&
        (role === 'admin' || role === 'customer' || role === 'staff')
    ) {
        return {
            id: candidate.id,
            email: candidate.email,
            firstName:
                typeof candidate.firstName === 'string'
                    ? candidate.firstName
                    : undefined,
            lastName:
                typeof candidate.lastName === 'string'
                    ? candidate.lastName
                    : undefined,
            role,
            status:
                typeof candidate.status === 'string'
                    ? candidate.status
                    : undefined,
        };
    }

    return null;
}

export default function SiteChrome({
    children,
    initialUser = null,
}: {
    children: ReactNode;
    initialUser?: SessionUser | null;
}) {
    const pathname = usePathname();
    const [user, setUser] = useState<SessionUser | null>(initialUser);

    useEffect(() => {
        let active = true;

        async function loadUser() {
            try {
                const response = await fetch('/api/auth/session', {
                    cache: 'no-store',
                });

                if (!active) {
                    return;
                }

                if (!response.ok) {
                    setUser(null);
                    return;
                }

                const data = (await response.json()) as {
                    user?: unknown;
                };
                setUser(normalizeUser(data.user));
            } catch {
                // Conserver l'état initial en cas d'interruption réseau transitoire
            }
        }

        void loadUser();

        const handleAuthEvent = () => {
            void loadUser();
        };

        window.addEventListener(AUTH_CHANGED_EVENT, handleAuthEvent);
        return () => {
            active = false;
            window.removeEventListener(AUTH_CHANGED_EVENT, handleAuthEvent);
        };
    }, [pathname, initialUser]);

    if (pathname?.startsWith('/admin')) {
        return <>{children}</>;
    }

    return (
        <>
            <SiteHeader
                user={user}
                onUserChange={setUser}
            />

            {children}

            <SiteFooter user={user} />
        </>
    );
}


