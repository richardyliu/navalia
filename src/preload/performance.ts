import { ipcRenderer } from 'electron'
import { PERFORMANCE_CHANNELS, type PerformanceApi } from '../main/performance/api'

// Preload bridge fragment for S1-FULL C16 「表现」 (owner-only counts + user-written projects).
// Main window only; the Quick Box preload does not include it.
export const performanceBridge: PerformanceApi = {
  performance: {
    counts: (range, offset) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.counts, { range, offset }),
    rows: (range, offset, kind, day) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.rows, day === undefined ? { range, offset, kind } : { range, offset, kind, day }),
    repos: () => ipcRenderer.invoke(PERFORMANCE_CHANNELS.repos),
    addRepo: () => ipcRenderer.invoke(PERFORMANCE_CHANNELS.addRepo),
    updateRepo: (id, authorEmail) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.updateRepo, { id, authorEmail }),
    removeRepo: (id) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.removeRepo, { id }),
    projects: () => ipcRenderer.invoke(PERFORMANCE_CHANNELS.projects),
    saveProject: (input) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.saveProject, { input }),
    deleteProject: (id) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.deleteProject, { id }),
    setMilestoneDone: (projectId, milestoneId, done) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.setMilestoneDone, { projectId, milestoneId, done }),
    activity: (projectId, days) => ipcRenderer.invoke(PERFORMANCE_CHANNELS.activity, { projectId, days })
  }
}
