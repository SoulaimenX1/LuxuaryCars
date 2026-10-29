'use client';

import {
    Suspense,
    useState,
    type FormEvent,
} from 'react';
import Link from 'next/link';
import {
    useRouter,
    useSearchParams,
} from 'next/navigation';
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

function ForgotPasswordContent() {
    const router = useRouter();
    const toast = useToast();
    const searchParams = useSearchParams();
    const tokenFromUrl = searchParams.get('token')?.trim() ?? '';

    const [mode, setMode] = useState<'request' | 'confirm'>(
        tokenFromUrl ? 'confirm' : 'request',
    );
    const [email, setEmail] = useState('');
    const [token, setToken] = useState(tokenFromUrl);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');

    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [loading, setLoading] = useState(false);

    async function handleRequestSubmit(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();
        setError('');
        setSuccess('');
        setLoading(true);

        try {
            const response = await fetch(
                '/api/auth/password-reset/request',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: email.trim(),
                    }),
                },
            );

            const data = (await response.json()) as {
                message?: string | string[];
            };

            if (!response.ok) {
                const failure = extractErrorMessage(data);
                setError(failure);
                toast.error(failure, 'Password reset');
                return;
            }

            const message =
                typeof data.message === 'string'
                    ? data.message
                    : 'If an account matches this email, password reset instructions have been sent.';
            setSuccess(message);
            toast.success(message, 'Password reset');
            setMode('confirm');
        } catch {
            const failure =
                'Unable to reach the server. Please try again.';
            setError(failure);
            toast.error(failure, 'Password reset');
        } finally {
            setLoading(false);
        }
    }

    async function handleConfirmSubmit(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault();
        setError('');
        setSuccess('');

        if (newPassword !== confirmPassword) {
            const failure = 'The two passwords do not match.';
            setError(failure);
            toast.error(failure, 'Password reset');
            return;
        }

        setLoading(true);

        try {
            const response = await fetch(
                '/api/auth/password-reset/confirm',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        token: token.trim(),
                        newPassword,
                    }),
                },
            );

            const data = (await response.json()) as {
                message?: string | string[];
            };

            if (!response.ok) {
                const failure = extractErrorMessage(data);
                setError(failure);
                toast.error(failure, 'Password reset');
                return;
            }

            const message =
                typeof data.message === 'string'
                    ? `${data.message} Redirecting to sign in...`
                    : 'Password reset successfully. Redirecting to sign in...';
            setSuccess(message);
            toast.success(message, 'Password reset');

            window.setTimeout(() => {
                router.push('/login');
            }, 1400);
        } catch {
            const failure =
                'Unable to reach the server. Please try again.';
            setError(failure);
            toast.error(failure, 'Password reset');
        } finally {
            setLoading(false);
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
                        ACCOUNT SECURITY
                    </span>

                    <h1>
                        Restore
                        <span>access</span>
                    </h1>

                    <p>
                        Request a one-time security token to reset your
                        password and protect your active sessions.
                    </p>
                </div>

                <span className={styles.visualFooter}>
                    ENCRYPTED CREDENTIALS · SESSION PROTECTION
                </span>
            </section>

            <section className={styles.formSection}>
                <div className={styles.formContainer}>
                    <Link href="/login" className={styles.backLink}>
                        ← Back to sign in
                    </Link>

                    <span className={styles.formLabel}>
                        PASSWORD RECOVERY
                    </span>

                    <h2>
                        {mode === 'request'
                            ? 'Forgot your password?'
                            : 'Set a new password'}
                    </h2>

                    <p className={styles.formSubtitle}>
                        {mode === 'request'
                            ? 'Enter the email address associated with your account to receive a reset token.'
                            : 'Enter the security token sent to your email along with your new password.'}
                    </p>

                    {mode === 'request' ? (
                        <form
                            className={styles.form}
                            onSubmit={handleRequestSubmit}
                        >
                            <div className={styles.field}>
                                <label htmlFor="reset-email">
                                    Email address
                                </label>
                                <input
                                    id="reset-email"
                                    type="email"
                                    autoComplete="email"
                                    placeholder="name@example.com"
                                    required
                                    value={email}
                                    onChange={(event) =>
                                        setEmail(event.target.value)
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
                                disabled={loading}
                            >
                                {loading
                                    ? 'Sending instructions...'
                                    : 'Send reset token'}
                            </button>

                            <p className={styles.switchText}>
                                Already received a token?{' '}
                                <a
                                    href="#confirm"
                                    onClick={(event) => {
                                        event.preventDefault();
                                        setError('');
                                        setMode('confirm');
                                    }}
                                >
                                    Enter reset token
                                </a>
                            </p>
                        </form>
                    ) : (
                        <form
                            className={styles.form}
                            onSubmit={handleConfirmSubmit}
                        >
                            <div className={styles.field}>
                                <label htmlFor="reset-token">
                                    Security reset token
                                </label>
                                <input
                                    id="reset-token"
                                    type="text"
                                    placeholder="Paste your one-time reset token"
                                    required
                                    value={token}
                                    onChange={(event) =>
                                        setToken(event.target.value)
                                    }
                                />
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="new-password">
                                    New password
                                </label>
                                <input
                                    id="new-password"
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="Enter your new password"
                                    required
                                    value={newPassword}
                                    onChange={(event) =>
                                        setNewPassword(
                                            event.target.value,
                                        )
                                    }
                                />
                                <span className={styles.passwordHint}>
                                    Minimum 8 characters with uppercase,
                                    lowercase, number and symbol.
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="confirm-new-password">
                                    Confirm new password
                                </label>
                                <input
                                    id="confirm-new-password"
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="Repeat your new password"
                                    required
                                    value={confirmPassword}
                                    onChange={(event) =>
                                        setConfirmPassword(
                                            event.target.value,
                                        )
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
                                disabled={loading}
                            >
                                {loading
                                    ? 'Updating password...'
                                    : 'Reset password'}
                            </button>

                            <p className={styles.switchText}>
                                Need a new token?{' '}
                                <a
                                    href="#request"
                                    onClick={(event) => {
                                        event.preventDefault();
                                        setError('');
                                        setSuccess('');
                                        setMode('request');
                                    }}
                                >
                                    Request again
                                </a>
                            </p>
                        </form>
                    )}

                    <p className={styles.switchText}>
                        Remembered your password?{' '}
                        <Link href="/login">Sign in</Link>
                    </p>
                </div>
            </section>
        </main>
    );
}

export default function ForgotPasswordPage() {
    return (
        <Suspense fallback={null}>
            <ForgotPasswordContent />
        </Suspense>
    );
}
