import { SetMetadata } from '@nestjs/common';

export const REQUIRE_MFA_KEY = 'require_mfa';

/**
 * Decorator to enforce mandatory Multi-Factor Authentication (MFA)
 * on privileged Admin or Staff endpoints.
 */
export const RequireMfa = (required: boolean = true) =>
    SetMetadata(REQUIRE_MFA_KEY, required);
