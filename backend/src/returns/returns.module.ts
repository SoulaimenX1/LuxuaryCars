import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';
import { ReturnsService } from './returns.service.js';
import { ReturnsController } from './returns.controller.js';

@Module({
  imports: [AuthModule, UsersModule, NotificationsModule],
  providers: [ReturnsService],
  controllers: [ReturnsController],
})
export class ReturnsModule {}
