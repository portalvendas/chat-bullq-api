import { PrismaClient, PipelineStageType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * Funil de Vendas otimizado (derivado do funil do Kommo da operação
 * Armazém Decora). As 11 etapas do Kommo foram consolidadas em 6, com
 * terminais WON/LOST explícitos pra métrica de conversão limpa:
 *
 *   Kommo                                   →  Etapa
 *   ─────────────────────────────────────────────────────────────
 *   Leads de entrada + Importados           →  Entrada
 *   Follow-up inicial/automático/manual     →  Em contato
 *   Contato qualificado                     →  Qualificado
 *   Orçamento enviado                       →  Orçamento enviado
 *   Pedido realizado + Pedido enviado       →  Pedido realizado (WON)
 *   Provisório - mensagem não entregue      →  Perdido (LOST, vira motivo)
 *
 * "Parceria" (Personal Organizers, B2B) fica de fora de propósito — é um
 * fluxo distinto do B2C e deve virar um pipeline próprio pra não sujar a
 * conversão do funil de vendas.
 */
const SALES_PIPELINE_NAME = 'Funil de Vendas';
const SALES_STAGES: Array<{
  name: string;
  color: string;
  type: PipelineStageType;
}> = [
  { name: 'Entrada', color: 'zinc', type: PipelineStageType.NORMAL },
  { name: 'Em contato', color: 'blue', type: PipelineStageType.NORMAL },
  { name: 'Qualificado', color: 'violet', type: PipelineStageType.NORMAL },
  { name: 'Orçamento enviado', color: 'amber', type: PipelineStageType.NORMAL },
  { name: 'Pedido realizado', color: 'green', type: PipelineStageType.WON },
  { name: 'Perdido', color: 'red', type: PipelineStageType.LOST },
];

/**
 * Provisiona o Funil de Vendas para uma org. Idempotente: se já existir um
 * pipeline com o mesmo nome, não faz nada (seguro rodar em todo deploy).
 */
async function ensureSalesPipeline(organizationId: string): Promise<void> {
  const existing = await prisma.pipeline.findFirst({
    where: { organizationId, name: SALES_PIPELINE_NAME },
    select: { id: true },
  });
  if (existing) {
    console.log(`✓ Pipeline "${SALES_PIPELINE_NAME}" já existe (${existing.id})`);
    return;
  }

  const maxOrder = await prisma.pipeline.findFirst({
    where: { organizationId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });

  const pipeline = await prisma.pipeline.create({
    data: {
      organizationId,
      name: SALES_PIPELINE_NAME,
      description: 'Funil comercial B2C (derivado do funil do Kommo).',
      icon: 'trending-up',
      color: 'emerald',
      isDefault: true,
      order: (maxOrder?.order ?? -1) + 1,
      stages: {
        create: SALES_STAGES.map((s, i) => ({
          name: s.name,
          color: s.color,
          type: s.type,
          order: i,
        })),
      },
    },
    include: { stages: true },
  });

  // Garante só um default por org — rebaixa os demais.
  await prisma.pipeline.updateMany({
    where: { organizationId, isDefault: true, id: { not: pipeline.id } },
    data: { isDefault: false },
  });

  console.log(
    `✓ Pipeline "${SALES_PIPELINE_NAME}" criado (${pipeline.id}) com ${pipeline.stages.length} etapas`,
  );
}

/** Cria o admin/org na primeira vez; retorna o organizationId. */
async function ensureAdminOrg(): Promise<string> {
  const adminEmail = 'admin@bravy.com';
  const adminPassword = 'Admin@123';
  const adminName = 'Admin Bravy';

  const existing = await prisma.user.findUnique({
    where: { email: adminEmail },
    include: { organizations: { select: { organizationId: true } } },
  });

  if (existing) {
    const orgId = existing.organizations[0]?.organizationId;
    if (!orgId) {
      throw new Error('Admin existe mas sem organização vinculada.');
    }
    console.log(`✓ Usuário admin já existe: ${adminEmail} (org ${orgId})`);
    return orgId;
  }

  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: adminName,
        email: adminEmail,
        password: hashedPassword,
        isActive: true,
      },
    });

    const slug = `bravy-admin-${Date.now().toString(36)}`;

    const organization = await tx.organization.create({
      data: {
        name: 'Bravy HQ',
        slug,
        plan: 'enterprise',
        settings: { maxAgents: 999, maxChannels: 999, maxDepartments: 999 },
      },
    });

    const userOrg = await tx.userOrganization.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        role: 'OWNER',
        agentStatus: 'ONLINE',
        maxConcurrent: 99,
      },
    });

    const department = await tx.department.create({
      data: {
        organizationId: organization.id,
        name: 'Geral',
        description: 'Departamento padrão',
        isDefault: true,
      },
    });

    await tx.departmentAgent.create({
      data: { departmentId: department.id, userOrganizationId: userOrg.id },
    });

    return { user, organization };
  });

  console.log('═══════════════════════════════════════════');
  console.log('  ADMIN OWNER CRIADO COM SUCESSO');
  console.log(`  Email: ${adminEmail}  Senha: ${adminPassword}`);
  console.log(`  Org:   ${result.organization.name}`);
  console.log('═══════════════════════════════════════════');
  return result.organization.id;
}

async function main() {
  const organizationId = await ensureAdminOrg();
  await ensureSalesPipeline(organizationId);
}

main()
  .catch((e) => {
    console.error('Erro ao executar seed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
