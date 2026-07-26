import { GraphEdge, GraphNode, NodeHandle, WorkflowGraph } from './cadences.graph';

/**
 * Conversor de bots exportados do Kommo (Salesbot) para o grafo do Chat Bullq.
 *
 * O export do Kommo tem a forma `{ type_functionality, model: { text } }`, onde
 * `model.text` é um JSON (string) de PASSOS indexados por número. Cada passo tem
 * uma lista de handlers executados em sequência:
 *   - waits        → nó de espera; condições timer/message/working-time viram
 *                    as saídas "timeout"/"reply" (working-time ⇒ businessHoursOnly)
 *   - send_message → nó de mensagem (params.text)
 *   - list_message → nó de mensagem (list_message.body)
 *   - action(set_tag) → nó de ação (aplica tag)
 *   - goto         → aresta de saída para outro passo (type finish ⇒ stop)
 *   - conditions   → ramo por dado do lead (sem nó equivalente): seguimos o
 *                    `result` (best-effort) e registramos um aviso
 *   - start        → marca o passo de entrada
 *
 * Exemplo de entrada (model):
 *   { "text": "{\"0\": {\"question\": [{\"params\": {...}, \"handler\": \"waits\"}], ...}}" }
 * Saída: WorkflowGraph { nodes, edges } com posições (x,y) já calculadas.
 */

interface StepAction {
  step?: number | string;
  type?: string; // 'question' | 'finish'
}

export interface KommoModel {
  text?: string;
  [k: string]: unknown;
}

export interface ConversionResult {
  graph: WorkflowGraph;
  warnings: string[];
}

export function kommoToGraph(model: KommoModel): ConversionResult {
  const warnings: string[] = [];
  let steps: Record<string, any> = {};
  try {
    steps = typeof model?.text === 'string' ? JSON.parse(model.text) : {};
  } catch {
    warnings.push('model.text não é um JSON válido');
  }
  if (!steps || typeof steps !== 'object') steps = {};

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const alias: Record<string, string> = {};
  let stopUsed = false;

  const stop = (): string => {
    if (!stopUsed) {
      nodes.push({ id: 'stop', type: 'stop' });
      stopUsed = true;
    }
    return 'stop';
  };
  const target = (action?: StepAction): string => {
    if (!action) return stop();
    if (action.type === 'finish') return stop();
    return 's' + String(action.step);
  };

  let entryKey: string | null = null;

  for (const [S, v] of Object.entries(steps)) {
    if (!v || typeof v !== 'object') continue;
    const blocks: any[] = Array.isArray((v as any).question) ? (v as any).question : [];
    if (blocks.some((b) => b && b.handler === 'start')) entryKey = S;

    let prev: string | null = null; // nó cujo "out" aponta para o próximo
    let madeInStep = false;
    const nid = (bi: number) => (bi === 0 ? 's' + S : `s${S}_${bi}`);

    blocks.forEach((b, bi) => {
      if (!b || typeof b !== 'object') return;
      const h = b.handler as string;
      const p = (b.params ?? {}) as any;

      if (h === 'waits') {
        const node: GraphNode = { id: nid(bi), type: 'wait', delayMinutes: 0 };
        for (const c of p.conditions ?? []) {
          const ev = c?.event ?? {};
          const ac = c?.action as StepAction | undefined;
          if (ev.source === 'timer') {
            node.delayMinutes = Math.round((Number(ev.delay) || 0) / 60);
            edges.push({ from: node.id, fromHandle: 'timeout', to: target(ac) });
          } else if (ev.source === 'message') {
            node.untilReply = true;
            edges.push({ from: node.id, fromHandle: 'reply', to: target(ac) });
          } else if (ev.source === 'working-time') {
            node.businessHoursOnly = true;
            edges.push({ from: node.id, fromHandle: 'timeout', to: target(ac) });
          }
        }
        if (prev) edges.push({ from: prev, fromHandle: 'out', to: node.id });
        nodes.push(node);
        madeInStep = true;
        prev = null; // espera ramifica → encerra a cadeia do passo
      } else if (h === 'send_message' || h === 'list_message') {
        const text =
          (typeof p.text === 'string' && p.text) ||
          (p.list_message && p.list_message.body) ||
          '';
        const node: GraphNode = { id: nid(bi), type: 'message', text };
        if (prev) edges.push({ from: prev, fromHandle: 'out', to: node.id });
        nodes.push(node);
        madeInStep = true;
        prev = node.id;
      } else if (h === 'action') {
        if (p.name === 'set_tag') {
          const vals = (p.params && p.params.value) || [''];
          const node: GraphNode = {
            id: nid(bi),
            type: 'action',
            action: 'tag',
            value: Array.isArray(vals) ? String(vals[0] ?? '') : String(vals),
          };
          if (prev) edges.push({ from: prev, fromHandle: 'out', to: node.id });
          nodes.push(node);
          madeInStep = true;
          prev = node.id;
        } else {
          warnings.push(`ação "${p.name}" ignorada (passo ${S})`);
        }
      } else if (h === 'goto') {
        const tgt = target(p as StepAction);
        if (prev) {
          edges.push({ from: prev, fromHandle: 'out', to: tgt });
          prev = null;
        } else if (!madeInStep) {
          alias['s' + S] = tgt;
        }
      } else if (h === 'conditions') {
        let res: StepAction | undefined;
        for (const r of p.result ?? []) {
          if (r?.handler === 'goto') {
            res = r.params as StepAction;
            break;
          }
        }
        const tgt = res ? target(res) : stop();
        if (prev) {
          edges.push({ from: prev, fromHandle: 'out', to: tgt });
          prev = null;
        } else if (!madeInStep) {
          alias['s' + S] = tgt;
        }
        warnings.push(`condição por dado do lead simplificada (passo ${S})`);
      }
      // 'start' e desconhecidos: ignorados
    });
  }

  // Passo de entrada
  if (entryKey === null) {
    const keys = Object.keys(steps);
    entryKey = keys.includes('0')
      ? '0'
      : keys.sort((a, b) => (a.length - b.length) || a.localeCompare(b))[0] ?? null;
  }

  const resolve = (t: string): string => {
    const seen = new Set<string>();
    while (alias[t] && !seen.has(t)) {
      seen.add(t);
      t = alias[t];
    }
    return t;
  };

  // Nó start + aresta para a entrada
  nodes.unshift({ id: 'start', type: 'start' });
  if (entryKey !== null) {
    edges.unshift({ from: 'start', fromHandle: 'out', to: resolve('s' + entryKey) });
  }

  // Resolve alias e limpa alvos inexistentes → stop
  const nodeIds = new Set(nodes.map((n) => n.id));
  const clean: GraphEdge[] = [];
  for (const e of edges) {
    let to = resolve(e.to);
    if (!nodeIds.has(to) && to !== 'stop') {
      to = stop();
      nodeIds.add('stop');
    }
    if (!nodeIds.has(e.from)) continue;
    clean.push({ from: e.from, fromHandle: (e.fromHandle ?? 'out') as NodeHandle, to });
  }

  layout(nodes, clean);
  return { graph: { nodes, edges: clean }, warnings };
}

/** Layout em camadas (BFS a partir do start) — esquerda→direita, como o Kommo. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (byId.has('start')) {
    depth.set('start', 0);
    queue.push('start');
  }
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    for (const e of edges.filter((x) => x.from === id)) {
      if (!depth.has(e.to)) {
        depth.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }
  // nós desconectados vão para uma coluna extra
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const rowByDepth = new Map<number, number>();
  for (const n of nodes) {
    const d = depth.has(n.id) ? depth.get(n.id)! : maxDepth + 1;
    const row = rowByDepth.get(d) ?? 0;
    rowByDepth.set(d, row + 1);
    n.x = 40 + d * 300;
    n.y = 40 + row * 170;
  }
}
