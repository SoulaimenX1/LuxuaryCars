import {
    Body,
    Controller,
    Get,
    Patch,
    Req,
    UseGuards,
} from '@nestjs/common';
import { RequireMfa } from '../auth/decorators/require-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { MfaGuard } from '../auth/guards/mfa.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UserRole } from '../users/entities/user.entity.js';
import { PlatformSettingsValues, SettingsService } from './settings.service.js';

interface AuthenticatedRequest {
    user?: { id?: string };
}

@Controller('admin/settings')
@UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)
@Roles(UserRole.ADMIN)
@RequireMfa()
export class SettingsController {
    constructor(private readonly settingsService: SettingsService) {}

    @Get()
    async getSettings() {
        return this.settingsService.getSettings();
    }

    @Patch()
    async updateSettings(
        @Body() body: Partial<PlatformSettingsValues>,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.settingsService.updateSettings(body, req.user?.id);
    }
}
