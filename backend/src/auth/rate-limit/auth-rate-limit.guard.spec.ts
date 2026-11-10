import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import type {
  ExecutionContext,
} from '@nestjs/common';

import type {
  Reflector,
} from '@nestjs/core';

import {
  AuthRateLimiter,
} from './auth-rate-limiter.service.js';

import {
  AuthRateLimitGuard,
} from './auth-rate-limit.guard.js';

import type {
  AuthRateLimitOptions,
  AuthRateLimitScope,
} from './auth-rate-limit.options.js';

// ==========================================================
// TESTS — GUARD DE LIMITATION DE DÉBIT
// ==========================================================

const TEST_OPTIONS: AuthRateLimitOptions = {
  windowMs: 60_000,
  registerMaxPerIp: 2,
  loginMaxPerIp: 100,
  loginMaxPerAccount: 2,
};

function makeContext(request: unknown) {
  const responseHeaders: Record<string, string> = {};

  const response = {
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
  };

  const context = {
    getHandler: () => function handler() { },
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, responseHeaders };
}

function makeGuard(
  scope: AuthRateLimitScope | undefined,
): AuthRateLimitGuard {
  const reflector = {
    get: () => scope,
  } as unknown as Reflector;

  return new AuthRateLimitGuard(
    new AuthRateLimiter(),
    reflector,
    TEST_OPTIONS,
  );
}

describe('AuthRateLimitGuard', () => {
  it('ne limite rien sans portée explicite', () => {
    const guard = makeGuard(undefined);
    const { context } = makeContext({
      ip: '10.0.0.1',
      body: {},
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('limite les inscriptions par IP (429 + Retry-After)', () => {
    const guard = makeGuard('register');

    const first = makeContext({
      ip: '10.0.0.2',
      body: {},
    });

    const second = makeContext({
      ip: '10.0.0.2',
      body: {},
    });

    const third = makeContext({
      ip: '10.0.0.2',
      body: {},
    });

    expect(guard.canActivate(first.context)).toBe(
      true,
    );

    expect(guard.canActivate(second.context)).toBe(
      true,
    );

    let caught: unknown;

    try {
      guard.canActivate(third.context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);
    expect(
      (caught as HttpException).getStatus(),
    ).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(
      third.responseHeaders['Retry-After'],
    ).toBeDefined();
  });

  it('limite la connexion par compte, indépendamment de l’IP', () => {
    const guard = makeGuard('login');

    const attempt = (ip: string, email: string) =>
      makeContext({ ip, body: { email } });

    // Deux tentatives pour le même compte, depuis deux IP.
    expect(
      guard.canActivate(
        attempt('10.0.0.3', 'target@example.com')
          .context,
      ),
    ).toBe(true);

    expect(
      guard.canActivate(
        attempt('10.0.0.4', 'target@example.com')
          .context,
      ),
    ).toBe(true);

    // Troisième tentative : refusée par la limite de compte.
    expect(() =>
      guard.canActivate(
        attempt(
          '10.0.0.5',
          'target@example.com',
        ).context,
      ),
    ).toThrow(HttpException);

    // Un autre compte n'est pas affecté.
    expect(
      guard.canActivate(
        attempt('10.0.0.5', 'other@example.com')
          .context,
      ),
    ).toBe(true);
  });

  it('retombe sur socket.remoteAddress quand ip est absent', () => {
    const guard = makeGuard('register');

    const context = makeContext({
      socket: { remoteAddress: '192.168.0.9' },
      body: {},
    });

    expect(guard.canActivate(context.context)).toBe(
      true,
    );
  });

  it('limite les demandes de vérification email et de réinitialisation par IP et par compte', () => {
    const limiter = new AuthRateLimiter();
    const options: AuthRateLimitOptions = {
      ...TEST_OPTIONS,
      verifyEmailRequestMaxPerIp: 5,
      verifyEmailRequestMaxPerAccount: 2,
      passwordResetRequestMaxPerIp: 5,
      passwordResetRequestMaxPerAccount: 2,
    };

    const verifyGuard = new AuthRateLimitGuard(
      limiter,
      { get: () => 'verify-email-request' } as unknown as Reflector,
      options,
    );
    const resetGuard = new AuthRateLimitGuard(
      limiter,
      { get: () => 'password-reset-request' } as unknown as Reflector,
      options,
    );
    const loginGuard = new AuthRateLimitGuard(
      limiter,
      { get: () => 'login' } as unknown as Reflector,
      options,
    );

    const email = 'victim@example.com';

    expect(
      verifyGuard.canActivate(
        makeContext({ ip: '10.0.1.1', body: { email } }).context,
      ),
    ).toBe(true);
    expect(
      verifyGuard.canActivate(
        makeContext({ ip: '10.0.1.2', body: { email } }).context,
      ),
    ).toBe(true);
    expect(() =>
      verifyGuard.canActivate(
        makeContext({ ip: '10.0.1.3', body: { email } }).context,
      ),
    ).toThrow(HttpException);

    // Password-reset bucket is isolated from verify-email bucket
    expect(
      resetGuard.canActivate(
        makeContext({ ip: '10.0.1.3', body: { email } }).context,
      ),
    ).toBe(true);
    expect(
      resetGuard.canActivate(
        makeContext({ ip: '10.0.1.4', body: { email } }).context,
      ),
    ).toBe(true);
    expect(() =>
      resetGuard.canActivate(
        makeContext({ ip: '10.0.1.5', body: { email } }).context,
      ),
    ).toThrow(HttpException);

    // Exhausting verify-email and password-reset never locks the user out of login
    expect(
      loginGuard.canActivate(
        makeContext({ ip: '10.0.1.6', body: { email } }).context,
      ),
    ).toBe(true);
  });

  it('empêche le contournement par casse/espaces sur email ou en-tête X-Forwarded-For non fiable', () => {
    const limiter = new AuthRateLimiter();
    const guard = new AuthRateLimitGuard(
      limiter,
      { get: () => 'password-reset-request' } as unknown as Reflector,
      {
        ...TEST_OPTIONS,
        passwordResetRequestMaxPerIp: 10,
        passwordResetRequestMaxPerAccount: 2,
        trustProxy: false,
      },
    );

    expect(
      guard.canActivate(
        makeContext({
          ip: '10.0.2.1',
          headers: { 'x-forwarded-for': '203.0.113.1' },
          body: { email: '  User@Example.COM ' },
        }).context,
      ),
    ).toBe(true);

    expect(
      guard.canActivate(
        makeContext({
          ip: '10.0.2.2',
          headers: { 'x-forwarded-for': '203.0.113.2' },
          body: { email: 'user@example.com' },
        }).context,
      ),
    ).toBe(true);

    expect(() =>
      guard.canActivate(
        makeContext({
          ip: '10.0.2.3',
          headers: { 'x-forwarded-for': '203.0.113.3' },
          body: { email: 'USER@EXAMPLE.COM' },
        }).context,
      ),
    ).toThrow(HttpException);
  });

  it('extrait l’IP client réelle derrière le BFF de confiance sans faire confiance au préfixe X-Forwarded-For usurpé', () => {
    const limiter = new AuthRateLimiter();
    const guard = new AuthRateLimitGuard(
      limiter,
      { get: () => 'register' } as unknown as Reflector,
      {
        ...TEST_OPTIONS,
        registerMaxPerIp: 2,
        registerMaxPerAccount: 10,
        trustProxy: true,
      },
    );

    // Attacker behind BFF (127.0.0.1) prepends a different fake IP on each call,
    // while the BFF appends the real client IP (198.51.100.42) at the end.
    expect(
      guard.canActivate(
        makeContext({
          socket: { remoteAddress: '::ffff:127.0.0.1' },
          headers: { 'x-forwarded-for': '1.1.1.1, 198.51.100.42' },
          body: { email: 'a@example.com' },
        }).context,
      ),
    ).toBe(true);

    expect(
      guard.canActivate(
        makeContext({
          socket: { remoteAddress: '::ffff:127.0.0.1' },
          headers: { 'x-forwarded-for': '8.8.8.8, 198.51.100.42' },
          body: { email: 'b@example.com' },
        }).context,
      ),
    ).toBe(true);

    // Third call from the same real client IP (despite a 3rd spoofed prefix) is blocked
    expect(() =>
      guard.canActivate(
        makeContext({
          socket: { remoteAddress: '::ffff:127.0.0.1' },
          headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.42' },
          body: { email: 'c@example.com' },
        }).context,
      ),
    ).toThrow(HttpException);

    // Another real client IP behind the same BFF is isolated and allowed
    expect(
      guard.canActivate(
        makeContext({
          socket: { remoteAddress: '::ffff:127.0.0.1' },
          headers: { 'x-forwarded-for': '198.51.100.99' },
          body: { email: 'd@example.com' },
        }).context,
      ),
    ).toBe(true);
  });
});
