import { Module } from '@nestjs/common';
import { AiAgentModule } from './ai-agent/ai-agent.module';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [AiAgentModule],
  providers: [PrismaService],
})
export class AppModule {}