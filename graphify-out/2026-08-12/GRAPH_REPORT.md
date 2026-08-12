# Graph Report - chat-bullq-api  (2026-08-10)

## Corpus Check
- 451 files · ~191,712 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 200 nodes · 438 edges · 13 communities (7 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8dcd4a23`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- pipelines.module.ts
- WhatsappMergeService
- PipelinesService
- ApiOperation
- Body
- pipelines.service.ts
- Param
- .upsertStages
- CadencesService
- InboundMessageProcessor
- ZApiMessageMapper
- PipelinesController
- .remove

## God Nodes (most connected - your core abstractions)
1. `PipelinesService` - 32 edges
2. `CadencesService` - 27 edges
3. `PipelinesController` - 24 edges
4. `InboundMessageProcessor` - 17 edges
5. `UpsertStageDto` - 10 edges
6. `CreatePipelineDto` - 10 edges
7. `UpdatePipelineDto` - 10 edges
8. `resolveGraph()` - 9 edges
9. `WhatsappMergeService` - 9 edges
10. `WhatsappMergeController` - 8 edges

## Surprising Connections (you probably didn't know these)
- `CadenceInput` --references--> `WorkflowGraph`  [EXTRACTED]
  src/modules/cadences/cadences.service.ts → src/modules/cadences/cadences.graph.ts

## Import Cycles
- None detected.

## Communities (13 total, 6 thin omitted)

### Community 0 - "pipelines.module.ts"
Cohesion: 0.15
Nodes (9): InjectQueue, Module, Processor, PipelineInactivityCronService, Injectable, PIPELINE_INACTIVITY_QUEUE, PIPELINE_INACTIVITY_SCAN_JOB, PipelineInactivityProcessor (+1 more)

### Community 1 - "WhatsappMergeService"
Cohesion: 0.17
Nodes (7): AppModule, Module, Module, WhatsappMergeModule, MergePair, MergeSummary, WhatsappMergeService

### Community 3 - "ApiOperation"
Cohesion: 0.24
Nodes (4): ApiOperation, CurrentOrg, Get, Query

### Community 5 - "pipelines.service.ts"
Cohesion: 0.15
Nodes (25): IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length (+17 more)

### Community 8 - "CadencesService"
Cohesion: 0.10
Nodes (21): ActionKind, CadenceLike, edgeTarget(), GraphEdge, GraphNode, GraphNodeType, isGraph(), LinearStep (+13 more)

### Community 9 - "InboundMessageProcessor"
Cohesion: 0.18
Nodes (6): InboundJobData, InboundMessageProcessor, NON_TRIGGERING_MESSAGE_TYPES, replyMediaLabel(), safeJson(), StatusJobData

### Community 11 - "PipelinesController"
Cohesion: 0.43
Nodes (6): ApiBearerAuth, ApiTags, Controller, PipelinesController, WhatsappMergeController, UseGuards

## Knowledge Gaps
- **18 isolated node(s):** `InboundJobData`, `StatusJobData`, `GraphNodeType`, `NodeHandle`, `GraphEdge` (+13 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PipelinesService` connect `PipelinesService` to `pipelines.module.ts`, `ApiOperation`, `Body`, `pipelines.service.ts`, `Param`, `.upsertStages`, `InboundMessageProcessor`, `PipelinesController`, `.remove`?**
  _High betweenness centrality (0.347) - this node is a cross-community bridge._
- **Why does `CadencesService` connect `CadencesService` to `pipelines.module.ts`, `InboundMessageProcessor`, `ZApiMessageMapper`?**
  _High betweenness centrality (0.320) - this node is a cross-community bridge._
- **Why does `InboundMessageProcessor` connect `InboundMessageProcessor` to `pipelines.module.ts`?**
  _High betweenness centrality (0.137) - this node is a cross-community bridge._
- **What connects `InboundJobData`, `StatusJobData`, `GraphNodeType` to the rest of the system?**
  _18 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `pipelines.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1455026455026455 - nodes in this community are weakly interconnected._
- **Should `CadencesService` be split into smaller, more focused modules?**
  _Cohesion score 0.10048309178743961 - nodes in this community are weakly interconnected._