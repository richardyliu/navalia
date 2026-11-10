import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CARD_FORMAT, newCardId, signCard, type SignedCard } from '../../src/main/identity/card'
import type { CardContent } from '../../src/main/identity/card-schema'
import { createKeyManager, type KeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import type { ModelGraphResponse } from '../../src/shared/types'
import { createTestBox } from '../identity/helpers'
import { fileScopedTempDirs } from '../_support/tmpdir'

// B17: every dir is `<tmpdir>/lens-peers-<label>-XXXXXX` and is removed (prefix-guarded) after the file.
const temps = fileScopedTempDirs('lens-peers')
export function tempDir(label: string): string {
  return temps.make(label)
}

export interface Friend {
  root: string
  keys: KeyManager
  fingerprint: string
  card(opts?: { name?: string | null; summary?: string | null; highlights?: string[]; issuedAt?: string }): SignedCard
}

/** A friend with their own Lens Store + key (separate temp root), able to sign cards. */
export function friend(label: string): Friend {
  const root = tempDir(`friend-${label}`)
  const keys = createKeyManager(storePaths(root), createTestBox())
  const id = keys.ensureIdentity()
  return {
    root,
    keys,
    fingerprint: id.fingerprint,
    card(opts = {}) {
      const highlights = opts.highlights ?? ['在做本地优先的知识图谱工具', 'Rust CLI and SQLite tooling']
      const content: CardContent = {
        front: {
          display_name: opts.name === undefined ? 'Alice' : opts.name,
          summary: opts.summary === undefined ? '独立开发者，专注于个人知识管理。' : opts.summary,
          summary_confidence: 0.8,
          summary_observations: 12,
          highlights: highlights.map((signature, i) => ({ level: 'face', signature, observations: 5 + i, confidence: 0.7 })),
          as_of: '2026-11-01T08:00:00.000Z',
          model_status: 'complete',
          degraded: false
        },
        back: {
          mini_map: {
            nodes: [
              { key: 'r0', level: 'root', label: '独立开发者', observations: 12, confidence: 0.8, member_count: 1 },
              { key: 'v0', level: 'volume', label: '工具链与自动化', observations: 6, confidence: 0.6, member_count: 2 }
            ],
            edges: [{ from: 'r0', to: 'v0' }]
          },
          stats: { points: 40, evolution_lines: 2, relation_lines: 3, faces: 2, volumes: 1, roots: 1 }
        }
      }
      return signCard(
        {
          format: CARD_FORMAT,
          version: 1,
          card_id: newCardId(),
          issued_at: opts.issuedAt ?? '2026-11-01T09:00:00.000Z',
          issuer: { alg: 'Ed25519', public_key: id.public_key, fingerprint: id.fingerprint },
          content
        },
        keys
      )
    }
  }
}

export function text(card: SignedCard): string {
  return `${JSON.stringify(card, null, 2)}\n`
}

export function userGraph(): ModelGraphResponse {
  return {
    generated_at: '2026-11-05T08:00:00Z',
    model: {
      schema_version: 1,
      generated_at: '2026-11-05T08:00:00Z',
      build: { status: 'complete' } as never,
      points: [
        {
          id: 'pt-1',
          content: '这周在给 Navalia 做知识图谱的可视化。',
          layer: 'fact',
          status: 'active',
          is_latest: true,
          file_name: 'project-navalia.md',
          tags: [],
          confidence: 0.8,
          conflicted: false,
          receipt: '⟨pt-1:project-navalia.md⟩'
        },
        {
          id: 'pt-2',
          content: '用户偏好用 Rust 写 CLI。',
          layer: 'fact',
          status: 'active',
          is_latest: true,
          file_name: 'user-preferences.md',
          tags: [],
          confidence: 0.8,
          conflicted: false,
          receipt: '⟨pt-2:user-preferences.md⟩'
        },
        {
          id: 'pt-old',
          content: '旧的：知识图谱已经放弃。',
          layer: 'fact',
          status: 'superseded',
          is_latest: false,
          file_name: 'project-x.md',
          tags: [],
          confidence: 0.5,
          conflicted: false,
          receipt: '⟨pt-old:project-x.md⟩'
        }
      ],
      lines: [],
      faces: [{ signature: '上午先清理沟通，再进入深度工作。', observations: 6, confidence: 0.6 }],
      volumes: [],
      root: { signature: '软件工程师，关注本地优先的工具。', observations: 20, confidence: 0.8 },
      receipts: [],
      stats: { points: 3, evolution_lines: 0, relation_lines: 0, faces: 1, volumes: 0, roots: 1, receipts: 0 }
    }
  }
}
