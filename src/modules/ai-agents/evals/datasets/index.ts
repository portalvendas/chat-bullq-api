import type { EvalDataset } from '../types';

import { andreEval } from './andre.eval';
import { augustoEval } from './augusto.eval';
import { brunoEval } from './bruno.eval';
import { danielEval } from './daniel.eval';
import { liviaEval } from './livia.eval';

/**
 * Catalog of eval datasets keyed by canonical agent name.
 *
 * Keys MUST match `EvalDataset.agentName` exactly so the runner can lookup
 * the dataset by the agent under test without ambiguity.
 */
export const datasets: Record<string, EvalDataset> = {
  'Augusto Mendes': augustoEval,
  'Daniel Souza': danielEval,
  'André Silva': andreEval,
  'Bruno Costa': brunoEval,
  'Lívia Andrade': liviaEval,
};

export { andreEval, augustoEval, brunoEval, danielEval, liviaEval };
