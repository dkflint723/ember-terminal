/// <reference types="vite/client" />

import type { EmberApi } from '@shared/types'

declare global {
  interface Window {
    ember: EmberApi
  }
}
