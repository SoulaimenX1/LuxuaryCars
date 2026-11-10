import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { RequireMfa } from '../auth/decorators/require-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { MfaGuard } from '../auth/guards/mfa.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UserRole } from '../users/entities/user.entity.js';
import { DynamicPricingService, DynamicPricingStatus } from './dynamic-pricing.service.js';
import type {
    ApplyPricingRecommendationDto,
    RollbackPricingRuleDto,
    ScopedPricingRuleDto,
} from '../dashboard/dto/pricing-demand.dto.js';

interface AuthenticatedRequest {
    user?: {
        id?: string;
        email?: string;
        role?: string;
        mfaVerified?: boolean;
    };
}

@Controller('admin/pricing')
@UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
@Roles(UserRole.ADMIN)
@RequireMfa()
export class AdminPricingController {
    constructor(private readonly dynamicPricing: DynamicPricingService) {}

    @Get('status')
    async getStatus(): Promise<DynamicPricingStatus> {
        return this.dynamicPricing.getStatus();
    }

    @Patch('toggle')
    async toggle(
        @Body() body: { enabled: boolean },
        @Req() req: AuthenticatedRequest,
    ) {
        if (typeof body?.enabled !== 'boolean') {
            throw new BadRequestException('Field "enabled" must be an explicit boolean value.');
        }

        return this.dynamicPricing.setEnabled(body.enabled, req.user?.id);
    }

    @Get('rules')
    async getApprovedRules(): Promise<ScopedPricingRuleDto[]> {
        return this.dynamicPricing.getApprovedPricingRules();
    }

    @Post('rules/apply')
    @HttpCode(HttpStatus.OK)
    async applyRule(
        @Body() body: ApplyPricingRecommendationDto & { recommendationId?: string },
        @Req() req: AuthenticatedRequest,
    ) {
        return this.dynamicPricing.applyScopedRule(body, body.recommendationId, req.user?.id);
    }

    @Post('rules/:id/rollback')
    @HttpCode(HttpStatus.OK)
    async rollbackRule(
        @Param('id') ruleId: string,
        @Body() body: RollbackPricingRuleDto,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.dynamicPricing.rollbackPricingRule(ruleId, body?.reason, req.user?.id);
    }
}
