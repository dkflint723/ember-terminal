/** Vite's `?worker` imports resolve to a Worker constructor. */
declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(id: string, label: string): Worker
    }
  }
}

export {}
