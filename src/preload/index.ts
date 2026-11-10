import { contextBridge, ipcRenderer } from 'electron'
import type { LensApi } from '../shared/api'
import { workflowsBridge } from './workflows'
import { importBridge } from './import'
import { libraryBridge } from './library'
import { peersBridge } from './peers'
import { onboardingBridge } from './onboarding'
import { backupBridge } from './backup'
import { rewindBridge } from './rewind'
import { shellBridge } from './shell'
import { recoveryBridge } from './recovery'
import { privacyBridge } from './privacy'
import { askSaveBridge } from './ask'
import { connectorsBridge } from './connectors'
import { proactiveBridge } from './proactive'
import { performanceBridge } from './performance'
import { cloudBridge } from './cloud'
import { i18nBridge } from './i18n'

const api: LensApi = {
  // S1 feature fragments (each owned by its feature agent; see src/preload/<feature>.ts).
  ...workflowsBridge,
  ...importBridge,
  ...libraryBridge,
  ...peersBridge,
  ...onboardingBridge,
  ...backupBridge,
  ...rewindBridge,
  ...shellBridge,
  ...recoveryBridge,
  ...privacyBridge,
  ...askSaveBridge,
  ...connectorsBridge,
  ...proactiveBridge,
  ...performanceBridge,
  ...cloudBridge,
  ...i18nBridge,
  runtime: {
    discover: () => ipcRenderer.invoke('lens:runtime:discover'),
    start: () => ipcRenderer.invoke('lens:runtime:start'),
    status: () => ipcRenderer.invoke('lens:status'),
    permissions: () => ipcRenderer.invoke('lens:permissions')
  },
  model: {
    graph: () => ipcRenderer.invoke('lens:model:graph'),
    evidence: (ref, asOf) => ipcRenderer.invoke('lens:model:evidence', { ref, asOf }),
    deltaReport: (limit) => ipcRenderer.invoke('lens:model:delta-report', limit === undefined ? undefined : { limit }),
    node: (id) => ipcRenderer.invoke('lens:model:node', { id })
  },
  mcp: {
    search: (query, topK) => ipcRenderer.invoke('lens:mcp:search', { query, topK }),
    searchCaptures: (query, limit) => ipcRenderer.invoke('lens:mcp:captures', { query, limit }),
    recent: (limit) => ipcRenderer.invoke('lens:mcp:recent', { limit }),
    remember: (content, tags) => ipcRenderer.invoke('lens:mcp:remember', { content, tags }),
    correct: (correction) => ipcRenderer.invoke('lens:mcp:correct', { correction }),
    patterns: () => ipcRenderer.invoke('lens:mcp:patterns')
  },
  identity: {
    status: () => ipcRenderer.invoke('lens:identity:status'),
    init: () => ipcRenderer.invoke('lens:identity:init'),
    reset: (confirm) => ipcRenderer.invoke('lens:identity:reset', { confirm })
  },
  card: {
    create: () => ipcRenderer.invoke('lens:card:create'),
    latest: () => ipcRenderer.invoke('lens:card:latest'),
    verify: (text) => ipcRenderer.invoke('lens:card:verify', { text })
  },
  ownerAliases: {
    list: (status) => ipcRenderer.invoke('lens:owner-aliases:list', status === undefined ? undefined : { status }),
    confirm: (alias) => ipcRenderer.invoke('lens:owner-aliases:confirm', { alias }),
    reject: (alias) => ipcRenderer.invoke('lens:owner-aliases:reject', { alias })
  },
  swipe: {
    qr: () => ipcRenderer.invoke('lens:swipe:qr'),
    exportFile: (kind) => ipcRenderer.invoke('lens:swipe:export', { kind }),
    exportPng: (rect) => ipcRenderer.invoke('lens:swipe:export', { kind: 'png', rect }),
    importFile: () => ipcRenderer.invoke('lens:swipe:import')
  },
  connections: {
    list: () => ipcRenderer.invoke('lens:connections:list'),
    connect: (agent) => ipcRenderer.invoke('lens:connections:connect', { agent }),
    disconnect: (agent) => ipcRenderer.invoke('lens:connections:disconnect', { agent }),
    copyManualConfig: (agent) => ipcRenderer.invoke('lens:connections:copy-manual', { agent }),
    revokeGrant: (grantId) => ipcRenderer.invoke('lens:connections:revoke', { grantId }),
    renewGrant: (grantId, ttlSeconds) => ipcRenderer.invoke('lens:connections:renew', { grantId, ttlSeconds })
  },
  accessLog: {
    list: (options) => ipcRenderer.invoke('lens:accesslog:list', options),
    daily: (days) => ipcRenderer.invoke('lens:accesslog:daily', days === undefined ? undefined : { days }),
    preview: (id) => ipcRenderer.invoke('lens:accesslog:preview', { id }),
    clear: (confirm) => ipcRenderer.invoke('lens:accesslog:clear', { confirm })
  },
  het: {
    summary: (days, timezone) =>
      ipcRenderer.invoke('lens:het:summary', days === undefined && timezone === undefined ? undefined : { days, timezone }),
    tasks: (limit, includeActivity) => ipcRenderer.invoke('lens:het:tasks', { limit, includeActivity }),
    period: (start, end, cursor, limit, includeActivity, timezone) =>
      ipcRenderer.invoke('lens:het:period', { start, end, cursor, limit, includeActivity, timezone }),
    activity: (start, end, timezone) => ipcRenderer.invoke('lens:het:activity', { start, end, timezone }),
    correct: (taskId, action) => ipcRenderer.invoke('lens:het:correct', { taskId, action }),
    status: () => ipcRenderer.invoke('lens:het:status'),
    setAssessorEnabled: (enabled) => ipcRenderer.invoke('lens:het:set-assessor-enabled', { enabled }),
    assessorInfo: () => ipcRenderer.invoke('lens:het:assessor-info'),
    setSendSummaries: (enabled) => ipcRenderer.invoke('lens:het:set-send-summaries', { enabled }),
    exportWeekly: (weekStart) => ipcRenderer.invoke('lens:het:export-weekly', { weekStart }),
    revertCorrection: (taskId) => ipcRenderer.invoke('lens:het:revert-correction', { taskId }),
    retry: () => ipcRenderer.invoke('lens:het:retry'),
    weekCounts: (timezone) => ipcRenderer.invoke('lens:het:week-counts', timezone === undefined ? undefined : { timezone }),
    filteredTasks: (start, end, filter, cursor, limit, timezone) =>
      ipcRenderer.invoke('lens:het:filtered-tasks', { start, end, filter, cursor, limit, timezone })
  },
  capture: {
    status: () => ipcRenderer.invoke('lens:capture:status'),
    restart: () => ipcRenderer.invoke('lens:capture:restart'),
    pause: (mode) => ipcRenderer.invoke('lens:capture:pause', { mode }),
    resume: () => ipcRenderer.invoke('lens:capture:resume'),
    excludeAdd: (kind, value) => ipcRenderer.invoke('lens:capture:exclude-add', { kind, value }),
    excludeRemove: (kind, value) => ipcRenderer.invoke('lens:capture:exclude-remove', { kind, value }),
    pickApp: () => ipcRenderer.invoke('lens:capture:pick-app'),
    requestAccessibility: () => ipcRenderer.invoke('lens:capture:request-accessibility'),
    requestScreenRecording: () => ipcRenderer.invoke('lens:capture:request-screen-recording'),
    openPrivacy: (pane) => ipcRenderer.invoke('lens:capture:open-privacy', { pane }),
    diagnostics: () => ipcRenderer.invoke('lens:capture:diagnostics')
  },
  llm: {
    budget: () => ipcRenderer.invoke('lens:llm:budget')
  },
  build: {
    start: () => ipcRenderer.invoke('lens:model:build-start'),
    status: () => ipcRenderer.invoke('lens:model:build-status'),
    cancel: () => ipcRenderer.invoke('lens:model:build-cancel')
  },
  app: {
    info: () => ipcRenderer.invoke('lens:app:info'),
    open: (kind) => ipcRenderer.invoke('lens:app:open', kind),
    copy: (text) => ipcRenderer.invoke('lens:app:copy', { text })
  }
}

contextBridge.exposeInMainWorld('lens', api)
