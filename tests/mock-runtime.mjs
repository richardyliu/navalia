// Minimal fixture server for UI development. It speaks the subset of the
// Persome runtime API that Navalia reads; it is never used in production.
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 8799)
const TOKEN = 'demo-token-1234567890'

const points = [
  ['pt-001', '用户偏好用 Rust 写 CLI 工具，认为启动时间和单二进制分发比生态更重要。', 'user-preferences.md', ['preference', 'rust'], 0.92, '2026-10-12T14:03:00-07:00'],
  ['pt-002', 'Navalia 的目标是只读、无登录的本地查看器。', 'project-navalia.md', ['project', 'design'], 0.88, '2026-11-04T10:12:00-08:00'],
  ['pt-003', '用户在周三上午通常会先处理邮件，再进入深度工作。', 'user-profile.md', ['habit'], 0.71, '2026-10-29T09:20:00-07:00'],
  ['pt-004', 'Mira 是 Navalia 的设计负责人，此前在 Acme 负责用户研究。', 'person-mira.md', ['person'], 0.84, '2026-10-20T18:40:00-07:00'],
  ['pt-005', '团队决定不在 v1 做 HET，因为开源 runtime 没有该模块。', 'project-navalia.md', ['decision', 'scope'], 0.9, '2026-11-04T11:02:00-08:00'],
  ['pt-006', '用户更信任带逐字引文和 receipt 的 AI 结论。', 'user-preferences.md', ['preference', 'trust'], 0.86, '2026-10-18T16:30:00-07:00'],
  ['pt-007', 'Screenpipe 是当前最直接的竞品，跨平台且已收费。', 'topic-competitors.md', ['research'], 0.79, '2026-11-03T09:15:00-08:00'],
  ['pt-008', '用户希望模型可视化能回到原始窗口与 URL，而不是只给摘要。', 'project-navalia.md', ['requirement'], 0.83, '2026-11-04T10:45:00-08:00']
].map(([id, content, file_name, tags, confidence, occurred_at], index) => ({
  id,
  content,
  layer: 'fact',
  status: 'active',
  is_latest: true,
  supersedes: null,
  superseded_by: null,
  occurred_at,
  valid_from: occurred_at,
  valid_until: null,
  created_at: occurred_at,
  file_name,
  tags,
  confidence,
  conflicted: index === 6,
  receipt: `⟨${id}:${file_name}⟩`,
  edit_refusal: ''
}))

const graph = {
  generated_at: new Date().toISOString(),
  model: {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    build: {
      build_id: 'bld_demo_7f3a91',
      core_commit: 'b7a28ff',
      models: { timeline: 'qwen3-fast', reducer: 'claude-sonnet-4-5' },
      prompt_hashes: { reducer: 'sha256:demo' },
      config_hash: 'sha256:config-demo',
      input_window: { start: '2026-10-01T00:00:00-07:00', end: '2026-11-04T09:00:00-08:00' },
      mode: 'live',
      trigger: 'scheduled',
      started_at: '2026-11-04T09:01:00-08:00',
      completed_at: '2026-11-04T09:04:12-08:00',
      duration_ms: 192000,
      degraded_stages: [],
      status: 'complete'
    },
    points,
    lines: [
      { kind: 'evolution', from: 'pt-005', to: 'pt-002', reason: 'scope narrowed' },
      { kind: 'relation', src: 'pt-004', dst: 'pt-002', predicate: 'part_of', label: 'co-founder' }
    ],
    faces: [
      { signature: '重视证据链：结论必须能回到原文和来源。', observations: 14, confidence: 0.86, provenance: 'both', source_receipts: ['⟨pt-006:user-preferences.md⟩'], edit_refusal: '' },
      { signature: '偏好本地优先、可导出的工具，抵触云端锁定。', observations: 9, confidence: 0.78, provenance: 'emergent', source_receipts: ['⟨pt-001:user-preferences.md⟩'], edit_refusal: '' },
      { signature: '上午先清理沟通，再进入深度工作。', observations: 6, confidence: 0.64, provenance: 'mined', source_receipts: ['⟨pt-003:user-profile.md⟩'], edit_refusal: '' }
    ],
    volumes: [
      { signature: '在工具选择上，可靠性与可审计性优先于功能数量。', observations: 11, confidence: 0.74, provenance: 'synth', source_receipts: [], edit_refusal: '' }
    ],
    root: {
      signature: '软件工程师，专注于 AI 原生产品。重视证据与可追溯性，偏好本地优先、可导出的工具；当前主要精力在 Navalia 与个人上下文层。',
      observations: 23,
      confidence: 0.81,
      provenance: 'synth',
      source_receipts: ['⟨pt-001:user-preferences.md⟩', '⟨pt-002:project-navalia.md⟩'],
      edit_refusal: ''
    },
    receipts: [],
    stats: {
      points: points.length,
      evolution_lines: 1,
      relation_lines: 1,
      faces: 3,
      volumes: 1,
      roots: 1,
      receipts: 8
    }
  }
}

const status = {
  success: true,
  data: {
    version: '0.3.2',
    root: process.env.PERSOME_ROOT || '/tmp/lens-demo',
    daemon: 'running pid 4242',
    uptime: '2h 13m',
    health: 'ok',
    capture: 'active',
    ocr: { enabled: true, ready: true, worker: 'ready', tier: 'tiny' },
    last_capture: '2m ago (Cursor)',
    buffer: '42 files, last: cap-2026-11-04T15-58-12.json',
    index_health: { status: 'ok', index: { status: 'ok' }, capture: { state: 'ok' } },
    sessions: '128 total (120 reduced, 6 ended, 2 failed)',
    memory: '14 active files, 2 dormant, 934 entries',
    timeline: '812 blocks, last end: 2026-11-04T15:58:00-08:00',
    llm_profile: { provider: 'ollama', model: 'qwen3:8b' },
    models: {},
    models_checked: false
  }
}

const evidence = {
  reference: '⟨pt-001:user-preferences.md⟩',
  canonical_reference: '⟨pt-001:user-preferences.md⟩',
  kind: 'point',
  id: 'pt-001',
  status: 'ok',
  label: '偏好 Rust 写 CLI 工具',
  summary: '用户比较了 Node、Go、Rust 三种实现，认为启动时间与单二进制分发更重要。',
  timestamp: '2026-10-12T14:03:00-07:00',
  path: 'user-preferences.md',
  metadata: { confidence: 0.92, session: 'sess-2026-10-12-14' },
  sources: [
    {
      relation: 'derived_from',
      kind: 'capture',
      id: 'cap-2026-10-12T14-03-11',
      reference: '⟨cap:2026-10-12T14-03-11⟩',
      label: 'Terminal · iTerm — cargo init',
      timestamp: '2026-10-12T14:03:11-07:00',
      status: 'ok',
      resolvable: true
    },
    {
      relation: 'quoted',
      kind: 'entry',
      id: 'ent-1182',
      reference: '⟨ent:1182⟩',
      label: '用户原话：“I’ll use Rust for this one.”',
      timestamp: '2026-10-12T14:04:02-07:00',
      status: 'ok',
      resolvable: true
    }
  ],
  context: [
    {
      relation: 'nearby',
      kind: 'capture',
      id: 'cap-2026-10-12T14-01-40',
      reference: '⟨cap:2026-10-12T14-01-40⟩',
      label: 'VS Code · Cargo.toml',
      timestamp: '2026-10-12T14:01:40-07:00',
      status: 'ok',
      resolvable: true
    }
  ],
  history: [
    {
      relation: 'supersedes',
      kind: 'point',
      id: 'pt-0009',
      reference: '⟨pt-0009:user-preferences.md⟩',
      label: '早前偏好 Go 写 CLI',
      timestamp: '2026-09-18T11:20:00-07:00',
      status: 'ok',
      resolvable: true
    }
  ]
}

const node = {
  id: 'pt-001',
  source: 'user-preferences.md',
  raw: [
    {
      ts: '2026-10-12T14:03:11-07:00',
      text: 'Terminal — iTerm: cargo init; user said “I’ll use Rust for this one.”',
      receipt: '⟨cap:2026-10-12T14-03-11⟩'
    },
    {
      ts: '2026-10-12T14:04:02-07:00',
      text: 'Comparison of Node vs Go vs Rust startup time in a note.',
      receipt: '⟨ent:1182⟩'
    }
  ],
  tree: {
    id: 'pt-001',
    predicate: null,
    children: [
      { id: 'person-self', predicate: 'about', status: 'active', strength: 0.9, children: [] }
    ]
  }
}

function json(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/health') return json(response, 200, { status: 'ok' })
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, 401, { detail: 'unauthorized' })
  if (url.pathname === '/status') return json(response, 200, status)
  if (url.pathname === '/permissions') {
    return json(response, 200, {
      success: true,
      data: { accessibility: 'granted', screen_recording: 'granted' }
    })
  }
  if (url.pathname === '/model/graph') return json(response, 200, graph)
  if (url.pathname === '/model/evidence') return json(response, 200, evidence)
  if (url.pathname === '/model/node') return json(response, 200, node)
  return json(response, 404, { detail: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock runtime on http://127.0.0.1:${PORT}`)
})
