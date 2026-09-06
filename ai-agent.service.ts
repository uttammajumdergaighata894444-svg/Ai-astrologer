import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ActionStatus,
  AuditEventType,
  ExecutionStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ActionProposal {
  actionType: string;
  payload: any;
  analysis: {
    pros: string[];
    cons: string[];
    estimatedCostINR: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  };
}

@Injectable()
export class AiAgentService {
  constructor(private readonly prisma: PrismaService) {}

  async getPendingAction(userId: string) {
    return this.prisma.actionRequest.findFirst({
      where: {
        userId,
        status: ActionStatus.PENDING,
      },
      include: {
        executions: {
          orderBy: { attempt: 'asc' },
        },
        auditEvents: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Step 1: AI analyzes and suggests an action. Execution requires approval.
  async analyzeAndPropose(
    userId: string,
    userIntent: string,
    payload: any,
  ): Promise<any> {
    const amount = Number(payload?.amount ?? 0);
    const analysis = {
      pros: ['Best price matching Indian market', 'Instant confirmation guaranteed'],
      cons: ['Cancellation fee applies after 2 hours'],
      estimatedCostINR: Number.isFinite(amount) ? amount : 0,
      riskLevel: amount > 5000 ? ('MEDIUM' as const) : ('LOW' as const),
    };

    const actionRequest = await this.prisma.$transaction(async (tx) => {
      const createdRequest = await tx.actionRequest.create({
        data: {
          userId,
          actionType: userIntent,
          payload,
          analysis,
          status: ActionStatus.PENDING,
        },
      });

      await tx.actionAuditEvent.create({
        data: {
          actionRequestId: createdRequest.id,
          actorId: userId,
          type: AuditEventType.CREATED,
          details: { actionType: userIntent },
        },
      });

      return createdRequest;
    });

    return {
      message:
        'AI option analysis complete. Explicit user approval is required to execute.',
      actionRequestId: actionRequest.id,
      analysis: actionRequest.analysis,
      payload: actionRequest.payload,
    };
  }

  // Step 2: record the approval, create an execution attempt, and run it.
  async executeApprovedAction(
    userId: string,
    actionRequestId: string,
    approved: boolean,
  ) {
    const request = await this.prisma.actionRequest.findUnique({
      where: { id: actionRequestId },
    });

    if (!request || request.userId !== userId) {
      throw new BadRequestException('Invalid or unauthorized action request.');
    }

    if (request.status !== ActionStatus.PENDING) {
      throw new BadRequestException('Action has already been processed.');
    }

    if (!approved) {
      const rejected = await this.prisma.$transaction(async (tx) => {
        const update = await tx.actionRequest.updateMany({
          where: {
            id: actionRequestId,
            userId,
            status: ActionStatus.PENDING,
          },
          data: { status: ActionStatus.REJECTED },
        });

        if (update.count !== 1) {
          throw new BadRequestException('Action has already been processed.');
        }

        await tx.actionAuditEvent.create({
          data: {
            actionRequestId,
            actorId: userId,
            type: AuditEventType.REJECTED,
            details: { reason: 'Rejected by user' },
          },
        });

        return update;
      });

      return {
        status: rejected.count === 1 ? ActionStatus.REJECTED : undefined,
        message: 'Action cancelled by user.',
      };
    }

    const execution = await this.prisma.$transaction(async (tx) => {
      const update = await tx.actionRequest.updateMany({
        where: {
          id: actionRequestId,
          userId,
          status: ActionStatus.PENDING,
        },
        data: { status: ActionStatus.APPROVED },
      });

      if (update.count !== 1) {
        throw new BadRequestException('Action has already been processed.');
      }

      const attempt = await tx.actionExecution.create({
        data: {
          actionRequestId,
          attempt: 1,
          status: ExecutionStatus.RUNNING,
          provider: this.providerFor(request.actionType),
          operation: request.actionType,
          requestSnapshot: (request.payload ?? {}) as Prisma.InputJsonValue,
        },
      });

      await tx.actionAuditEvent.createMany({
        data: [
          {
            actionRequestId,
            actorId: userId,
            type: AuditEventType.APPROVED,
            details: { attempt: attempt.attempt },
          },
          {
            actionRequestId,
            type: AuditEventType.EXECUTION_STARTED,
            details: { attempt: attempt.attempt },
          },
        ],
      });

      return attempt;
    });

    try {
      const executionResult = await this.dispatchIntegration(
        request.actionType,
        request.payload,
      );
      const externalReference = this.externalReferenceFrom(executionResult);

      await this.prisma.$transaction(async (tx) => {
        await tx.actionExecution.update({
          where: { id: execution.id },
          data: {
            status: ExecutionStatus.SUCCEEDED,
            responseSnapshot: executionResult,
            externalReference,
            completedAt: new Date(),
          },
        });

        await tx.actionRequest.update({
          where: { id: actionRequestId },
          data: { status: ActionStatus.EXECUTED },
        });

        await tx.actionAuditEvent.create({
          data: {
            actionRequestId,
            type: AuditEventType.EXECUTION_SUCCEEDED,
            details: { attempt: execution.attempt, externalReference },
          },
        });
      });

      return {
        status: ActionStatus.EXECUTED,
        executionId: execution.id,
        attempt: execution.attempt,
        result: executionResult,
      };
    } catch (error: unknown) {
      const errorMessage = this.errorMessage(error);

      await this.prisma.$transaction(async (tx) => {
        await tx.actionExecution.update({
          where: { id: execution.id },
          data: {
            status: ExecutionStatus.FAILED,
            errorMessage,
            completedAt: new Date(),
          },
        });

        await tx.actionRequest.update({
          where: { id: actionRequestId },
          data: { status: ActionStatus.FAILED },
        });

        await tx.actionAuditEvent.create({
          data: {
            actionRequestId,
            type: AuditEventType.EXECUTION_FAILED,
            details: { attempt: execution.attempt, errorMessage },
          },
        });
      });

      throw new Error(`Execution failed: ${errorMessage}`);
    }
  }

  private providerFor(actionType: string): string {
    if (actionType.startsWith('BOOK_')) return 'booking';
    if (actionType.startsWith('PAYMENT')) return 'payments';
    if (actionType.startsWith('SEND_')) return 'messaging';
    if (actionType.startsWith('COURIER_')) return 'courier';
    return 'internal';
  }

  private externalReferenceFrom(result: any): string | undefined {
    const reference =
      result?.externalReference ?? result?.transactionId ?? result?.bookingId;
    return reference == null ? undefined : String(reference);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async dispatchIntegration(actionType: string, payload: any) {
    // Replace this hook with the real provider call.
    // Never store provider secrets in responseSnapshot.
    return {
      success: true,
      transactionId: `TXN_IND_${Date.now()}`,
      actionType,
      payload,
    };
  }
}