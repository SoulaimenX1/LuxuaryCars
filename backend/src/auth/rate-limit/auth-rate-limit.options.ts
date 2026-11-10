import { SetMetadata } from '@nestjs/common';

// ==========================================================
// LIMITATION DE DÉBIT DE L'AUTHENTIFICATION — OPTIONS
// ==========================================================
//
// Implémentation volontairement sans dépendance externe : le
// comportement est ainsi entièrement déterministe et testable,
// sans risque d'incompatibilité de version avec NestJS 12.

// Jeton d'injection des options de limitation.
export const AUTH_RATE_LIMIT_OPTIONS = Symbol('AUTH_RATE_LIMIT_OPTIONS');

// Portée de la limitation par point de terminaison d'authentification.
export type AuthRateLimitScope =
  | 'login'
  | 'register'
  | 'verify-email-request'
  | 'verify-email-confirm'
  | 'password-reset-request'
  | 'password-reset-confirm';

// Clé de métadonnées associant une portée à un handler.
export const AUTH_RATE_LIMIT_SCOPE_KEY = 'authRateLimitScope';

// Décorateur appliqué sur les handlers concernés.
export const AuthRateLimit = (scope: AuthRateLimitScope) =>
  SetMetadata(AUTH_RATE_LIMIT_SCOPE_KEY, scope);

export interface AuthRateLimitOptions {
  // Durée de la fenêtre, en millisecondes.
  windowMs: number;
  // Inscriptions autorisées par IP et par fenêtre.
  registerMaxPerIp: number;
  // Inscriptions autorisées par compte (email) et par fenêtre.
  registerMaxPerAccount?: number;
  // Tentatives de connexion autorisées par IP et par fenêtre.
  loginMaxPerIp: number;
  // Tentatives de connexion autorisées par compte (email) et par fenêtre.
  loginMaxPerAccount: number;
  // Demandes de vérification d'email autorisées par IP et par fenêtre.
  verifyEmailRequestMaxPerIp?: number;
  // Demandes de vérification d'email autorisées par compte (email) et par fenêtre.
  verifyEmailRequestMaxPerAccount?: number;
  // Confirmations de vérification d'email autorisées par IP et par fenêtre.
  verifyEmailConfirmMaxPerIp?: number;
  // Confirmations de vérification d'email autorisées par compte (email) et par fenêtre.
  verifyEmailConfirmMaxPerAccount?: number;
  // Demandes de réinitialisation de mot de passe autorisées par IP et par fenêtre.
  passwordResetRequestMaxPerIp?: number;
  // Demandes de réinitialisation de mot de passe autorisées par compte (email) et par fenêtre.
  passwordResetRequestMaxPerAccount?: number;
  // Confirmations de réinitialisation de mot de passe autorisées par IP et par fenêtre.
  passwordResetConfirmMaxPerIp?: number;
  // Confirmations de réinitialisation de mot de passe autorisées par compte (email) et par fenêtre.
  passwordResetConfirmMaxPerAccount?: number;
  // Faire confiance aux en-têtes X-Forwarded-For / X-Real-IP uniquement depuis un proxy de confiance.
  trustProxy?: boolean;
}

// Valeurs par défaut raisonnables pour la production.
export const DEFAULT_AUTH_RATE_LIMIT_OPTIONS: Required<AuthRateLimitOptions> = {
  windowMs: 60_000,
  registerMaxPerIp: 5,
  registerMaxPerAccount: 3,
  loginMaxPerIp: 20,
  loginMaxPerAccount: 5,
  verifyEmailRequestMaxPerIp: 10,
  verifyEmailRequestMaxPerAccount: 3,
  verifyEmailConfirmMaxPerIp: 10,
  verifyEmailConfirmMaxPerAccount: 5,
  passwordResetRequestMaxPerIp: 10,
  passwordResetRequestMaxPerAccount: 3,
  passwordResetConfirmMaxPerIp: 10,
  passwordResetConfirmMaxPerAccount: 5,
  trustProxy: false,
};

function positiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function booleanFlag(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return fallback;
}

// Construit les options depuis l'environnement en retombant
// sur les valeurs par défaut si une variable est absente/invalide.
export function authRateLimitOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Required<AuthRateLimitOptions> {
  return {
    windowMs: positiveInt(
      env.AUTH_RATE_LIMIT_WINDOW_MS,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.windowMs,
    ),
    registerMaxPerIp: positiveInt(
      env.AUTH_RATE_LIMIT_REGISTER_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.registerMaxPerIp,
    ),
    registerMaxPerAccount: positiveInt(
      env.AUTH_RATE_LIMIT_REGISTER_ACCOUNT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.registerMaxPerAccount,
    ),
    loginMaxPerIp: positiveInt(
      env.AUTH_RATE_LIMIT_LOGIN_IP_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.loginMaxPerIp,
    ),
    loginMaxPerAccount: positiveInt(
      env.AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.loginMaxPerAccount,
    ),
    verifyEmailRequestMaxPerIp: positiveInt(
      env.AUTH_RATE_LIMIT_VERIFY_REQUEST_IP_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailRequestMaxPerIp,
    ),
    verifyEmailRequestMaxPerAccount: positiveInt(
      env.AUTH_RATE_LIMIT_VERIFY_REQUEST_ACCOUNT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailRequestMaxPerAccount,
    ),
    verifyEmailConfirmMaxPerIp: positiveInt(
      env.AUTH_RATE_LIMIT_VERIFY_CONFIRM_IP_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailConfirmMaxPerIp,
    ),
    verifyEmailConfirmMaxPerAccount: positiveInt(
      env.AUTH_RATE_LIMIT_VERIFY_CONFIRM_ACCOUNT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailConfirmMaxPerAccount,
    ),
    passwordResetRequestMaxPerIp: positiveInt(
      env.AUTH_RATE_LIMIT_PASSWORD_RESET_REQUEST_IP_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetRequestMaxPerIp,
    ),
    passwordResetRequestMaxPerAccount: positiveInt(
      env.AUTH_RATE_LIMIT_PASSWORD_RESET_REQUEST_ACCOUNT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetRequestMaxPerAccount,
    ),
    passwordResetConfirmMaxPerIp: positiveInt(
      env.AUTH_RATE_LIMIT_PASSWORD_RESET_CONFIRM_IP_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetConfirmMaxPerIp,
    ),
    passwordResetConfirmMaxPerAccount: positiveInt(
      env.AUTH_RATE_LIMIT_PASSWORD_RESET_CONFIRM_ACCOUNT_MAX,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetConfirmMaxPerAccount,
    ),
    trustProxy: booleanFlag(
      env.AUTH_TRUST_PROXY,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.trustProxy,
    ),
  };
}
