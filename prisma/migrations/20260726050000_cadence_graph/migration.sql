-- Salesbot com ramificações: grafo de nós na Cadence + cursor de nó no Run.
ALTER TABLE "cadences" ADD COLUMN IF NOT EXISTS "graph" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "cadence_runs" ADD COLUMN IF NOT EXISTS "current_node_id" TEXT;
