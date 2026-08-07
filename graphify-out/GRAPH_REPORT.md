# Graph Report - chat-bullq-api  (2026-08-07)

## Corpus Check
- 437 files · ~183,234 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 88 nodes · 201 edges · 8 communities (4 shown, 4 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `61e45972`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- PipelinesController
- WhatsappMergeService
- PipelinesService
- ApiOperation
- Body
- pipelines.service.ts
- .update
- .upsertStages

## God Nodes (most connected - your core abstractions)
1. `PipelinesService` - 30 edges
2. `PipelinesController` - 23 edges
3. `WhatsappMergeService` - 9 edges
4. `WhatsappMergeController` - 8 edges
5. `WhatsappMergeModule` - 3 edges
6. `RoutingTarget` - 2 edges
7. `RoutingException` - 2 edges
8. `AppModule` - 2 edges
9. `RoutingCtx` - 1 edges
10. `LeadRouting` - 1 edges

## Surprising Connections (you probably didn't know these)
- `PipelinesService` --references--> `Injectable`  [EXTRACTED]
  src/modules/pipelines/pipelines.service.ts →   _Bridges community 2 → community 1_

## Import Cycles
- None detected.

## Communities (8 total, 4 thin omitted)

### Community 0 - "PipelinesController"
Cohesion: 0.43
Nodes (6): ApiBearerAuth, ApiTags, Controller, PipelinesController, WhatsappMergeController, UseGuards

### Community 1 - "WhatsappMergeService"
Cohesion: 0.16
Nodes (8): Injectable, AppModule, Module, Module, WhatsappMergeModule, MergePair, MergeSummary, WhatsappMergeService

### Community 3 - "ApiOperation"
Cohesion: 0.28
Nodes (6): ApiOperation, CurrentOrg, Delete, Get, Param, Query

### Community 5 - "pipelines.service.ts"
Cohesion: 0.25
Nodes (7): DEFAULT_STAGES, LeadRouting, ORIGIN_TYPES, RoutingCtx, RoutingException, RoutingTarget, SOURCE_TAG_MAP

## Knowledge Gaps
- **7 isolated node(s):** `RoutingCtx`, `LeadRouting`, `ORIGIN_TYPES`, `SOURCE_TAG_MAP`, `DEFAULT_STAGES` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PipelinesService` connect `PipelinesService` to `PipelinesController`, `WhatsappMergeService`, `ApiOperation`, `Body`, `pipelines.service.ts`, `.update`, `.upsertStages`?**
  _High betweenness centrality (0.447) - this node is a cross-community bridge._
- **Why does `PipelinesController` connect `PipelinesController` to `ApiOperation`, `Body`, `pipelines.service.ts`, `.update`, `.upsertStages`?**
  _High betweenness centrality (0.208) - this node is a cross-community bridge._
- **What connects `RoutingCtx`, `LeadRouting`, `ORIGIN_TYPES` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._