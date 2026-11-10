import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminSecurityController } from './admin-security.controller.js';
import { AdminSecurityService } from './admin-security.service.js';

@Module({
    imports: [AuthModule, UsersModule],
    providers: [AdminSecurityService],
    controllers: [AdminSecurityController],
    exports: [AdminSecurityService],
})
export class AdminSecurityModule {}
