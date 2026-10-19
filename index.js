/**
 * dsh-remember-approval —— 让同一会话里“已经批准过的”审批请求不再重复询问。
 *
 * 背景：DSH 的审批接缝（@deepseek-ai/dsh-user-approval）只有一次性授权
 * （`allowed-once` / `rejected` / `cancelled` / `unavailable`），官方明确没有
 * allow-always、记住规则或授权存储；会话策略也只有 `ask` / `never`。所以
 * 只要沙箱拦一次，之后同类操作仍会逐个弹窗。
 *
 * 本插件占用官方两条接缝里的一条：`approval/request` 瀑布（应答者）。
 * 它在瀑布最前面挂一个 listener：
 *
 *   1. 命中记忆（同一会话 + 同一工具 + 同一动作前缀）→ 直接返回 `allowed-once`，
 *      不弹窗、不等待；
 *   2. 未命中 → `next()` 交给下游（人工 UI / IM / auto-review），
 *      拿到结果；若结果是 `allowed-once`，把这条键记下来。
 *
 * 也就是说：你亲手批准过一次的那类请求，本会话内不再问你；你拒绝过的不会
 * 被记住（下次仍然问），abort / unavailable 同样不记。
 *
 * 粒度说明：审批请求本身不带工具参数（官方限制：answerer 只看得到工具名、
 * reason、可选 callId）。而 reason 的实际形态是「动作前缀: 模型每次现写的
 * 理由」，理由正文每次都不一样，所以记忆键只取冒号前的动作前缀（例如
 * "escalate sandbox to danger-full-access"），正文不参与——这是真机验证后
 * 修正过的地方。同一条前缀覆盖的后续请求会一起放行，这也意味着一次误批会让
 * 同类请求一路通行。`skipTools` 与 `neverRemember` 用来兜底。
 */

export const name = 'remember-approval'

/** 只监听 `approval/request` 事件，不需要注入任何服务；会话 id 从事件参数里取。 */
export const inject = []

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEY_SEP = '\u0000'

/**
 * 调试日志默认写到系统临时目录：那里一定可写，也不污染用户的工作区。
 * 需要固定位置时用 config.debugLogPath 指定。
 */
const DEFAULT_DEBUG_LOG = path.join(os.tmpdir(), 'dsh-remember-approval.debug.log')

let DEBUG = false
let DEBUG_LOG = DEFAULT_DEBUG_LOG

function debugLog(line) {
  if (!DEBUG) return
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 调试日志失败绝不能影响审批流程
  }
}

/**
 * 默认不记忆任何“没有理由”的请求：reason 为空时无法区分同类请求，
 * 记住它等于“这个工具以后随便用”，风险太高。需要时用
 * `rememberEmptyReason: true` 显式打开。
 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    enabled: raw.enabled !== false,
    rememberEmptyReason: raw.rememberEmptyReason === true,
    // 本会话内最多记多少条键，防止长时间会话无限增长（超出按插入顺序淘汰）。
    maxKeysPerSession: Number.isInteger(raw.maxKeysPerSession) && raw.maxKeysPerSession > 0
      ? raw.maxKeysPerSession
      : 200,
    // 最多跟踪多少个会话，防止会话反复新建导致 Map 增长。
    maxSessions: Number.isInteger(raw.maxSessions) && raw.maxSessions > 0
      ? raw.maxSessions
      : 64,
    // 这些工具永远不记忆（每次仍然人工确认）。
    skipTools: Array.isArray(raw.skipTools)
      ? raw.skipTools.filter((value) => typeof value === 'string' && value.length > 0)
      : [],
    // 只有「下游真的停下来等人」超过这个毫秒数，才把 allowed-once 记成人工授权。
    // 用来挡住另一类应答者（如 auto-review）的秒批——否则自动批准会被误记成
    // “人批过”，之后同类请求就会被无声放行。设为 0 关闭该判断。
    minHumanDelayMs: Number.isFinite(raw.minHumanDelayMs) && raw.minHumanDelayMs >= 0
      ? raw.minHumanDelayMs
      : 200,
    // reason 命中这些正则的请求永远不记忆（例如升权到完全访问、涉及删除等）。
    // 用字符串写正则，加载期校验，写错就跳过该条并打日志，不会静默放行。
    neverRemember: Array.isArray(raw.neverRemember)
      ? raw.neverRemember
        .map((pattern) => {
          try {
            return new RegExp(pattern, 'i')
          } catch (error) {
            console.warn(`[remember-approval] 无效的 neverRemember 正则已忽略: ${String(pattern)} (${error?.message ?? error})`)
            return null
          }
        })
        .filter(Boolean)
      : [],
    log: raw.log !== false,
    // 是否把每次审批的调用 / reason / 命中情况追加到日志；默认关闭，
    // 排查问题（比如“为什么没记住”）时再打开。
    debug: raw.debug === true,
    // 调试日志路径；默认系统临时目录，仅在 debug=true 时才会写。
    debugLogPath: typeof raw.debugLogPath === 'string' && raw.debugLogPath.length > 0
      ? raw.debugLogPath
      : DEFAULT_DEBUG_LOG,
  }
}

function sessionIdOf(request) {
  const session = request?.agent?.session
  const id = session?.id ?? request?.agent?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * 把审批 reason 归一化成「动作前缀」。
 *
 * 实测 reason 的格式是 `escalate sandbox to danger-full-access: <reason>`，
 * 冒号后面是模型每次现写的理由文本。如果把整条 reason 当记忆键，每次理由
 * 措辞不同就永远对不上——这正是插件最初“看起来没生效”的真实原因。
 * 因此只取冒号前的动作前缀；没有冒号时退回全文。
 */
function reasonScope(reason) {
  const idx = reason.indexOf(':')
  if (idx > 0) {
    const head = reason.slice(0, idx).trim()
    if (head) return head
  }
  return reason
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)
  DEBUG = options.debug
  DEBUG_LOG = options.debugLogPath
  debugLog(`apply enabled=${options.enabled} minHumanDelayMs=${options.minHumanDelayMs} skipTools=${JSON.stringify(options.skipTools)}`)

  if (!options.enabled) {
    if (options.log) console.info('[remember-approval] 已禁用（config.enabled=false），审批行为保持原样')
    return
  }

  /** sessionId -> Set<key>，插入顺序即淘汰顺序 */
  const grants = new Map()

  const remember = (sessionId, key) => {
    let keys = grants.get(sessionId)
    if (!keys) {
      keys = new Set()
      grants.set(sessionId, keys)
      if (grants.size > options.maxSessions) {
        const oldest = grants.keys().next().value
        if (oldest !== undefined) grants.delete(oldest)
      }
    }
    keys.add(key)
    if (keys.size > options.maxKeysPerSession) {
      const first = keys.values().next().value
      if (first !== undefined) keys.delete(first)
    }
  }

  ctx.on('approval/request', async (request, next) => {
    try {
      const sessionId = sessionIdOf(request)
      const tool = typeof request?.toolName === 'string' ? request.toolName : ''
      if (!sessionId || !tool) return next()

      if (request.signal?.aborted) return 'cancelled'
      if (options.skipTools.includes(tool)) return next()

      const reason = typeof request?.reason === 'string' ? request.reason.trim() : ''
      if (!reason && !options.rememberEmptyReason) return next()
      if (reason && options.neverRemember.some((re) => re.test(reason))) return next()

      // 记忆键只取「动作前缀」：reason 冒号后面是模型每次现写的理由，措辞天然
      // 不同，整条进键会让同类请求永远对不上（实测就是这个原因）。
      const scope = reasonScope(reason)
      const key = `${tool}${KEY_SEP}${scope}`

      if (grants.get(sessionId)?.has(key)) {
        debugLog(`HIT tool=${tool} scope=${JSON.stringify(scope)} reason=${JSON.stringify(reason).slice(0, 400)}`)
        if (options.log) {
          console.info(`[remember-approval] 已记住，直接放行: ${tool} ← ${reason || '(空理由)'}`)
        }
        return 'allowed-once'
      }

      debugLog(`IN  tool=${tool} scope=${JSON.stringify(scope)} reason=${JSON.stringify(reason).slice(0, 400)}`)
      const startedAt = Date.now()
      const outcome = await next()
      const elapsedMs = Date.now() - startedAt
      debugLog(`OUT tool=${tool} outcome=${String(outcome)} elapsed=${elapsedMs}ms`)

      // 只记住“这次真的被人批准了”的结果。拒绝、取消、不可用都不记，
      // 以免一次误拒或一次超时把后续请求静默放行。
      // elapsedMs 门槛用于排除自动批准者（秒批），避免把模型判断记成人批。
      if (outcome === 'allowed-once' && elapsedMs >= options.minHumanDelayMs) {
        remember(sessionId, key)
        if (options.log) {
          console.info(`[remember-approval] 记下本次授权（人工确认 ${elapsedMs}ms）: ${tool} ← ${reason || '(空理由)'}`)
        }
      } else if (outcome === 'allowed-once' && options.log) {
        console.info(`[remember-approval] 下游 ${elapsedMs}ms 就放行了，判定为自动批准，不记忆: ${tool}`)
      }
      return outcome
    } catch (error) {
      // 记忆层绝不能把异常吞成一次“静默放行”，也不能再调一次 next() 造成
      // 二次消费（重复弹窗 / 对已 settle 的请求重复应答）。原样抛给审批服务，
      // 由它按 unavailable 处理，属于 fail closed。
      console.warn(`[remember-approval] 处理审批请求失败，交给审批服务处理: ${error?.message ?? error}`)
      throw error
    }
  }, { global: true, prepend: true })

  if (options.log) {
    console.info('[remember-approval] 已启用：同一会话内，已批准过的「工具+动作前缀」不再重复询问')
  }
}
