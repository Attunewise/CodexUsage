const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  estimateCost,
  normalizeUsage,
  scanSessionFile,
  usageFromTokenInfo
} = require('../scripts/codex_usage.js')

const script = path.join(__dirname, '..', 'scripts', 'codex_usage.js')

const writeJsonl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
}

const fixtureCatalog = {
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-test': {
        id: 'gpt-test',
        cost: { input: 1, output: 10, cache_read: 0.1, reasoning: 15 }
      },
      'gpt-other': {
        id: 'gpt-other',
        cost: { input: 2, output: 20 }
      }
    }
  }
}

test('normalizes Codex token_count usage shapes', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 30,
    output_tokens: 12,
    reasoning_output_tokens: 4,
    total_tokens: 112
  }), {
    input_tokens: 100,
    cached_input_tokens: 30,
    cache_write_input_tokens: 0,
    output_tokens: 12,
    reasoning_output_tokens: 4,
    unallocated_tokens: 0,
    total_tokens: 112
  })

  assert.equal(usageFromTokenInfo({
    total_token_usage: { input_tokens: 120, output_tokens: 10, total_tokens: 130 }
  }, {
    input_tokens: 100,
    output_tokens: 6,
    total_tokens: 106
  }).input_tokens, 20)
})

test('scans a session and attributes last usage to active model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-session-'))
  const file = path.join(root, '2026', '06', '05', 'rollout-test.jsonl')
  writeJsonl(file, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 's1', cwd: '/tmp/a', model_provider: 'openai' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-test' } },
    { timestamp: '2026-06-05T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 } } } },
    { timestamp: '2026-07-01T00:00:03.000Z', type: 'turn_context', payload: { model: 'gpt-other' } },
    { timestamp: '2026-07-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } } } }
  ])

  const result = scanSessionFile(file)
  assert.equal(result.sessionId, 's1')
  assert.equal(result.tokenCountEvents, 2)
  assert.deepEqual(result.byModel.map(item => item.model).sort(), ['gpt-other', 'gpt-test'])
  assert.deepEqual(result.byModel.flatMap(item => item.byMonth.map(month => month.month)).sort(), ['2026-06', '2026-07'])
})

test('cost estimate handles cache reads and separate reasoning rates', () => {
  const cost = estimateCost({
    pricing: { cost: { input: 1, output: 10, cache_read: 0.1, reasoning: 15 } },
    usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }
  })
  assert.equal(cost.breakdown.input.tokens, 80)
  assert.equal(cost.breakdown.output.tokens, 8)
  assert.equal(cost.breakdown.reasoning.tokens, 2)
  assert.equal(cost.breakdown.unallocated.tokens, 0)
  assert.ok(cost.total_cost_usd > 0)
})

test('CLI aggregates usage, prices it, and reuses session cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-cli-'))
  const sessionsRoot = path.join(root, 'sessions')
  const cacheDir = path.join(root, 'cache')
  const catalogFile = path.join(root, 'models.json')
  fs.writeFileSync(catalogFile, `${JSON.stringify(fixtureCatalog, null, 2)}\n`)
  writeJsonl(path.join(sessionsRoot, '2026', '06', '05', 'rollout-a.jsonl'), [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'a', model_provider: 'openai' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-test' } },
    { timestamp: '2026-06-05T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 } } } },
    { timestamp: '2026-07-01T00:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 25, output_tokens: 3, total_tokens: 28 } } } }
  ])

  const run = () => JSON.parse(childProcess.execFileSync(process.execPath, [
    script,
    '--sessions-root', sessionsRoot,
    '--cache-dir', cacheDir,
    '--pricing-file', catalogFile,
    '--json'
  ], { encoding: 'utf8' }))

  const first = run()
  assert.equal(first.cache.scanned, 1)
  assert.equal(first.byModel[0].model, 'gpt-test')
  assert.equal(first.byModel[0].usage.input_tokens, 125)
  assert.deepEqual(first.byMonth.map(item => item.month), ['2026-06', '2026-07'])
  assert.ok(first.totalCostUsd > 0)

  const second = run()
  assert.equal(second.cache.scanned, 0)
  assert.equal(second.cache.reusedFromCache, 1)

  const markdown = childProcess.execFileSync(process.execPath, [
    script,
    '--sessions-root', sessionsRoot,
    '--cache-dir', cacheDir,
    '--pricing-file', catalogFile
  ], { encoding: 'utf8' })
  assert.match(markdown, /## By Model/)
  assert.match(markdown, /\| Model \| Sessions \| Events \|/)
  assert.match(markdown, /## By Month/)
  assert.match(markdown, /\| Month \| Sessions \| Models \|/)
  assert.match(markdown, /\| 2026-07 \|/)
})
