import type { AnchorKind, Complexity, SizeBucket } from '../../src/main/het/anchors'

/**
 * E3.7 calibration set: 20 synthetic tasks (no real transcript content).
 * `estimateMin` is the agent author's independent guess of how long a competent
 * professional would need to recreate the output from scratch — NOT reviewed by the user.
 * `anchorTenths` is locked by calibration.test.ts against DEFAULT_ANCHORS at adoption
 * `confirmed` (weight 1.0), so the comparison isolates kind × size × complexity.
 */
export interface CalibrationRow {
  id: string
  task: string
  kind: AnchorKind
  size: SizeBucket
  complexity: Complexity
  anchorTenths: number
  estimateMin: number
}

export const CALIBRATION: CalibrationRow[] = [
  { id: 'C01', task: 'Fix a typo and a broken link in a README', kind: 'writing', size: 'xs', complexity: 'low', anchorTenths: 56, estimateMin: 3 },
  { id: 'C02', task: 'Write a ~500-word release note from a changelog', kind: 'writing', size: 'm', complexity: 'medium', anchorTenths: 300, estimateMin: 45 },
  { id: 'C03', task: 'Draft a ~2000-word design doc with trade-offs', kind: 'writing', size: 'xl', complexity: 'high', anchorTenths: 1800, estimateMin: 240 },
  { id: 'C04', task: 'Translate ~1000 words of user docs', kind: 'writing', size: 'l', complexity: 'medium', anchorTenths: 600, estimateMin: 60 },
  { id: 'C05', task: 'Rename a variable across 3 files', kind: 'coding', size: 'xs', complexity: 'low', anchorTenths: 84, estimateMin: 10 },
  { id: 'C06', task: 'Fix an off-by-one bug and add a regression test (~15 lines)', kind: 'coding', size: 'xs', complexity: 'medium', anchorTenths: 113, estimateMin: 45 },
  { id: 'C07', task: 'Add a CLI flag with tests (~80 lines)', kind: 'coding', size: 's', complexity: 'medium', anchorTenths: 225, estimateMin: 60 },
  { id: 'C08', task: 'Implement a parser/adapter with tests (~400 lines)', kind: 'coding', size: 'l', complexity: 'high', anchorTenths: 1350, estimateMin: 240 },
  { id: 'C09', task: 'Build a new subsystem with storage + UI (~1200 lines)', kind: 'coding', size: 'xl', complexity: 'high', anchorTenths: 2700, estimateMin: 960 },
  { id: 'C10', task: 'Look up one API detail and answer', kind: 'research', size: 'xs', complexity: 'low', anchorTenths: 38, estimateMin: 5 },
  { id: 'C11', task: 'Compare 3 libraries and recommend one', kind: 'research', size: 's', complexity: 'medium', anchorTenths: 100, estimateMin: 45 },
  { id: 'C12', task: 'Survey ~10 sources into a sourced brief', kind: 'research', size: 'l', complexity: 'high', anchorTenths: 600, estimateMin: 180 },
  { id: 'C13', task: 'Review a short doc and leave comments', kind: 'review', size: 's', complexity: 'low', anchorTenths: 75, estimateMin: 10 },
  { id: 'C14', task: 'Review a ~150-line PR', kind: 'review', size: 'm', complexity: 'medium', anchorTenths: 200, estimateMin: 30 },
  { id: 'C15', task: 'Review a ~1500-line PR touching auth', kind: 'review', size: 'xl', complexity: 'high', anchorTenths: 1200, estimateMin: 150 },
  { id: 'C16', task: 'Restart a service and clear a full disk', kind: 'ops', size: 'xs', complexity: 'low', anchorTenths: 19, estimateMin: 5 },
  { id: 'C17', task: 'Set up a CI workflow from scratch', kind: 'ops', size: 'm', complexity: 'high', anchorTenths: 150, estimateMin: 60 },
  { id: 'C18', task: 'Migrate a database with backup and verification', kind: 'ops', size: 'l', complexity: 'high', anchorTenths: 300, estimateMin: 90 },
  { id: 'C19', task: 'Summarise a 30-minute meeting into notes + actions', kind: 'meeting', size: 'm', complexity: 'medium', anchorTenths: 10, estimateMin: 15 },
  { id: 'C20', task: 'Prepare a short meeting agenda', kind: 'meeting', size: 's', complexity: 'low', anchorTenths: 4, estimateMin: 10 }
]
