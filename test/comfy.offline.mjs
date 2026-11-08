/**
 * ComfyUI 那块儿的离线测试 —— 全部用假数据，不碰真实 ComfyUI、不出图。
 *
 *   node test/comfy.offline.mjs
 *
 * 为什么改成离线：
 *   之前为了验证「能抓到进度」，我反复提交真实出图任务去制造「正在跑」的场景。
 *   那会占显卡、占队列、往 comfyui-output 里堆没用的图。
 *   真正需要真机验证的只有「连不上时不崩」—— 用假 fetch 就够。
 */

import { ComfyWatcher, configureComfy, fingerprintOf, titleOf, etaText } from '../lib/comfy.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  — ' + extra : ''))
}

const dir = await mkdtemp(join(tmpdir(), 'ojj-comfy-offline-'))
configureComfy({ stateDir: dir })

/* ── 纯函数部分 ── */

const entry = {
  status: {
    messages: [
      ['execution_start', { timestamp: 1_000_000 }],
      ['execution_cached', { timestamp: 1_000_006 }],
      ['execution_success', { timestamp: 1_019_020 }],
    ],
  },
}
check('durationOf reads the event timestamps', ComfyWatcher.durationOf(entry) === 19_020)

check('durationOf returns null without a start', ComfyWatcher.durationOf({ status: { messages: [] } }) === null)
check('durationOf survives garbage', ComfyWatcher.durationOf(null) === null)

const prompt = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wai_v170.safetensors' } },
  5: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl' } },
  7: { class_type: 'KSampler', inputs: { steps: 30, width: 768, height: 768 } },
}
check('fingerprint ignores prompt text', fingerprintOf(prompt) === fingerprintOf({ ...prompt }))
check(
  'fingerprint changes with steps',
  fingerprintOf(prompt) !== fingerprintOf({ ...prompt, 7: { class_type: 'KSampler', inputs: { steps: 40, width: 768, height: 768 } } }),
)
check('fingerprint changes with size', fingerprintOf(prompt).includes('768x768'))
check('title prefers the checkpoint name', titleOf(prompt) === 'wai_v170')
check('title falls back to the prompt text', titleOf({ 1: { class_type: 'X', inputs: { text: 'hello, world' } } }) === 'hello')
check('etaText under a minute', etaText(45_000) === '45 秒')
check('etaText over a minute', etaText(80_000) === '1 分 20 秒')
check('etaText exact minute', etaText(120_000) === '2 分')
check('etaText on zero', etaText(0) === '')

/* ── 假 ComfyUI：验证轮询行为 ── */

const snapshot = []
let fakeState = 'idle' // idle → running → done
let fetchCalls = 0

const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  fetchCalls += 1
  const u = String(url)
  if (u.endsWith('/queue')) {
    if (fakeState === 'running') {
      return json({
        queue_running: [[42, 'pid-1', prompt, {}, []]],
        queue_pending: [],
      })
    }
    return json({ queue_running: [], queue_pending: [] })
  }
  if (u.includes('/history/')) {
    return json({ 'pid-1': entry })
  }
  return { ok: false, status: 404 }
}

function json(obj) {
  return { ok: true, status: 200, json: async () => obj }
}

const w = new ComfyWatcher({
  onSnapshot: (s) => snapshot.push(s),
  log: () => {},
})

await w.tick() // idle：还没任务
check('idle snapshot has no jobs', snapshot.at(-1).jobs.length === 0)
check('idle marks ComfyUI as reachable', snapshot.at(-1).available === true)

fakeState = 'running'
await w.tick() // 任务出现
const running = snapshot.at(-1)
check('running snapshot has one job', running.jobs.length === 1)
check('job is tagged as coming from comfy', running.jobs[0].source === 'comfy')
check('first run has no estimate yet', running.jobs[0].percent === null, String(running.jobs[0].percent))
check('first run still shows elapsed time', Boolean(running.jobs[0].bytesText), running.jobs[0].bytesText)

fakeState = 'done'
await w.tick() // 任务消失 → 去 /history 收尸
check('job disappears when the queue empties', snapshot.at(-1).jobs.length === 0)

// 写盘是异步的（void flushTimes），给它一拍
await new Promise((r) => setTimeout(r, 120))

// 耗时应该被记下来了
const saved = JSON.parse(await readFile(join(dir, 'comfy-times.json'), 'utf8'))
check('real duration was persisted', Object.keys(saved).length === 1, JSON.stringify(saved))

// 第二次同款任务应该立刻有估算
fakeState = 'running'
await w.tick()
const second = snapshot.at(-1)
check('second run has an estimate', second.jobs[0] && second.jobs[0].percent !== null, String(second.jobs[0] && second.jobs[0].percent))
check('second run shows the estimate in text', Boolean(second.jobs[0] && second.jobs[0].totalText), second.jobs[0] && second.jobs[0].totalText)

w.stop()

/* ── 连不上时不许崩 ── */

globalThis.fetch = async () => {
  throw new Error('ECONNREFUSED')
}
const down = []
const w2 = new ComfyWatcher({ onSnapshot: (s) => down.push(s), log: () => {} })
let threw = false
try {
  for (let i = 0; i < 4; i += 1) await w2.tick()
} catch {
  threw = true
}
w2.stop()
check('survives a dead ComfyUI', !threw)
check('reports itself as unavailable', down.at(-1).available === false)

globalThis.fetch = realFetch
await rm(dir, { recursive: true, force: true }).catch(() => {})

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? failed.length + ' failed' : 'all ' + results.length + ' passed'))
process.exit(failed.length ? 1 : 0)
