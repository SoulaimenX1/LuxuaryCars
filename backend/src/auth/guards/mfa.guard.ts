import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/entities/user.entity.js';
import { REQUIRE_MFA_KEY } from '../decorators/require-mfa.decorator.js';
import type { AuthenticatedUser } from './jwt-auth.guard.js';

@Injectable()
export class MfaGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const isMfaEnforcedGlobal =
            process.env.ENABLE_MANDATORY_ADMIN_MFA === 'true';

        const explicitRequireMfa = this.reflector.getAllAndOverride<boolean>(
            REQUIRE_MFA_KEY,
            [context.getHandler(), context.getClass()],
        );

        // If neither explicit MFA nor global mandatory MFA is active, allow passage
        if (!explicitRequireMfa && !isMfaEnforcedGlobal) {
            return true;
        }

        const request = context.switchToHttp().getRequest<{
            user?: AuthenticatedUser;
        }>();

        const user = request.user;
        if (!user) {
            throw new UnauthorizedException('Authentication required');
        }

        const isPrivileged =
            user.role === UserRole.ADMIN || user.role === UserRole.STAFF;

        // If explicitly required OR global enforcement is on for privileged roles
        if (explicitRequireMfa || (isMfaEnforcedGlobal && isPrivileged)) {
            if (!user.mfaVerified) {
                throw new ForbiddenException(
                    'Multi-Factor Authentication (MFA) verification required for privileged operations',
                );
            }
        }

        return true;
    }
}
