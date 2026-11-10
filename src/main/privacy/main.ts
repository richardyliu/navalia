import type { IpcMain } from 'electron'
import { createBackupService, runtimeSecretValues } from '../backup/service'
import { createAgentManager, defaultAgentEnv } from '../broker/agents'
import { createGrantStore } from '../identity/grants'
import { locate } from '../runtime/paths'
import { readLocalToken } from '../runtime/token'
import type { S1Deps } from '../s1/deps'
import type { StorePaths } from '../store/paths'
import { registerPrivacyIpc } from './ipc'
import type { PrivacyService } from './service'
import type { PrivacyActionId } from './api'
import { PRIVACY_CONFIRM_SPECS } from './confirm'
import { tr } from '../../shared/i18n'

/** OG3: title + destructive-button label of the main-owned confirmation, per action. */
export const PRIVACY_DIALOG_TEXT: Record<PrivacyActionId, { message: string; confirmLabel: string }> = {
  'delete-captures': {
    get message() {
      return tr('Delete all raw captures?', '删除全部原始采集？')
    },
    get confirmLabel() {
      return tr('Delete raw captures', '删除原始采集')
    }
  },
  'delete-timeline': {
    get message() {
      return tr('Delete the entire timeline?', '删除全部时间线？')
    },
    get confirmLabel() {
      return tr('Delete timeline', '删除时间线')
    }
  },
  'delete-memory': {
    get message() {
      return tr('Delete all memory and the model?', '删除全部记忆与模型？')
    },
    get confirmLabel() {
      return tr('Delete all memory', '删除全部记忆')
    }
  },
  'delete-all': {
    get message() {
      return tr('Delete all personal data?', '删除全部个人数据？')
    },
    get confirmLabel() {
      return tr('Delete all personal data', '删除全部个人数据')
    }
  },
  'withdraw-all': {
    get message() {
      return tr('Withdraw all Agent connections?', '撤回全部 Agent 连接？')
    },
    get confirmLabel() {
      return tr('Withdraw all connections', '撤回全部连接')
    }
  }
}

export type NativeConfirmFn = (sender: unknown, opts: { message: string; detail: string; confirmLabel: string }) => Promise<boolean>

export function privacyConfirmDialog(nativeConfirm: NativeConfirmFn) {
  return (action: PrivacyActionId, sender: unknown): Promise<boolean> => {
    const text = PRIVACY_DIALOG_TEXT[action]
    return nativeConfirm(sender, { message: text.message, confirmLabel: text.confirmLabel, detail: PRIVACY_CONFIRM_SPECS[action].warning })
  }
}

/**
 * OG-09 wiring, kept out of index.ts. Grant store and agent manager are separate instances over
 * the same Lens Store files the Broker uses (the grant store re-reads grants.json on every call,
 * so revocations take effect on the Broker's next authorize).
 */
export function setupPrivacyPlane(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: {
    paths: StorePaths
    s1: S1Deps
    brokerUrl: () => string
    appVersion: () => string | null
    /** OG3: main-owned native confirmation (security.ts nativeConfirm). */
    nativeConfirm: NativeConfirmFn
  }
): PrivacyService {
  const grants = createGrantStore(deps.paths)
  const agents = createAgentManager({ env: defaultAgentEnv(), grants, brokerUrl: deps.brokerUrl })
  const backup = createBackupService({
    storeRoot: deps.s1.storeRoot,
    runtimeRoot: deps.s1.runtimeRoot,
    persomeBin: deps.s1.persomeBin,
    appVersion: deps.appVersion
  })
  const pickDir = deps.s1.openDirectoryDialog
  return registerPrivacyIpc(ipcMain, {
    locate,
    grants,
    agents,
    appVersion: deps.appVersion,
    confirmDialog: privacyConfirmDialog(deps.nativeConfirm),
    backup: pickDir
      ? async () => {
          const dir = await pickDir({ title: tr('Back up before deleting: choose where to save the backup', '删除前先备份：选择备份保存位置'), createDirectory: true })
          if (!dir) return { cancelled: true, path: null, files: 0 }
          const r = await backup.exportTo(dir, { withoutModel: false })
          return { cancelled: r.cancelled, path: r.path, files: r.files }
        }
      : undefined,
    knownSecrets: (root) => {
      const out = new Set<string>(runtimeSecretValues(root))
      try {
        out.add(readLocalToken(root))
      } catch {
        // no token
      }
      return [...out]
    }
  })
}
