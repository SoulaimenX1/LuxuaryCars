import { isIP } from 'node:net';

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';

import {
  Reflector,
} from '@nestjs/core';

import {
  AuthRateLimiter,
} from './auth-rate-limiter.service.js';

import {
  AUTH_RATE_LIMIT_OPTIONS,
  AUTH_RATE_LIMIT_SCOPE_KEY,
  DEFAULT_AUTH_RATE_LIMIT_OPTIONS,
} from './auth-rate-limit.options.js';

import type {
  AuthRateLimitOptions,
  AuthRateLimitScope,
} from './auth-rate-limit.options.js';

export interface GuardedRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: {
    'x-forwarded-for'?: string | string[];
    'x-real-ip'?: string | string[];
  };
  body?: { email?: unknown };
}

interface GuardedResponse {
  setHeader?: (
    name: string,
    value: string,
  ) => void;
}

export function normalizeClientIp(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  let candidate = raw.trim();
  if (!candidate || candidate.length > 128) {
    return null;
  }

  // Strip IPv6 zone index (e.g., fe80::1%lo0)
  const zoneIndex = candidate.indexOf('%');
  if (zoneIndex !== -1) {
    candidate = candidate.slice(0, zoneIndex);
  }

  // Strip bracketed IPv6 with port (e.g., [::1]:3000)
  if (candidate.startsWith('[')) {
    const closingBracket = candidate.indexOf(']');
    if (closingBracket === -1) {
      return null;
    }
    candidate = candidate.slice(1, closingBracket);
  }

  // Normalize IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const mappedIpv4 = candidate.slice(7);
    if (isIP(mappedIpv4) === 4) {
      candidate = mappedIpv4;
    }
  }

  // Normalize IPv6 loopback to IPv4 loopback so localhost shares one bucket
  if (candidate === '::1' || candidate === '0:0:0:0:0:0:0:1') {
    return '127.0.0.1';
  }

  const version = isIP(candidate);
  if (version === 0) {
    return null;
  }

  return candidate.toLowerCase();
}

export function isTrustedProxyPeer(ip: string): boolean {
  if (ip === '127.0.0.1' || ip.startsWith('127.')) {
    return true;
  }

  if (ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return true;
  }

  if (ip.startsWith('172.')) {
    const secondOctet = Number(ip.split('.')[1]);
    if (
      Number.isInteger(secondOctet) &&
      secondOctet >= 16 &&
      secondOctet <= 31
    ) {
      return true;
    }
  }

  if (
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe80:')
  ) {
    return true;
  }

  return false;
}

export function resolveSafeClientIp(
  request: GuardedRequest | undefined,
  trustProxy = false,
): string {
  if (!request) {
    return 'unknown';
  }

  const directIp =
    normalizeClientIp(request.socket?.remoteAddress) ??
    normalizeClientIp(request.ip);

  // Never blindly trust X-Forwarded-For / X-Real-IP:
  // Only inspect forwarded headers when trustProxy is explicitly enabled
  // AND the immediate socket peer is a trusted loopback/private proxy (e.g., Next.js BFF).
  if (trustProxy && directIp && isTrustedProxyPeer(directIp)) {
    const rawXff = request.headers?.['x-forwarded-for'];
    const xffValue = Array.isArray(rawXff)
      ? rawXff.join(',')
      : rawXff;

    if (typeof xffValue === 'string' && xffValue.trim().length > 0) {
      const validHops = xffValue
        .split(',')
        .map((hop) => normalizeClientIp(hop))
        .filter((hop): hop is string => hop !== null);

      // Scan right-to-left so a client cannot spoof the leftmost X-Forwarded-For entry
      for (let i = validHops.length - 1; i >= 0; i -= 1) {
        if (!isTrustedProxyPeer(validHops[i])) {
          return validHops[i];
        }
      }

      if (validHops.length > 0) {
        return validHops[validHops.length - 1];
      }
    }

    const rawRealIp = request.headers?.['x-real-ip'];
    const realIpValue = Array.isArray(rawRealIp)
      ? rawRealIp[0]
      : rawRealIp;
    const normalizedRealIp = normalizeClientIp(realIpValue);
    if (normalizedRealIp) {
      return normalizedRealIp;
    }
  }

  return directIp ?? 'unknown';
}

// ==========================================================
// GUARD DE LIMITATION DE DÉBIT AUTHENTIFICATION
// ==========================================================
//
// - Limite par IP et par compte (email normalisé) sur :
//   inscription, connexion, demande/confirmation de vérification d'email,
//   et demande/confirmation de réinitialisation de mot de passe.
// - Applique les mêmes seuils que le compte existe ou non (anti-énumération).
// - En cas de dépassement : HTTP 429 avec en-tête `Retry-After`.
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: AuthRateLimiter,

    private readonly reflector: Reflector,

    @Inject(AUTH_RATE_LIMIT_OPTIONS)
    private readonly options: AuthRateLimitOptions,
  ) {}

  canActivate(
    context: ExecutionContext,
  ): boolean {
    // Un guard sans portée explicite ne limite rien.
    const scope =
      this.reflector.get<AuthRateLimitScope | undefined>(
        AUTH_RATE_LIMIT_SCOPE_KEY,
        context.getHandler(),
      );

    if (!scope) {
      return true;
    }

    const http = context.switchToHttp();

    const request =
      http.getRequest<GuardedRequest>();

    const response =
      http.getResponse<GuardedResponse>();

    const ip = this.clientIp(request);
    const email = this.normalizeAccountIdentifier(
      request.body?.email,
    );

    const checks = this.buildChecks(scope, ip, email);
    const windowMs =
      this.options.windowMs ??
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.windowMs;

    for (const check of checks) {
      const result = this.limiter.consume(
        check.key,
        check.limit,
        windowMs,
      );

      if (!result.allowed) {
        response.setHeader?.(
          'Retry-After',
          String(result.retryAfterSeconds),
        );

        throw new HttpException(
          {
            statusCode:
              HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message:
              'Too many attempts. Please try again later.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  private buildChecks(
    scope: AuthRateLimitScope,
    ip: string,
    email: string,
  ): { key: string; limit: number }[] {
    const checks: { key: string; limit: number }[] = [];

    switch (scope) {
      case 'register': {
        checks.push({
          key: `register:ip:${ip}`,
          limit:
            this.options.registerMaxPerIp ??
            DEFAULT_AUTH_RATE_LIMIT_OPTIONS.registerMaxPerIp,
        });
        if (email) {
          checks.push({
            key: `register:account:${email}`,
            limit:
              this.options.registerMaxPerAccount ??
              DEFAULT_AUTH_RATE_LIMIT_OPTIONS.registerMaxPerAccount,
          });
        }
        break;
      }

      case 'login': {
        checks.push({
          key: `login:ip:${ip}`,
          limit:
            this.options.loginMaxPerIp ??
            DEFAULT_AUTH_RATE_LIMIT_OPTIONS.loginMaxPerIp,
        });
        if (email) {
          checks.push({
            key: `login:account:${email}`,
            limit:
              this.options.loginMaxPerAccount ??
              DEFAULT_AUTH_RATE_LIMIT_OPTIONS.loginMaxPerAccount,
          });
        }
        break;
      }

      case 'verify-email-request': {
        checks.push({
          key: `verify-email-request:ip:${ip}`,
          limit:
            this.options.verifyEmailRequestMaxPerIp ??
            DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailRequestMaxPerIp,
        });
        if (email) {
          checks.push({
            key: `verify-email-request:account:${email}`,
            limit:
              this.options.verifyEmailRequestMaxPerAccount ??
              DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailRequestMaxPerAccount,
          });
        }
        break;
      }

      case 'verify-email-confirm': {
        checks.push({
          key: `verify-email-confirm:ip:${ip}`,
          limit:
            this.options.verifyEmailConfirmMaxPerIp ??
            DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailConfirmMaxPerIp,
        });
        if (email) {
          checks.push({
            key: `verify-email-confirm:account:${email}`,
            limit:
              this.options.verifyEmailConfirmMaxPerAccount ??
              DEFAULT_AUTH_RATE_LIMIT_OPTIONS.verifyEmailConfirmMaxPerAccount,
          });
        }
        break;
      }

      case 'password-reset-request': {
        checks.push({
          key: `password-reset-request:ip:${ip}`,
          limit:
            this.options.passwordResetRequestMaxPerIp ??
            DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetRequestMaxPerIp,
        });
        if (email) {
          checks.push({
            key: `password-reset-request:account:${email}`,
            limit:
              this.options.passwordResetRequestMaxPerAccount ??
              DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetRequestMaxPerAccount,
          });
        }
        break;
      }

      case 'password-reset-confirm': {
        checks.push({
          key: `password-reset-confirm:ip:${ip}`,
          limit:
            this.options.passwordResetConfirmMaxPerIp ??
            DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetConfirmMaxPerIp,
        });
        if (email) {
          checks.push({
            key: `password-reset-confirm:account:${email}`,
            limit:
              this.options.passwordResetConfirmMaxPerAccount ??
              DEFAULT_AUTH_RATE_LIMIT_OPTIONS.passwordResetConfirmMaxPerAccount,
          });
        }
        break;
      }
    }

    return checks;
  }

  private normalizeAccountIdentifier(
    raw: unknown,
  ): string {
    if (typeof raw !== 'string') {
      return '';
    }
    return raw.trim().toLowerCase().slice(0, 320);
  }

  private clientIp(
    request: GuardedRequest,
  ): string {
    return resolveSafeClientIp(
      request,
      Boolean(this.options.trustProxy),
    );
  }
}
