# Graph Report - chat-bullq-api  (2026-08-14)

## Corpus Check
- 476 files · ~204,499 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 232 nodes · 489 edges · 10 communities (8 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b3280abe`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- pipelines.module.ts
- WhatsappMergeService
- PipelinesService
- PipelinesController
- CommercialRoutineService
- pipelines.service.ts
- LeadDistributionService
- CadencesService
- InboundMessageProcessor
- ZApiMessageMapper

## God Nodes (most connected - your core abstractions)
1. `PipelinesService` - 33 edges
2. `CadencesService` - 28 edges
3. `PipelinesController` - 24 edges
4. `InboundMessageProcessor` - 17 edges
5. `LeadDistributionService` - 14 edges
6. `CommercialRoutineService` - 12 edges
7. `resolveGraph()` - 9 edges
8. `UpsertStageDto` - 9 edges
9. `CreatePipelineDto` - 9 edges
10. `UpdatePipelineDto` - 9 edges

## Surprising Connections (you probably didn't know these)
- `CadenceInput` --references--> `WorkflowGraph`  [EXTRACTED]
  src/modules/cadences/cadences.service.ts → src/modules/cadences/cadences.graph.ts

## Import Cycles
- None detected.

## Communities (10 total, 2 thin omitted)

### Community 0 - "pipelines.module.ts"
Cohesion: 0.14
Nodes (9): InjectQueue, Module, Processor, PipelineInactivityCronService, Injectable, PIPELINE_INACTIVITY_QUEUE, PIPELINE_INACTIVITY_SCAN_JOB, PipelineInactivityProcessor (+1 more)

### Community 1 - "WhatsappMergeService"
Cohesion: 0.13
Nodes (12): ApiBearerAuth, ApiTags, Controller, AppModule, Module, WhatsappMergeController, Module, WhatsappMergeModule (+4 more)

### Community 3 - "PipelinesController"
Cohesion: 0.23
Nodes (11): ApiOperation, Body, CurrentOrg, Delete, Get, Param, Patch, Post (+3 more)

### Community 4 - "CommercialRoutineService"
Cohesion: 0.19
Nodes (5): CommercialRoutineService, DEFAULT_STEPS, RoutineConfigInput, RoutineStep, StepMetric

### Community 5 - "pipelines.service.ts"
Cohesion: 0.15
Nodes (25): IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length (+17 more)

### Community 6 - "LeadDistributionService"
Cohesion: 0.18
Nodes (5): LeadDistributionConfigInput, LeadDistributionService, LeadWeight, PipelineRule, Injectable

### Community 8 - "CadencesService"
Cohesion: 0.10
Nodes (21): ActionKind, CadenceLike, edgeTarget(), GraphEdge, GraphNode, GraphNodeType, isGraph(), LinearStep (+13 more)

### Community 9 - "InboundMessageProcessor"
Cohesion: 0.18
Nodes (6): InboundJobData, InboundMessageProcessor, NON_TRIGGERING_MESSAGE_TYPES, replyMediaLabel(), safeJson(), StatusJobData

## Knowledge Gaps
- **25 isolated node(s):** `LeadWeight`, `PipelineRule`, `LeadDistributionConfigInput`, `InboundJobData`, `StatusJobData` (+20 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CadencesService` connect `CadencesService` to `pipelines.module.ts`, `InboundMessageProcessor`, `ZApiMessageMapper`, `pipelines.service.ts`?**
  _High betweenness centrality (0.382) - this node is a cross-community bridge._
- **Why does `PipelinesService` connect `PipelinesService` to `pipelines.module.ts`, `InboundMessageProcessor`, `pipelines.service.ts`, `LeadDistributionService`?**
  _High betweenness centrality (0.276) - this node is a cross-community bridge._
- **Why does `PipelinesController` connect `PipelinesController` to `pipelines.module.ts`, `WhatsappMergeService`, `PipelinesService`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **What connects `LeadWeight`, `PipelineRule`, `LeadDistributionConfigInput` to the rest of the system?**
  _25 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `pipelines.module.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.14035087719298245 - nodes in this community are weakly interconnected._
- **Should `WhatsappMergeService` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Should `PipelinesService` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._