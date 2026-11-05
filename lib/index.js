/**
 * dsh-oujingjing-progress —— 宿主半侧
 *
 * 干的事只有一件：盯着几个目录，看哪个文件在变大。
 * 在变大 = 有东西正在写进来 = 那条进度条该冒出来了。
 * 全都停下来了 = 什么都没发生 = 前端一个字都不画。
 *
 * 设计上的取舍（都是为了「好装、不惹事」）：
 *   - 零依赖：只用 node 标准库
 *   - 不碰别人：只注册一个 /api/oujingjing 前缀，不覆盖别人的路由
 *   - 不解析命令行：所以不管谁在下（curl、python、aria2、浏览器）都看得见
 *   - 目录不存在 / 没权限 / 扫失败：静默跳过，绝不抛错
 */

import { mkdir, readdir, stat, writeFile, readFile, copyFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const API_PREFIX = '/api/oujingjing'

/** 四态立绘按皮肤分目录放：assets/<skin>/{eating,idle,stuck,done}.png */
const ASSET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const ASSET_NAMES = new Set(['eating', 'idle', 'stuck', 'done'])
const SKIN_RE = /^[A-Za-z0-9_-]{1,40}$/

const DEFAULTS = {
  watchDirs: [],
  scanIntervalMs: 700,
  idleMs: 4000,
  lingerMs: 2500,
  minBytes: 65536,
  staleMs: 20000,
  snapshotFile: '',
}

/**
 * 判据只有一个：**这个文件最近有没有被写过**（mtime）。
 *
 * 不认文件名、不认进程、不认下载器 —— 所以 curl 下的、python 脚本下的、
 * aria2 下的、浏览器下的，写法各不相同，这里一律看得见。
 * 超过 staleMs 没再被写，就当作「不是在下载」，连提都不提。
 */
const MIN_STALE_MS = 2000

/** 算速度用的采样窗口长度。 */
const SAMPLES = 4

/* ───────────────────────── 配置 ───────────────────────── */

function clampNum(value, fallback, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function readConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const dirs = Array.isArray(c.watchDirs)
    ? c.watchDirs.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim())
    : []
  return {
    watchDirs: dirs,
    scanIntervalMs: clampNum(c.scanIntervalMs, DEFAULTS.scanIntervalMs, 200, 10000),
    idleMs: clampNum(c.idleMs, DEFAULTS.idleMs, 1000, 120000),
    lingerMs: clampNum(c.lingerMs, DEFAULTS.lingerMs, 0, 60000),
    minBytes: clampNum(c.minBytes, DEFAULTS.minBytes, 0, 1 << 30),
    staleMs: clampNum(c.staleMs, Math.max(DEFAULTS.staleMs, Number(c.idleMs) * 3 || 0), MIN_STALE_MS, 600000),
    // 用哪一套形象：assets/<skin>/ 下要有 eating/idle/stuck/done 四张
    // 默认 blue —— 冲「蓝色大肥鱼」来的用户先看到的就是它
    skin:
      typeof c.skin === 'string' && SKIN_RE.test(c.skin.trim()) ? c.skin.trim() : 'blue',
    // 手动补总量：文件名里含 match 的，总大小就按 bytes 算
    knownTotals: Array.isArray(c.knownTotals)
      ? c.knownTotals
          .filter((r) => r && typeof r.match === 'string' && Number.isFinite(Number(r.bytes)))
          .map((r) => ({ match: String(r.match), bytes: Number(r.bytes) }))
      : [],
    // 填了就把每轮状态写一份 JSON 到磁盘。排查用；平时留空，一个字节都不落。
    snapshotFile:
      typeof c.snapshotFile === 'string' && c.snapshotFile.trim() ? c.snapshotFile.trim() : '',
  }
}

/* ───────────────────────── 总大小：记忆 + 显式配置 ───────────────────────── */

/**
 * 光看磁盘只知道「已下载」，不知道「总共多大」，所以也算不出还剩多久。
 * 这里给两条补总量的路，都不需要改任何下载方式：
 *
 *   1. 历史记忆：下完一次就把 (文件名 → 字节数) 记下来；
 *      下次同名文件再下，一上来就有百分比和 ETA。同一个模型重下很常见。
 *   2. knownTotals：配置里写明某个文件名对多少字节，适合「第一次下也想看进度」。
 */

// 状态目录：记下的文件体积、设置页的选择都放这儿。
// 测试时用 OJJ_STATE_DIR 指到临时目录，免得读到开发机上的真实设置。
const STATE_DIR = process.env.OJJ_STATE_DIR || join(homedir(), '.dsh', 'oujingjing-progress')
const SIZES_FILE = join(STATE_DIR, 'sizes.json')
const SETTINGS_FILE = join(STATE_DIR, 'settings.json')
const sizes = new Map()
let sizesLoaded = false
let sizesDirty = false

/** `.part` 之类只是半成品后缀，去掉才是「这个东西本身的身份」。 */
function baseKey(name) {
  return String(name || '').replace(/\.(part|incomplete|crdownload|download|tmp)$/i, '')
}

async function loadSizes() {
  if (sizesLoaded) return
  sizesLoaded = true
  try {
    const raw = await readFile(SIZES_FILE, 'utf8')
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(v)
        if (Number.isFinite(n) && n > 0) sizes.set(k, n)
      }
    }
  } catch {
    /* 第一次跑没有这个文件，正常 */
  }
}

function rememberSize(name, bytes) {
  const key = baseKey(name)
  if (!key || !Number.isFinite(bytes) || bytes <= 0) return
  const prev = sizes.get(key) || 0
  if (bytes <= prev) return // 半截的记录不允许把完整的覆盖掉
  sizes.set(key, bytes)
  sizesDirty = true
}

async function flushSizes() {
  if (!sizesDirty) return
  sizesDirty = false
  try {
    await mkdir(dirname(SIZES_FILE), { recursive: true })
    const obj = {}
    for (const [k, v] of sizes) obj[k] = v
    await writeFile(SIZES_FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch {
    /* 存不下不影响正事 */
  }
}

/** 这个文件的「总共多大」：显式配置优先，其次历史记忆。都没有就是 null。 */
function resolveTotal(job, cfg) {
  for (const rule of cfg.knownTotals) {
    if (rule.match && job.name.includes(rule.match) && rule.bytes > job.bytes) return rule.bytes
  }
  const known = sizes.get(baseKey(job.name))
  if (Number.isFinite(known) && known > job.bytes) return known
  return null
}

/**
 * 资源版本：取 assets 目录树里最新的 mtime。
 * 换图之后这个数字会变，前端把它拼到 URL 后面，浏览器就必须重新拉 ——
 * 否则 max-age 会让人一直看着缓存里的旧图。
 *
 * 注意：这个必须在每次 /status 时重新算。只在启动时算一次的话，
 * 运行期换掉的文件永远不会反映到版本号上，缓存就永远命中旧图。
 * 目录里就十几个文件，但 700ms 轮询一次还是太勤，所以缓存 2 秒。
 */
let assetVersion = ''
let assetVersionAt = 0
async function computeAssetVersion() {
  const now = Date.now()
  if (now - assetVersionAt < 2000) return assetVersion
  assetVersionAt = now
  let newest = 0
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else {
        const st = await stat(full).catch(() => null)
        if (st && st.mtimeMs > newest) newest = st.mtimeMs
      }
    }
  }
  await walk(ASSET_ROOT)
  assetVersion = newest ? String(Math.floor(newest)) : '0'
  return assetVersion
}
/** 扫 assets 下所有「四态齐全」的目录，当成可选皮肤。 */
async function listSkins() {
  const out = []
  let dirs = []
  try {
    dirs = await readdir(ASSET_ROOT, { withFileTypes: true })
  } catch {
    return out
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    let ok = true
    for (const name of ASSET_NAMES) {
      const hit =
        (await stat(join(ASSET_ROOT, d.name, name + '.webp')).catch(() => null)) ||
        (await stat(join(ASSET_ROOT, d.name, name + '.png')).catch(() => null))
      if (!hit) {
        ok = false
        break
      }
    }
    if (ok) out.push({ id: d.name })
  }
  out.sort((a, b) => {
    // 主预设排最前，其余按名字
    const rank = (id) => (id === 'blue' ? 0 : id === 'cute' ? 1 : id === 'default' ? 2 : 3)
    const d = rank(a.id) - rank(b.id)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
  return out
}

/**
 * 用户在设置页改的东西，存在自己的小文件里，不动 cordis.patch.yml。
 * watchDirs 也放这儿 —— 别人装完插件不该被要求去翻 YAML 才知道怎么用。
 */
let chosenSkin = ''
let chosenVisible = true
let chosenWatchDirs = []
/** 设置页改完目录后由 attach 注册，用来让扫描立刻用上新目录。 */
let refreshWatchDirs = () => {}
async function loadSettings() {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8')
    const obj = JSON.parse(raw)
    if (obj && typeof obj.skin === 'string' && SKIN_RE.test(obj.skin)) chosenSkin = obj.skin
    if (obj && typeof obj.visible === 'boolean') chosenVisible = obj.visible
    if (obj && Array.isArray(obj.watchDirs)) {
      chosenWatchDirs = obj.watchDirs
        .filter((d) => typeof d === 'string' && d.trim())
        .map((d) => d.trim())
    }
  } catch {
    /* 还没选过 */
  }
}
async function saveSettings() {
  try {
    await mkdir(dirname(SETTINGS_FILE), { recursive: true })
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify(
        { skin: chosenSkin, visible: chosenVisible, watchDirs: chosenWatchDirs },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* 存不下不影响正事 */
  }
}

/* ───────────────────────── 作业表 ───────────────────────── */

/** @type {Map<string, any>} 以绝对路径为键 */
const jobs = new Map()

function touchJob(path, name, dir, bytes, now) {
  let job = jobs.get(path)
  if (!job) {
    job = {
      path,
      name,
      dir,
      bytes,
      samples: [{ t: now, bytes }],
      firstAt: now,
      lastGrowAt: now,
      state: 'active',
      doneAt: 0,
      retired: false,
      total: null,
    }
    jobs.set(path, job)
    return
  }
  if (bytes > job.bytes) {
    job.bytes = bytes
    job.lastGrowAt = now
    // 刚退休过的文件又长起来了 —— 它不是躺尸，是真的在写，重新上班
    job.state = 'active'
    job.retired = false
    job.doneAt = 0
    job.samples.push({ t: now, bytes })
    if (job.samples.length > SAMPLES) job.samples.shift()
  }
}

function speedOf(job) {
  const s = job.samples
  if (!s || s.length < 2) return 0
  const first = s[0]
  const last = s[s.length - 1]
  const dt = (last.t - first.t) / 1000
  if (dt <= 0) return 0
  const delta = last.bytes - first.bytes
  return delta > 0 ? delta / dt : 0
}

/* ───────────────────────── 扫描 ───────────────────────── */

/**
 * 扫一轮。返回这一轮「确认还在」的路径集合，
 * 以及这一轮「真的扫成功」的目录（扫失败的目录不参与消失判定）。
 */
async function scanOnce(dirs, cfg, now) {
  const alive = new Set()
  const okDirs = new Set()

  for (const dir of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 目录不存在 / 没权限：跳过，不算它失效
    }
    okDirs.add(dir)

    for (const ent of entries) {
      if (!ent.isFile()) continue
      const full = join(dir, ent.name)

      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (!Number.isFinite(st.size) || st.size < cfg.minBytes) continue

      // 最后一次写入太久远 —— 不是「正在下的东西」，连提都不提
      if (now - st.mtimeMs > cfg.staleMs) continue

      // 诊断快照自己也在写盘，别让它把自己当成下载
      if (cfg.snapshotFile && full === cfg.snapshotFile) continue

      alive.add(full)
      touchJob(full, ent.name, dir, st.size, now)
    }
  }

  return { alive, okDirs }
}

/**
 * 推进状态：太久没长 → done；done 待够 linger → 退休（不再显示），但记录留着。
 *
 * 为什么不直接删：文件还躺在原地，mtime 也还在候选窗口里，
 * 删掉它下一轮就会被当成「新下载」重新捡起来，进度条会一闪一闪。
 * 退休只影响可见性，不删记录；真又长起来了，touchJob 会让它重新上班。
 */
function settle(cfg, now, alive, okDirs) {
  for (const [path, job] of jobs) {
    if (job.state === 'active') {
      const dirStillOk = okDirs.has(job.dir)
      // 目录还扫得动、但文件不见了 —— 多半是下完被改名搬走了，直接判完成
      if (dirStillOk && !alive.has(path)) {
        job.state = 'done'
        job.doneAt = now
        rememberSize(job.name, job.bytes) // 被改名搬走 = 下完了，这个字节数就是总量
        continue
      }
      if (now - job.lastGrowAt >= cfg.idleMs) {
        job.state = 'done'
        job.doneAt = now
        // 停手也记一笔：中途断的话记的是半截，下次真下完会覆盖成更大的值
        rememberSize(job.name, job.bytes)
      }
      continue
    }
    if (job.state === 'done') {
      if (!job.retired && now - job.doneAt >= cfg.lingerMs) job.retired = true
      // 半小时都没动静才真的忘掉，控制内存
      if (job.retired && now - job.doneAt > 30 * 60 * 1000) jobs.delete(path)
    }
  }
}

/* ───────────────────────── 出参 ───────────────────────── */

function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Number(n) || 0
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i]
}

function snapshot(now, cfg) {
  const list = []
  for (const job of jobs.values()) {
    if (job.retired) continue // 下了、也谢过幕了：留着记录防止被重新捡起，但不再显示
    const speed = speedOf(job)
    const total = resolveTotal(job, cfg)
    const percent = total ? Math.min(100, (job.bytes / total) * 100) : null
    const eta = total && speed > 0 ? Math.max(0, (total - job.bytes) / speed) : null
    list.push({
      id: Buffer.from(job.path).toString('base64url'),
      name: job.name,
      dir: job.dir,
      state: job.state,
      bytes: job.bytes,
      bytesText: humanBytes(job.bytes),
      speed,
      speedText: speed > 0 ? humanBytes(speed) + '/s' : '',
      total,
      totalText: total ? humanBytes(total) : '',
      percent,
      eta,
      ageMs: now - job.firstAt,
      idleMs: now - job.lastGrowAt,
    })
  }
  // 最近还在长的排前面：多任务时挂件显示的就是「眼下最活跃的那个」
  list.sort((a, b) => a.idleMs - b.idleMs)
  return list
}

/* ───────────────────────── HTTP ───────────────────────── */

function sendJson(res, code, data) {
  let body = '{}'
  try {
    body = JSON.stringify(data)
  } catch {
    /* 走默认 */
  }
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch {
    /* 连接已经断了 */
  }
}

/** 读一个小 JSON body（设置页切皮肤用）。 */
function readJsonBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/* ───────────────────────── 入口 ───────────────────────── */

export function apply(root, config = {}) {
  // 最外面这道闸：插件自己出任何事，都不许把异常抛回宿主管线
  try {
    const cfg = readConfig(config)

  /**
   * 排查探针：只有配了 snapshotFile 才写。
   * 平时留空 → 一个字节都不落；出问题时配上一个路径 → 每一步都留下记号。
   */
  const probe = (tag, detail) => {
    if (!cfg.snapshotFile) return
    try {
      const file = cfg.snapshotFile.replace(/\.json$/i, '') + '.' + tag + '.txt'
      const text = new Date().toISOString() + (detail ? '\n' + detail : '')
      mkdir(dirname(cfg.snapshotFile), { recursive: true })
        .then(() => writeFile(file, text, 'utf8'))
        .catch(() => {})
    } catch {
      /* 探针自己失败不影响正事 */
    }
  }

  probe(
    '00-entry',
    'inject=' + typeof (root && root.inject) + ' get=' + typeof (root && root.get),
  )

  const attach = (ctx, via) => {
    const server =
      ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
    probe(
      '02-attach-' + via,
      'webServer=' + typeof server + ' register=' + (server && typeof server.register),
    )
    if (!server || typeof server.register !== 'function') return

    // 扫描目录的优先级：设置页里填的 > cordis.patch.yml 里写的 > 猜两个大概率有东西的地方
    const computeDirs = () => {
      if (chosenWatchDirs.length) return chosenWatchDirs.slice()
      if (cfg.watchDirs.length) return cfg.watchDirs.slice()

      // 注意：cordis 的 ctx 在没声明 inject 时，读 ctx.workingDirectory
      // 和调 ctx.get('workingDirectory') 都是**抛异常**，不是返回 undefined。
      // 所以这两条都得包起来，否则新用户配置为空时插件直接起不来。
      let wd
      try {
        wd = ctx.workingDirectory
      } catch {
        /* 没注入这个服务 */
      }
      if (!wd) {
        try {
          wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
        } catch {
          /* 同上 */
        }
      }

      const candidates = []
      const def = wd && typeof wd.defaultDirectory === 'string' ? wd.defaultDirectory : ''
      if (def) candidates.push(def)
      try {
        candidates.push(process.cwd())
      } catch {
        /* 拿不到就算了 */
      }
      return [...new Set(candidates.filter(Boolean))]
    }

    let dirs
    try {
      dirs = computeDirs()
    } catch (e) {
      probe('03x-dirs-threw', String((e && e.stack) || e))
      dirs = []
    }
    // 设置页改完目录要能立刻生效，不用重启插件
    refreshWatchDirs = () => {
      dirs = computeDirs()
    }

    probe('03-dirs', JSON.stringify(dirs))
    void loadSizes()
    void loadSettings().then(() => {
      refreshWatchDirs()
    })
    void computeAssetVersion()

    let stopped = false
    let busy = false
    let lastScanAt = 0

    const tick = async () => {
      if (stopped || busy) return
      busy = true
      const now = Date.now()
      lastScanAt = now
      try {
        const { alive, okDirs } = await scanOnce(dirs, cfg, now)
        settle(cfg, now, alive, okDirs)
        if (sizesDirty) void flushSizes()
        if (cfg.snapshotFile) {
          const payload = JSON.stringify(
            { at: now, dirs, jobs: snapshot(now, cfg), alive: [...alive] },
            null,
            2,
          )
          writeFile(cfg.snapshotFile, payload, 'utf8').catch(() => {})
        }
      } catch {
        // 一轮扫挂了不影响下一轮
      } finally {
        busy = false
      }
    }

    const timer = setInterval(tick, cfg.scanIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(
      () => () => {
        stopped = true
        clearInterval(timer)
        jobs.clear()
      },
      'dsh-oujingjing-progress: 扫描定时器',
    )

    void tick()

    try {
      ctx.effect(
        () =>
          server.register({
            kind: 'prefix',
            path: API_PREFIX,
            handler: async (req, res) => {
              try {
                const url = String(req.url || '')
                const path = url.split('?')[0]

                // 从别的文件夹「装上」一套自己的形象
                //   POST /api/oujingjing/addskin { dir: "D:\\我的鲸娘" }
                // 只认那四个文件名，不递归、不复制别的东西
                if (req.method === 'POST' && path.replace(/\/$/, '') === API_PREFIX + '/addskin') {
                  const body = await readJsonBody(req)
                  const dir = body && typeof body.dir === 'string' ? body.dir.trim() : ''
                  if (!dir) {
                    sendJson(res, 400, { ok: false, error: '要一个文件夹路径' })
                    return
                  }
                  const abs = resolve(dir)
                  const st = await stat(abs).catch(() => null)
                  if (!st || !st.isDirectory()) {
                    sendJson(res, 404, { ok: false, error: '这个路径不是文件夹' })
                    return
                  }

                  const found = []
                  const missing = []
                  for (const name of ASSET_NAMES) {
                    let hit = null
                    for (const ext of ['.png', '.webp']) {
                      const s = await stat(join(abs, name + ext)).catch(() => null)
                      if (s && s.isFile() && s.size > 0) {
                        hit = { name, ext }
                        break
                      }
                    }
                    if (hit) found.push(hit)
                    else missing.push(name)
                  }
                  if (missing.length) {
                    sendJson(res, 400, {
                      ok: false,
                      error: '这个文件夹里少了：' + missing.join('、') + '（要 .png 或 .webp）',
                      missing,
                    })
                    return
                  }

                  // 目标目录名：取文件夹名，清掉非法字符，重名就加序号
                  const base = (basename(abs) || 'custom').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40) || 'custom'
                  let id = base
                  let n = 1
                  while (await stat(join(ASSET_ROOT, id)).catch(() => null)) {
                    n += 1
                    id = base + '-' + n
                    if (n > 50) {
                      sendJson(res, 409, { ok: false, error: '同名太多了，换个文件夹名吧' })
                      return
                    }
                  }

                  const target = join(ASSET_ROOT, id)
                  await mkdir(target, { recursive: true })
                  for (const f of found) {
                    await copyFile(join(abs, f.name + f.ext), join(target, f.name + f.ext))
                  }
                  await computeAssetVersion()
                  sendJson(res, 200, { ok: true, id, files: found.map((f) => f.name + f.ext) })
                  return
                }

                // 设置页：切皮肤 / 藏起来。POST /api/oujingjing/settings
                if (req.method === 'POST' && path.replace(/\/$/, '') === API_PREFIX + '/settings') {
                  const body = await readJsonBody(req)
                  if (!body || typeof body !== 'object') {
                    sendJson(res, 400, { ok: false, error: 'bad body' })
                    return
                  }
                  if (typeof body.skin === 'string') {
                    const want = body.skin.trim()
                    const hit = SKIN_RE.test(want) ? await stat(join(ASSET_ROOT, want)).catch(() => null) : null
                    if (!hit || !hit.isDirectory()) {
                      sendJson(res, 404, { ok: false, error: 'no such skin' })
                      return
                    }
                    chosenSkin = want
                  }
                  if (typeof body.visible === 'boolean') chosenVisible = body.visible
                  if (Array.isArray(body.watchDirs)) {
                    const wanted = body.watchDirs
                      .filter((d) => typeof d === 'string' && d.trim())
                      .map((d) => d.trim())
                    for (const d of wanted) {
                      const st = await stat(d).catch(() => null)
                      if (!st || !st.isDirectory()) {
                        sendJson(res, 400, { ok: false, error: '不是文件夹：' + d })
                        return
                      }
                    }
                    chosenWatchDirs = wanted
                    refreshWatchDirs()
                  }
                  await saveSettings()
                  sendJson(res, 200, {
                    ok: true,
                    skin: chosenSkin,
                    visible: chosenVisible,
                    watchDirs: chosenWatchDirs,
                  })
                  return
                }

                // 兼容旧的单字段接口
                if (req.method === 'POST' && path.replace(/\/$/, '') === API_PREFIX + '/skin') {
                  const body = await readJsonBody(req)
                  const want = body && typeof body.skin === 'string' ? body.skin.trim() : ''
                  if (!want || !SKIN_RE.test(want)) {
                    sendJson(res, 400, { ok: false, error: 'bad skin id' })
                    return
                  }
                  const hit = await stat(join(ASSET_ROOT, want)).catch(() => null)
                  if (!hit || !hit.isDirectory()) {
                    sendJson(res, 404, { ok: false, error: 'no such skin' })
                    return
                  }
                  chosenSkin = want
                  await saveSettings()
                  sendJson(res, 200, { ok: true, skin: chosenSkin, visible: chosenVisible })
                  return
                }

                if (req.method !== 'GET') {
                  sendJson(res, 405, { ok: false, error: 'method not allowed' })
                  return
                }

                if (path.replace(/\/$/, '') === API_PREFIX + '/status') {
                  const now = Date.now()
                  const skin = chosenSkin || cfg.skin
                  sendJson(res, 200, {
                    ok: true,
                    skin,
                    visible: chosenVisible,
                    assetVersion: await computeAssetVersion(),
                    skins: await listSkins(),
                    jobs: snapshot(now, cfg),
                    watchDirs: dirs,
                    customWatchDirs: chosenWatchDirs,
                    scanIntervalMs: cfg.scanIntervalMs,
                    lastScanAt,
                    now,
                  })
                  return
                }

                // 立绘：/api/oujingjing/asset/<name>.(png|webp)，取当前皮肤那一套
                const assetPrefix = API_PREFIX + '/asset/'
                if (path.startsWith(assetPrefix)) {
                  const m = /^([A-Za-z0-9_-]+)\.(png|webp)$/i.exec(path.slice(assetPrefix.length))
                  const name = m ? m[1] : ''
                  if (!m || !ASSET_NAMES.has(name)) {
                    sendJson(res, 404, { ok: false, error: 'no such asset' })
                    return
                  }
                  const skin = (() => {
                    // 设置页要预览「别的」皮肤，所以允许 ?skin= 覆盖一次
                    const q = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : ''
                    let want = ''
                    try {
                      want = new URLSearchParams(q).get('skin') || ''
                    } catch {
                      /* 忽略 */
                    }
                    return want && SKIN_RE.test(want) ? want : chosenSkin || cfg.skin
                  })()
                  const exts = ['.' + m[2].toLowerCase(), m[2].toLowerCase() === 'png' ? '.webp' : '.png']
                  let buf = null
                  let ext = exts[0]
                  for (const base of [skin, 'default']) {
                    for (const e of exts) {
                      try {
                        buf = await readFile(join(ASSET_ROOT, base, name + e))
                        ext = e
                        break
                      } catch {
                        /* 试下一个 */
                      }
                    }
                    if (buf) break
                  }
                  if (!buf) {
                    sendJson(res, 404, { ok: false, error: 'asset missing' })
                    return
                  }
                  res.statusCode = 200
                  res.setHeader('content-type', ext === '.webp' ? 'image/webp' : 'image/png')
                  res.setHeader('cache-control', 'public, max-age=86400')
                  res.end(buf)
                  return
                }

                sendJson(res, 404, { ok: false, error: 'not found' })
              } catch (e) {
                sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
              }
            },
          }),
        'dsh-oujingjing-progress: ' + API_PREFIX,
      )
      probe('04-registered', via)
    } catch (e) {
      probe('04x-register-threw', String((e && e.stack) || e))
    }
  }

  // 先直接拿：拿得到就现在挂，绕开注入时序；拿不到再等 webServer 出现
  let direct = null
  try {
    direct = root.webServer || (typeof root.get === 'function' ? root.get('webServer') : undefined)
  } catch {
    /* 忽略 */
  }
  if (direct && typeof direct.register === 'function') {
    probe('01-direct-path')
    attach(root, 'direct')
    return
  }

  probe('01-inject-path', 'direct=' + typeof direct)
  try {
    root.inject(['webServer'], (ctx) => attach(ctx, 'inject'))
  } catch (e) {
    probe('01x-inject-threw', String((e && e.stack) || e))
  }
  } catch {
    /* 插件自己出问题，静默收场，宿主照常跑 */
  }
}
