'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { notifyAuthChanged } from '@/components/site-chrome';
import { useToast } from '@/components/toast';
import styles from './mfa.module.css';

export default function MfaVerifyPage() {
    const router = useRouter();
    const toast = useToast();

    const [preAuthToken] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        return sessionStorage.getItem('lux_mfa_pre_auth');
    });

    const [userEmail] = useState<string>(() => {
        if (typeof window === 'undefined') return '';
        const userJson = sessionStorage.getItem('lux_mfa_user');
        if (userJson) {
            try {
                return JSON.parse(userJson).email || '';
            } catch {
                return '';
            }
        }
        return '';
    });

    const [userRole] = useState<string>(() => {
        if (typeof window === 'undefined') return '';
        const userJson = sessionStorage.getItem('lux_mfa_user');
        if (userJson) {
            try {
                return JSON.parse(userJson).role || '';
            } catch {
                return '';
            }
        }
        return '';
    });

    const [showRecovery, setShowRecovery] = useState(false);
    const [recoveryCode, setRecoveryCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (typeof window !== 'undefined' && !sessionStorage.getItem('lux_mfa_pre_auth')) {
            router.replace('/login');
        }
    }, [router]);

    async function handlePasskeyMfa() {
        if (!preAuthToken) return;
        setLoading(true);
        setError(null);

        try {
            // 1. Fetch WebAuthn options
            const optRes = await fetch('/api/auth/passkeys/authenticate/options', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: userEmail || undefined }),
            });

            if (!optRes.ok) {
                throw new Error('Unable to generate WebAuthn challenge.');
            }

            const options = await optRes.json();

            // 2. Browser biometric prompt (Windows Hello / Passkey)
            const assertion = await startAuthentication({ optionsJSON: options });

            // 3. Verify MFA assertion via BFF
            const verifyRes = await fetch('/api/auth/mfa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preAuthToken,
                    method: 'passkey',
                    response: assertion,
                }),
            });

            const verifyData = await verifyRes.json();
            if (!verifyRes.ok) {
                throw new Error(verifyData.message || 'MFA verification failed.');
            }

            sessionStorage.removeItem('lux_mfa_pre_auth');
            sessionStorage.removeItem('lux_mfa_user');
            notifyAuthChanged();
            toast.success('MFA verification successful.');

            const target = userRole === 'admin' ? '/admin' : userRole === 'staff' ? '/admin/rentals' : '/account';
            router.replace(target);
            router.refresh();
        } catch (err: unknown) {
            const errorObj = err instanceof Error ? err : new Error(String(err));
            if (errorObj.name === 'NotAllowedError') {
                setError('Biometric authentication was cancelled.');
            } else {
                setError(errorObj.message || 'Passkey verification failed.');
            }
        } finally {
            setLoading(false);
        }
    }

    async function handleRecoverySubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!preAuthToken || !recoveryCode.trim()) return;

        setLoading(true);
        setError(null);

        try {
            const verifyRes = await fetch('/api/auth/mfa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preAuthToken,
                    method: 'recovery',
                    code: recoveryCode.trim(),
                }),
            });

            const verifyData = await verifyRes.json();
            if (!verifyRes.ok) {
                throw new Error(verifyData.message || 'Invalid recovery code.');
            }

            sessionStorage.removeItem('lux_mfa_pre_auth');
            sessionStorage.removeItem('lux_mfa_user');
            notifyAuthChanged();
            toast.success('Recovery code verified.');

            const target = userRole === 'admin' ? '/admin' : userRole === 'staff' ? '/admin/rentals' : '/account';
            router.replace(target);
            router.refresh();
        } catch (err: unknown) {
            const errorObj = err instanceof Error ? err : new Error(String(err));
            setError(errorObj.message || 'Recovery verification failed.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className={styles.page}>
            <section className={styles.card} aria-labelledby="mfa-title">
                <div className={styles.header}>
                    <Link href="/login" className={styles.backLink}>
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
                        <span>Back to login</span>
                    </Link>
                    <span className={styles.badge}>MFA Required</span>
                </div>

                <h1 id="mfa-title" className={styles.title}>
                    Two-Factor Authentication
                </h1>

                <p className={styles.subtitle}>
                    Privileged access requires second-factor verification. Confirm your identity with a registered passkey or single-use recovery code.
                </p>

                {userEmail && (
                    <div className={styles.userNotice}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                        </svg>
                        <span>
                            Authenticating as <strong>{userEmail}</strong>
                        </span>
                    </div>
                )}

                {error && <div className={styles.error} role="alert">{error}</div>}

                <div className={styles.actionSection}>
                    {!showRecovery ? (
                        <>
                            <button
                                type="button"
                                onClick={handlePasskeyMfa}
                                disabled={loading}
                                className={styles.passkeyBtn}
                            >
                                {loading ? (
                                    <>
                                        <svg className={styles.spinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                            <path d="M12 2a10 10 0 0 1 10 10" />
                                        </svg>
                                        <span>Waiting for biometric...</span>
                                    </>
                                ) : (
                                    <>
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 3" />
                                            <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
                                            <path d="M2 12a10 10 0 0 1 18-6" />
                                            <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
                                        </svg>
                                        <span>Verify with Windows Hello / Passkey</span>
                                    </>
                                )}
                            </button>

                            <div className={styles.divider}>
                                <span className={styles.dividerLine} />
                                <span className={styles.dividerText}>or</span>
                                <span className={styles.dividerLine} />
                            </div>

                            <button
                                type="button"
                                onClick={() => setShowRecovery(true)}
                                className={styles.secondaryBtn}
                            >
                                Use single-use recovery code
                            </button>
                        </>
                    ) : (
                        <form onSubmit={handleRecoverySubmit} className={styles.recoveryForm}>
                            <div className={styles.field}>
                                <label htmlFor="recovery-code">8-Character Recovery Code</label>
                                <input
                                    id="recovery-code"
                                    type="text"
                                    placeholder="XXXX-XXXX"
                                    maxLength={9}
                                    value={recoveryCode}
                                    onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                                    required
                                    autoFocus
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={loading || !recoveryCode.trim()}
                                className={styles.passkeyBtn}
                            >
                                {loading ? 'Verifying code...' : 'Verify recovery code'}
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    setShowRecovery(false);
                                    setError(null);
                                }}
                                className={styles.secondaryBtn}
                            >
                                ← Back to Passkey
                            </button>
                        </form>
                    )}
                </div>
            </section>
        </main>
    );
}
