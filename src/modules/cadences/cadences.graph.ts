/**
 * Modelo de grafo do Salesbot (motor com ramificações).
 *
 * Um bot é um grafo de NÓS conectados por ARESTAS. Cada nó tem saídas
 * (handles) que apontam para o próximo nó:
 *   - start   → handle "out"
 *   - message → handle "out"          (envia texto, segue)
 *   - action  → handle "out"          (tag / mover etapa / fechar)
 *   - wait    → handles "timeout" e "reply"
 *        · "timeout" dispara quando o cronômetro estoura
 *        · "reply"   dispara quando o cliente responde durante a espera
 *   - stop    → terminal (sem saída)
 *
 * Compat: cadências antigas gravaram só `steps` (régua linear). `resolveGraph`
 * deriva um grafo linear equivalente quando `graph` está vazio — nenhum dado
 * precisa ser migrado.
 *
 * Exemplo de payload (graph):
 * {
 *   "nodes": [
 *     { "id": "start", "type": "start", "x": 40,  "y": 200 },
 *     { "id": "w1", "type": "wait", "delayMinutes": 60, "untilReply": true, "x": 260, "y": 200 },
 *     { "id": "m1", "type": "message", "text": "Oie!", "x": 520, "y": 120 },
 *     { "id": "stop1", "type": "stop", "x": 520, "y": 320 }
 *   ],
 *   "edges": [
 *     { "from": "start", "fromHandle": "out", "to": "w1" },
 *     { "from": "w1", "fromHandle": "timeout", "to": "m1" },
 *     { "from": "w1", "fromHandle": "reply", "to": "stop1" }
 *   ]
 * }
 */

export type GraphNodeType = 'start' | 'message' | 'wait' | 'action' | 'stop';
export type NodeHandle = 'out' | 'timeout' | 'reply';
export type ActionKind = 'tag' | 'move_stage' | 'close';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  // message
  text?: string;
  // wait
  delayMinutes?: number;
  untilReply?: boolean;
  businessHoursOnly?: boolean;
  // action
  action?: ActionKind;
  value?: string;
  // canvas (ignorado pelo motor)
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id?: string;
  from: string;
  fromHandle?: NodeHandle;
  to: string;
}

export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Passo TIPADO do formato linear legado. */
export type LinearStep =
  | { type: 'message'; text: string }
  | { type: 'wait'; delayMinutes: number }
  | { type: 'action'; action: ActionKind; value?: string };

/** Normaliza `steps` (aceita tipados + legado {delayMinutes,text}) → LinearStep[]. */
export function normalizeSteps(raw: unknown): LinearStep[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: LinearStep[] = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, any>;
    if (o.type === 'message' && typeof o.text === 'string') {
      out.push({ type: 'message', text: o.text });
    } else if (o.type === 'wait') {
      out.push({ type: 'wait', delayMinutes: Number(o.delayMinutes) || 0 });
    } else if (o.type === 'action') {
      out.push({ type: 'action', action: o.action, value: o.value });
    } else if (typeof o.text === 'string') {
      // legado { delayMinutes, text } → espera + mensagem
      if (Number(o.delayMinutes) > 0) {
        out.push({ type: 'wait', delayMinutes: Number(o.delayMinutes) });
      }
      out.push({ type: 'message', text: o.text });
    }
  }
  return out;
}

interface CadenceLike {
  graph?: unknown;
  steps?: unknown;
  stopOnReply?: boolean;
  businessHoursOnly?: boolean;
}

function isGraph(g: unknown): g is WorkflowGraph {
  return (
    !!g &&
    typeof g === 'object' &&
    Array.isArray((g as WorkflowGraph).nodes) &&
    (g as WorkflowGraph).nodes.length > 0
  );
}

/**
 * Resolve o grafo executável da cadência. Se `graph` tem nós, usa-o. Senão,
 * deriva um grafo LINEAR a partir de `steps` (start → ...passos... → stop),
 * mapeando `stopOnReply`/`businessHoursOnly` nos nós de espera.
 */
export function resolveGraph(cadence: CadenceLike): WorkflowGraph {
  if (isGraph(cadence.graph)) return cadence.graph as WorkflowGraph;

  const steps = normalizeSteps(cadence.steps);
  const nodes: GraphNode[] = [{ id: 'start', type: 'start', x: 40, y: 160 }];
  const edges: GraphEdge[] = [];
  let prev = 'start';
  let x = 260;

  steps.forEach((s, i) => {
    const id = `n${i}`;
    const node: GraphNode = { id, type: s.type, x, y: 160 };
    if (s.type === 'message') node.text = s.text;
    else if (s.type === 'wait') {
      node.delayMinutes = s.delayMinutes;
      node.untilReply = !!cadence.stopOnReply;
      node.businessHoursOnly = !!cadence.businessHoursOnly;
    } else if (s.type === 'action') {
      node.action = s.action;
      node.value = s.value;
    }
    nodes.push(node);
    edges.push({ from: prev, fromHandle: 'out', to: id });
    // Numa espera linear, "reply" encerra (equivale ao stopOnReply global).
    prev = id;
    x += 220;
  });

  const stopId = 'stop';
  nodes.push({ id: stopId, type: 'stop', x, y: 160 });
  edges.push({ from: prev, fromHandle: 'out', to: stopId });
  return { nodes, edges };
}

export function nodeById(g: WorkflowGraph, id: string | null | undefined): GraphNode | undefined {
  if (!id) return undefined;
  return g.nodes.find((n) => n.id === id);
}

/** Nó de entrada: o `start`, ou o 1º nó se não houver start explícito. */
export function startNode(g: WorkflowGraph): GraphNode | undefined {
  return g.nodes.find((n) => n.type === 'start') ?? g.nodes[0];
}

/** Alvo da aresta que sai de `nodeId` pelo handle dado (default "out"). */
export function edgeTarget(
  g: WorkflowGraph,
  nodeId: string,
  handle: NodeHandle = 'out',
): string | null {
  const e = g.edges.find((x) => x.from === nodeId && (x.fromHandle ?? 'out') === handle);
  return e ? e.to : null;
}

// ─── Horário de expediente ───────────────────────────────
// Janela padrão: Seg–Sex, 08:00–17:30 no fuso America/Sao_Paulo (UTC-3).
// O servidor roda em UTC; aplicamos offset fixo (-3h) — suficiente para o
// caso de uso (sem horário de verão no BR desde 2019).
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3
const BIZ_START_MIN = 8 * 60; // 08:00
const BIZ_END_MIN = 17 * 60 + 30; // 17:30

/**
 * Retorna o timestamp (ms epoch) em que um disparo agendado para `fireAtMs`
 * deve realmente ocorrer, respeitando a janela de expediente. Se cair fora,
 * empurra para a próxima abertura (08:00 do próximo dia útil).
 */
export function shiftIntoBusinessHours(fireAtMs: number): number {
  // Trabalha em "horário local BRT" somando o offset e usando getUTC*.
  let d = new Date(fireAtMs - BRT_OFFSET_MS);
  for (let guard = 0; guard < 14; guard++) {
    const dow = d.getUTCDay(); // 0=Dom … 6=Sáb (já em BRT)
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    const isWeekend = dow === 0 || dow === 6;

    if (!isWeekend && minutes >= BIZ_START_MIN && minutes <= BIZ_END_MIN) {
      return d.getTime() + BRT_OFFSET_MS; // dentro da janela → mantém
    }
    if (!isWeekend && minutes < BIZ_START_MIN) {
      // antes de abrir → hoje às 08:00
      d.setUTCHours(8, 0, 0, 0);
      return d.getTime() + BRT_OFFSET_MS;
    }
    // depois de fechar ou fim de semana → próximo dia às 08:00
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    d.setUTCHours(8, 0, 0, 0);
  }
  return fireAtMs; // fallback improvável
}
