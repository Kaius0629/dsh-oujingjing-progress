/**
 * 集成测试：插件开着 ComfyUI 那条线的时候，/status 要能把它带出来。
 *
 *   node test/comfy.integration.mjs
 *
 * 起一个假的 ComfyUI（只实现 /queue 和 /history/<id>），
 * 再起插件的宿主半侧，看快照里有没有那条任务。
 * 全程本地假数据，不出图、不占显卡。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  — ' + extra : ''))
}

/* ── 假 ComfyUI ── */

const PROMPT = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'fake_model.safetensors' } },
  7: { class_type: 'KSampler', inputs: { steps: 30, width: 512, height: 512 } },
}

let comfyRunning = false
const comfy = createServer((req, res) => {
  const url = req.url || ''
  res.setHeader('content-type', 'application/json')
  if (url.startsWith('/queue')) {
    res.end(
      JSON.stringify({
        queue_running: comfyRunning ? [[1, 'fake-pid', PROMPT, {}, []]] : [],
        queue_pending: [],
      }),
    )
    return
  }
  if (url.startsWith('/history/')) {
    res.end(
      JSON.stringify({
        'fake-pid': {
          status: {
            messages: [
              ['execution_start', { timestamp: 1000 }],
              ['execution_success', { timestamp: 12000 }],
            ],
          },
        },
      }),
    )
    return
  }
  res.statusCode = 404
  res.end('{}')
})

await new Promise((r) => comfy.listen(0, '127.0.0.1', r))
const comfyPort = comfy.address().port
console.log('  假 ComfyUI 在 127.0.0.1:' + comfyPort)

/* ── 起插件 ── */

const stateDir = await mkdtemp(join(tmpdir(), 'ojj-comfy-int-'))
process.env.OJJ_STATE_DIR = stateDir

const routes = new Map()
const fakeServer = {
  // 真实签名是 { kind, path, handler } —— 没有 id
  register(def) {
    if (def && typeof def.handler === 'function' && def.path) routes.set(def.path, def)
    return () => routes.delete(def && def.path)
  },
}

const root = {
  inject(_names, cb) {
    cb({
      webServer: fakeServer,
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      get() {
        throw new Error('not declared')
      },
    })
  },
}
const disposers = []

const mod = await import('../lib/index.js')
mod.apply(root, {
  comfy: true,
  comfyUrl: 'http://127.0.0.1:' + comfyPort,
  watchDirs: [],
  scanIntervalMs: 200,
})

// 等到设置读完、watcher 起来
await new Promise((r) => setTimeout(r, 1600))

function findStatusRoute() {
  return routes.get('/api/oujingjing') || [...routes.values()][0] || null
}
check('plugin registered its route', routes.size > 0, String(routes.size))

async function getStatus() {
  const def = findStatusRoute()
  if (!def) return null
  return await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(body) {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      },
    }
    def.handler(
      { method: 'GET', url: '/api/oujingjing/status', headers: {} },
      res,
    )
  })
}

const idle = await getStatus()
check('status responds', Boolean(idle))
check('comfy shows as enabled', idle && idle.comfy && idle.comfy.enabled === true)
check('comfyUrl is echoed back', idle && idle.comfy && idle.comfy.url.includes(String(comfyPort)))
check('comfy reports reachable', idle && idle.comfy && idle.comfy.available === true)
check('no jobs while idle', idle && Array.isArray(idle.jobs) && idle.jobs.length === 0)

/* 让假 ComfyUI「开始跑」 */

comfyRunning = true
await new Promise((r) => setTimeout(r, 1800))

const busy = await getStatus()
const comfyJobs = (busy && busy.jobs ? busy.jobs : []).filter((j) => j.source === 'comfy')
check('comfy job appears in the snapshot', comfyJobs.length === 1, String(comfyJobs.length))
check('job carries the checkpoint name', comfyJobs[0] && comfyJobs[0].name === 'fake_model', comfyJobs[0] && comfyJobs[0].name)
check('job is tagged source=comfy', comfyJobs[0] && comfyJobs[0].source === 'comfy')
check('first run has no percentage', comfyJobs[0] && comfyJobs[0].percent === null)
check('first run still shows elapsed', Boolean(comfyJobs[0] && comfyJobs[0].bytesText), comfyJobs[0] && comfyJobs[0].bytesText)
check('running counter reflects it', busy && busy.comfy && busy.comfy.running === 1)

/* 收尾 */

for (const d of disposers) {
  try {
    d()
  } catch {
    /* ignore */
  }
}
comfy.close()
await rm(stateDir, { recursive: true, force: true }).catch(() => {})

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? failed.length + ' failed' : 'all ' + results.length + ' passed'))
process.exit(failed.length ? 1 : 0)
