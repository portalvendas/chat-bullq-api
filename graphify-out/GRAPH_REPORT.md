# Graph Report - chat-bullq-api  (2026-08-14)

## Corpus Check
- 476 files · ~204,755 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 318 nodes · 752 edges · 10 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1388f74e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- pipelines.module.ts
- WhatsappMergeService
- PipelinesService
- Param
- CommercialRoutineService
- pipelines.service.ts
- LeadDistributionService
- ConversationsService
- CadencesService
- InboundMessageProcessor

## God Nodes (most connected - your core abstractions)
1. `PipelinesService` - 33 edges
2. `CadencesService` - 28 edges
3. `ConversationsController` - 25 edges
4. `ConversationsService` - 25 edges
5. `PipelinesController` - 24 edges
6. `LeadDistributionService` - 17 edges
7. `InboundMessageProcessor` - 17 edges
8. `ConversationsRepository` - 12 edges
9. `CommercialRoutineService` - 12 edges
10. `LeadDistributionController` - 9 edges

## Surprising Connections (you probably didn't know these)
- `CadenceInput` --references--> `WorkflowGraph`  [EXTRACTED]
  src/modules/cadences/cadences.service.ts → src/modules/cadences/cadences.graph.ts

## Import Cycles
- None detected.

## Communities (10 total, 0 thin omitted)

### Community 0 - "pipelines.module.ts"
Cohesion: 0.14
Nodes (9): InjectQueue, Module, Processor, PipelineInactivityCronService, Injectable, PIPELINE_INACTIVITY_QUEUE, PIPELINE_INACTIVITY_SCAN_JOB, PipelineInactivityProcessor (+1 more)

### Community 1 - "WhatsappMergeService"
Cohesion: 0.13
Nodes (12): ApiBearerAuth, ApiTags, Controller, AppModule, Module, WhatsappMergeController, Module, WhatsappMergeModule (+4 more)

### Community 2 - "PipelinesService"
Cohesion: 0.09
Nodes (11): ApiOperation, Body, CurrentOrg, Delete, Get, Patch, Put, Query (+3 more)

### Community 3 - "Param"
Cohesion: 0.24
Nodes (15): ApiQuery, CurrentChannelAccess, CurrentUser, Param, Post, ConversationsController, ApiBearerAuth, ApiOperation (+7 more)

### Community 4 - "CommercialRoutineService"
Cohesion: 0.12
Nodes (7): Injectable, ZApiMessageMapper, CommercialRoutineService, DEFAULT_STEPS, RoutineConfigInput, RoutineStep, StepMetric

### Community 5 - "pipelines.service.ts"
Cohesion: 0.15
Nodes (25): IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length (+17 more)

### Community 6 - "LeadDistributionService"
Cohesion: 0.10
Nodes (15): LeadDistributionController, ApiBearerAuth, ApiOperation, ApiTags, Body, Controller, CurrentOrg, Get (+7 more)

### Community 7 - "ConversationsService"
Cohesion: 0.11
Nodes (5): ConversationsRepository, InboxFilters, Injectable, ConversationsService, Injectable

### Community 8 - "CadencesService"
Cohesion: 0.10
Nodes (21): ActionKind, CadenceLike, edgeTarget(), GraphEdge, GraphNode, GraphNodeType, isGraph(), LinearStep (+13 more)

### Community 9 - "InboundMessageProcessor"
Cohesion: 0.18
Nodes (6): InboundJobData, InboundMessageProcessor, NON_TRIGGERING_MESSAGE_TYPES, replyMediaLabel(), safeJson(), StatusJobData

## Knowledge Gaps
- **24 isolated node(s):** `LeadWeight`, `PipelineRule`, `InboundJobData`, `StatusJobData`, `RoutingCtx` (+19 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PipelinesService` connect `PipelinesService` to `pipelines.module.ts`, `InboundMessageProcessor`, `pipelines.service.ts`, `LeadDistributionService`?**
  _High betweenness centrality (0.255) - this node is a cross-community bridge._
- **Why does `CadencesService` connect `CadencesService` to `pipelines.module.ts`, `InboundMessageProcessor`, `CommercialRoutineService`, `pipelines.service.ts`?**
  _High betweenness centrality (0.255) - this node is a cross-community bridge._
- **Why does `PipelinesController` connect `PipelinesService` to `pipelines.module.ts`, `WhatsappMergeService`?**
  _High betweenness centrality (0.175) - this node is a cross-community bridge._
- **What connects `LeadWeight`, `PipelineRule`, `InboundJobData` to the rest of the system?**
  _24 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `pipelines.module.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.14035087719298245 - nodes in this community are weakly interconnected._
- **Should `WhatsappMergeService` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Should `PipelinesService` be split into smaller, more focused modules?**
  _Cohesion score 0.09225589225589226 - nodes in this community are weakly interconnected._