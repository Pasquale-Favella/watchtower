const { appendFileSync } = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')

if (!parentPort) throw new Error('fixture requires a worker thread')

parentPort.on('message', request => {
  if (request.op === 'scan:start') {
    parentPort.postMessage({ event: 'scan:progress', manual: true, progress: { stage: 'parse' } })
    setTimeout(() => {
      appendFileSync(workerData.markerPath, 'late-write\n')
      parentPort.postMessage({ event: 'scan:progress', manual: true, progress: { stage: 'parse' } })
    }, workerData.lateWriteDelayMs)
    return
  }

  if (request.op === 'scan:abort') return
  if (request.op === 'shutdown') {
    parentPort.postMessage({ id: request.id, ok: true, data: null })
  }
})

parentPort.postMessage({ event: 'ready' })
