import { performance } from 'node:perf_hooks'

import {
  decodeFrame,
  encodeFrame,
  FrameDecoder,
  server,
} from '../src/protocol/index.js'

const iterations = Number(process.env.BENCH_ITERATIONS ?? 250_000)
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new RangeError('BENCH_ITERATIONS must be positive')

const message = server.search(123, 'benchmark lossless audio')
const wire = encodeFrame('server', message.code, message.payload)

function measure(name: string, run: () => void): { name: string; operationsPerSecond: number; milliseconds: number } {
  for (let index = 0; index < 10_000; index++) run()
  const start = performance.now()
  for (let index = 0; index < iterations; index++) run()
  const milliseconds = performance.now() - start
  return {
    name,
    milliseconds: Math.round(milliseconds * 100) / 100,
    operationsPerSecond: Math.round((iterations * 1_000) / milliseconds),
  }
}

const results = [
  measure('encode frame', () => {
    encodeFrame('server', message.code, message.payload)
  }),
  measure('decode frame', () => {
    decodeFrame('server', { code: 999, payload: message.payload })
  }),
  measure('stream frame', () => {
    new FrameDecoder('server').push(wire)
  }),
]

console.log(
  JSON.stringify(
    {
      node: process.version,
      iterations,
      wireBytes: wire.length,
      results,
    },
    undefined,
    2,
  ),
)
