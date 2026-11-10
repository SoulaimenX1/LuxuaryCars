'use client';

import { PasskeyManager } from '@/components/passkeys/PasskeyManager';
import styles from '../admin.module.css';

export default function AdminSecurityPage() {
    return (
        <div className={styles.page}>
            <div className={styles.container}>
                <header className={styles.hero}>
                    <span className={styles.eyebrow}>EXECUTIVE SECURITY & BIOMETRICS</span>
                    <h1>
                        Windows Hello & <span>MFA Assurance</span>
                    </h1>
                    <p>
                        Register hardware-bound biometric passkeys and generate single-use emergency recovery codes to safeguard privileged access to administrative operations.
                    </p>
                </header>

                <main style={{ marginTop: '36px' }}>
                    <PasskeyManager />
                </main>
            </div>
        </div>
    );
}
