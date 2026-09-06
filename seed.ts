import { PrismaClient, ActionStatus, AuditEventType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'demo@bharatai.local' },
    update: {},
    create: {
      email: 'demo@bharatai.local',
      phone: '+919999999999',
      name: 'Demo User',
    },
  });

  const existing = await prisma.actionRequest.findFirst({
    where: {
      userId: user.id,
      status: ActionStatus.PENDING,
    },
  });

  if (!existing) {
    const action = await prisma.actionRequest.create({
      data: {
        userId: user.id,
        actionType: 'SEND_MARKETING_CAMPAIGN',
        payload: { targetCategory: 'Restaurants & Cafes' },
        analysis: {
          pros: [
            'Expected 25% revenue boost in Mumbai zone',
            'Automated customer targeting',
          ],
          cons: ['Requires ₹3,000 ad credit allocation'],
          estimatedCostINR: 3000,
          riskLevel: 'LOW',
        },
        status: ActionStatus.PENDING,
      },
    });

    await prisma.actionAuditEvent.create({
      data: {
        actionRequestId: action.id,
        actorId: user.id,
        type: AuditEventType.CREATED,
        details: { actionType: 'SEND_MARKETING_CAMPAIGN' },
      },
    });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());