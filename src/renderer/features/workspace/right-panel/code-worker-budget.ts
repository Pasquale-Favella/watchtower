export function codeWorkerCount(hardwareConcurrency: number): number {
  return Math.max(1, Math.min(2, Math.floor((hardwareConcurrency || 2) / 3)))
}
