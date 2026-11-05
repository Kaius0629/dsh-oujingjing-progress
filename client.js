/**
 * dsh-oujingjing-progress —— 浏览器半侧
 *
 * 一只站在桌面上的鲸娘：没有卡片、没有边框、没有把她圈起来的环。
 *   1. 宿主没响应 → 不画（分得清「插件坏了」和「没在下载」）
 *   2. 没在下载 → 站着打盹（常驻），不冒泡
 *   3. 点击她 → 挥手 + 说一句话
 *   4. 皮肤在 设置 → 欧鲸鲸 里点，选完记在宿主那边
 */

window.__ModuleLoader__.load({
  id: 'dsh-oujingjing-progress',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/oujingjing'
    const POLL_MS = 700
    const POS_KEY = 'dsh-oujingjing-progress:pos'
    const SIZE = { w: 168, h: 152 }
    const POKE_MS = 2600
    // 气泡退场时长，要跟 CSS 里 ojj-bub-out 的 .18s 对上
    const BUBBLE_OUT_MS = 180
    // 台词原则：她在「陪你玩」，不是在「催你」或「被你催」。
    // 所以不要出现「别急」「再等等」「再催就…」这类往回推的话。
    const LINES = [
      '嗯？',
      '在呢',
      '还没下完啦',
      '怎么啦？',
      '有事吗？',
      '马上就好',
      '呼……',
      '咦？',
      '要不要一起等？',
      '在努力吃了',
      '碗还空着呢',
      '下好了会叫你的',
      '我盯着呢',
      '尾巴给你摸…',
      '这一口还没咽下去',
      '你要下什么呀',
      '我吃的很快的',
      '好痒呀…',
      '嘿嘿',
      '快了快了',
      '你也在等吗',
      '我一直都在呀',
    ]

    /* ───────────────── 样式 ───────────────── */

    const CSS = `
[data-ojj-widget]{position:fixed;z-index:2147483000;width:168px;box-sizing:border-box;
  display:flex;flex-direction:column;align-items:center;
  cursor:grab;user-select:none;touch-action:none;background:none;border:0;padding:0;}
[data-ojj-widget][data-dragging]{cursor:grabbing;}

/* 气泡：蓝紫渐变 + 细边 + 底下一对分叉的鲸尾尖（这地方是自己的，不是谁的）
   overflow 要放开，不然尾巴露不出来；进度条自己补圆角 */
[data-ojj-bubble]{position:relative;max-width:166px;box-sizing:border-box;
  padding:5px 11px 8px;border-radius:14px;margin-bottom:9px;
  color:#fff;
  background:linear-gradient(155deg,rgba(41,66,148,.94) 0%,rgba(58,47,124,.94) 100%);
  border:1px solid rgba(125,211,252,.30);
  box-shadow:0 3px 12px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.10);
  text-shadow:0 1px 2px rgba(0,0,0,.5);
  transform-origin:50% 100%;
  animation:ojj-bub-in .2s cubic-bezier(.2,1.4,.5,1);}
@keyframes ojj-bub-in{from{opacity:0;transform:translateY(6px) scale(.92)}to{opacity:1;transform:none}}
/* 退场：往下沉一点、缩一点、淡出。放在最后，同权重靠后胜出，能压过出场动画 */
@keyframes ojj-bub-out{from{opacity:1;transform:translateY(0) scale(1)}
  to{opacity:0;transform:translateY(6px) scale(.94)}}
/* 她说话的时候气泡轻轻弹一下，别太闹 */
@keyframes ojj-bub-poke{0%{transform:scale(1)}40%{transform:scale(1.05)}100%{transform:scale(1)}}
[data-ojj-bubble][data-bface="poke"]{animation:ojj-bub-in .2s cubic-bezier(.2,1.4,.5,1), ojj-bub-poke .4s ease-out .2s;}
/* 一对斜三角，拼出鲸尾的样子 */
[data-ojj-bubble]::before,
[data-ojj-bubble]::after{content:'';position:absolute;bottom:-8px;width:0;height:0;
  border-top:9px solid rgba(50,52,128,.94);}
[data-ojj-bubble]::before{left:50%;margin-left:-12px;
  border-left:10px solid transparent;border-right:2px solid transparent;}
[data-ojj-bubble]::after{left:50%;margin-left:1px;
  border-left:2px solid transparent;border-right:10px solid transparent;}

[data-ojj-bubble][data-bface="stuck"]{
  background:linear-gradient(155deg,rgba(154,72,20,.94) 0%,rgba(120,53,15,.94) 100%);
  border-color:rgba(251,191,36,.32);}
[data-ojj-bubble][data-bface="stuck"]::before,
[data-ojj-bubble][data-bface="stuck"]::after{border-top-color:rgba(120,53,15,.94);}
[data-ojj-bubble][data-bface="done"]{
  background:linear-gradient(155deg,rgba(6,120,86,.94) 0%,rgba(4,96,70,.94) 100%);
  border-color:rgba(110,231,183,.34);}
[data-ojj-bubble][data-bface="done"]::before,
[data-ojj-bubble][data-bface="done"]::after{border-top-color:rgba(4,96,70,.94);}
[data-ojj-bubble][data-bface="poke"]{
  background:linear-gradient(155deg,rgba(56,120,220,.95) 0%,rgba(67,56,202,.95) 100%);
  border-color:rgba(191,219,254,.4);}
[data-ojj-bubble][data-bface="poke"]::before,
[data-ojj-bubble][data-bface="poke"]::after{border-top-color:rgba(67,56,202,.95);}
/* 必须排在所有出场/配色规则之后：退场时不许再有别的动画抢 */
[data-ojj-bubble][data-leaving]{animation:ojj-bub-out .18s ease-in forwards;
  pointer-events:none;}
[data-ojj-b-name]{font-size:10px;line-height:13px;font-weight:500;opacity:.8;
  max-width:146px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-ojj-b-main]{font-size:12px;line-height:16px;font-weight:700;white-space:nowrap;
  font-variant-numeric:tabular-nums;}
[data-ojj-b-sub]{font-size:9px;line-height:12px;opacity:.7;white-space:nowrap;
  font-variant-numeric:tabular-nums;}
[data-ojj-bubble-bar]{position:absolute;left:1px;right:1px;bottom:1px;height:3px;
  border-radius:0 0 13px 13px;overflow:hidden;background:rgba(255,255,255,.18);}
[data-ojj-bubble-fill]{height:100%;background:#7dd3fc;transition:width .35s ease;}
[data-ojj-bubble][data-bface="done"] [data-ojj-bubble-fill]{background:#6ee7b7;}
[data-ojj-widget][data-indet] [data-ojj-bubble-fill]{
  width:34% !important;animation:ojj-slide 1.5s ease-in-out infinite;}
@keyframes ojj-slide{0%{transform:translateX(-130%)}100%{transform:translateX(330%)}}

/* 角色本体：就是一张图，别跟 background 较劲 */
[data-ojj-shell]{position:relative;width:168px;height:104px;display:flex;align-items:flex-end;justify-content:center;}
[data-ojj-face]{width:96px;height:104px;object-fit:contain;display:block;
  pointer-events:none;filter:drop-shadow(0 4px 8px rgba(0,0,0,.5));}

/* 单帧皮肤用 CSS 做呼吸：只上下浮，不转不歪 */
@keyframes ojj-idle{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes ojj-eat{0%{transform:translateY(0) scale(1,1)}28%{transform:translateY(3px) scale(1.04,.95)}
  58%{transform:translateY(-5px) scale(.97,1.04)}100%{transform:translateY(0) scale(1,1)}}
@keyframes ojj-stuck{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes ojj-done{0%{transform:translateY(0) scale(1)}35%{transform:translateY(-20px) scale(1.1)}
  65%{transform:translateY(0) scale(.95,1.06)}82%{transform:translateY(-5px) scale(1)}100%{transform:translateY(0) scale(1,1)}}

[data-ojj-widget][data-face="idle"] [data-ojj-face]{animation:ojj-idle 3.6s ease-in-out infinite;}
[data-ojj-widget][data-face="eating"] [data-ojj-face]{animation:ojj-eat .85s ease-in-out infinite;}
[data-ojj-widget][data-face="stuck"] [data-ojj-face]{animation:ojj-stuck .5s ease-in-out infinite;}
[data-ojj-widget][data-face="done"] [data-ojj-face]{animation:ojj-done .7s ease-out 1;}
[data-ojj-widget][data-face="poke"] [data-ojj-face]{animation:ojj-idle 2s ease-in-out infinite;}

[data-ojj-more]{position:absolute;top:0;right:2px;min-width:16px;height:16px;padding:0 4px;
  border-radius:8px;background:#3b82f6;color:#fff;font-size:10px;line-height:16px;text-align:center;
  box-sizing:border-box;box-shadow:0 1px 4px rgba(0,0,0,.35);}

[data-ojj-list]{position:absolute;left:50%;transform:translateX(-50%);top:calc(100% - 8px);
  min-width:156px;max-width:230px;box-sizing:border-box;padding:5px;
  border-radius:10px;background:rgba(18,22,30,.95);
  box-shadow:0 4px 14px rgba(0,0,0,.45);z-index:5;
  display:flex;flex-direction:column;gap:3px;}
[data-ojj-item]{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:6px;
  font-size:10px;line-height:14px;color:#e6edf3;}
[data-ojj-item][data-current]{background:rgba(59,130,246,.35);}
[data-ojj-item-name]{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.9;}
[data-ojj-item-pct]{flex:none;font-variant-numeric:tabular-nums;opacity:.72;}

/* 设置页 */
[data-ojj-set]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 10px;max-width:640px;}
[data-ojj-set-h]{font-size:11px;font-weight:600;letter-spacing:.04em;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
/* 每行放得下几张就放几张，放不下自动换行；卡片本身不许被挤变形 */
[data-ojj-grid]{display:flex;flex-wrap:wrap;align-content:flex-start;gap:10px;
  width:100%;box-sizing:border-box;}
[data-ojj-card]{flex:0 0 auto;width:104px;box-sizing:border-box;padding:8px 6px;border-radius:12px;cursor:pointer;
  display:flex;flex-direction:column;align-items:center;gap:4px;
  border:2px solid transparent;background:var(--dsw-alias-bg-hover,rgba(128,128,128,.1));
  transition:border-color .15s;}
[data-ojj-card]:hover{border-color:var(--dsw-alias-border-default,rgba(128,128,128,.4));}
[data-ojj-card][data-on]{border-color:#3b82f6;}
[data-ojj-card-img]{width:76px;height:82px;object-fit:contain;display:block;}
[data-ojj-card-name]{font-size:11px;line-height:14px;text-align:center;word-break:break-all;
  width:100%;max-height:28px;overflow:hidden;display:-webkit-box;
  -webkit-line-clamp:2;-webkit-box-orient:vertical;}
/* 网格里那张「加号」卡：虚线圈 + 圆里一个 + */
[data-ojj-card][data-ojj-add]{border:2px dashed var(--dsw-alias-border-default,rgba(128,128,128,.34));
  background:transparent;justify-content:center;min-height:118px;}
[data-ojj-card][data-ojj-add]:hover{border-color:#3b82f6;}
[data-ojj-add-circle]{width:44px;height:44px;border-radius:50%;box-sizing:border-box;
  display:flex;align-items:center;justify-content:center;
  font-size:22px;line-height:1;font-weight:300;user-select:none;
  border:2px solid var(--dsw-alias-border-default,rgba(128,128,128,.45));
  color:var(--dsw-alias-label-secondary,#b6c2cf);}
[data-ojj-card][data-ojj-add]:hover [data-ojj-add-circle]{border-color:#3b82f6;color:#3b82f6;}
/* 装了特别多套的时候别把整页撑到天边：超过三行半就在网格里滚，加号卡始终在最后 */
[data-ojj-grid][data-many]{max-height:360px;overflow-y:auto;padding-right:4px;}
[data-ojj-link]{font-size:11px;line-height:16px;cursor:pointer;color:#38bdf8;
  text-decoration:underline;text-underline-offset:2px;background:none;border:0;padding:0;}
[data-ojj-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-ojj-btn]{padding:6px 14px;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;
  color:inherit;border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.3));
  background:transparent;transition:background .15s;}
[data-ojj-btn]:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.12));}
[data-ojj-btn][disabled]{opacity:.5;cursor:default;}
[data-ojj-input]{flex:1;min-width:180px;max-width:340px;box-sizing:border-box;
  padding:6px 10px;border-radius:8px;font:inherit;font-size:12px;color:inherit;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.3));
  background:var(--dsw-alias-bg-base,transparent);}
[data-ojj-note][data-ojj-msg]{color:#38bdf8;}
/* 监控目录：一行一个路径，长的截断，右边一个叉 */
[data-ojj-dir]{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08));max-width:520px;box-sizing:border-box;}
[data-ojj-dir-path]{flex:1;min-width:0;font-size:11px;line-height:16px;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;}
[data-ojj-dir-tag]{margin-left:6px;font-size:10px;opacity:.6;direction:ltr;}
[data-ojj-dir-del]{flex:0 0 auto;width:20px;height:20px;padding:0;border:0;border-radius:50%;
  cursor:pointer;font-size:14px;line-height:1;color:inherit;background:transparent;opacity:.55;}
[data-ojj-dir-del]:hover{opacity:1;background:rgba(239,68,68,.18);color:#ef4444;}
[data-ojj-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}

@media (prefers-reduced-motion: reduce){
  [data-ojj-face]{animation:none !important;transform:none !important;}
  [data-ojj-widget][data-indet] [data-ojj-bubble-fill]{animation:none;width:100% !important;opacity:.5;}
}
`

    /* ───────────────── 取数 ───────────────── */

    function useStatus() {
      const [data, setData] = React.useState(null)
      const [alive, setAlive] = React.useState(true)
      React.useEffect(() => {
        let running = true
        let timer = null
        const tick = async () => {
          try {
            const res = await fetch(API + '/status', { credentials: 'same-origin' })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const json = await res.json()
            if (running) {
              setData(json && Array.isArray(json.jobs) ? json : null)
              setAlive(true)
            }
          } catch {
            if (running) setAlive(false)
          }
          if (running) timer = setTimeout(tick, POLL_MS)
        }
        tick()
        return () => {
          running = false
          if (timer) clearTimeout(timer)
        }
      }, [])
      return alive ? data : null
    }

    /* ───────────────── 位置记忆 ───────────────── */

    function readPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (raw) {
          const p = JSON.parse(raw)
          if (Number.isFinite(p && p.x) && Number.isFinite(p && p.y)) return p
        }
      } catch {
        /* 隐私模式 / 坏了：用默认 */
      }
      return null
    }

    function clampPos(x, y) {
      const maxX = Math.max(4, (window.innerWidth || 1280) - SIZE.w - 4)
      const maxY = Math.max(4, (window.innerHeight || 800) - SIZE.h - 4)
      return { x: Math.min(maxX, Math.max(4, x)), y: Math.min(maxY, Math.max(4, y)) }
    }

    function defaultPos() {
      const vw = window.innerWidth || 1280
      const vh = window.innerHeight || 800
      return clampPos(vw - SIZE.w - 40, vh - SIZE.h - 170)
    }

    /* ───────────────── 格式化 ───────────────── */

    function fmtDuration(sec) {
      const s = Math.max(0, Math.round(sec))
      if (s < 1) return '马上好'
      if (s < 60) return '剩 ' + s + ' 秒'
      const m = Math.floor(s / 60)
      if (m < 60) return '剩 ' + m + ' 分'
      return '剩 ' + Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分'
    }

    /* ───────────────── 她那张脸 ───────────────── */

    /** 拼资源地址：带上皮肤和版本号，换图之后浏览器一定会重新拉。 */
    function assetUrl(state, skin, ver) {
      const q = []
      if (skin) q.push('skin=' + encodeURIComponent(skin))
      if (ver) q.push('v=' + encodeURIComponent(ver))
      return API + '/asset/' + state + '.png' + (q.length ? '?' + q.join('&') : '')
    }

    function Face(props) {
      // 一张图一个字。poke 只是「让她动一下」，用的还是待机那张 —— 皮肤里没有第五张图
      const img = props.state === 'poke' ? 'idle' : props.state
      return h('img', {
        'data-ojj-face': '',
        src: assetUrl(img, props.skin, props.ver),
        alt: '',
        draggable: false,
      })
    }

    /* ───────────────── 挂件 ───────────────── */

    function Widget() {
      const data = useStatus()
      const [pos, setPos] = React.useState(() => readPos() || defaultPos())
      const [dragging, setDragging] = React.useState(false)
      const [hovering, setHovering] = React.useState(false)
      const [poking, setPoking] = React.useState(false)
      // 这一句是「戳下去那一刻」定下来的，之后轮询多少次都不许再变
      const [pokeLine, setPokeLine] = React.useState('')
      const drag = React.useRef(null)
      const pokeTimer = React.useRef(null)

      React.useEffect(() => () => {
        if (pokeTimer.current) clearTimeout(pokeTimer.current)
      }, [])

      // ── 气泡退场 ──
      // 不能一撤状态就把节点删掉，那样只有出场没有离场。
      // 做法：内容先冻在 ref 里，标记 out 播 .18s 动画，播完才真正摘掉。
      const bubbleSnap = React.useRef(null)
      const [bubblePhase, setBubblePhase] = React.useState('gone')

      const bubbleOn = Boolean(data && data.jobs && data.jobs.length) || poking

      React.useEffect(() => {
        if (bubbleOn) {
          setBubblePhase('in')
          return undefined
        }
        let alive = true
        setBubblePhase((prev) => (prev === 'gone' ? 'gone' : 'out'))
        const t = setTimeout(() => {
          if (alive) setBubblePhase('gone')
        }, BUBBLE_OUT_MS)
        return () => {
          alive = false
          clearTimeout(t)
        }
      }, [bubbleOn])

      const poke = () => {
        setPokeLine((prev) => {
          if (LINES.length < 2) return LINES[0] || ''
          let next = LINES[Math.floor(Math.random() * LINES.length)]
          if (next === prev) next = LINES[(LINES.indexOf(prev) + 1) % LINES.length]
          return next
        })
        setPoking(true)
        if (pokeTimer.current) clearTimeout(pokeTimer.current)
        pokeTimer.current = setTimeout(() => setPoking(false), POKE_MS)
      }

      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return
        drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, x0: e.clientX, y0: e.clientY, moved: false }
        setDragging(true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 老浏览器 */
        }
      }
      const onPointerMove = (e) => {
        const d = drag.current
        if (!d) return
        if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 4) d.moved = true
        // 没真的拖动就别动位置 —— 否则点一下手抖两像素，她会自己跳
        if (!d.moved) return
        setPos(clampPos(e.clientX - d.dx, e.clientY - d.dy))
      }
      const onPointerUp = () => {
        const d = drag.current
        if (!d) return
        drag.current = null
        setDragging(false)
        if (!d.moved) {
          poke() // 点一下就算戳她
          return
        }
        setPos((p) => {
          try {
            window.localStorage.setItem(POS_KEY, JSON.stringify(p))
          } catch {
            /* 存不下就算了 */
          }
          return p
        })
      }

      // 宿主没响应 → 什么都不画
      if (!data) return null
      // 用户在设置里把她藏起来了
      if (data.visible === false) return null

      const jobs = data.jobs || []
      const job = jobs[0] || null
      const extra = jobs.length - 1
      const done = Boolean(job) && job.state === 'done'
      const hasPercent = Boolean(job) && job.percent != null && Number.isFinite(job.percent)

      let faceState = 'idle'
      if (job) faceState = done ? 'done' : job.idleMs > 1600 ? 'stuck' : 'eating'
      if (poking) faceState = 'poke'

      // 气泡
      let nameLine = ''
      let mainLine = ''
      let subLine = ''
      if (poking) {
        mainLine = pokeLine || LINES[0]
      } else if (job) {
        nameLine = job.name
        if (done) {
          mainLine = '吃完啦'
        } else if (hasPercent && job.eta != null) {
          mainLine = job.percent.toFixed(0) + '% · ' + fmtDuration(job.eta)
        } else if (job.eta != null) {
          mainLine = fmtDuration(job.eta)
        } else if (job.speedText) {
          mainLine = job.speedText
        } else {
          mainLine = '下载中'
        }
        if (!done) {
          subLine = job.total
            ? job.bytesText + ' / ' + job.totalText
            : job.speedText && mainLine !== job.speedText
              ? job.speedText + ' · ' + job.bytesText
              : job.bytesText || ''
        }
      }
      const pct = hasPercent ? Math.max(2, Math.min(100, job.percent)) : 0
      const showBubble = Boolean(job) || poking

      // 气泡还开着就把当前内容存一份；退场时读这份，界面上的状态怎么变都不影响
      if (showBubble) {
        bubbleSnap.current = {
          faceState,
          nameLine,
          mainLine,
          subLine,
          pct,
          showBar: Boolean(job) && !done,
          width: done ? '100%' : pct + '%',
        }
      }
      const snap = showBubble
        ? bubbleSnap.current
        : bubblePhase === 'out'
          ? bubbleSnap.current
          : null
      const leaving = !showBubble && bubblePhase === 'out'

      return h(
        'div',
        {
          'data-ojj-widget': '',
          'data-face': faceState,
          'data-indet': job && !hasPercent && !done ? '' : undefined,
          'data-dragging': dragging ? '' : undefined,
          style: { left: pos.x + 'px', top: pos.y + 'px' },
          title: job
            ? job.name + '\n' + (job.dir || '') + (job.total ? '\n总大小 ' + job.totalText : '\n总量未知')
            : '欧鲸鲸：暂时没有下载（点我一下试试）',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onMouseEnter: () => setHovering(true),
          onMouseLeave: () => setHovering(false),
        },
        snap
          ? h(
              'div',
              {
                'data-ojj-bubble': '',
                'data-bface': snap.faceState,
                'data-leaving': leaving ? '' : undefined,
                key: 'b|' + snap.faceState + '|' + snap.mainLine,
              },
              snap.nameLine ? h('div', { 'data-ojj-b-name': '' }, snap.nameLine) : null,
              h('div', { 'data-ojj-b-main': '' }, snap.mainLine),
              snap.subLine ? h('div', { 'data-ojj-b-sub': '' }, snap.subLine) : null,
              h(
                'div',
                { 'data-ojj-bubble-bar': '', style: snap.showBar ? undefined : { opacity: 0 } },
                h('div', {
                  'data-ojj-bubble-fill': '',
                  style: { width: snap.width },
                }),
              ),
            )
          : null,
        h(
          'div',
          { 'data-ojj-shell': '' },
          h(Face, { state: faceState, skin: data.skin, ver: data.assetVersion }),
          extra > 0 ? h('div', { 'data-ojj-more': '' }, '+' + extra) : null,
          extra > 0 && hovering
            ? h(
                'div',
                { 'data-ojj-list': '' },
                jobs.map((j, i) =>
                  h(
                    'div',
                    {
                      'data-ojj-item': '',
                      'data-current': i === 0 ? '' : undefined,
                      key: j.id || String(i),
                    },
                    h('span', { 'data-ojj-item-name': '' }, j.name),
                    h(
                      'span',
                      { 'data-ojj-item-pct': '' },
                      j.state === 'done' ? '✓' : j.percent != null ? j.percent.toFixed(0) + '%' : j.speedText || '…',
                    ),
                  ),
                ),
              )
            : null,
        ),
      )
    }

    /* ───────────────── 设置页：选皮肤 ───────────────── */

    /** 由 apply 注入：当前宿主支不支持弹目录选择器 */
    let pickDirImpl = null

    function SettingsPage() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [manual, setManual] = React.useState('')
      const [showManual, setShowManual] = React.useState(false)
      const [dirMsg, setDirMsg] = React.useState('')
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(API + '/status', { credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const json = await res.json()
          if (alive.current) setState(json)
        } catch {
          if (alive.current) setState({ skins: [], skin: '', visible: true })
        }
      }, [])
      React.useEffect(() => { load() }, [load])

      const save = async (patch) => {
        if (busy) return
        setBusy(true)
        try {
          await fetch(API + '/settings', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          await load()
        } catch {
          /* 失败就保持原样 */
        }
        if (alive.current) setBusy(false)
      }

      const addSkin = async (dir) => {
        const path = String(dir || '').trim()
        if (!path) return
        setBusy(true)
        setMsg('')
        try {
          const res = await fetch(API + '/addskin', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: path }),
          })
          const json = await res.json().catch(() => ({}))
          if (res.ok && json.ok) {
            if (alive.current) setMsg('装好了：' + json.id)
            setManual('')
            await load()
          } else if (alive.current) {
            setMsg('没装成：' + (json.error || 'HTTP ' + res.status))
          }
        } catch (e) {
          if (alive.current) setMsg('没装成：' + (e && e.message ? e.message : '网络错误'))
        }
        if (alive.current) setBusy(false)
      }

      const pickAndAdd = async () => {
        if (busy) return
        if (typeof pickDirImpl !== 'function') {
          if (alive.current) setMsg('这个版本不支持弹文件夹选择器，直接填路径吧')
          return
        }
        setBusy(true)
        let dir = null
        try {
          dir = await pickDirImpl()
        } catch {
          dir = null
        }
        if (alive.current) setBusy(false)
        if (dir) addSkin(dir)
      }

      const skins = (state && state.skins) || []
      const current = (state && state.skin) || ''
      const visible = !state || state.visible !== false
      const customDirs = (state && Array.isArray(state.customWatchDirs) ? state.customWatchDirs : [])
      const dirs = (state && Array.isArray(state.watchDirs) ? state.watchDirs : [])

      const pickAndWatch = async () => {
        if (busy) return
        if (typeof pickDirImpl !== 'function') {
          if (alive.current) setDirMsg('这个版本不支持弹文件夹选择器，去改 cordis.patch.yml 里的 watchDirs')
          return
        }
        let dir = null
        try {
          dir = await pickDirImpl()
        } catch {
          dir = null
        }
        if (!dir) return
        if (customDirs.includes(dir)) {
          if (alive.current) setDirMsg('已经盯着这个了')
          return
        }
        await save({ watchDirs: customDirs.concat([dir]) })
      }

      return h(
        'div',
        { 'data-ojj-set': '' },
        h('div', { 'data-ojj-set-h': '' }, '形象'),
        h(
          'div',
          { 'data-ojj-grid': '', 'data-many': skins.length > 10 ? '' : undefined },
          skins.map((s) =>
            h(
              'div',
              {
                'data-ojj-card': '',
                'data-on': s.id === current ? '' : undefined,
                key: s.id,
                onClick: () => save({ skin: s.id }),
                title: s.id,
              },
              h('img', {
                'data-ojj-card-img': '',
                src: assetUrl('idle', s.id, state && state.assetVersion),
                alt: '',
                draggable: false,
              }),
              h('div', { 'data-ojj-card-name': '' }, s.id),
            ),
          ),
          // 最后一张是「加号」卡，跟皮肤卡并排
          h(
            'div',
            {
              'data-ojj-card': '',
              'data-ojj-add': '',
              key: '__add__',
              onClick: () => (busy ? null : pickAndAdd()),
              title: '添加自己的形象',
            },
            h('div', { 'data-ojj-add-circle': '' }, '+'),
            h('div', { 'data-ojj-card-name': '' }, '添加'),
          ),
        ),
        h(
          'div',
          { 'data-ojj-row': '' },
          h(
            'button',
            { 'data-ojj-btn': '', onClick: () => save({ visible: !visible }), disabled: busy },
            visible ? '隐藏她' : '让她出来',
          ),
          h('button', { 'data-ojj-btn': '', onClick: () => load(), disabled: busy }, '刷新'),
        ),
        h(
          'div',
          { 'data-ojj-note': '' },
          '四张图就是她的四种状态，文件名必须对上：',
        ),
        h(
          'div',
          { 'data-ojj-note': '' },
          'eating（正在下载，扒饭）· idle（没下载，站着打盹）· stuck（卡住了，皱眉）· done（下完了，打饱嗝）',
        ),
        h(
          'div',
          { 'data-ojj-note': '' },
          '放进同一个文件夹就行，.png 或 .webp，透明底最好。她会出现上面那一排里。',
        ),
        h(
          'div',
          { 'data-ojj-row': '' },
          h(
            'button',
            { 'data-ojj-link': '', onClick: () => setShowManual((v) => !v), disabled: busy },
            showManual ? '收起手动输入' : '没有目录选择器？手动填路径',
          ),
          msg ? h('div', { 'data-ojj-note': '', 'data-ojj-msg': '' }, msg) : null,
        ),
        showManual
          ? h(
              'div',
              { 'data-ojj-row': '' },
              h('input', {
                'data-ojj-input': '',
                type: 'text',
                value: manual,
                placeholder: '粘贴装着那四张图的文件夹路径',
                onChange: (e) => setManual(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') addSkin(manual)
                },
              }),
              h(
                'button',
                { 'data-ojj-btn': '', onClick: () => addSkin(manual), disabled: busy || !manual.trim() },
                '添加',
              ),
            )
          : null,
        h(
          'div',
          { 'data-ojj-note': '' },
          '选中的那套和显隐状态记在 ~/.dsh/oujingjing-progress/settings.json，改 cordis.patch.yml 里的 skin 也能设默认值。',
        ),
        h(
          'div',
          { 'data-ojj-note': '' },
          '想加自己的：在 assets/ 下新建一个目录，放 eating / idle / stuck / done 四张同尺寸透明底图，点「刷新」就能看到。',
        ),

        /* ── 监控目录 ── */
        h('div', { 'data-ojj-set-h': '' }, '盯着哪些文件夹'),
        h(
          'div',
          { 'data-ojj-note': '' },
          '她只看这些文件夹里「最近被写过」的文件，不认下载器 —— curl、浏览器、aria2、自己写的脚本都算。',
        ),
        // customDirs 是纯字符串数组，先统一成 {path, fallback} 再渲染
        (customDirs.length
          ? customDirs.map((p) => ({ path: p, fallback: false }))
          : [{ path: dirs[0] || '', fallback: true }]
        ).map((d) =>
          h(
            'div',
            { 'data-ojj-dir': '', key: 'd|' + (d.path || '#fallback') },
            h(
              'span',
              { 'data-ojj-dir-path': '', title: d.path || '' },
              d.path || '（当前会话目录）',
              d.fallback ? h('span', { 'data-ojj-dir-tag': '' }, '默认') : null,
            ),
            d.fallback
              ? null
              : h(
                  'button',
                  {
                    'data-ojj-dir-del': '',
                    disabled: busy,
                    title: '不再盯着这个文件夹',
                    onClick: () => save({ watchDirs: customDirs.filter((x) => x !== d.path) }),
                  },
                  '×',
                ),
          ),
        ),
        h(
          'div',
          { 'data-ojj-row': '' },
          h(
            'button',
            { 'data-ojj-btn': '', onClick: pickAndWatch, disabled: busy },
            '选择文件夹…',
          ),
          h(
            'button',
            {
              'data-ojj-btn': '',
              disabled: busy || !customDirs.length,
              onClick: () => save({ watchDirs: [] }),
              title: '清空后回到默认：只看当前会话目录',
            },
            '清空',
          ),
        ),
        dirMsg ? h('div', { 'data-ojj-note': '', 'data-ojj-msg': '' }, dirMsg) : null,
      )
    }

    /* ───────────────── 挂载 ───────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式注入：宿主没有 head（极端情况）也不许炸
        try {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-oujingjing-progress')
          style.textContent = CSS
          document.head.appendChild(style)
          ctx.effect(() => () => style.remove(), 'dsh-oujingjing-progress: 样式')
        } catch {
          /* 样式挂了也让下面的逻辑照跑 */
        }

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || typeof slots.inject !== 'function') return

        // 有没有「弹文件夹选择器」的能力，交给宿主决定；没有就只留手填路径
        try {
          const ws = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          if (ws && typeof ws.pickDirectory === 'function') {
            pickDirImpl = () => ws.pickDirectory()
          }
        } catch {
          /* 没有就算了 */
        }

        // 两个座位各自独立：设置页注册失败，绝不许连累挂件
        const seat = (name, opts, component, label) => {
          try {
            slots.inject(name, () => slots.register(opts, component))
          } catch {
            /* 这个座位不在了就算了，别的继续 */
          }
        }

        seat(
          'shell.overlay',
          { name: 'shell.overlay', id: 'oujingjing-progress', order: 40 },
          Widget,
          '浮层',
        )
        seat(
          'settings.section',
          { name: 'settings.section', id: 'oujingjing-progress', order: 36, label: '鲸鲸进度条' },
          SettingsPage,
          '设置页',
        )
      },
    }
  },
})
