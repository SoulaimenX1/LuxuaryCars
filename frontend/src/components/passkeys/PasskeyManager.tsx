'use client';

import { useEffect, useState } from 'react';
import {
    browserSupportsWebAuthn,
    startRegistration,
} from '@simplewebauthn/browser';
import { useToast } from '@/components/toast';
import styles from './PasskeyManager.module.css';

interface PasskeyItem {
    id: string;
    credentialId: string;
    deviceName: string | null;
    deviceType: string;
    backedUp: boolean;
    createdAt: string;
    lastUsedAt: string | null;
}

export function PasskeyManager() {
    const toast = useToast();
    const [supported] = useState<boolean>(() => {
        return typeof window !== 'undefined' ? browserSupportsWebAuthn() : false;
    });
    const [passkeys, setPasskeys] = useState<PasskeyItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [registering, setRegistering] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deviceName, setDeviceName] = useState('Windows Hello Device');
    const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
    const [generatingCodes, setGeneratingCodes] = useState(false);
    const [confirmedSaved, setConfirmedSaved] = useState(false);

    useEffect(() => {
        loadPasskeys();
    }, []);

    async function handleGenerateRecoveryCodes() {
        if (!confirm('Generate new recovery codes? Any previously unused codes will be revoked.')) return;
        setGeneratingCodes(true);
        try {
            const res = await fetch('/api/auth/mfa/recovery-codes', { method: 'POST' });
            if (!res.ok) {
                const err = await res.json().catch(() => null);
                throw new Error(err?.message || 'Failed to generate recovery codes. Privileged role required.');
            }
            const data = await res.json();
            if (Array.isArray(data.recoveryCodes)) {
                setRecoveryCodes(data.recoveryCodes);
                setConfirmedSaved(false);
                toast.success('Generated 10 emergency recovery codes.');
            }
        } catch (err: unknown) {
            const errorObj = err instanceof Error ? err : new Error(String(err));
            toast.error(errorObj.message || 'Error generating recovery codes.');
        } finally {
            setGeneratingCodes(false);
        }
    }

    async function loadPasskeys() {
        setLoading(true);
        try {
            const res = await fetch('/api/auth/passkeys');
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    setPasskeys(data);
                }
            }
        } catch {
            // Ignore load errors on unauthenticated profile
        } finally {
            setLoading(false);
        }
    }

    async function handleRegister() {
        if (!supported) {
            toast.error('WebAuthn / Windows Hello is not supported in this browser.');
            return;
        }

        setRegistering(true);
        try {
            // 1. Fetch registration options from BFF
            const optionsRes = await fetch('/api/auth/passkeys/register/options', {
                method: 'POST',
            });
            if (!optionsRes.ok) {
                const err = await optionsRes.json();
                throw new Error(err.message || 'Failed to start passkey registration.');
            }
            const options = await optionsRes.json();

            // 2. Perform browser ceremony (Windows Hello prompt)
            const registrationResponse = await startRegistration({ optionsJSON: options });

            // 3. Verify assertion with backend
            const verifyRes = await fetch('/api/auth/passkeys/register/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    response: registrationResponse,
                    challenge: options.challenge,
                    deviceName: deviceName.trim() || 'Windows Hello Device',
                }),
            });

            if (!verifyRes.ok) {
                const err = await verifyRes.json();
                throw new Error(err.message || 'Failed to complete passkey registration.');
            }

            toast.success('Passkey enrolled successfully with Windows Hello!');
            await loadPasskeys();
        } catch (error: unknown) {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            if (errorObj.name === 'NotAllowedError') {
                toast.error('Passkey creation was cancelled or timed out.');
            } else {
                toast.error(errorObj.message || 'Passkey enrollment failed.');
            }
        } finally {
            setRegistering(false);
        }
    }

    async function handleDelete(credentialId: string) {
        if (!confirm('Are you sure you want to remove this passkey?')) return;
        setDeletingId(credentialId);
        try {
            const res = await fetch(`/api/auth/passkeys?id=${encodeURIComponent(credentialId)}`, {
                method: 'DELETE',
            });
            if (!res.ok) {
                throw new Error('Failed to delete passkey.');
            }
            toast.success('Passkey removed.');
            setPasskeys((prev) => prev.filter((p) => p.credentialId !== credentialId));
        } catch (err: unknown) {
            const errorObj = err instanceof Error ? err : new Error(String(err));
            toast.error(errorObj.message || 'Unable to remove passkey.');
        } finally {
            setDeletingId(null);
        }
    }

    return (
        <section className={styles.section} aria-labelledby="passkeys-heading">
            <span className={styles.eyebrow}>Biometric Security</span>

            <div className={styles.headerRow}>
                <span className={styles.fingerprintIcon} aria-hidden="true">
                    <svg
                        width="22"
                        height="22"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
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
                </span>
                <h2 id="passkeys-heading" className={styles.title}>
                    Windows Hello &amp; Passkeys
                </h2>
            </div>

            <p className={styles.description}>
                Sign in seamlessly using biometric authentication (fingerprint, facial recognition) or hardware security keys without typing a password.
            </p>

            {supported === false && (
                <div className={styles.unsupportedBanner} role="alert">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>WebAuthn and Windows Hello are not supported or disabled in this browser.</span>
                </div>
            )}

            <div className={styles.enrollRow}>
                <input
                    type="text"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="Device label (e.g. Work Laptop, Windows Hello)"
                    aria-label="Passkey device label"
                    className={styles.input}
                    maxLength={60}
                />
                <button
                    type="button"
                    onClick={handleRegister}
                    disabled={registering || supported === false}
                    className={styles.addButton}
                >
                    {registering ? (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
                                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
                            </svg>
                            <span>Enrolling with Windows Hello...</span>
                        </>
                    ) : (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            <span>Add Passkey</span>
                        </>
                    )}
                </button>
            </div>

            <div className={styles.registeredSection}>
                <div className={styles.listHeader}>
                    <h3 className={styles.listTitle}>
                        Registered Devices
                        {loading && <span className={styles.loadingNotice}>(Refreshing...)</span>}
                    </h3>
                    <span className={styles.badge}>
                        {passkeys.length} {passkeys.length === 1 ? 'device' : 'devices'}
                    </span>
                </div>

                {passkeys.length === 0 ? (
                    <p className={styles.emptyState}>
                        No passkeys registered yet. Add your current device to enable fast, passwordless biometric access.
                    </p>
                ) : (
                    <ul className={styles.deviceList}>
                        {passkeys.map((p) => (
                            <li key={p.credentialId} className={styles.deviceCard}>
                                <div className={styles.deviceLeft}>
                                    <div className={styles.deviceIconWrapper} aria-hidden="true">
                                        <svg
                                            width="18"
                                            height="18"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.75"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        >
                                            <rect x="2" y="3" width="20" height="14" rx="2" />
                                            <line x1="8" y1="21" x2="16" y2="21" />
                                            <line x1="12" y1="17" x2="12" y2="21" />
                                        </svg>
                                    </div>
                                    <div className={styles.deviceText}>
                                        <span className={styles.deviceName}>
                                            {p.deviceName || 'Windows Hello Passkey'}
                                        </span>
                                        <span className={styles.deviceSubtext}>
                                            Added: {new Date(p.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                            {p.lastUsedAt && ` · Last active: ${new Date(p.lastUsedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`}
                                        </span>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => handleDelete(p.credentialId)}
                                    disabled={deletingId === p.credentialId}
                                    className={styles.removeButton}
                                    aria-label={`Remove passkey ${p.deviceName || ''}`}
                                >
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="3 6 5 6 21 6" />
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    </svg>
                                    <span>{deletingId === p.credentialId ? 'Removing...' : 'Remove'}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className={styles.recoverySection}>
                <div className={styles.listHeader}>
                    <h3 className={styles.listTitle}>
                        Emergency Recovery Codes
                    </h3>
                    <span className={styles.badge}>MFA Fallback</span>
                </div>

                <p className={styles.description}>
                    Generate offline, single-use recovery codes to access privileged Admin/Staff accounts if your biometric device is unavailable.
                </p>

                {recoveryCodes ? (
                    <div className={styles.recoveryCard}>
                        <div className={styles.recoveryWarning}>
                            <strong>Important:</strong> These 10 codes are shown ONCE. Store them in a password manager or secure vault immediately.
                        </div>
                        <div className={styles.codeGrid}>
                            {recoveryCodes.map((c, i) => (
                                <code key={i} className={styles.codeItem}>
                                    {c}
                                </code>
                            ))}
                        </div>
                        <label className={styles.confirmRow}>
                            <input
                                type="checkbox"
                                checked={confirmedSaved}
                                onChange={(e) => setConfirmedSaved(e.target.checked)}
                            />
                            <span>I have saved these 10 recovery codes safely.</span>
                        </label>
                        <button
                            type="button"
                            disabled={!confirmedSaved}
                            onClick={() => {
                                setRecoveryCodes(null);
                                setConfirmedSaved(false);
                                toast.success('Recovery codes acknowledged and secured.');
                            }}
                            className={styles.confirmBtn}
                        >
                            Done &amp; Dismiss
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={handleGenerateRecoveryCodes}
                        disabled={generatingCodes}
                        className={styles.recoveryBtn}
                    >
                        {generatingCodes ? 'Generating...' : 'Generate 10 Emergency Recovery Codes'}
                    </button>
                )}
            </div>
        </section>
    );
}
