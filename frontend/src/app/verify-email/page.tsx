'use client';

import {
    Suspense,
    useEffect,
    useRef,
    useState,
    type FormEvent,
} from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useToast } from '@/components/toast';
import styles from '../auth.module.css';

function extractErrorMessage(data: {
    message?: string | string[];
}): string {
    if (Array.isArray(data.message)) {
        return data.message.join(' ');
    }
    if (typeof data.message === 'string') {
        return data.message;
    }
    return 'An unexpected error occurred. Please try again.';
}

function VerifyEmailContent() {
    const toast = useToast();
    const searchParams = useSearchParams();
    const tokenFromUrl = searchParams.get('token')?.trim() ?? '';
    const emailFromUrl = searchParams.get('email')?.trim() ?? '';

    const [token, setToken] = useState(tokenFromUrl);
    const [email, setEmail] = useState(emailFromUrl);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [requesting, setRequesting] = useState(false);
    const [isVerified, setIsVerified] = useState(false);

    const autoSubmittedRef = useRef(false);
    const inFlightRef = useRef(false);
    const lastConfirmedTokenRef = useRef<string | null>(null);

    async function confirmTokenValue(tokenValue: string) {
        const cleanToken = tokenValue.trim();
        if (!cleanToken) {
            return;
        }

        // Prevent duplicate concurrent requests or redundant re-submissions
        if (inFlightRef.current || (isVerified && lastConfirmedTokenRef.current === cleanToken)) {
            return;
        }

        inFlightRef.current = true;
        setError('');
        setSuccess('');
        setConfirming(true);

        try {
            const candidateEmail = (emailFromUrl || email).trim();
            const response = await fetch(
                '/api/auth/verify-email/confirm',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        token: cleanToken,
                        ...(candidateEmail ? { email: candidateEmail } : {}),
                    }),
                },
            );

            const data = (await response.json()) as {
                message?: string | string[];
                verified?: boolean;
                alreadyVerified?: boolean;
            };

            if (!response.ok) {
                const failure = extractErrorMessage(data);
                setError(failure);
                toast.error(failure, 'Email verification');
                return;
            }

            const message =
                typeof data.message === 'string'
                    ? data.message
                    : data.alreadyVerified
                    ? 'Your email address is already verified. You can sign in directly.'
                    : 'Your email address has been verified successfully.';

            setSuccess(message);
            setIsVerified(true);
            lastConfirmedTokenRef.current = cleanToken;
            toast.success(message, 'Email verification');
        } catch {
            const failure =
                'Unable to reach the server. Please try again.';
            setError(failure);
            toast.error(failure, 'Email verification');
        } finally {
            inFlightRef.current = false;
            setConfirming(false);
        }
    }

    useEffect(() => {
        if (tokenFromUrl && !autoSubmittedRef.current && !isVerified) {
            autoSubmittedRef.current = true;
            void Promise.resolve().then(() =>
                confirmTokenValue(tokenFromUrl),
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tokenFromUrl]);

    async function handleConfirmSubmit(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();
        if (confirming || inFlightRef.current || isVerified) {
            return;
        }
        await confirmTokenValue(token);
    }

    async function handleRequestSubmit(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();
        const cleanEmail = email.trim();
        if (requesting || !cleanEmail) {
            return;
        }

        setError('');
        setSuccess('');
        setRequesting(true);

        try {
            const response = await fetch(
                '/api/auth/verify-email/request',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: cleanEmail,
                    }),
                },
            );

            const data = (await response.json()) as {
                message?: string | string[];
                alreadyVerified?: boolean;
            };

            if (!response.ok) {
                const failure = extractErrorMessage(data);
                setError(failure);
                toast.error(failure, 'Email verification');
                return;
            }

            if (data.alreadyVerified) {
                setIsVerified(true);
            }

            const message =
                typeof data.message === 'string'
                    ? data.message
                    : 'If an unverified account matches this email, a verification link has been sent.';
            setSuccess(message);
            toast.success(message, 'Email verification');
        } catch {
            const failure =
                'Unable to reach the server. Please try again.';
            setError(failure);
            toast.error(failure, 'Email verification');
        } finally {
            setRequesting(false);
        }
    }

    return (
        <main className={styles.page}>
            <section className={styles.visualSection}>
                <Link href="/" className={styles.logo}>
                    <span className={styles.logoMark}>L</span>
                    <span className={styles.logoText}>
                        <strong>LUXURY</strong>
                        <span>CAR RENTAL</span>
                    </span>
                </Link>

                <div className={styles.visualContent}>
                    <span className={styles.visualLabel}>
                        IDENTITY ASSURANCE
                    </span>

                    <h1>
                        Verify
                        <span>your email</span>
                    </h1>

                    <p>
                        Confirming your email address ensures reliable
                        delivery of booking confirmations, check-in codes
                        and rental statements.
                    </p>
                </div>

                <span className={styles.visualFooter}>
                    VERIFIED MEMBER ACCESS · BESPOKE SERVICE
                </span>
            </section>

            <section className={styles.formSection}>
                <div className={styles.formContainer}>
                    <Link href="/login" className={styles.backLink}>
                        ← Back to sign in
                    </Link>

                    <span className={styles.formLabel}>
                        EMAIL VERIFICATION
                    </span>

                    <h2>Confirm your email</h2>

                    <p className={styles.formSubtitle}>
                        Enter your verification token below or request a
                        fresh verification email.
                    </p>

                    {isVerified ? (
                        <div style={{ marginTop: '28px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                            <div className={styles.success}>
                                {success || 'Your email address has been verified successfully.'}
                            </div>
                            <p className={styles.formSubtitle} style={{ marginTop: 0 }}>
                                Your membership is confirmed. You now have full access to our concierge reservation services and vehicle catalog.
                            </p>
                            <Link
                                href="/login"
                                className={styles.submitButton}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    textDecoration: 'none',
                                }}
                            >
                                Continue to sign in
                            </Link>
                        </div>
                    ) : (
                        <>
                            <form
                                className={styles.form}
                                onSubmit={handleConfirmSubmit}
                            >
                                <div className={styles.field}>
                                    <label htmlFor="verify-token">
                                        Verification token
                                    </label>
                                    <input
                                        id="verify-token"
                                        type="text"
                                        placeholder="Paste your email verification token"
                                        required
                                        value={token}
                                        disabled={confirming}
                                        onChange={(event) =>
                                            setToken(event.target.value)
                                        }
                                    />
                                </div>

                                {error && (
                                    <div className={styles.error}>
                                        {error}
                                    </div>
                                )}

                                {success && (
                                    <div className={styles.success}>
                                        {success}
                                    </div>
                                )}

                                <button
                                    className={styles.submitButton}
                                    type="submit"
                                    disabled={confirming}
                                >
                                    {confirming
                                        ? 'Verifying email...'
                                        : 'Verify email'}
                                </button>
                            </form>

                            <form
                                className={styles.form}
                                onSubmit={handleRequestSubmit}
                            >
                                <div className={styles.field}>
                                    <label htmlFor="resend-email">
                                        Need a new verification link?
                                    </label>
                                    <input
                                        id="resend-email"
                                        type="email"
                                        autoComplete="email"
                                        placeholder="name@example.com"
                                        required
                                        value={email}
                                        disabled={requesting}
                                        onChange={(event) =>
                                            setEmail(event.target.value)
                                        }
                                    />
                                </div>

                                <button
                                    className={styles.submitButton}
                                    type="submit"
                                    disabled={requesting}
                                >
                                    {requesting
                                        ? 'Sending verification email...'
                                        : 'Resend verification email'}
                                </button>
                            </form>
                        </>
                    )}

                    <p className={styles.switchText}>
                        Ready to continue?{' '}
                        <Link href="/login">Sign in</Link>
                    </p>
                </div>
            </section>
        </main>
    );
}

export default function VerifyEmailPage() {
    return (
        <Suspense fallback={null}>
            <VerifyEmailContent />
        </Suspense>
    );
}
