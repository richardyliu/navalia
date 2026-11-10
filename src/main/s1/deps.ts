// Shared dependencies handed to every S1 feature module (workflows, import, library, brief).
// Lead-owned. Feature agents may ADD optional fields (re-read the file right before editing);
// never remove or rename existing ones. Everything here runs in main only.
import type { KeyManager } from '../identity/keys'
import type { RuntimeClient } from '../runtime/client'

export interface S1Deps {
  /** Lens Store root (LENS_STORE_ROOT in tests). Feature data lives in `<storeRoot>/<feature>/`. */
  storeRoot: string
  /** Runtime root (PERSOME_ROOT in tests). Read-only for Lens; never write index.db. */
  runtimeRoot: () => string
  /** Absolute path of the `persome` CLI, or null when not found. */
  persomeBin: () => string | null
  /** A fresh RuntimeClient (REST on 127.0.0.1) with the local token. */
  runtime: () => RuntimeClient
  /** One Runtime MCP tool call (stdio), returns the raw text payload. */
  ossTool: (name: string, args: Record<string, unknown>) => Promise<string>
  /** User home for agent transcript discovery (overridable in tests). */
  homeDir: () => string
  /** Native save dialog; returns null when cancelled. */
  saveDialog: (opts: { title: string; defaultPath: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
  /** Native open-file dialog; returns null when cancelled. */
  openDialog: (opts: { title: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
  /**
   * S1-10 (skillshare): the identity KeyManager that signs Cards, used to sign `.navaliaskill`
   * exports. Optional; when absent or the identity is not initialised, export is refused.
   */
  identityKeys?: KeyManager
  /**
   * S2 (lead): native choose-directory dialog (backup target / restore source / subscription folder).
   * Returns null when cancelled. Unpackaged builds honour LENS_E2E_PICK_DIR for E2E.
   */
  openDirectoryDialog?: (opts: { title: string; createDirectory?: boolean }) => Promise<string | null>
  /**
   * S1-R3-SEC L5: main-owned native confirmation (security.ts nativeConfirm; Cancel default), parented
   * to the sender's window. Connectors commit and backup restore refuse when it is absent.
   */
  nativeConfirm?: (sender: unknown, opts: { message: string; detail: string; confirmLabel: string }) => Promise<boolean>
}
