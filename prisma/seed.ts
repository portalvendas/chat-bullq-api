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
 * Pipeline de Marketplaces (ML/Shopee). Fluxo é Pergunta→Venda. A conversão
 * é detectada automaticamente pelo MarketplaceConversionService (cron), que
 * cruza o buyer_id da pergunta com pedidos pagos na API do canal e move o
 * card pra "Venda" com o valor do pedido.
 *
 * IMPORTANTE: os nomes das etapas abaixo são referenciados pelo
 * MarketplaceConversionService (MARKETPLACE_STAGES). Manter em sincronia.
 */
const MARKETPLACE_PIPELINE_NAME = 'Marketplaces';
const MARKETPLACE_STAGES: Array<{
  name: string;
  color: string;
  type: PipelineStageType;
}> = [
  { name: 'Pergunta recebida', color: 'zinc', type: PipelineStageType.NORMAL },
  { name: 'Respondida', color: 'blue', type: PipelineStageType.NORMAL },
  { name: 'Em negociação', color: 'amber', type: PipelineStageType.NORMAL },
  { name: 'Venda', color: 'green', type: PipelineStageType.WON },
  { name: 'Sem conversão', color: 'red', type: PipelineStageType.LOST },
];

/** Provisiona um pipeline (idempotente por nome) com as etapas dadas. */
async function ensurePipeline(
  organizationId: string,
  name: string,
  description: string,
  icon: string,
  color: string,
  stages: Array<{ name: string; color: string; type: PipelineStageType }>,
  isDefault: boolean,
): Promise<void> {
  const existing = await prisma.pipeline.findFirst({
    where: { organizationId, name },
    select: { id: true },
  });
  if (existing) {
    console.log(`✓ Pipeline "${name}" já existe (${existing.id})`);
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
      name,
      description,
      icon,
      color,
      isDefault,
      order: (maxOrder?.order ?? -1) + 1,
      stages: {
        create: stages.map((s, i) => ({
          name: s.name,
          color: s.color,
          type: s.type,
          order: i,
        })),
      },
    },
    include: { stages: true },
  });

  if (isDefault) {
    await prisma.pipeline.updateMany({
      where: { organizationId, isDefault: true, id: { not: pipeline.id } },
      data: { isDefault: false },
    });
  }

  console.log(
    `✓ Pipeline "${name}" criado (${pipeline.id}) com ${pipeline.stages.length} etapas`,
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
  await ensurePipeline(
    organizationId,
    SALES_PIPELINE_NAME,
    'Funil comercial B2C (derivado do funil do Kommo).',
    'trending-up',
    'emerald',
    SALES_STAGES,
    true, // default
  );
  await ensurePipeline(
    organizationId,
    MARKETPLACE_PIPELINE_NAME,
    'Perguntas de marketplace (ML/Shopee). Conversão detectada via API do canal.',
    'shopping-cart',
    'orange',
    MARKETPLACE_STAGES,
    false,
  );
}

main()
  .catch((e) => {
    console.error('Erro ao executar seed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
