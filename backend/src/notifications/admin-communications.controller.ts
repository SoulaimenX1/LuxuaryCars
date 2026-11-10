import {
    BadRequestException,
    Controller,
    Get,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UserRole } from '../users/entities/user.entity.js';
import { EmailOutboxService } from './email-outbox.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('admin/communications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminCommunicationsController {
    constructor(private readonly outboxService: EmailOutboxService) {}

    @Get('overview')
    async getOverview() {
        return this.outboxService.getOutboxMetrics();
    }

    @Get('outbox')
    async getOutbox(
        @Query('status') status?: string,
        @Query('search') search?: string,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
    ) {
        const pageNum = Math.max(0, parseInt(page || '0', 10) || 0);
        const limitNum = Math.min(Math.max(1, parseInt(limit || '30', 10) || 30), 100);
        const offset = pageNum * limitNum;

        return this.outboxService.getOutboxItems({
            status: status && status !== 'all' ? status : undefined,
            search: search ? search.trim() : undefined,
            limit: limitNum,
            offset,
        });
    }

    @Post('outbox/:id/retry')
    async retryOutbox(@Param('id') id: string) {
        if (!UUID_REGEX.test(id)) {
            throw new BadRequestException('Invalid outbox email record ID format.');
        }
        return this.outboxService.retryOutboxItem(id);
    }

    @Post('outbox/process')
    async triggerWorkerProcess() {
        return this.outboxService.processOutboxBatch(25);
    }
}
