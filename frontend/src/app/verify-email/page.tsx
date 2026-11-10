'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useToast } from '@/components/toast';
import styles from './verify-email.module.css';

type VerificationState =
  | 'verifying'
  | 'success'
  | 'already_verified'
  | 'expired'
  | 'invalid'
  | 'request';

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  const tokenFromUrl = searchParams.get('token')?.trim() ?? '';
  const emailFromUrl = searchParams.get('email')?.trim() ?? '';

  const [status, setStatus] = useState<VerificationState>(
    tokenFromUrl ? 'verifying' : 'request',
  );
  const [emailInput, setEmailInput] = useState(emailFromUrl);
  const [errorMessage, setErrorMessage] = useState('');
  const [countdown, setCountdown] = useState(4);

  // Resend state
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  const verificationAttemptedRef = useRef(false);

  // Perform secure POST verification confirmation
  const confirmToken = useCallback(
    async (tokenVal: string, emailVal: string) => {
      try {
        setErrorMessage('');
        const res = await fetch('/api/auth/verify-email/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: tokenVal,
            ...(emailVal ? { email: emailVal } : {}),
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const rawMsg = typeof data.message === 'string'
            ? data.message
            : Array.isArray(data.message)
            ? data.message.join(' ')
            : 'Invalid or expired verification token';

          setErrorMessage(rawMsg);
          setStatus('expired');
          return;
        }

        if (data.alreadyVerified) {
          setStatus('already_verified');
          toast.success('Your email address has already been verified.', 'Account Verified');
        } else {
          setStatus('success');
          toast.success('Your email address has been verified successfully.', 'Email Verified');
        }
      } catch {
        setErrorMessage('Unable to connect to verification service. Please try again.');
        setStatus('invalid');
      }
    },
    [toast],
  );

  // Automatic one-click confirmation on load when token is present
  useEffect(() => {
    if (tokenFromUrl && !verificationAttemptedRef.current) {
      verificationAttemptedRef.current = true;
      void confirmToken(tokenFromUrl, emailFromUrl);
    }
  }, [tokenFromUrl, emailFromUrl, confirmToken]);

  // Success state auto-redirect countdown
  useEffect(() => {
    if (status !== 'success') return;

    if (countdown <= 0) {
      const loginUrl = emailInput
        ? `/login?email=${encodeURIComponent(emailInput)}&verified=1`
        : '/login?verified=1';
      router.push(loginUrl);
      return;
    }

    const timer = setTimeout(() => {
      setCountdown((c) => c - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [status, countdown, router, emailInput]);

  // Countdown timer for rate limiting
  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const interval = setInterval(() => {
      setRetryAfter((prev) => {
        if (prev === null || prev <= 1) return null;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [retryAfter]);

  // Handle Resend Verification Email
  async function handleResend(e?: FormEvent) {
    if (e) e.preventDefault();
    const cleanEmail = emailInput.trim();
    if (!cleanEmail || resendLoading || (retryAfter !== null && retryAfter > 0)) {
      return;
    }

    setResendLoading(true);
    setResendError(null);
    setResendSuccess(null);

    try {
      const res = await fetch('/api/auth/verify-email/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        const retryHeader = res.headers.get('retry-after');
        const seconds = retryHeader ? parseInt(retryHeader, 10) : 30;
        setRetryAfter(isNaN(seconds) ? 30 : seconds);
        setResendError(`Rate limit reached. Please wait ${isNaN(seconds) ? 30 : seconds}s before requesting another verification email.`);
        return;
      }

      if (!res.ok) {
        const msg = typeof data.message === 'string'
          ? data.message
          : Array.isArray(data.message)
          ? data.message.join(' ')
          : 'Failed to send verification email. Please try again.';
        setResendError(msg);
        return;
      }

      if (data.alreadyVerified) {
        setStatus('already_verified');
        return;
      }

      setResendSuccess('A new verification email has been sent. Please check your inbox and click "VERIFY MY EMAIL".');
      toast.success('Verification email sent.', 'Check Inbox');
    } catch {
      setResendError('Unable to connect to verification service. Please try again.');
    } finally {
      setResendLoading(false);
    }
  }

  const navigateToLogin = () => {
    const loginUrl = emailInput
      ? `/login?email=${encodeURIComponent(emailInput)}&verified=1`
      : '/login?verified=1';
    router.push(loginUrl);
  };

  return (
    <main className={styles.page}>
      {/* Brand Visual Column */}
      <section className={styles.visualSection}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoMark}>L</span>
          <span className={styles.logoText}>
            <strong>LUXUAR</strong>
            <span>PREMIUM RENTAL</span>
          </span>
        </Link>

        <div className={styles.visualContent}>
          <span className={styles.visualLabel}>IDENTITY ASSURANCE</span>
          <h1>
            Seamless <span>Email Verification</span>
          </h1>
          <p>
            Confirming your email address activates your bespoke privileges,
            priority reservations, and direct access to our verified supercar fleet.
          </p>
        </div>

        <span className={styles.visualFooter}>
          INSTITUTIONAL LUXURY · VERIFIED ACCESS
        </span>
      </section>

      {/* Interactive Verification Console */}
      <section className={styles.formSection}>
        <div className={styles.cardContainer}>
          <Link href="/login" className={styles.backLink}>
            ← Back to sign in
          </Link>

          {/* 1. VERIFYING STATE */}
          {status === 'verifying' && (
            <div>
              <div className={`${styles.badgeIcon} ${styles.badgeLoading}`}>
                <div className={styles.spinner} />
              </div>
              <span className={styles.kicker}>AUTHENTICATING LINK</span>
              <h2 className={styles.title}>Verifying Your Email Address…</h2>
              <p className={styles.subtitle}>
                Validating your luxury credentials and securing your account access with our concierge service.
              </p>
            </div>
          )}

          {/* 2. SUCCESS STATE */}
          {status === 'success' && (
            <div>
              <div className={`${styles.badgeIcon} ${styles.badgeSuccess}`}>
                ✓
              </div>
              <span className={styles.kicker}>MEMBERSHIP CONFIRMED</span>
              <h2 className={styles.title}>Email Verified Successfully</h2>
              <p className={styles.subtitle}>
                Welcome to LUXUAR. Your email address has been confirmed and your bespoke reservation privileges are now active.
              </p>

              <div className={styles.infoBox}>
                <strong>Account Activated</strong>
                {emailInput ? `Verified account: ${emailInput}` : 'You can now sign in with your credentials or biometric passkey.'}
              </div>

              <span className={styles.countdownText}>
                Redirecting you to sign in in {countdown} second{countdown !== 1 ? 's' : ''}…
              </span>

              <button
                type="button"
                onClick={navigateToLogin}
                className={styles.btnPrimary}
              >
                Continue to Sign In Now →
              </button>

              <Link href="/" className={styles.btnSecondary}>
                Return to Vehicle Catalog
              </Link>
            </div>
          )}

          {/* 3. ALREADY VERIFIED STATE */}
          {status === 'already_verified' && (
            <div>
              <div className={`${styles.badgeIcon} ${styles.badgeSuccess}`}>
                ✓
              </div>
              <span className={styles.kicker}>MEMBERSHIP ACTIVE</span>
              <h2 className={styles.title}>Account Already Verified</h2>
              <p className={styles.subtitle}>
                Your email address has already been verified. You have full access to our vehicle catalog and reservations.
              </p>

              <div className={styles.infoBox}>
                <strong>Direct Access Ready</strong>
                {emailInput ? `Verified account: ${emailInput}` : 'Your credentials are fully active.'}
              </div>

              <button
                type="button"
                onClick={navigateToLogin}
                className={styles.btnPrimary}
              >
                Sign In to Your Account →
              </button>

              <Link href="/vehicles" className={styles.btnSecondary}>
                Browse Fleet
              </Link>
            </div>
          )}

          {/* 4. EXPIRED OR INVALID STATE */}
          {(status === 'expired' || status === 'invalid') && (
            <div>
              <div className={`${styles.badgeIcon} ${styles.badgeWarning}`}>
                ⚠
              </div>
              <span className={styles.kicker}>VERIFICATION LINK NOTICE</span>
              <h2 className={styles.title}>
                {status === 'expired' ? 'Verification Link Expired' : 'Invalid Verification Link'}
              </h2>
              <p className={styles.subtitle}>
                For institutional security, email verification links are single-use and expire 5 minutes after issuance.
              </p>

              {errorMessage && (
                <div className={styles.errorBanner}>{errorMessage}</div>
              )}

              {resendSuccess && (
                <div className={styles.successBanner}>{resendSuccess}</div>
              )}

              {resendError && (
                <div className={styles.errorBanner}>{resendError}</div>
              )}

              <form onSubmit={handleResend} style={{ marginTop: '1.5rem' }}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="resend-email" className={styles.fieldLabel}>
                    Registered Email Address
                  </label>
                  <input
                    id="resend-email"
                    type="email"
                    className={styles.textInput}
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="client@luxurycars.hu"
                    required
                    disabled={resendLoading}
                  />
                  {retryAfter !== null && retryAfter > 0 && (
                    <span className={styles.rateLimitNotice}>
                      Rate limit active. Please wait {retryAfter}s before requesting again.
                    </span>
                  )}
                </div>

                <button
                  type="submit"
                  className={styles.btnPrimary}
                  disabled={resendLoading || (retryAfter !== null && retryAfter > 0)}
                >
                  {resendLoading ? 'Sending…' : 'Resend Verification Link'}
                </button>
              </form>

              <Link href="/login" className={styles.btnSecondary} style={{ marginTop: '1rem' }}>
                Return to Sign In
              </Link>
            </div>
          )}

          {/* 5. STANDALONE REQUEST STATE (No token in URL) */}
          {status === 'request' && (
            <div>
              <span className={styles.kicker}>EMAIL VERIFICATION</span>
              <h2 className={styles.title}>Verify Your Email</h2>
              <p className={styles.subtitle}>
                Enter your registered email address below to receive an instant, one-click verification link.
              </p>

              {resendSuccess && (
                <div className={styles.successBanner}>{resendSuccess}</div>
              )}

              {resendError && (
                <div className={styles.errorBanner}>{resendError}</div>
              )}

              <form onSubmit={handleResend} style={{ marginTop: '1.5rem' }}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="request-email" className={styles.fieldLabel}>
                    Registered Account Email
                  </label>
                  <input
                    id="request-email"
                    type="email"
                    className={styles.textInput}
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="client@luxurycars.hu"
                    required
                    disabled={resendLoading}
                  />
                  {retryAfter !== null && retryAfter > 0 && (
                    <span className={styles.rateLimitNotice}>
                      Rate limit active. Please wait {retryAfter}s before requesting again.
                    </span>
                  )}
                </div>

                <button
                  type="submit"
                  className={styles.btnPrimary}
                  disabled={resendLoading || (retryAfter !== null && retryAfter > 0)}
                >
                  {resendLoading ? 'Sending Link…' : 'Send Verification Email'}
                </button>
              </form>

              <p style={{ marginTop: '1.75rem', fontSize: '0.82rem', color: 'var(--muted, #6e675f)', textAlign: 'center' }}>
                Already verified?{' '}
                <Link href="/login" style={{ color: 'var(--champagne-2, #c5a880)', textDecoration: 'none', fontWeight: 600 }}>
                  Sign in directly
                </Link>
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center' }}>Loading verification portal…</div>}>
      <VerifyEmailContent />
    </Suspense>
  );
}
