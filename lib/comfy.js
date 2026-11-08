/**
 * ComfyUI 任务进度。
 *
 * 跟下载那条完全独立：下载看文件 mtime，这里看 ComfyUI 的 HTTP 接口。
 * 两者产出同一种 job 形状，交给同一个 snapshot() 排序显示。
 *
 * 为什么这么取数（都是实测出来的，不是猜的）：
 *
 *   /queue           返回 { queue_running: [[number, prompt_id, prompt, ...]], queue_pending: [...] }
 *                    只有「在跑几个」，没有步数、没有开始时间。
 *
 *   /history/<id>    返回 { status: { status_str, messages: [["execution_start",{timestamp}], ...] } }
 *                    ★ 事件流带毫秒时间戳 —— 这是我们唯一能拿到的真实耗时来源。
 *
 *   WebSocket /ws    progress 只推给「提交任务的 client_id」(main.py:464),
 *                    插件不是提交者，收不到。所以不走 WS。
 *
 * 于是进度只能这么算：
 *   1. /queue 里出现 → 开始计时（本地 now）
 *   2. 跑完 → 去 /history 拿 execution_start / execution_success 的差值 = 真实耗时
 *   3. 把 (工作流指纹 → 耗时) 记下来，下次同样的活一上来就有估算
 *
 * 第一次跑永远没有百分比 —— 没见过就是没见过，不编。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 同一台机器上 ComfyUI 默认端口。可以在配置里改。 */
const DEFAULT_BASE = 'http://127.0.0.1:8188'

/** 多久去问一次 /queue。比下载的 700ms 松一点，HTTP 比 stat 贵。 */
const POLL_MS = 1200

/** ComfyUI 断连后，连续失败这么多次就认为它没开，停止轮询。 */
const MAX_FAIL = 3

/**
 * 工作流指纹：决定「这两个任务算不算同一类活」。
 * 只看会影响耗时的东西 —— 采样步数、画布大小、工作流里用了哪些节点类型。
 * 不看 prompt 文字（改几个字不影响耗时）。
 */
function fingerprintOf(prompt) {
  if (!prompt || typeof prompt !== 'object') return ''
  const classes = []
  let steps = 0
  let width = 0
  let height = 0
  for (const node of Object.values(prompt)) {
    if (!node || typeof node !== 'object') continue
    if (typeof node.class_type === 'string') classes.push(node.class_type)
    const inp = node.inputs || {}
    if (Number.isFinite(Number(inp.steps))) steps = Math.max(steps, Number(inp.steps))
    if (Number.isFinite(Number(inp.width))) width = Math.max(width, Number(inp.width))
    if (Number.isFinite(Number(inp.height))) height = Math.max(height, Number(inp.height))
  }
  classes.sort()
  return `${classes.join('+')}|${steps}|${width}x${height}`
}

/** 从 prompt 里挑一个好认的名字出来当标题。 */
function titleOf(prompt, fallback) {
  if (prompt && typeof prompt === 'object') {
    for (const node of Object.values(prompt)) {
      if (!node || typeof node !== 'object') continue
      const inp = node.inputs || {}
      // 优先用 checkpoint 名，没有就用正提示词的第一段
      if (typeof inp.ckpt_name === 'string' && inp.ckpt_name) {
        return String(inp.ckpt_name).replace(/\.(safetensors|ckpt|pt|bin)$/i, '')
      }
    }
    for (const node of Object.values(prompt)) {
      if (!node || typeof node !== 'object') continue
      const t = (node.inputs || {}).text
      if (typeof t === 'string' && t.trim()) {
        const first = t.split(/[,\n]/)[0].trim()
        if (first) return first.slice(0, 40)
      }
    }
  }
  return fallback || 'ComfyUI'
}

/** 秒 → 「还剩 1 分 20 秒」 */
function etaText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} 分 ${r} 秒` : `${m} 分`
}

/**
 * 耗时记忆：~/.dsh/oujingjing-progress/comfy-times.json
 * { "<指纹>": { avg: 毫秒, n: 次数 } }
 *
 * 用滑动平均而不是只记最后一次 —— 同一工作流第一次会慢（要加载模型），
 * 后面快很多，只记最后一次会让预估偏乐观。
 */
let times = new Map()
let timesLoaded = false
let timesDirty = false
let timesFile = ''

export function configureComfy({ stateDir }) {
  timesFile = join(stateDir, 'comfy-times.json')
}

async function loadTimes() {
  if (timesLoaded || !timesFile) return
  timesLoaded = true
  try {
    const raw = await readFile(timesFile, 'utf8')
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const avg = Number(v && v.avg)
        const n = Number(v && v.n)
        if (Number.isFinite(avg) && avg > 0) times.set(k, { avg, n: Number.isFinite(n) ? n : 1 })
      }
    }
  } catch {
    /* 第一次跑没有这个文件，正常 */
  }
}

async function flushTimes() {
  if (!timesDirty || !timesFile) return
  timesDirty = false
  try {
    await mkdir(dirname(timesFile), { recursive: true })
    const obj = {}
    for (const [k, v] of times) obj[k] = v
    await writeFile(timesFile, JSON.stringify(obj, null, 2), 'utf8')
  } catch {
    /* 存不下不影响正事 */
  }
}

function rememberTime(fp, ms) {
  if (!fp || !Number.isFinite(ms) || ms < 500) return
  const prev = times.get(fp)
  if (!prev) {
    times.set(fp, { avg: ms, n: 1 })
  } else {
    // 滑动平均，越新的权重越大一点，但不让一次异常值把估值带跑
    const n = Math.min(prev.n + 1, 20)
    const avg = prev.avg + (ms - prev.avg) / n
    times.set(fp, { avg, n })
  }
  timesDirty = true
}

function estimateOf(fp) {
  const t = times.get(fp)
  return t && Number.isFinite(t.avg) && t.avg > 0 ? t.avg : null
}

/**
 * ComfyUI 轮询器。
 *
 * 每次 tick 做的事：
 *   1. GET /queue 看现在跑的是什么
 *   2. 跟上一轮比对：新出现的 → 记下开始时间；消失的 → 去 /history 拿真实耗时
 *   3. 产出 job 列表交给调用方
 */
export class ComfyWatcher {
  constructor({ baseUrl, onSnapshot, log } = {}) {
    this.base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
    this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : () => {}
    this.log = typeof log === 'function' ? log : () => {}
    this.timer = null
    this.stopped = false
    this.fails = 0
    this.available = null // null=还没探过 · true=在跑 · false=连不上
    this.running = new Map() // prompt_id → { startedAt, fp, title }
    this.lastSeen = new Map() // prompt_id → 上一轮是否在跑
  }

  async fetchJson(path) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    try {
      const res = await fetch(this.base + path, { signal: ctrl.signal })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    } finally {
      clearTimeout(t)
    }
  }

  /** 从 /history 的一条记录里抠出真实耗时。 */
  static durationOf(entry) {
    const msgs = entry && entry.status && Array.isArray(entry.status.messages)
      ? entry.status.messages
      : []
    let start = 0
    let end = 0
    for (const m of msgs) {
      if (!Array.isArray(m) || m.length < 2) continue
      const name = m[0]
      const ts = Number(m[1] && m[1].timestamp)
      if (!Number.isFinite(ts)) continue
      if (name === 'execution_start' && !start) start = ts
      if (/^execution_(success|error|interrupted)$/.test(name) && !end) end = ts
    }
    return start && end && end > start ? end - start : null
  }

  async tick() {
    if (this.stopped) return
    // 第一次 tick 时把历史耗时读进来 —— 不读的话重启后等于没记忆
    await loadTimes()
    let queue
    try {
      queue = await this.fetchJson('/queue')
      this.fails = 0
      if (this.available !== true) {
        this.available = true
        this.log('ComfyUI 连上了：' + this.base)
      }
    } catch {
      this.fails += 1
      if (this.fails >= MAX_FAIL && this.available !== false) {
        this.available = false
        this.running.clear()
        this.log('ComfyUI 连不上，先不看了：' + this.base)
      }
      this.push()
      return
    }

    const now = Date.now()
    const runningNow = new Map()

    // queue_running 是数组的数组：[number, prompt_id, prompt, extra, outputs]
    const runs = Array.isArray(queue.queue_running) ? queue.queue_running : []
    for (const item of runs) {
      if (!Array.isArray(item) || item.length < 3) continue
      const promptId = String(item[1] || '')
      if (!promptId) continue
      const prompt = item[2]
      const fp = fingerprintOf(prompt)
      const prev = this.running.get(promptId)
      if (prev) {
        runningNow.set(promptId, prev)
      } else {
        runningNow.set(promptId, {
          startedAt: now,
          fp,
          title: titleOf(prompt),
        })
      }
    }

    // 这一轮消失了 = 跑完了，去 /history 收尸，把真实耗时记下来
    for (const [id, old] of this.running) {
      if (runningNow.has(id)) continue
      try {
        const hist = await this.fetchJson('/history/' + encodeURIComponent(id))
        const entry = hist && hist[id]
        const dur = ComfyWatcher.durationOf(entry)
        if (dur) {
          rememberTime(old.fp, dur)
          void flushTimes()
          this.log(`ComfyUI 任务完成：${old.title} · 实测 ${(dur / 1000).toFixed(1)} 秒`)
        }
      } catch {
        /* 拿不到就算了，不记这一笔 */
      }
    }

    this.running = runningNow
    this.push()
  }

  push() {
    const now = Date.now()
    const jobs = []
    let i = 0
    for (const [id, r] of this.running) {
      i += 1
      const elapsed = now - r.startedAt
      const est = estimateOf(r.fp)
      const percent = est ? Math.min(99, (elapsed / est) * 100) : null
      const eta = est ? Math.max(0, est - elapsed) : null
      jobs.push({
        id: 'comfy-' + id,
        source: 'comfy',
        name: r.title,
        dir: this.base,
        state: percent != null && percent >= 99 ? 'waiting' : 'active',
        // 下载那边是字节，这边用「已用时」占同一个位置，前端按 source 决定怎么显示
        bytes: elapsed,
        bytesText: elapsed < 1000 ? '刚开始' : `${Math.round(elapsed / 1000)} 秒`,
        speed: 0,
        speedText: est ? '约 ' + (est / 1000).toFixed(0) + ' 秒的活' : '',
        total: est,
        totalText: est ? '预计 ' + (est / 1000).toFixed(0) + ' 秒' : '',
        percent,
        percentText: percent != null ? '约 ' + percent.toFixed(0) + '%' : null,
        eta,
        etaText: eta != null ? '还剩 ' + etaText(eta) : '',
        ageMs: elapsed,
        idleMs: 0,
        order: i,
      })
    }
    // 排队中的也算进来，让人知道后面还有
    this.onSnapshot({
      available: this.available,
      base: this.base,
      jobs,
    })
  }

  start() {
    if (this.timer) return
    const loop = async () => {
      if (this.stopped) return
      await this.tick().catch(() => {})
      if (this.stopped) return
      this.timer = setTimeout(loop, POLL_MS)
    }
    void loop()
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

export { fingerprintOf, titleOf, etaText, POLL_MS, DEFAULT_BASE }
