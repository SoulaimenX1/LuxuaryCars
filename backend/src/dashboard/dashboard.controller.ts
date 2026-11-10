import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';

// ==========================================
// RÔLES DES UTILISATEURS
// ==========================================

import {
    UserRole,
} from '../users/entities/user.entity.js';

// ==========================================
// GUARDS DE SÉCURITÉ
// ==========================================

import {
    JwtAuthGuard,
} from '../auth/guards/jwt-auth.guard.js';

import {
    RolesGuard,
} from '../auth/guards/roles.guard.js';

import {
    MfaGuard,
} from '../auth/guards/mfa.guard.js';

// ==========================================
// DÉCORATEUR DES PERMISSIONS
// ==========================================

import {
    Roles,
} from '../auth/decorators/roles.decorator.js';

import {
    RequireMfa,
} from '../auth/decorators/require-mfa.decorator.js';

// ==========================================
// SERVICES & DTOS DU DASHBOARD
// ==========================================

import {
    DashboardService,
} from './dashboard.service.js';

import {
    DashboardIntelligenceService,
} from './dashboard-intelligence.service.js';

import {
    FleetMaintenanceIntelligenceService,
} from './fleet-maintenance-intelligence.service.js';

import {
    PricingDemandIntelligenceService,
} from './pricing-demand-intelligence.service.js';

import {
    OperationsRiskMonitorService,
} from './operations-risk-monitor.service.js';

import {
    DashboardIntelligenceQueryDto,
    type ExecutiveIntelligenceReportDto,
} from './dto/dashboard-intelligence.dto.js';

import {
    CreateMaintenanceRecordRequestDto,
    type FleetMaintenanceOverviewResponseDto,
} from './dto/fleet-maintenance.dto.js';

import {
    ApplyPricingRecommendationDto,
    DismissPricingRecommendationDto,
    PricingDemandOverviewQueryDto,
    RollbackPricingRuleDto,
    SimulatePricingRecommendationDto,
    type PricingDemandOverviewResponseDto,
    type ScopedPricingRuleDto,
    type SimulationResultDto,
} from './dto/pricing-demand.dto.js';

import {
    CancelExpiredActionDto,
    FlagReviewActionDto,
    OperationsRiskQueryDto,
    ResolveRiskActionDto,
    SendReminderActionDto,
    type OperationsRiskOverviewResponseDto,
} from './dto/operations-risk.dto.js';

@Controller('dashboard')
export class DashboardController {
    constructor(
        private readonly dashboardService: DashboardService,
        private readonly intelligenceService: DashboardIntelligenceService,
        private readonly fleetMaintenanceService: FleetMaintenanceIntelligenceService,
        private readonly pricingDemandService: PricingDemandIntelligenceService,
        private readonly operationsRiskService: OperationsRiskMonitorService,
    ) { }

    // ==========================================
    // 1. CONSULTER LE DASHBOARD ADMINISTRATEUR (RÉGRESSION ZÉRO)
    // ==========================================

    @Get('admin')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    getAdminDashboard() {
        return this.dashboardService.getSummary();
    }

    // ==========================================
    // 2. BUSINESS INTELLIGENCE EXÉCUTIF
    // ==========================================

    @Get('admin/intelligence')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    getAdminIntelligence(
        @Query() query: DashboardIntelligenceQueryDto,
    ): Promise<ExecutiveIntelligenceReportDto> {
        return this.intelligenceService.getExecutiveReport(query);
    }

    // ==========================================
    // 3. FLEET HEALTH & PREDICTIVE MAINTENANCE
    // ==========================================

    @Get('admin/maintenance/overview')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    getFleetMaintenanceOverview(): Promise<FleetMaintenanceOverviewResponseDto> {
        return this.fleetMaintenanceService.getFleetMaintenanceOverview();
    }

    @Post('admin/maintenance/records')
    @HttpCode(HttpStatus.CREATED)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    recordMaintenanceActivity(
        @Body() dto: CreateMaintenanceRecordRequestDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.fleetMaintenanceService.recordMaintenanceActivity(
            dto,
            actorId,
        );
    }

    // ==========================================
    // 4. DEMAND FORECASTING & SMART PRICING
    // ==========================================

    @Get('admin/pricing-demand/overview')
    @UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
    @Roles(UserRole.ADMIN)
    @RequireMfa()
    getPricingDemandOverview(
        @Query() query: PricingDemandOverviewQueryDto,
    ): Promise<PricingDemandOverviewResponseDto> {
        return this.pricingDemandService.getPricingDemandOverview(query);
    }

    @Post('admin/pricing-demand/recommendations/:id/apply')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
    @Roles(UserRole.ADMIN)
    @RequireMfa()
    applyPricingRecommendation(
        @Param('id') recommendationId: string,
        @Query('licensePlate') licensePlate: string,
        @Body() dto: ApplyPricingRecommendationDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.pricingDemandService.applyRecommendation(
            recommendationId,
            licensePlate,
            dto,
            actorId,
        );
    }

    @Post('admin/pricing-demand/recommendations/:id/simulate')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
    @Roles(UserRole.ADMIN)
    @RequireMfa()
    simulatePricingRecommendation(
        @Param('id') recommendationId: string,
        @Body() dto: SimulatePricingRecommendationDto,
    ): Promise<SimulationResultDto> {
        return this.pricingDemandService.simulateRecommendation(
            recommendationId,
            dto,
        );
    }

    @Post('admin/pricing-demand/recommendations/:id/dismiss')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
    @Roles(UserRole.ADMIN)
    @RequireMfa()
    dismissPricingRecommendation(
        @Param('id') recommendationId: string,
        @Body() dto: DismissPricingRecommendationDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.pricingDemandService.dismissRecommendation(
            recommendationId,
            dto,
            actorId,
        );
    }

    @Get('admin/pricing-demand/rules')
    @UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
    @Roles(UserRole.ADMIN)
    @RequireMfa()
    getApprovedPricingRules(): Promise<ScopedPricingRuleDto[]> {
        return this.pricingDemandService.getApprovedPricingRules();
    }

    @Post('admin/pricing-demand/rules/:id/rollback')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
    @Roles(UserRole.ADMIN)
    @RequireMfa()
    rollbackPricingRule(
        @Param('id') ruleId: string,
        @Body() dto: RollbackPricingRuleDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.pricingDemandService.rollbackPricingRule(
            ruleId,
            dto,
            actorId,
        );
    }

    // ==========================================
    // 5. OPERATIONS & RISK MONITOR
    // ==========================================

    @Get('admin/operations-risk/overview')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    getOperationsRiskOverview(
        @Query() query: OperationsRiskQueryDto,
    ): Promise<OperationsRiskOverviewResponseDto> {
        return this.operationsRiskService.getOperationsRiskOverview(query);
    }

    @Post('admin/operations-risk/actions/send-reminder')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    sendOperationsReminder(
        @Body() dto: SendReminderActionDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.operationsRiskService.executeSendReminder(dto, actorId);
    }

    @Post('admin/operations-risk/actions/flag-review')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    flagOperationsRiskForReview(
        @Body() dto: FlagReviewActionDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.operationsRiskService.executeFlagReview(dto, actorId);
    }

    @Post('admin/operations-risk/actions/resolve')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    resolveOperationsRisk(
        @Body() dto: ResolveRiskActionDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.operationsRiskService.executeResolveRisk(dto, actorId);
    }

    @Post('admin/operations-risk/actions/cancel-expired')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    cancelExpiredReservation(
        @Body() dto: CancelExpiredActionDto,
        @Req() req?: { user?: { id?: string; sub?: string } },
    ) {
        const actorId = req?.user?.id ?? req?.user?.sub;
        return this.operationsRiskService.executeCancelExpired(dto, actorId);
    }
}
