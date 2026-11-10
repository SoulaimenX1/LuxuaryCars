import type {
    AuthenticatorTransportFuture,
    CredentialDeviceType,
} from '@simplewebauthn/server';

export interface PasskeyCredentialRecord {
    id: string;
    userId: string;
    credentialId: string;
    publicKey: Uint8Array<ArrayBuffer>;
    counter: number;
    deviceType: CredentialDeviceType;
    backedUp: boolean;
    transports?: AuthenticatorTransportFuture[];
    aaguid?: string | null;
    deviceName?: string | null;
    createdAt: Date;
    lastUsedAt?: Date | null;
}

export interface WebAuthnChallengeRecord {
    id: string;
    userId?: string | null;
    challenge: string;
    purpose: 'registration' | 'authentication';
    expiresAt: Date;
    createdAt: Date;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_REGEX = /^[0-9a-f]{32}$/i;

export function normalizeAaguid(raw?: string | null): string | null {
    if (!raw || typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') {
        return null;
    }
    if (UUID_REGEX.test(trimmed)) {
        return trimmed;
    }
    const cleanHex = trimmed.replace(/-/g, '');
    if (HEX32_REGEX.test(cleanHex)) {
        return `${cleanHex.slice(0, 8)}-${cleanHex.slice(8, 12)}-${cleanHex.slice(12, 16)}-${cleanHex.slice(16, 20)}-${cleanHex.slice(20)}`;
    }
    return null;
}
