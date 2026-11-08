/**
 * 离线冒烟：不碰真 DSH，只把宿主半个拉起来，喂一个正在变大的文件，
 * 看它认不认得出「有东西在下载」，以及停下来之后会不会自己收摊。
 *
 *   node test/smoke.mjs
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先把状态目录指到临时目录，再导入模块 —— 否则会读到开发机上真实的 settings.json，
// 里面存着设置页选的目录，会把本测试的 watchDirs 顶掉。
process.env.OJJ_STATE_DIR = await mkdtemp(join(tmpdir(), 'ojj-smoke-'))
const { apply } = await import('../lib/index.js')

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DIR = join(ROOT, '_smoke_dl')
const FILE = join(DIR, 'growing.bin.part')
const SNAP = join(ROOT, '_smoke_snap.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  — ' + extra : ''))
}

await rm(DIR, { recursive: true, force: true })
await mkdir(DIR, { recursive: true })
await writeFile(FILE, Buffer.alloc(0))

const routes = new Map()
const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  get() {
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
}
apply(
  { inject: (_names, cb) => cb(ctx) },
  {
    watchDirs: [DIR],
    scanIntervalMs: 100,
    idleMs: 600,
    lingerMs: 200,
    minBytes: 4096,
    staleMs: 500,
    snapshotFile: SNAP,
  },
)

const chunk = Buffer.alloc(256 * 1024)

// 1) 让它长一会儿
for (let i = 0; i < 6; i += 1) {
  await appendFile(FILE, chunk)
  await sleep(120)
}
await sleep(300)

let snap = null
try {
  snap = JSON.parse(await readFile(SNAP, 'utf8'))
} catch (e) {
  check('snapshot written', false, String(e && e.message))
}

check('host registered the status route', routes.has('/api/oujingjing') || routes.size > 0)
if (snap) {
  check('watchDirs resolved', Array.isArray(snap.dirs) && snap.dirs.includes(DIR), JSON.stringify(snap.dirs))
  const job = (snap.jobs || [])[0]
  check('one growing file detected', Boolean(job), job ? job.name : 'none')
  if (job) {
    check('state is active', job.state === 'active', job.state)
    check('bytes counted', job.bytes >= 6 * chunk.length, String(job.bytes))
    check('speed measured', job.speed > 0, String(Math.round(job.speed)))
    check('percent stays null without total', job.percent === null, String(job.percent))
  }
}

// 2) 停下来，看它会不会自己收摊
await sleep(3400)
let after = null
try {
  after = JSON.parse(await readFile(SNAP, 'utf8'))
} catch {
  /* 文件被清掉也算正常 */
}
const stillThere = after && Array.isArray(after.jobs) && after.jobs.length > 0
check('quiet disk empties the list', !stillThere, stillThere ? 'still ' + after.jobs.length : 'empty')

// 关键：不能过几秒又自己冒出来（文件还躺在原地）
await sleep(1600)
let again = null
try {
  again = JSON.parse(await readFile(SNAP, 'utf8'))
} catch {
  /* 也算正常 */
}
const cameBack = again && Array.isArray(again.jobs) && again.jobs.length > 0
check('does not reappear while the file just sits there', !cameBack, cameBack ? 'came back with ' + again.jobs.length : 'stays gone')

// 但它要是又开始长，得重新上班
await appendFile(FILE, chunk)
await sleep(500)
let revived = null
try {
  revived = JSON.parse(await readFile(SNAP, 'utf8'))
} catch {
  /* 忽略 */
}
const back = revived && Array.isArray(revived.jobs) && revived.jobs.length > 0
check('comes back when the file grows again', Boolean(back))

await rm(DIR, { recursive: true, force: true })
await rm(SNAP, { force: true })
for (const tag of ['00-entry', '01-inject-path', '01-direct-path', '02-attach-inject', '03-dirs', '04-registered']) {
  await rm(SNAP.replace(/\.json$/i, '') + '.' + tag + '.txt', { force: true })
}

/* ── 回归：配置为空 + 宿主不提供 workingDirectory 时，不许把插件弄崩 ──
 *
 * 之前这里踩过：cordis 的 ctx 在没声明 inject 时，读 ctx.workingDirectory /
 * 调 ctx.get('workingDirectory') 是**抛异常**，不是返回 undefined。
 * 出厂配置里 watchDirs 是空的，第一次装的人一定会走到这条兜底，
 * 于是插件静默起不来、路由全 401。这条测试就是钉住它。 */

const hostileRoutes = new Map()
const hostileCtx = {
  webServer: {
    register(route) {
      hostileRoutes.set(route.path, route.handler)
      return () => hostileRoutes.delete(route.path)
    },
  },
  get() {
    throw new Error('cannot get property "workingDirectory" without inject')
  },
  get workingDirectory() {
    throw new Error('cannot get property "workingDirectory" without inject')
  },
  effect(fn) {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
}

let hostileThrew = false
try {
  apply({ inject: (_names, cb) => cb(hostileCtx) }, { watchDirs: [], snapshotFile: '' })
} catch {
  hostileThrew = true
}
check('survives a host that refuses workingDirectory', !hostileThrew)
check(
  'still registers its route in that case',
  hostileRoutes.has('/api/oujingjing'),
  [...hostileRoutes.keys()].join(',') || 'none',
)

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? failed.length + ' failed' : 'all ' + results.length + ' passed'))

// 把 OJJ_STATE_DIR 那个临时目录也删掉，不然每跑一次就留一个
await rm(process.env.OJJ_STATE_DIR, { recursive: true, force: true }).catch(() => {})

process.exit(failed.length ? 1 : 0)
