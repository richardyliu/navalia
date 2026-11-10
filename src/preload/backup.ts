import { ipcRenderer } from 'electron'
import { BACKUP_CHANNELS, type BackupApi } from '../main/backup/api'

// Preload bridge fragment for S2-02 backup. Owned by the backup-import agent.
export const backupBridge: BackupApi = {
  backup: {
    exportBackup: (opts) =>
      ipcRenderer.invoke(BACKUP_CHANNELS.exportBackup, {
        withoutModel: opts.withoutModel,
        ...(opts.includeAccessLog ? { includeAccessLog: true } : {}),
        ...(opts.includeChat ? { includeChat: true } : {}),
        ...(opts.includeMeetings ? { includeMeetings: true } : {}),
        ...(opts.includeMoments ? { includeMoments: true } : {}),
        ...(typeof opts.passphrase === 'string' ? { passphrase: opts.passphrase } : {})
      }),
    inspect: (opts) =>
      ipcRenderer.invoke(BACKUP_CHANNELS.inspect, opts?.encrypted ? { encrypted: true, passphrase: opts.passphrase ?? '' } : undefined),
    restore: (inspectionId, confirm) => ipcRenderer.invoke(BACKUP_CHANNELS.restore, { inspectionId, confirm })
  }
}
