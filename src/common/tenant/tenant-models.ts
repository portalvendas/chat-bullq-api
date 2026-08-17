/**
 * Modelos Prisma escopados por tenant (têm coluna `organizationId`).
 * Fonte da verdade pro tenant-guard (prisma.service). Se adicionar um
 * modelo novo com organizationId no schema, inclua aqui.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'LeadDistributionConfig', 'CommercialRoutineConfig', 'RoutineDailyCheck',
  'UserOrganization', 'PermissionGroup', 'Invitation', 'Channel', 'Contact',
  'Conversation', 'ConversationRating', 'Department', 'ChatbotFlow', 'QuickReply',
  'Tag', 'Notification', 'NotificationPreference', 'ApiKey', 'AiAgent', 'AiTool',
  'AiSkill', 'AiAgentRun', 'InboxView', 'CustomField', 'InstagramComment',
  'Pipeline', 'Card', 'AgentKnowledgeNote', 'KnowledgeItem', 'Cadence', 'Product',
  'OutboxEvent', 'Automation', 'AutomationRun', 'WhatsappTemplate', 'LeadAdsPage',
  'TinyIntegration', 'TinyDocument', 'MetaCapiConfig', 'MetaCapiEvent',
]);

/** Ações Prisma que operam em CONJUNTOS de linhas e, portanto, DEVEM filtrar
 *  por org. findUnique/*by-id ficam de fora (chave única; o padrão do código
 *  é buscar por id e assertar a org logo depois — o guard não enxerga isso). */
export const SET_ACTIONS: ReadonlySet<string> = new Set([
  'findMany', 'findFirst', 'updateMany', 'deleteMany', 'count', 'aggregate', 'groupBy',
]);

/** Detecta (superficialmente) se o `where` menciona organizationId — no topo
 *  ou dentro de AND/OR/NOT. Suficiente pro modo observação. */
export function whereMentionsOrg(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  const w = where as Record<string, any>;
  if ('organizationId' in w) return true;
  for (const key of ['AND', 'OR', 'NOT'] as const) {
    const v = w[key];
    if (Array.isArray(v) && v.some((x) => whereMentionsOrg(x))) return true;
    if (v && !Array.isArray(v) && whereMentionsOrg(v)) return true;
  }
  return false;
}
