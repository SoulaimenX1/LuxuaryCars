import {createHmac, randomInt, timingSafeEqual} from 'node:crypto';

export function newCheckInCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, '0');
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET must be configured to protect agency check-in codes');
  }
  return value;
}

export function checkInCodeHash(code: string): string {
  return createHmac('sha256', secret()).update(code, 'utf8').digest('hex');
}

export function checkInCodeMatches(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(checkInCodeHash(code), 'hex');
  const expected = Buffer.from(storedHash.trim(), 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
