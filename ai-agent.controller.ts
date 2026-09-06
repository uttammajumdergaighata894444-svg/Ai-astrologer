import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';

@Controller('ai-agent')
export class AiAgentController {
  constructor(private readonly aiAgentService: AiAgentService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('pending')
  async pending(@Query('userId') userId = 'demo-user') {
    const request = await this.aiAgentService.getPendingAction(userId);
    if (!request) return null;

    return {
      requestId: request.id,
      actionType: request.actionType,
      status: request.status,
      createdAt: request.createdAt,
      analysis: request.analysis,
      payload: request.payload,
      executions: request.executions,
      auditEvents: request.auditEvents,
    };
  }

  @Post('execute')
  execute(
    @Body()
    body: {
      userId?: string;
      actionRequestId: string;
      approved: boolean;
    },
  ) {
    return this.aiAgentService.executeApprovedAction(
      body.userId ?? 'demo-user',
      body.actionRequestId,
      body.approved,
    );
  }
}