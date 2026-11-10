
import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

import { UsersService } from '../../users/users.service.js';

import {
    AccountStatus,
    User,
} from '../../users/entities/user.entity.js';

export interface JwtPayload {
    sub: string;
    role?: string;
    scope?: string;
    pre_auth?: boolean;
    amr?: string[];
    mfa_verified?: boolean;
}

export type AuthenticatedUser = Pick<
    User,
    'id' | 'firstName' | 'lastName' | 'email' | 'role'
> & {
    mfaVerified?: boolean;
    amr?: string[];
    scope?: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly jwtService: JwtService,
        private readonly usersService: UsersService,
    ) { }

    async canActivate(
        context: ExecutionContext,
    ): Promise<boolean> {
        const request = context.switchToHttp().getRequest<{
            headers: { authorization?: string };
            user?: AuthenticatedUser;
        }>();

        const authorization =
            request.headers.authorization;

        if (!authorization) {
            throw new UnauthorizedException(
                'Authentication required',
            );
        }

        const [type, token] =
            authorization.split(' ');

        if (type !== 'Bearer' || !token) {
            throw new UnauthorizedException(
                'Invalid authorization header',
            );
        }

        let payload: JwtPayload;

        try {
            payload =
                await this.jwtService.verifyAsync<JwtPayload>(token);
        } catch {
            throw new UnauthorizedException(
                'Invalid or expired token',
            );
        }

        if (
            !payload ||
            typeof payload.sub !== 'string'
        ) {
            throw new UnauthorizedException(
                'Invalid token payload',
            );
        }

        // Strict MFA gate: Pre-auth tokens (scope: 'mfa_pending' or pre_auth=true)
        // are strictly prohibited from accessing standard authenticated endpoints.
        if (payload.scope === 'mfa_pending' || payload.pre_auth === true) {
            throw new UnauthorizedException(
                'MFA verification required: pre-auth tokens cannot access protected endpoints',
            );
        }

        const user =
            await this.usersService.findById(
                payload.sub,
            );

        if (
            !user ||
            user.status !== AccountStatus.ACTIVE
        ) {
            throw new UnauthorizedException(
                'Account unavailable',
            );
        }

        request.user = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            role: user.role,
            mfaVerified: payload.mfa_verified ?? false,
            amr: payload.amr ?? [],
            scope: payload.scope ?? 'authenticated',
        };

        return true;
    }
}
