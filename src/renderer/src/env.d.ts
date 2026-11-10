import type { LensApi } from '../../shared/api'

declare global {
  interface Window {
    lens: LensApi
  }
}

export {}
