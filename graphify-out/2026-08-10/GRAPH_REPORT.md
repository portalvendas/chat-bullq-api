# Graph Report - chat-bullq-api  (2026-08-09)

## Corpus Check
- 441 files · ~186,975 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 124 nodes · 278 edges · 8 communities (5 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a145dc2c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- pipelines.module.ts
- PipelinesController
- PipelinesService
- ApiOperation
- Body
- pipelines.service.ts
- Param
- .upsertStages

## God Nodes (most connected - your core abstractions)
1. `PipelinesService` - 31 edges
2. `PipelinesController` - 24 edges
3. `UpsertStageDto` - 10 edges
4. `CreatePipelineDto` - 10 edges
5. `UpdatePipelineDto` - 10 edges
6. `WhatsappMergeService` - 9 edges
7. `WhatsappMergeController` - 8 edges
8. `CreateCardDto` - 7 edges
9. `UpdateCardDto` - 7 edges
10. `MoveCardDto` - 7 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (8 total, 3 thin omitted)

### Community 0 - "pipelines.module.ts"
Cohesion: 0.17
Nodes (9): InjectQueue, Module, Processor, PipelineInactivityCronService, Injectable, PIPELINE_INACTIVITY_QUEUE, PIPELINE_INACTIVITY_SCAN_JOB, PipelineInactivityProcessor (+1 more)

### Community 1 - "PipelinesController"
Cohesion: 0.12
Nodes (14): ApiBearerAuth, ApiTags, Controller, Injectable, AppModule, Module, PipelinesController, WhatsappMergeController (+6 more)

### Community 2 - "PipelinesService"
Cohesion: 0.21
Nodes (3): Delete, PipelinesService, Injectable

### Community 3 - "ApiOperation"
Cohesion: 0.24
Nodes (4): ApiOperation, CurrentOrg, Get, Query

### Community 5 - "pipelines.service.ts"
Cohesion: 0.15
Nodes (25): IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length (+17 more)

## Knowledge Gaps
- **7 isolated node(s):** `RoutingCtx`, `LeadRouting`, `ORIGIN_TYPES`, `SOURCE_TAG_MAP`, `DEFAULT_STAGES` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PipelinesController` connect `PipelinesController` to `pipelines.module.ts`, `PipelinesService`, `ApiOperation`, `Body`, `pipelines.service.ts`, `Param`, `.upsertStages`?**
  _High betweenness centrality (0.321) - this node is a cross-community bridge._
- **Why does `PipelinesService` connect `PipelinesService` to `pipelines.module.ts`, `PipelinesController`, `ApiOperation`, `Body`, `pipelines.service.ts`, `Param`, `.upsertStages`?**
  _High betweenness centrality (0.283) - this node is a cross-community bridge._
- **Why does `WhatsappMergeController` connect `PipelinesController` to `Body`?**
  _High betweenness centrality (0.175) - this node is a cross-community bridge._
- **What connects `RoutingCtx`, `LeadRouting`, `ORIGIN_TYPES` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `PipelinesController` be split into smaller, more focused modules?**
  _Cohesion score 0.12318840579710146 - nodes in this community are weakly interconnected._
- **Should `pipelines.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1455026455026455 - nodes in this community are weakly interconnected._