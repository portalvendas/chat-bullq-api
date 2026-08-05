# Graph Report - chat-bullq-api  (2026-08-05)

## Corpus Check
- 437 files · ~181,032 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 27 nodes · 35 edges · 5 communities (3 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6e5b9d38`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- WhatsappMergeController
- WhatsappMergeService
- whatsapp-merge.module.ts
- .run
- whatsapp-merge.service.ts

## God Nodes (most connected - your core abstractions)
1. `WhatsappMergeService` - 9 edges
2. `WhatsappMergeController` - 8 edges
3. `WhatsappMergeModule` - 3 edges
4. `AppModule` - 2 edges
5. `MergePair` - 1 edges
6. `MergeSummary` - 1 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (5 total, 2 thin omitted)

### Community 0 - "WhatsappMergeController"
Cohesion: 0.33
Nodes (5): ApiBearerAuth, ApiTags, Controller, WhatsappMergeController, UseGuards

### Community 2 - "whatsapp-merge.module.ts"
Cohesion: 0.40
Nodes (4): AppModule, Module, Module, WhatsappMergeModule

### Community 3 - ".run"
Cohesion: 0.40
Nodes (4): ApiOperation, CurrentOrg, Post, Query

## Knowledge Gaps
- **2 isolated node(s):** `MergePair`, `MergeSummary`
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WhatsappMergeController` connect `WhatsappMergeController` to `whatsapp-merge.module.ts`, `.run`, `whatsapp-merge.service.ts`?**
  _High betweenness centrality (0.454) - this node is a cross-community bridge._
- **Why does `WhatsappMergeService` connect `WhatsappMergeService` to `WhatsappMergeController`, `whatsapp-merge.module.ts`, `whatsapp-merge.service.ts`?**
  _High betweenness centrality (0.324) - this node is a cross-community bridge._
- **What connects `MergePair`, `MergeSummary` to the rest of the system?**
  _2 weakly-connected nodes found - possible documentation gaps or missing edges._