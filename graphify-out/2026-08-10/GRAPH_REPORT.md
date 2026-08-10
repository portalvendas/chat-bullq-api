# Graph Report - chat-bullq-api  (2026-08-10)

## Corpus Check
- 442 files · ~187,873 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 171 nodes · 385 edges · 13 communities (7 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `40354c8a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- pipelines.module.ts
- WhatsappMergeService
- PipelinesService
- ApiOperation
- Body
- pipelines.service.ts
- .update
- .upsertStages
- cadences.graph.ts
- CadencesService
- .advance
- PipelinesController
- Param

## God Nodes (most connected - your core abstractions)
1. `PipelinesService` - 31 edges
2. `CadencesService` - 26 edges
3. `PipelinesController` - 24 edges
4. `UpsertStageDto` - 10 edges
5. `CreatePipelineDto` - 10 edges
6. `UpdatePipelineDto` - 10 edges
7. `resolveGraph()` - 9 edges
8. `WhatsappMergeService` - 9 edges
9. `WhatsappMergeController` - 8 edges
10. `CreateCardDto` - 7 edges

## Surprising Connections (you probably didn't know these)
- `CadenceInput` --references--> `WorkflowGraph`  [EXTRACTED]
  src/modules/cadences/cadences.service.ts → src/modules/cadences/cadences.graph.ts

## Import Cycles
- None detected.

## Communities (13 total, 6 thin omitted)

### Community 0 - "pipelines.module.ts"
Cohesion: 0.16
Nodes (9): InjectQueue, Module, Processor, PipelineInactivityCronService, Injectable, PIPELINE_INACTIVITY_QUEUE, PIPELINE_INACTIVITY_SCAN_JOB, PipelineInactivityProcessor (+1 more)

### Community 1 - "WhatsappMergeService"
Cohesion: 0.16
Nodes (8): Injectable, AppModule, Module, Module, WhatsappMergeModule, MergePair, MergeSummary, WhatsappMergeService

### Community 3 - "ApiOperation"
Cohesion: 0.21
Nodes (4): ApiOperation, CurrentOrg, Get, Query

### Community 5 - "pipelines.service.ts"
Cohesion: 0.15
Nodes (25): IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length (+17 more)

### Community 8 - "cadences.graph.ts"
Cohesion: 0.15
Nodes (17): CadenceLike, GraphEdge, GraphNode, GraphNodeType, isGraph(), LinearStep, NodeHandle, normalizeSteps() (+9 more)

### Community 10 - ".advance"
Cohesion: 0.40
Nodes (3): ActionKind, edgeTarget(), nodeById()

### Community 11 - "PipelinesController"
Cohesion: 0.43
Nodes (6): ApiBearerAuth, ApiTags, Controller, PipelinesController, WhatsappMergeController, UseGuards

## Knowledge Gaps
- **16 isolated node(s):** `GraphNodeType`, `NodeHandle`, `GraphEdge`, `LinearStep`, `CadenceLike` (+11 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CadencesService` connect `CadencesService` to `cadences.graph.ts`, `WhatsappMergeService`, `.advance`, `pipelines.module.ts`?**
  _High betweenness centrality (0.427) - this node is a cross-community bridge._
- **What connects `GraphNodeType`, `NodeHandle`, `GraphEdge` to the rest of the system?**
  _16 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `pipelines.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1455026455026455 - nodes in this community are weakly interconnected._