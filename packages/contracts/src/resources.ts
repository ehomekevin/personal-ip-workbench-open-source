export const API_RESOURCES = [
  {method:'GET',path:'/api/v1/image-studio',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-01',implementation_path:'apps/service/src/routes/image-studio.ts'},
  {method:'POST',path:'/api/v1/image-studio/brief',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-01',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'POST',path:'/api/v1/image-studio/generations',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-01',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'POST',path:'/api/v1/image-studio/slots/{id}/adopt',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-01',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'POST',path:'/api/v1/image-studio/confirm-final',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-01',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'GET',path:'/api/v1/topics/{id}/web-image-candidates',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-B',implementation_path:'apps/service/src/routes/image-studio.ts'},
  {method:'POST',path:'/api/v1/image-studio/web-imports',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-B',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'GET',path:'/api/v1/image-studio/plan',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-A2',implementation_path:'apps/service/src/routes/image-studio.ts'},
  {method:'POST',path:'/api/v1/image-studio/plan/runs',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-A2',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'POST',path:'/api/v1/image-studio/plan/items/{id}',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-A2',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'POST',path:'/api/v1/image-studio/plan/items',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-A2',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'POST',path:'/api/v1/image-studio/asset-versions',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-A2',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'POST',path:'/api/v1/image-studio/plan/confirm',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-IMAGE-STUDIO-A2',implementation_path:'apps/service/src/routes/image-studio.ts',idempotent:true},
  {method:'GET',path:'/api/v1/article-layout',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-STUDIO-C1',implementation_path:'apps/service/src/routes/article-layout.ts'},
  {method:'POST',path:'/api/v1/article-layout',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-STUDIO-C1',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'POST',path:'/api/v1/article-layout/saves',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-STUDIO-C1',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'POST',path:'/api/v1/article-layout/image-syncs',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-STUDIO-C1',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'POST',path:'/api/v1/article-layout/confirmations',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-STUDIO-C2',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'POST',path:'/api/v1/article-layout/visual-renders',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-MAIN-R5',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'POST',path:'/api/v1/article-layout/visual-checks',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-MAIN-R5',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'POST',path:'/api/v1/article-layout/visual-queries',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-MAIN-R5',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'POST',path:'/api/v1/article-layout/visual-cancellations',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-MAIN-R5',implementation_path:'apps/service/src/routes/article-layout.ts',idempotent:true},
  {method:'GET',path:'/api/v1/article-layout/visual-status',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WECHAT-LAYOUT-MAIN-R5',implementation_path:'apps/service/src/routes/article-layout.ts'},
  {method:'GET',path:'/api/v1/settings/image-providers',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'IMAGE-PROVIDER-AGY-INTEGRATION',implementation_path:'apps/service/src/routes/configuration.ts'},
  {method:'PUT',path:'/api/v1/settings/image-providers',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'IMAGE-PROVIDER-AGY-INTEGRATION',implementation_path:'apps/service/src/routes/configuration.ts',idempotent:true},
  {method:'POST',path:'/api/v1/settings/image-providers/{id}/verify',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'IMAGE-PROVIDER-AGY-INTEGRATION',implementation_path:'apps/service/src/routes/configuration.ts'},
  {method:'POST',path:'/api/v1/jobs/{id}/image-query',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'IMAGE-PROVIDER-AGY-INTEGRATION',implementation_path:'apps/service/src/routes/jobs.ts',idempotent:true},
  {method:'POST',path:'/api/v1/topics/{id}/viewpoints',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'VIEWPOINTS-CORE-01',implementation_path:'apps/service/src/routes/topics.ts',idempotent:true},
  {method:'GET',path:'/api/v1/settings/speech-input',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts'},
  {method:'PUT',path:'/api/v1/settings/speech-input',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'POST',path:'/api/v1/speech-inputs',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'GET',path:'/api/v1/speech-inputs/{id}',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts'},
  {method:'POST',path:'/api/v1/speech-inputs/{id}/chunks',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'POST',path:'/api/v1/speech-inputs/{id}/chunk-batches',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'POST',path:'/api/v1/speech-inputs/{id}/cancel',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'POST',path:'/api/v1/speech-inputs/{id}/adoption',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'POST',path:'/api/v1/speech-inputs/{id}/topic-link',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'POST',path:'/api/v1/speech-inputs/{id}/cleanup',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  {method:'POST',path:'/api/v1/speech-recordings',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'ARK-ASR-01',implementation_path:'apps/service/src/routes/speech-input.ts',idempotent:true},
  { method:'GET',path:'/api/v1/topics/{id}/writing-runs',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WRITING-FLOW-01',implementation_path:'apps/service/src/routes/writing-flow.ts' },
  { method:'POST',path:'/api/v1/topics/{id}/writing-runs',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WRITING-FLOW-01',implementation_path:'apps/service/src/routes/writing-flow.ts',idempotent:true },
  { method:'GET',path:'/api/v1/writing-runs/{id}',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WRITING-FLOW-01',implementation_path:'apps/service/src/routes/writing-flow.ts' },
  { method:'POST',path:'/api/v1/writing-runs/{id}/actions',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WRITING-FLOW-01',implementation_path:'apps/service/src/routes/writing-flow.ts',idempotent:true },
  { method:'POST',path:'/api/v1/writing-runs/{id}/switch-executor',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WRITING-FLOW-01',implementation_path:'apps/service/src/routes/writing-flow.ts',idempotent:true },
  { method:'POST',path:'/api/v1/writing-runs/{id}/export-preparations',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WRITING-FLOW-01',implementation_path:'apps/service/src/routes/writing-flow.ts',idempotent:true },
  { method:'POST',path:'/api/v1/writing-runs/{id}/exports',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'WRITING-FLOW-01',implementation_path:'apps/service/src/routes/writing-flow.ts',idempotent:true },

  {method:'GET',path:'/api/v1/accounts/material-statistics-refresh',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'CONFIG-04',implementation_path:'apps/service/src/routes/benchmark-accounts.ts'},
  {method:'POST',path:'/api/v1/accounts/material-statistics-refresh',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'CONFIG-04',implementation_path:'apps/service/src/routes/benchmark-accounts.ts',idempotent:true},
  { method:'GET',path:'/api/v1/accounts/{id}/feed-sync',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'CONFIG-02',implementation_path:'apps/service/src/routes/benchmark-accounts.ts' },
  { method:'POST',path:'/api/v1/accounts/{id}/feed-sync',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'CONFIG-02',implementation_path:'apps/service/src/routes/benchmark-accounts.ts',idempotent:true },
  {method:'POST',path:'/api/v1/accounts/{id}/material-reprojection',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'CONFIG-04',implementation_path:'apps/service/src/routes/benchmark-accounts.ts',idempotent:true},
  { method:'GET',path:'/api/v1/topics/{id}/operations',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'account-operations',implementation_path:'apps/service/src/routes/topics.ts' },
  { method:'PUT',path:'/api/v1/topics/{id}/operations',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'account-operations',implementation_path:'apps/service/src/routes/topics.ts',idempotent:true },
  { method:'POST',path:'/api/v1/topics/{id}/operations/ensure',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'account-operations',implementation_path:'apps/service/src/routes/topics.ts',idempotent:true },
  { method:'POST',path:'/api/v1/topics/{id}/operations/decision',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'account-operations',implementation_path:'apps/service/src/routes/topics.ts',idempotent:true },
  {
    "method": "GET",
    "path": "/api/v1/identity",
    "source": "docs/spec/PLUGIN-HOSTS.md section2; runtime.v1",
    "status": "implemented",
    "implementation_owner": "WP-07"
  },
  {
    "method": "GET",
    "path": "/api/v1/overview",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/overview.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/topic-recommendations",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/recommendations.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/account-recommendations",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/recommendations.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/recommendation-runs",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/recommendations.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/recommendation-runs/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/recommendations.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/recommendation-candidates/{id}/adoption",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/recommendations.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/sources",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/sources.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/source-records",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/sources.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/source-records/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/sources.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/source-records",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/sources.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/sources/{id}/sync",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/sources.ts",
    "idempotent": true
  },
  {
    "method": "PUT",
    "path": "/api/v1/source-records/{id}/marks",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/sources.ts",
    "idempotent": false
  },
  {
    "method": "POST",
    "path": "/api/v1/topics/{id}/sources",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/sources.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/accounts",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/benchmark-accounts.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/accounts",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/benchmark-accounts.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/accounts/{id}/identity-check",
    "source": "docs/plans/TEXT-LOOP-01.md",
    "status": "registered_internal",
    "implementation_owner": "TEXT-LOOP-01",
    "implementation_path": "apps/service/src/routes/benchmark-accounts.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/accounts/{id}/research",
    "source": "docs/engineering/plans/BENCHMARK-RESEARCH-01.md",
    "status": "registered_internal",
    "implementation_owner": "BENCHMARK-RESEARCH-01",
    "implementation_path": "apps/service/src/routes/generation.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/accounts/{id}/research",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/topics",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/topics.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/topics",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/topics.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/topics/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/topics.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/topics/{id}/recommendations",
    "source": "docs/spec/CONTRACTS.md",
    "status": "reserved",
    "implementation_owner": "assigned_by_wp"
  },
  {
    "method": "POST",
    "path": "/api/v1/documents",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/documents/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/documents/{id}/revisions",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/topics/{id}/core-approvals",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/topics.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/documents/{id}/ai-edits",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/documents/{id}/revisions",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/documents/{id}/restores",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/topics/{id}/variants",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/variants/{id}/core-alignment",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/variants/{id}/generation",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/candidates/{id}/adoption",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/documents/{id}/merges",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/documents.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/assets",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/assets.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/assets/references",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/assets.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/assets",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/assets.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/asset-generations",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-19",
    "implementation_path": "apps/service/src/routes/artifacts.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/assets/{id}/content",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/assets.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/variants/{id}/content-plans",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/content-plans.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/content-plans",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/content-plans.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/content-plans/{id}/revisions/{revision_id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/content-plans.ts"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/content-plans/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/content-plans.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/content-plans/{id}/renders",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-19",
    "implementation_path": "apps/service/src/routes/artifacts.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/production-plans",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/production-plans.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/production-plans/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/production-plans.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/production-plans/{id}/revisions/{revision_id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/production-plans.ts"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/production-plans/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-18",
    "implementation_path": "apps/service/src/routes/production-plans.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/production-plans/{id}/renders",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-19",
    "implementation_path": "apps/service/src/routes/artifacts.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/shots/{id}/generation",
    "source": "docs/spec/CONTRACTS.md",
    "status": "reserved",
    "implementation_owner": "assigned_by_wp"
  },
  {
    "method": "POST",
    "path": "/api/v1/asset-candidates/{id}/adoption",
    "source": "docs/spec/CONTRACTS.md",
    "status": "reserved",
    "implementation_owner": "assigned_by_wp"
  },
  {
    "method": "GET",
    "path": "/api/v1/schedules",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/schedules.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/schedules",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/schedules.ts",
    "idempotent": true
  },
  {
    "method": "PATCH",
    "path": "/api/v1/schedules/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/schedules.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/schedules/{id}/cancel",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/schedules.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/publication-batches",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/publication-batches",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/publication-batches/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/publication-intents",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/publication-intents/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/publication-intents/{id}/retry",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/publication-intents/{id}/continue",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/publication-intents/{id}/reconcile",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-20",
    "implementation_path": "apps/service/src/routes/publications.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/works/import",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/works.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/works",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/works.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/works/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/works.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/works/{id}/identity-check",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/works.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/works/{id}/snapshots",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/metrics.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/works/{id}/collections",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/metrics.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/comparisons",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-13",
    "implementation_path": "apps/service/src/routes/comparisons.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/retro-adoptions/{id}/comparisons",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/comparisons",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-13",
    "implementation_path": "apps/service/src/routes/comparisons.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/comparisons/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-13",
    "implementation_path": "apps/service/src/routes/comparisons.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/retro-reports",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/retro-reports",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/retro-reports/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/retro-reports/{id}/actions",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/retro-actions",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/retro-actions/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/retro-actions/{id}/adoptions",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/retro-adoptions/{id}/works",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/retro-adoptions/{id}/evaluations",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/retro.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/business-events",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/business-outcomes.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/knowledge",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/knowledge.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/index-runs",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/knowledge.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/wiki-generations",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/search",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-11",
    "implementation_path": "apps/service/src/routes/knowledge.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/settings",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/settings.ts"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/settings",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-08",
    "implementation_path": "apps/service/src/routes/settings.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/jobs",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-09",
    "implementation_path": "apps/service/src/routes/jobs.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/jobs/{id}",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-09",
    "implementation_path": "apps/service/src/routes/jobs.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/jobs/{id}/cancel",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-09",
    "implementation_path": "apps/service/src/routes/jobs.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/jobs/{id}/resume",
    "source": "docs/spec/CONTRACTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-09",
    "implementation_path": "apps/service/src/routes/jobs.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/host-capabilities",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-23",
    "implementation_path": "apps/service/src/routes/host-capabilities.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/host-task-observers",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-observers.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/host-task-observers/{id}/bindings",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-observers.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/native-task-bindings/{id}/observations",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-observers.ts",
    "idempotent": false
  },
  {
    "method": "POST",
    "path": "/api/v1/native-task-bindings/{id}/reattach",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-observers.ts",
    "idempotent": false
  },
  {
    "method": "POST",
    "path": "/api/v1/host-runs",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-runs.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/host-runs/{job_id}/renewals",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-runs.ts",
    "idempotent": true
  },
  {
    "method": "POST",
    "path": "/api/v1/host-runs/{job_id}/outputs",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-runs.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/host-runs/{job_id}/receipts",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-runs.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/host-result-receipts/{id}",
    "source": "docs/spec/PLUGIN-HOSTS.md",
    "status": "registered_internal",
    "implementation_owner": "WP-17",
    "implementation_path": "apps/service/src/routes/host-runs.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/jobs/{id}/events",
    "source": "docs/spec/CONTRACTS.md section3",
    "status": "registered_internal",
    "implementation_owner": "WP-09",
    "implementation_path": "apps/service/src/routes/jobs.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/accounts/{id}/snapshots",
    "source": "docs/evidence/wp-07/D07-007/README.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/metrics.ts"
  },
  {
    "method": "POST",
    "path": "/api/v1/accounts/{id}/collections",
    "source": "docs/evidence/wp-07/D07-007/README.md",
    "status": "registered_internal",
    "implementation_owner": "WP-12",
    "implementation_path": "apps/service/src/routes/metrics.ts",
    "idempotent": true
  },
  {
    "method": "PUT",
    "path": "/api/v1/daily-plans/{local_date}",
    "source": "docs/evidence/wp-14/contract-change.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/daily-plans.ts",
    "idempotent": true
  },
  {
    "method": "GET",
    "path": "/api/v1/business-events",
    "source": "docs/evidence/wp-14/contract-change.md",
    "status": "registered_internal",
    "implementation_owner": "WP-14",
    "implementation_path": "apps/service/src/routes/business-outcomes.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/documents/{id}/candidates",
    "source": "D07-008 / docs/evidence/wp-07/D07-008/README.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/candidates/{id}",
    "source": "D07-008 / docs/evidence/wp-07/D07-008/README.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/documents/{id}/revisions/{revision_id}",
    "source": "D07-008 / docs/evidence/wp-07/D07-008/README.md",
    "status": "registered_internal",
    "implementation_owner": "WP-16",
    "implementation_path": "apps/service/src/routes/generation.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/artifacts/{id}",
    "source": "D07-008 / docs/evidence/wp-07/D07-008/README.md",
    "status": "registered_internal",
    "implementation_owner": "WP-19",
    "implementation_path": "apps/service/src/routes/artifacts.ts"
  },
  {
    "method": "GET",
    "path": "/api/v1/artifacts/{id}/files/{file_ref}",
    "source": "D07-008 / docs/evidence/wp-07/D07-008/README.md",
    "status": "registered_internal",
    "implementation_owner": "WP-19",
    "implementation_path": "apps/service/src/routes/artifacts.ts"
  },
  { method: 'GET', path: '/api/v1/settings/publishing', source: 'D07-011 / docs/evidence/wp-07/D07-011/contract-change.md', status: 'registered_internal', implementation_owner: 'WP-08', implementation_path: 'apps/service/src/routes/publishing-settings.ts' },
  { method: 'POST', path: '/api/v1/settings/publishing/connections', source: 'D07-011 / docs/evidence/wp-07/D07-011/contract-change.md', status: 'registered_internal', implementation_owner: 'WP-08', implementation_path: 'apps/service/src/routes/publishing-settings.ts', idempotent: true },
  { method: 'PATCH', path: '/api/v1/settings/publishing/connections/{id}', source: 'D07-011 / docs/evidence/wp-07/D07-011/contract-change.md', status: 'registered_internal', implementation_owner: 'WP-08', implementation_path: 'apps/service/src/routes/publishing-settings.ts', idempotent: true },
  { method: 'POST', path: '/api/v1/settings/publishing/connections/{id}/apply', source: 'D07-011 / docs/evidence/wp-07/D07-011/contract-change.md', status: 'registered_internal', implementation_owner: 'WP-08', implementation_path: 'apps/service/src/routes/publishing-settings.ts', idempotent: true },
  { method: 'POST', path: '/api/v1/settings/publishing/connections/{id}/check', source: 'D07-011 / docs/evidence/wp-07/D07-011/contract-change.md', status: 'registered_internal', implementation_owner: 'WP-08', implementation_path: 'apps/service/src/routes/publishing-settings.ts', idempotent: true },
  { method: 'PUT', path: '/api/v1/settings/publishing/connections/{id}/enabled', source: 'D07-011 / docs/evidence/wp-07/D07-011/contract-change.md', status: 'registered_internal', implementation_owner: 'WP-08', implementation_path: 'apps/service/src/routes/publishing-settings.ts', idempotent: true },
  { method: 'PUT', path: '/api/v1/settings/publishing/defaults', source: 'D07-011 / docs/evidence/wp-07/D07-011/contract-change.md', status: 'registered_internal', implementation_owner: 'WP-08', implementation_path: 'apps/service/src/routes/publishing-settings.ts', idempotent: true },
  {"method": "GET", "path": "/api/v1/settings/skills", "source": "docs/spec/SKILL-ROUTING.md", "status": "registered_internal", "implementation_owner": "SKILLS-01", "implementation_path": "apps/service/src/routes/skills.ts"},
  {"method": "PUT", "path": "/api/v1/settings/skills", "source": "docs/spec/SKILL-ROUTING.md", "status": "registered_internal", "implementation_owner": "SKILLS-01", "implementation_path": "apps/service/src/routes/skills.ts", "idempotent": true},
  {"method": "POST", "path": "/api/v1/settings/skills/drafts", "source": "docs/spec/SKILL-ROUTING.md", "status": "registered_internal", "implementation_owner": "SKILLS-01", "implementation_path": "apps/service/src/routes/skills.ts", "idempotent": true},
  {"method": "GET", "path": "/api/v1/settings/skills/library", "source": "docs/spec/SKILL-ROUTING.md", "status": "registered_internal", "implementation_owner": "SKILLS-01", "implementation_path": "apps/service/src/routes/skills.ts"},
  {"method": "GET", "path": "/api/v1/settings/skills/library/{id}", "source": "docs/spec/SKILL-ROUTING.md", "status": "registered_internal", "implementation_owner": "SKILLS-01", "implementation_path": "apps/service/src/routes/skills.ts"},
  {"method": "GET", "path": "/api/v1/settings/skills/samples", "source": "docs/spec/SKILL-ROUTING.md", "status": "registered_internal", "implementation_owner": "SKILLS-01", "implementation_path": "apps/service/src/routes/skills.ts"},
  {"method": "GET", "path": "/api/v1/media/voice", "source": "docs/spec/H3-VOICE.md", "status": "registered_internal", "implementation_owner": "H3-VOICE-01", "implementation_path": "apps/service/src/routes/artifacts.ts"},
  {"method": "POST", "path": "/api/v1/media/voice", "source": "docs/spec/H3-VOICE.md", "status": "registered_internal", "implementation_owner": "H3-VOICE-01", "implementation_path": "apps/service/src/routes/artifacts.ts", "idempotent": true},
  {"method": "POST", "path": "/api/v1/media/voice/{id}/recover", "source": "docs/spec/H3-VOICE.md", "status": "registered_internal", "implementation_owner": "H3-VOICE-01", "implementation_path": "apps/service/src/routes/artifacts.ts", "idempotent": true}
,
  {method: 'GET',path: '/api/v1/settings/configuration',source: 'docs/architecture.md',status: 'registered_internal',implementation_owner: 'CONFIG-01',implementation_path: 'apps/service/src/routes/configuration.ts'},
  {method: 'PUT',path: '/api/v1/settings/configuration',source: 'docs/architecture.md',status: 'registered_internal',implementation_owner: 'CONFIG-01',implementation_path: 'apps/service/src/routes/configuration.ts',idempotent:true},
  {method: 'POST',path: '/api/v1/settings/configuration/checks',source: 'docs/architecture.md',status: 'registered_internal',implementation_owner: 'CONFIG-01',implementation_path: 'apps/service/src/routes/configuration.ts',idempotent:true},
  {method: 'PUT',path: '/api/v1/settings/configuration/voice',source: 'docs/architecture.md',status: 'registered_internal',implementation_owner: 'CONFIG-01',implementation_path: 'apps/service/src/routes/configuration.ts',idempotent:true},
  {method: 'POST',path: '/api/v1/settings/configuration/login',source: 'docs/architecture.md',status: 'registered_internal',implementation_owner: 'CONFIG-01',implementation_path: 'apps/service/src/routes/configuration.ts',idempotent:true},
  {method: 'POST',path: '/api/v1/settings/configuration/accounts',source: 'docs/architecture.md',status: 'registered_internal',implementation_owner: 'CONFIG-01',implementation_path: 'apps/service/src/routes/configuration.ts',idempotent:true},
  {method:'POST',path:'/api/v1/settings/configuration/accounts/discover',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'CONFIG-02',implementation_path:'apps/service/src/routes/configuration.ts',idempotent:true},
  {method:'PUT',path:'/api/v1/settings/configuration/api-fallback',source: 'docs/architecture.md',status:'registered_internal',implementation_owner:'CONFIG-02',implementation_path:'apps/service/src/routes/configuration.ts',idempotent:true}
] as const;
export type ApiResource = typeof API_RESOURCES[number];
