'use client';

import {
    FormEvent,
    useState,
} from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { notifyAuthChanged } from '@/components/site-chrome';
import { useToast } from '@/components/toast';
import styles from '../auth.module.css';

// ==========================================================
// TYPE DE LA RÉPONSE LOGIN
// ==========================================================

interface LoginResponse {
    user?: {
        id?: string;
        email?: string;
        firstName?: string;
        lastName?: string;
        role?: string;
        status?: string;
    };

    mfaRequired?: boolean;
    preAuthToken?: string;
    expiresIn?: number;

    message?:
    | string
    | string[];
}

// ==========================================================
// PAGE LOGIN
// ==========================================================

export default function LoginPage() {
    const router =
        useRouter();

    const toast = useToast();

    // --------------------------------------------------------
    // CHAMPS DU FORMULAIRE
    // --------------------------------------------------------

    const [
        email,
        setEmail,
    ] = useState('');

    const [
        password,
        setPassword,
    ] = useState('');

    // --------------------------------------------------------
    // ÉTAT DE L'INTERFACE
    // --------------------------------------------------------

    const [
        loading,
        setLoading,
    ] = useState(false);

    const [
        error,
        setError,
    ] = useState('');

    const [
        passkeyLoading,
        setPasskeyLoading,
    ] = useState(false);

    async function handlePasskeyLogin() {
        setError('');
        setPasskeyLoading(true);
        try {
            const optRes = await fetch('/api/auth/passkeys/authenticate/options', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim() || undefined }),
            });
            if (!optRes.ok) {
                const err = await optRes.json();
                throw new Error(err.message || 'Unable to initialize passkey sign-in.');
            }
            const options = await optRes.json();

            const assertionResponse = await startAuthentication({ optionsJSON: options });

            const verRes = await fetch('/api/auth/passkeys/authenticate/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    response: assertionResponse,
                    challenge: options.challenge,
                }),
            });
            const data = await verRes.json();
            if (!verRes.ok) {
                throw new Error(data.message || 'Passkey authentication failed.');
            }

            notifyAuthChanged();
            toast.success('Signed in successfully with Windows Hello / Passkey.', 'Sign in');

            if (data.user?.role === 'admin') {
                router.replace('/admin');
                router.refresh();
                return;
            }

            if (data.user?.role === 'staff') {
                router.replace('/admin/rentals');
                router.refresh();
                return;
            }

            if (data.user?.role === 'customer') {
                router.replace('/account');
                router.refresh();
                return;
            }

            router.replace('/account');
            router.refresh();
            return;
        } catch (err: unknown) {
            const errorObj = err instanceof Error ? err : new Error(String(err));
            if (errorObj.name === 'NotAllowedError') {
                toast.error('Passkey sign in was cancelled or timed out.');
            } else {
                const msg = errorObj.message || 'Unable to sign in with passkey.';
                setError(msg);
                toast.error(msg, 'Sign in');
            }
        } finally {
            setPasskeyLoading(false);
        }
    }

    // ========================================================
    // SOUMISSION DU LOGIN
    // ========================================================

    async function handleSubmit(
        event: FormEvent<HTMLFormElement>,
    ) {
        // Empêcher le rechargement classique de la page.
        event.preventDefault();

        // Réinitialiser l'erreur précédente.
        setError('');

        // Activer l'état de chargement.
        setLoading(true);

        try {
            // ----------------------------------------------------
            // APPELER NOTRE API NEXT.JS
            // ----------------------------------------------------

            const response =
                await fetch(
                    '/api/auth/login',
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json',
                        },

                        body:
                            JSON.stringify({
                                email,
                                password,
                            }),
                    },
                );

            // ----------------------------------------------------
            // LIRE LA RÉPONSE
            // ----------------------------------------------------
            //
            // On utilise une déclaration typée directe.
            //
            // Cela évite l'erreur Turbopack rencontrée
            // avec :
            //
            // await response.json() as LoginResponse
            //
            // ----------------------------------------------------

            const data: LoginResponse =
                await response.json();

            // ----------------------------------------------------
            // LOGIN REFUSÉ
            // ----------------------------------------------------

            if (!response.ok) {
                const message =
                    Array.isArray(
                        data.message,
                    )
                        ? data.message.join(
                            ' ',
                        )
                        : data.message;

                const failure =
                    message ?? 'Unable to sign in.';

                setError(failure);
                toast.error(failure, 'Sign in');

                return;
            }

            // ==========================================================
            // MFA REQUIRED (MANDATORY ADMIN / STAFF STEP)
            // ==========================================================

            if (data.mfaRequired && data.preAuthToken) {
                if (typeof window !== 'undefined') {
                    sessionStorage.setItem('lux_mfa_pre_auth', data.preAuthToken);
                    if (data.user) {
                        sessionStorage.setItem('lux_mfa_user', JSON.stringify(data.user));
                    }
                }
                router.push('/mfa/verify');
                return;
            }

            // ----------------------------------------------------
            // ADMIN
            // ----------------------------------------------------
            //
            // Le dashboard admin sera développé plus tard.
            //
            // Pour le moment, un administrateur retourne
            // simplement vers la page d'accueil.
            // ----------------------------------------------------

            // ==========================================================
            // REDIRECTION SELON LE RÔLE
            // ==========================================================

            if (data.user?.role === 'admin') {
                notifyAuthChanged();
                router.replace('/admin');
                router.refresh();
                return;
            }

            if (data.user?.role === 'staff') {
                notifyAuthChanged();
                router.replace('/admin/rentals');
                router.refresh();
                return;
            }

            if (data.user?.role === 'customer') {
                notifyAuthChanged();
                router.replace('/account');
                router.refresh();
                return;
            }

            // ----------------------------------------------------
            // RÔLE NON SUPPORTÉ
            // ----------------------------------------------------
            //
            // Aucune redirection : on affiche l'erreur
            // et on laisse l'utilisateur sur la page.
            // ----------------------------------------------------

            const failure =
                'This account role is not supported.';
            setError(failure);
            toast.error(failure, 'Sign in');
            return;
        } catch {
            // ----------------------------------------------------
            // ERREUR RÉSEAU OU SERVEUR
            // ----------------------------------------------------

            const failure =
                'The authentication service is currently unavailable.';
            setError(failure);
            toast.error(failure, 'Sign in');
        } finally {
            // Désactiver l'état de chargement.
            setLoading(
                false,
            );
        }
    }

    return (
        <main
            className={
                styles.page
            }
            suppressHydrationWarning
        >

            {/* ============================================= */}
            {/* PARTIE VISUELLE */}
            {/* ============================================= */}

            <section
                className={
                    styles.visualSection
                }
            >

                <div
                    className={
                        styles.visualEyebrow
                    }
                >
                    <span
                        className={
                            styles.visualEyebrowDot
                        }
                    />
                    <span>
                        CLIENT ACCESS
                    </span>
                </div>

                <div
                    className={
                        styles.visualContent
                    }
                >

                    <span
                        className={
                            styles.visualLabel
                        }
                    >
                        EXCLUSIVE FLEET
                    </span>

                    <h1>
                        Welcome{' '}
                        <span>
                            back
                        </span>
                    </h1>

                    <p>
                        Access your customer account,
                        manage your reservations and
                        continue your premium rental
                        experience.
                    </p>

                </div>

                <div
                    className={
                        styles.visualFooter
                    }
                >
                    <span>
                        SECURE ACCESS
                    </span>
                    <span
                        className={
                            styles.footerBullet
                        }
                    >
                        ·
                    </span>
                    <span>
                        ENCRYPTED AUTHENTICATION
                    </span>
                </div>

            </section>

            {/* ============================================= */}
            {/* FORMULAIRE */}
            {/* ============================================= */}

            <section
                className={
                    styles.formSection
                }
            >

                <div
                    className={
                        styles.formContainer
                    }
                >

                    <div
                        className={
                            styles.formNav
                        }
                    >
                        <Link
                            href="/"
                            className={
                                styles.backLink
                            }
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                            >
                                <line x1="19" y1="12" x2="5" y2="12" />
                                <polyline points="12 19 5 12 12 5" />
                            </svg>
                            <span>
                                Back to home
                            </span>
                        </Link>

                        <span
                            className={
                                styles.formLabel
                            }
                        >
                            SIGN IN
                        </span>
                    </div>

                    <h2>
                        Access your account
                    </h2>

                    <p
                        className={
                            styles.formSubtitle
                        }
                    >
                        Enter your account credentials
                        to continue.
                    </p>

                    <form
                        className={
                            styles.form
                        }
                        onSubmit={
                            handleSubmit
                        }
                    >

                        {/* ======================================= */}
                        {/* EMAIL */}
                        {/* ======================================= */}

                        <div
                            className={
                                styles.field
                            }
                        >

                            <label
                                htmlFor="email"
                            >
                                Email address
                            </label>

                            <input
                                id="email"
                                name="email"
                                type="email"
                                autoComplete="email"
                                placeholder="name@example.com"
                                required
                                value={email}
                                onChange={(
                                    event,
                                ) =>
                                    setEmail(
                                        event.target.value,
                                    )
                                }
                            />

                        </div>

                        {/* ======================================= */}
                        {/* PASSWORD */}
                        {/* ======================================= */}

                        <div
                            className={
                                styles.field
                            }
                        >

                            <label
                                htmlFor="password"
                            >
                                Password
                            </label>

                            <input
                                id="password"
                                name="password"
                                type="password"
                                autoComplete="current-password"
                                placeholder="Enter your password"
                                required
                                value={password}
                                onChange={(
                                    event,
                                ) =>
                                    setPassword(
                                        event.target.value,
                                    )
                                }
                            />

                        </div>

                        {/* ======================================= */}
                        {/* MESSAGE D'ERREUR */}
                        {/* ======================================= */}

                        {error && (
                            <div
                                className={
                                    styles.error
                                }
                            >
                                {error}
                            </div>
                        )}

                        {/* ======================================= */}
                        {/* BOUTON LOGIN */}
                        {/* ======================================= */}

                        <button
                            className={
                                styles.submitButton
                            }
                            type="submit"
                            disabled={
                                loading || passkeyLoading
                            }
                        >
                            {loading
                                ? 'Signing in...'
                                : 'Sign in'}
                        </button>

                        <div
                            className={
                                styles.authDivider
                            }
                        >
                            <span
                                className={
                                    styles.dividerLine
                                }
                            />
                            <span
                                className={
                                    styles.dividerText
                                }
                            >
                                or continue with
                            </span>
                            <span
                                className={
                                    styles.dividerLine
                                }
                            />
                        </div>

                        <button
                            type="button"
                            onClick={handlePasskeyLogin}
                            disabled={loading || passkeyLoading}
                            className={styles.passkeyButton}
                            aria-label="Sign in with Windows Hello or Passkey"
                        >
                            {passkeyLoading ? (
                                <>
                                    <svg
                                        className={styles.passkeySpinner}
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        aria-hidden="true"
                                    >
                                        <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                        <path d="M12 2a10 10 0 0 1 10 10" />
                                    </svg>
                                    <span>Waiting for Windows Hello...</span>
                                </>
                            ) : (
                                <>
                                    <svg
                                        className={styles.passkeyIcon}
                                        width="18"
                                        height="18"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.75"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                    >
                                        <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 3" />
                                        <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
                                        <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
                                        <path d="M2 12a10 10 0 0 1 18-6" />
                                        <path d="M2 16h.01" />
                                        <path d="M21.8 16c.2-2 .131-5.354 0-6" />
                                        <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
                                        <path d="M8.65 22c.21-.66.45-1.32.57-2" />
                                        <path d="M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2" />
                                    </svg>
                                    <span>Sign in with Windows Hello / Passkey</span>
                                </>
                            )}
                        </button>

                    </form>

                    <div
                        className={
                            styles.authLinks
                        }
                    >
                        <p
                            className={
                                styles.switchText
                            }
                        >
                            <Link href="/forgot-password">
                                Forgot your password?
                            </Link>
                            <span
                                className={
                                    styles.linkDot
                                }
                            >
                                ·
                            </span>
                            <Link href="/verify-email">
                                Verify email
                            </Link>
                        </p>

                        <p
                            className={
                                styles.switchTextSecondary
                            }
                        >
                            New customer?{' '}
                            <Link
                                href="/register"
                            >
                                Create an account
                            </Link>
                        </p>
                    </div>

                </div>

            </section>

        </main>
    );
}
