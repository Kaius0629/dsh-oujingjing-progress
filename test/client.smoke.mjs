/**
 * 离线冒烟（浏览器半侧）：不起浏览器，只验证这几件事
 *   1. client.js 能被模块加载器收下，factory 结构正确
 *   2. apply 把自己挂到了 shell.overlay
 *   3. 宿主没响应 → 返回 null；宿主活着但没下载 → 她站着打盹（常驻）
 *   4. 三种下载态各自换图，气泡说「还剩多久」
 *   5. 画出来的是纯角色 + 气泡，没有卡片框
 *
 *   node test/client.smoke.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const CODE = await readFile(join(ROOT, 'client.js'), 'utf8')

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  — ' + extra : ''))
}

/** 从渲染出来的节点里，看她现在用的是哪张脸。 */
function faceOf(nodes) {
  const n = nodes.find((x) => x.props && x.props['data-ojj-face'] === '')
  if (!n || !n.props) return ''
  const src = String(n.props.src || '') || String((n.props.style && n.props.style.backgroundImage) || '')
  const m = /asset\/([a-z0-9_-]+)\.(png|webp)/i.exec(src)
  return m ? m[1] : ''
}

/* ── 最小的 window / document ── */

let captured = null
const styleStub = {
  attrs: {},
  textContent: '',
  setAttribute(k, v) {
    this.attrs[k] = v
  },
  remove() {},
}

const store = new Map()
const fakeWindow = {
  __ModuleLoader__: {
    load: (opts) => {
      captured = opts
    },
  },
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
}
const fakeDocument = { createElement: () => styleStub, head: { appendChild() {} } }

/* eslint-disable no-new-func */
new Function('window', 'document', CODE)(fakeWindow, fakeDocument)

check('module loader received the registration', Boolean(captured))
check(
  'registration id matches the package',
  captured && captured.id === 'dsh-oujingjing-progress',
  captured && captured.id,
)

/* ── mock React ── */

const created = []
const React = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') return type({ ...(props || {}), children })
    const node = { type, props: props || {}, children }
    created.push(node)
    return node
  },
  useState: null,
  useEffect() {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

/**
 * 让 useRef 跨「渲染」持久化：气泡退场是靠 ref 冻住内容的，
 * 如果每次渲染都给新对象，就没有第二次渲染能读到快照。
 */
const refSlots = []
let refIdx = 0
function withPersistentRefs(fn) {
  const original = React.useRef
  React.useRef = (v) => {
    const i = refIdx
    refIdx += 1
    if (!refSlots[i]) refSlots[i] = { current: v }
    return refSlots[i]
  }
  try {
    return fn()
  } finally {
    React.useRef = original
  }
}

/**
 * Widget 里 useState 的调用顺序是固定的：
 *   0 → status（useStatus）
 *   1 → alive（useStatus）
 *   2 → 位置
 *   3 → dragging
 */
function installStatus(statusValue, aliveValue = true, hoverValue = false, pokeValue = false, lineValue = '在呢') {
  let seen = 0
  React.useState = (initial) => {
    const index = seen
    seen += 1
    if (index === 0) return [statusValue, () => {}]
    if (index === 1) return [aliveValue, () => {}]
    if (index === 4) return [hoverValue, () => {}]
    if (index === 5) return [pokeValue, () => {}]
    if (index === 6) return [lineValue, () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  }
}

/* ── 拉起插件 ── */

const registered = []
const fakeCtx = {
  get() {
    return undefined
  },
  slots: {
    inject(name, fn) {
      fn()
    },
    register(opts, component) {
      registered.push({ opts, component })
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
}

const mod = captured.factory((id) => (id === 'react' ? React : undefined))
check('factory exposes apply + inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))

mod.apply(fakeCtx)

const slot = registered[0]
check(
  'registered into shell.overlay',
  Boolean(slot) && slot.opts.name === 'shell.overlay',
  slot && slot.opts.name,
)
check('style tag was injected', styleStub.attrs['data-plugin-css'] === 'dsh-oujingjing-progress')

/* ── 宿主没响应：不画 ── */

installStatus(null, false)
created.length = 0
const dead = slot.component({})
check('renders null when the host does not answer', dead === null, String(dead))
check('created nothing when the host is down', created.length === 0, String(created.length))

/* ── 宿主播活着、没在下载：她常驻站着 ── */

installStatus({ jobs: [] }, true)
created.length = 0
const idle = slot.component({})
check('stays on screen when nothing is downloading', idle !== null)
check('idle character is drawn', faceOf(created) === 'idle', faceOf(created))
check('no bubble while idle', !created.some((n) => n.props && n.props['data-ojj-bubble'] === ''))

/* ── 有个下载：吃 / 卡 / 饱 ── */

const base = {
  id: 'a',
  name: 'SexGod_v3.safetensors',
  dir: 'D:/Downloads',
  state: 'active',
  bytes: 123456789,
  bytesText: '117.7 MB',
  speed: 22020096,
  speedText: '21 MB/s',
  total: 209715200,
  totalText: '200 MB',
  percent: 50,
  eta: 150,
  ageMs: 5000,
  idleMs: 200,
}

installStatus({ jobs: [base] }, true)
created.length = 0
slot.component({})
check('eating art while downloading', faceOf(created) === 'eating', faceOf(created))
check(
  'bubble names the file being downloaded',
  created.some(
    (n) => n.props && n.props['data-ojj-b-name'] === '' && n.children[0] === 'SexGod_v3.safetensors',
  ),
)
check(
  'bubble shows percentage and remaining time',
  created.some((n) => {
    if (!n.props || n.props['data-ojj-b-main'] !== '') return false
    const text = String(n.children[0] || '')
    return text.indexOf('%') >= 0 && text.indexOf('剩 ') >= 0
  }),
)
check(
  'bubble shows downloaded over total',
  created.some(
    (n) => n.props && n.props['data-ojj-b-sub'] === '' && String(n.children[0] || '').includes('/'),
  ),
)
check(
  'no card chrome: widget has no background/border style',
  created.some((n) => {
    if (!n.props || n.props['data-ojj-widget'] !== '') return false
    const s = n.props.style || {}
    return !s.background && !s.border && !s.boxShadow
  }),
)
check(
  'bubble bar carries the percentage',
  created.some((n) => {
    if (!n.props || n.props['data-ojj-bubble-fill'] === undefined) return false
    return n.props.style && n.props.style.width === '50%'
  }),
)
check(
  'no ring around the character',
  !created.some((n) => n.props && n.props['data-ojj-ring'] !== undefined),
)

installStatus({ jobs: [{ ...base, idleMs: 2500 }] }, true)
created.length = 0
slot.component({})
check('stuck art when nothing has grown for a while', faceOf(created) === 'stuck', faceOf(created))

installStatus({ jobs: [{ ...base, state: 'done', percent: 100, eta: null }] }, true)
created.length = 0
slot.component({})
check('done art when finished', faceOf(created) === 'done', faceOf(created))
check(
  'done bubble says she is full',
  created.some((n) => n.props && n.props['data-ojj-b-main'] === '' && n.children[0] === '吃完啦'),
)

/* ── 多任务：+.N ── */

installStatus({ jobs: [base, { ...base, id: 'b', name: 'second.bin' }] }, true)
created.length = 0
slot.component({})
check('multiple jobs collapse into +N', created.some((n) => n.props && n.props['data-ojj-more'] === ''))
check(
  'no task list until hovered',
  !created.some((n) => n.props && n.props['data-ojj-list'] === ''),
)

installStatus({ jobs: [base, { ...base, id: 'b', name: 'second.bin' }] }, true, true)
created.length = 0
slot.component({})
check('hover expands the task list', created.some((n) => n.props && n.props['data-ojj-list'] === ''))
check(
  'list has one row per job',
  created.filter((n) => n.props && n.props['data-ojj-item'] === '').length === 2,
)
check(
  'list names every file',
  created.some((n) => n.props && n.props['data-ojj-item-name'] === '' && n.children[0] === 'second.bin'),
)

/* ── 戳一下：不能去请求皮肤里没有的图 ── */

installStatus({ jobs: [] }, true, false, true)
created.length = 0
slot.component({})
check('poking keeps the idle sprite', faceOf(created) === 'idle', faceOf(created))
check(
  'poking never asks for a poke.png',
  !created.some((n) => n.props && String(n.props.src || '').indexOf('poke') >= 0),
)
check(
  'poking shows a line',
  created.some((n) => n.props && n.props['data-ojj-b-main'] === '' && n.children[0]),
)

/* ── 关键：戳下去那句必须钉住，不能每轮轮询换一句 ── */

function mainTextOf(nodes) {
  const n = nodes.find((x) => x.props && x.props['data-ojj-b-main'] === '')
  return n ? String(n.children[0] || '') : ''
}

installStatus({ jobs: [] }, true, false, true, '还没下完啦')
created.length = 0
slot.component({})
const lineA = mainTextOf(created)

// 模拟 700ms 后的一次轮询重渲染
installStatus({ jobs: [] }, true, false, true, '还没下完啦')
created.length = 0
slot.component({})
const lineB = mainTextOf(created)

check('poke line is pinned', lineA === '还没下完啦' && lineB === lineA, lineA + ' / ' + lineB)

/* ── 台词不许把用户往回推（催 / 别急 / 再等 这类） ── */

const ALL_LINES = (() => {
  const m = CODE.match(/const LINES = \[([\s\S]*?)\]/)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^'|'$/g, ''))
})()

// 不许往回推（催/别急/再等），也不许挑衅（试试/敢不敢）
const PUSHBACK = /别急|再等|再催|噎着|别戳|手别乱动|试试|敢不敢|挑衅/
check('there are enough lines', ALL_LINES.length >= 15, String(ALL_LINES.length))
check(
  'no line pushes the user back or dares them',
  !ALL_LINES.some((l) => PUSHBACK.test(l)),
  ALL_LINES.filter((l) => PUSHBACK.test(l)).join(' / '),
)
check('no duplicate lines', new Set(ALL_LINES).size === ALL_LINES.length)

/* ── 气泡退场：任务撤掉之后气泡还得在，播完 .18s 才摘 ── */

function renderPass(opts) {
  const status = opts.status === undefined ? { jobs: [] } : opts.status
  let idx = 0
  refIdx = 0
  React.useState = (initial) => {
    const i = idx
    idx += 1
    if (i === 0) return [status, () => {}]
    if (i === 1) return [true, () => {}]
    if (i === 4) return [false, () => {}]
    if (i === 5) return [Boolean(opts.poking), () => {}]
    if (i === 6) return [opts.line || '在呢', () => {}]
    if (i === 7) return [opts.bubblePhase || 'gone', () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  }
  created.length = 0
  withPersistentRefs(() => slot.component({}))
  return created.slice()
}

const JOB = {
  id: 'x',
  name: 'a.bin',
  state: 'active',
  percent: 40,
  eta: 60,
  bytesText: '1 MB',
  totalText: '2 MB',
  total: 2000,
  bytes: 800,
  idleMs: 0,
}

// 第一趟：有任务 —— 气泡出现，内容被存进 ref
renderPass({ status: { jobs: [JOB] }, bubblePhase: 'in' })

// 第二趟：任务没了、也没在戳，阶段还停在 out —— 气泡应该留着并带 leaving
const leavingNodes = renderPass({ status: { jobs: [] }, bubblePhase: 'out' })
const leavingBubble = leavingNodes.find((n) => n.props && n.props['data-ojj-bubble'] === '')
check('bubble stays while it fades', Boolean(leavingBubble))
check(
  'bubble is flagged as leaving',
  Boolean(leavingBubble) && leavingBubble.props['data-leaving'] === '',
)
check(
  'the fading bubble keeps its old text',
  leavingNodes.some((n) => n.props && n.props['data-ojj-b-name'] === '' && n.children[0] === 'a.bin'),
)

// 第三趟：阶段 gone —— 气泡真的摘掉了
const goneNodes = renderPass({ status: { jobs: [] }, bubblePhase: 'gone' })
check(
  'bubble is gone once the phase ends',
  !goneNodes.some((n) => n.props && n.props['data-ojj-bubble'] === ''),
)

/* ── 设置页：很多套形象时不能撑破，加号永远在最后 ── */

const settingsSlot = registered.find((r) => r.opts.name === 'settings.section')
check('settings page registered', Boolean(settingsSlot))

function renderSettings(skinCount, statusOverride) {
  const skins = []
  for (let i = 0; i < skinCount; i += 1) skins.push({ id: 'skin-' + i })
  let seen = 0
  React.useState = (initial) => {
    const index = seen
    seen += 1
    if (index === 0) {
      return [statusOverride || { skins, skin: 'skin-0', visible: true }, () => {}]
    }
    if (index === 1) return [false, () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  }
  // h 是工厂里 early-bind 的，替换 React.createElement 拦不到它；
  // 但所有节点都由那个原函数推进入全局 created，直接清空再取。
  created.length = 0
  settingsSlot.component({})
  return created.slice()
}

const few = renderSettings(3)
const cardsFew = few.filter((n) => n.props && n.props['data-ojj-card'] === '')
check('add-card sits in the same grid as skins', cardsFew.length === 4, String(cardsFew.length))
check(
  'add-card is the last one',
  cardsFew[cardsFew.length - 1].props['data-ojj-add'] === '',
)
check(
  'add-card holds a circled plus',
  few.some((n) => n.props && n.props['data-ojj-add-circle'] === '' && n.children[0] === '+'),
)

const many = renderSettings(14)
const cardsMany = many.filter((n) => n.props && n.props['data-ojj-card'] === '')
check('many skins keep the add card reachable', cardsMany[cardsMany.length - 1].props['data-ojj-add'] === '')
check(
  'many skins switch the grid into scroll mode',
  many.some((n) => n.props && n.props['data-ojj-grid'] === '' && n.props['data-many'] === ''),
)
check('every skin still gets a card', cardsMany.length === 15, String(cardsMany.length))

/* ── 监控目录：能看、能删；没配的时候显示「默认」 ── */

const withDirs = renderSettings(2, {
  skins: [{ id: 'blue' }, { id: 'cute' }],
  skin: 'blue',
  visible: true,
  customWatchDirs: ['D:\\Downloads', 'E:\\models'],
  watchDirs: ['D:\\Downloads', 'E:\\models'],
})
const dirRows = withDirs.filter((n) => n.props && n.props['data-ojj-dir'] === '')
check('one row per watched folder', dirRows.length === 2, String(dirRows.length))
check(
  'each row can be removed',
  withDirs.filter((n) => n.props && n.props['data-ojj-dir-del'] === '').length === 2,
)
check(
  'the paths are shown',
  withDirs.some((n) => n.props && n.props['data-ojj-dir-path'] === '' && n.children[0] === 'D:\\Downloads'),
  withDirs
    .filter((n) => n.props && n.props['data-ojj-dir-path'] === '')
    .map((n) => JSON.stringify(n.children))
    .join(' | '),
)

const noDirs = renderSettings(2, {
  skins: [{ id: 'blue' }],
  skin: 'blue',
  visible: true,
  customWatchDirs: [],
  watchDirs: ['C:\\some\\session\\dir'],
})
const fallbackRows = noDirs.filter((n) => n.props && n.props['data-ojj-dir'] === '')
check('falls back to one default row', fallbackRows.length === 1, String(fallbackRows.length))
check(
  'the fallback row cannot be removed',
  noDirs.filter((n) => n.props && n.props['data-ojj-dir-del'] === '').length === 0,
)

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? failed.length + ' failed' : 'all ' + results.length + ' passed'))
process.exit(failed.length ? 1 : 0)
