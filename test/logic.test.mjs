/**
 * 纯逻辑测试：不依赖 DSH、不需要安装插件、不需要启动任何进程。
 * 只需要 Node >= 18（DSH 要求 Node 22，所以一定有）。
 *
 *   node --test test/logic.test.mjs
 *   # 或
 *   node test/logic.test.mjs
 *
 * 它把 cordis 的 ctx 和审批瀑布 next() 都模拟掉，直接验证“记忆”本身：
 * 什么该放行、什么该继续问、什么不该被记住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 抓取 apply() 注册的 listener，模拟 cordis ctx。 */
function install(config = {}) {
  let handler = null
  const ctx = {
    on(event, listener) {
      assert.equal(event, 'approval/request', '应当只注册 approval/request')
      assert.equal(handler, null, '不应当注册多个 listener')
      handler = listener
    },
  }
  apply(ctx, { log: false, ...config })
  assert.equal(typeof handler, 'function', 'apply() 必须注册一个 listener')
  return handler
}

/** 构造一个审批请求；request 字段依据官方 @deepseek-ai/dsh-user-approval 的接口。 */
function requestOf({ sessionId = 's1', tool = 'pwsh', reason = 'sandbox escalation', aborted = false } = {}) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    agent: { session: { id: sessionId } },
    toolName: tool,
    reason,
    signal: controller.signal,
    displayReason: reason,
    callId: 'call-1',
  }
}

/** 下游应答者：延迟 ms 之后返回 outcome，并记录被调用次数。 */
function downstream(outcome, ms = 0) {
  const fn = async () => {
    fn.calls += 1
    if (ms > 0) await sleep(ms)
    return outcome
  }
  fn.calls = 0
  return fn
}

test('第一次：交给下游，并按“人工批准”的记忆键记住', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  const next = downstream('allowed-once')
  const outcome = await handler(requestOf(), next)

  assert.equal(outcome, 'allowed-once')
  assert.equal(next.calls, 1, '第一次必须询问下游')
})

test('第二次同会话同工具同理由：不再询问，直接放行', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(requestOf(), downstream('allowed-once'))

  const next = downstream('allowed-once')
  const outcome = await handler(requestOf(), next)

  assert.equal(outcome, 'allowed-once')
  assert.equal(next.calls, 0, '第二次不应再打扰下游（人）')
})

test('理由不同：仍然询问', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(requestOf({ reason: 'sandbox escalation' }), downstream('allowed-once'))

  const next = downstream('allowed-once')
  await handler(requestOf({ reason: 'network access' }), next)
  assert.equal(next.calls, 1)
})

test('动作前缀相同、理由正文不同：命中（真实审批 reason 的形态）', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(
    requestOf({ reason: 'escalate sandbox to danger-full-access: 第一次的理由' }),
    downstream('allowed-once'),
  )

  const next = downstream('allowed-once')
  const outcome = await handler(
    requestOf({ reason: 'escalate sandbox to danger-full-access: 完全不同的另一段理由' }),
    next,
  )
  assert.equal(outcome, 'allowed-once')
  assert.equal(next.calls, 0, '冒号后的理由正文不应影响命中')
})

test('动作前缀相同、工具不同：仍然询问', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(
    requestOf({ tool: 'pwsh', reason: 'escalate sandbox: 一次批准' }),
    downstream('allowed-once'),
  )

  const next = downstream('allowed-once')
  await handler(requestOf({ tool: 'write', reason: 'escalate sandbox: 另一次' }), next)
  assert.equal(next.calls, 1, '工具名仍然参与记忆键')
})

test('工具不同：仍然询问', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(requestOf({ tool: 'pwsh' }), downstream('allowed-once'))

  const next = downstream('allowed-once')
  await handler(requestOf({ tool: 'write' }), next)
  assert.equal(next.calls, 1)
})

test('会话不同：不继承记忆', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(requestOf({ sessionId: 's1' }), downstream('allowed-once'))

  const next = downstream('allowed-once')
  await handler(requestOf({ sessionId: 's2' }), next)
  assert.equal(next.calls, 1)
})

test('被拒绝：不记忆，下次仍然问', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(requestOf(), downstream('rejected'))

  const next = downstream('allowed-once')
  await handler(requestOf(), next)
  assert.equal(next.calls, 1, '拒绝过的不应被记住')
})

test('取消：不记忆', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(requestOf(), downstream('cancelled'))

  const next = downstream('allowed-once')
  await handler(requestOf(), next)
  assert.equal(next.calls, 1)
})

test('秒批（自动批准）：不记成人批', async () => {
  // 下游 0ms 就返回 allowed-once，说明不是人点的，默认 minHumanDelayMs=200 应拒记
  const handler = install()
  await handler(requestOf(), downstream('allowed-once', 0))

  const next = downstream('allowed-once')
  await handler(requestOf(), next)
  assert.equal(next.calls, 1, '自动批准不应被记忆')
})

test('人工批准（慢）：超过阈值才记忆', async () => {
  const handler = install({ minHumanDelayMs: 20 })
  await handler(requestOf(), downstream('allowed-once', 40))

  const next = downstream('allowed-once')
  await handler(requestOf(), next)
  assert.equal(next.calls, 0)
})

test('空理由：默认不记忆', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  await handler(requestOf({ reason: '' }), downstream('allowed-once'))

  const next = downstream('allowed-once')
  await handler(requestOf({ reason: '' }), next)
  assert.equal(next.calls, 1, '空理由等于“这个工具随便用”，默认不放行')
})

test('rememberEmptyReason: true 时才允许记忆空理由', async () => {
  const handler = install({ minHumanDelayMs: 0, rememberEmptyReason: true })
  await handler(requestOf({ reason: '' }), downstream('allowed-once'))

  const next = downstream('allowed-once')
  await handler(requestOf({ reason: '' }), next)
  assert.equal(next.calls, 0)
})

test('skipTools：永不记忆', async () => {
  const handler = install({ minHumanDelayMs: 0, skipTools: ['pwsh'] })
  await handler(requestOf({ tool: 'pwsh' }), downstream('allowed-once'))

  const next = downstream('allowed-once')
  await handler(requestOf({ tool: 'pwsh' }), next)
  assert.equal(next.calls, 1)
})

test('neverRemember：reason 命中正则则永不记忆', async () => {
  const handler = install({ minHumanDelayMs: 0, neverRemember: ['full-access|danger'] })
  await handler(requestOf({ reason: 'escalate to danger-full-access' }), downstream('allowed-once'))

  const next = downstream('allowed-once')
  await handler(requestOf({ reason: 'escalate to danger-full-access' }), next)
  assert.equal(next.calls, 1)
})

test('请求已 abort：返回 cancelled，不询问', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  const next = downstream('allowed-once')
  const outcome = await handler(requestOf({ aborted: true }), next)

  assert.equal(outcome, 'cancelled')
  assert.equal(next.calls, 0)
})

test('下游抛错不会被吞：错误向上抛，且不误记', async () => {
  const handler = install({ minHumanDelayMs: 0 })
  let calls = 0
  const boom = async () => {
    calls += 1
    throw new Error('downstream exploded')
  }

  await assert.rejects(() => handler(requestOf(), boom), /downstream exploded/)

  // 关键：错误路径下如果又调用一次 next 会造成二次消费，这里只允许一次
  assert.equal(calls, 1)
})
