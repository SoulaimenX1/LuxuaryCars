import {
    Controller,
    Get,
    Query,
    UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UserRole } from '../users/entities/user.entity.js';
import { AdminSecurityService } from './admin-security.service.js';

@Controller('admin/security')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminSecurityController {
    constructor(private readonly securityService: AdminSecurityService) {}

    @Get('overview')
    async getOverview() {
        return this.securityService.getSecurityOverview();
    }

    @Get('audit-logs')
    async getAuditLogs(
        @Query('action') action?: string,
        @Query('entityType') entityType?: string,
        @Query('search') search?: string,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
    ) {
        const pageNum = Math.max(0, parseInt(page || '0', 10) || 0);
        const limitNum = Math.min(Math.max(1, parseInt(limit || '25', 10) || 25), 100);
        const offset = pageNum * limitNum;

        return this.securityService.getAuditLogs({
            action: action && action !== 'all' ? action : undefined,
            entityType: entityType && entityType !== 'all' ? entityType : undefined,
            search: search ? search.trim() : undefined,
            limit: limitNum,
            offset,
        });
    }
}
