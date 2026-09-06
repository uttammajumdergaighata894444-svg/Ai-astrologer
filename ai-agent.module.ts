import { Module } from '@nestjs/common';
import { AiAgentController } from './ai-agent.controller';
import { AiAgentService } from './ai-agent.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [AiAgentController],
  providers: [AiAgentService, PrismaService],
})
export class AiAgentModule {}