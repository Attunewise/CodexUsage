#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')

const MODELS_DEV_API_URL = 'https://models.dev/api.json'
const CACHE_SCHEMA = 'codex-usage.cache.v2'
const REPORT_SCHEMA = 'codex-usage.report.v1'
const PRICING_TTL_MS = 24 * 60 * 60 * 1000
const USD_PER_TOKEN_UNIT = 1_000_000
const DEFAULT_SKILL_NAME = 'codex-usage'
const SKILL_PACKAGE_ENTRIES = ['SKILL.md', 'README.md', 'package.json', 'agents', 'scripts']

const skillRoot = path.resolve(__dirname, '..')
const defaultCacheDir = path.join(skillRoot, '.cache')

const expandHome = value => String(value || '').replace(/^~(?=$|\/)/, os.homedir())

const usageZero = () => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  unallocated_tokens: 0,
  total_tokens: 0
})

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0

const normalizeUsage = value => {
  const raw = value || {}
  const details = raw.input_tokens_details || raw.prompt_tokens_details || {}
  const outputDetails = raw.output_tokens_details || raw.completion_tokens_details || {}
  const input = number(raw.input_tokens ?? raw.prompt_tokens ?? raw.input)
  const output = number(raw.output_tokens ?? raw.completion_tokens ?? raw.output)
  const cached = number(raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? details.cached_tokens ?? raw.cache_read)
  const cacheWrite = number(raw.cache_write_input_tokens ?? raw.cache_creation_input_tokens ?? raw.prefill_write_tokens ?? raw.cache_write)
  const reasoning = number(raw.reasoning_output_tokens ?? outputDetails.reasoning_tokens ?? raw.reasoning)
  const total = number(raw.total_tokens ?? raw.total ?? input + output)
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    unallocated_tokens: number(raw.unallocated_tokens ?? Math.max(0, total - input - output)),
    total_tokens: total
  }
}

const addUsage = (...items) => items.reduce((out, item) => {
  const usage = normalizeUsage(item)
  for (const key of Object.keys(out)) out[key] += usage[key]
  return out
}, usageZero())

const diffUsage = (current, previous) => {
  const a = normalizeUsage(current)
  const b = normalizeUsage(previous)
  const out = usageZero()
  for (const key of Object.keys(out)) out[key] = Math.max(0, a[key] - b[key])
  return out
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const readJsonIfExists = file => {
  try {
    return readJson(file)
  } catch (_err) {
    return null
  }
}

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temp, file)
}

const parseArgs = argv => {
  const opts = {
    sessionsRoot: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
    cacheDir: defaultCacheDir,
    refreshPricing: false,
    noSessionCache: false,
    json: false,
    topSessions: 0,
    pricingFile: '',
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--sessions-root') opts.sessionsRoot = path.resolve(expandHome(next()))
    else if (arg === '--cache-dir') opts.cacheDir = path.resolve(expandHome(next()))
    else if (arg === '--pricing-file') opts.pricingFile = path.resolve(expandHome(next()))
    else if (arg === '--refresh-pricing') opts.refreshPricing = true
    else if (arg === '--no-session-cache') opts.noSessionCache = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--top-sessions') opts.topSessions = Number(next())
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(opts.topSessions) || opts.topSessions < 0) throw new Error('--top-sessions must be zero or greater')
  return opts
}

const usageText = () => `
Usage:
  codex-usage install-skill [--target DIR] [--name NAME] [--force] [--link]
  codex-usage uninstall-skill [--target DIR] [--name NAME]
  codex-usage skill-status [--target DIR] [--name NAME]
  node scripts/codex_usage.js [--json] [--sessions-root DIR] [--cache-dir DIR]
                              [--refresh-pricing] [--no-session-cache]
                              [--pricing-file FILE] [--top-sessions N]
`.trim()

const skillInstallUsageText = () => `
Usage:
  codex-usage install-skill [--target DIR] [--name NAME] [--force] [--link]
  codex-usage uninstall-skill [--target DIR] [--name NAME] [--force]
  codex-usage skill-status [--target DIR] [--name NAME] [--json]

Defaults:
  --target ~/.agents/skills
  --name codex-usage

Notes:
  install-skill copies package files by default. Use --link only when you
  explicitly want a symlink or Windows junction for local development.
`.trim()

const defaultSkillTarget = () => path.join(os.homedir(), '.agents', 'skills')

const parseSkillCommandArgs = argv => {
  const opts = {
    target: defaultSkillTarget(),
    name: DEFAULT_SKILL_NAME,
    force: false,
    link: false,
    json: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--target') opts.target = path.resolve(expandHome(next()))
    else if (arg === '--name') opts.name = next()
    else if (arg === '--force') opts.force = true
    else if (arg === '--link') opts.link = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(opts.name)) throw new Error('--name may only contain letters, numbers, dots, underscores, and dashes')
  opts.dest = path.join(opts.target, opts.name)
  return opts
}

const pathExists = file => {
  try {
    fs.lstatSync(file)
    return true
  } catch (_err) {
    return false
  }
}

const copySkillPackage = (dest, opts = {}) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (pathExists(dest)) {
    if (!opts.force) throw new Error(`${dest} already exists; pass --force to replace it`)
    fs.rmSync(dest, { recursive: true, force: true })
  }
  const temp = `${dest}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(temp, { recursive: true })
  try {
    for (const entry of SKILL_PACKAGE_ENTRIES) {
      const source = path.join(skillRoot, entry)
      if (!pathExists(source)) continue
      fs.cpSync(source, path.join(temp, entry), { recursive: true })
    }
    fs.renameSync(temp, dest)
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true })
    throw err
  }
}

const linkSkillPackage = (dest, opts = {}) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (pathExists(dest)) {
    if (!opts.force) throw new Error(`${dest} already exists; pass --force to replace it`)
    fs.rmSync(dest, { recursive: true, force: true })
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(skillRoot, dest, type)
}

const skillStatus = opts => {
  const exists = pathExists(opts.dest)
  let lstat = null
  let skill = null
  if (exists) {
    lstat = fs.lstatSync(opts.dest)
    skill = readJsonIfExists(path.join(opts.dest, 'package.json'))
  }
  return {
    name: opts.name,
    target: opts.target,
    path: opts.dest,
    exists,
    kind: !exists ? 'missing' : lstat.isSymbolicLink() ? 'link' : 'copy',
    packageName: skill && skill.name || null,
    version: skill && skill.version || null
  }
}

const formatSkillStatus = status => {
  const lines = []
  lines.push(status.exists
    ? `${status.name} skill is installed at ${status.path}`
    : `${status.name} skill is not installed at ${status.path}`)
  if (status.exists) lines.push(`Install kind: ${status.kind}${status.version ? `, version ${status.version}` : ''}`)
  return lines.join('\n')
}

const runSkillCommand = (command, argv) => {
  const opts = parseSkillCommandArgs(argv)
  if (opts.help) {
    console.log(skillInstallUsageText())
    return
  }
  if (command === 'install-skill') {
    if (opts.link) linkSkillPackage(opts.dest, opts)
    else copySkillPackage(opts.dest, opts)
    const status = skillStatus(opts)
    console.log(formatSkillStatus(status))
    console.log('Restart Codex or start a new thread if the skill does not appear immediately.')
    return
  }
  if (command === 'uninstall-skill') {
    if (!pathExists(opts.dest)) {
      console.log(`${opts.name} skill is not installed at ${opts.dest}`)
      return
    }
    fs.rmSync(opts.dest, { recursive: true, force: true })
    console.log(`${opts.name} skill removed from ${opts.dest}`)
    return
  }
  if (command === 'skill-status') {
    const status = skillStatus(opts)
    console.log(opts.json ? JSON.stringify(status, null, 2) : formatSkillStatus(status))
    return
  }
  throw new Error(`unknown command: ${command}`)
}

const walkJsonl = root => {
  const files = []
  const visit = dir => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_err) {
      return
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file)
    }
  }
  visit(root)
  return files.sort()
}

const sessionTitle = payload => payload.title || payload.id || ''

const monthKey = timestamp => {
  const match = String(timestamp || '').match(/^(\d{4}-\d{2})/)
  return match ? match[1] : 'unknown'
}

const usageFromTokenInfo = (info, previousTotal) => {
  if (info && info.last_token_usage) return normalizeUsage(info.last_token_usage)
  if (info && info.total_token_usage) {
    return previousTotal ? diffUsage(info.total_token_usage, previousTotal) : normalizeUsage(info.total_token_usage)
  }
  return usageZero()
}

const scanSessionFile = file => {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  let sessionId = ''
  let title = ''
  let cwd = ''
  let provider = 'openai'
  let model = 'unknown'
  let previousTotal = null
  let tokenCountEvents = 0
  let malformedLines = 0
  let firstTimestamp = ''
  let lastTimestamp = ''
  const byModel = new Map()

  const addModelUsage = (modelId, providerId, usage, timestamp) => {
    const key = `${providerId || 'unknown'}/${modelId || 'unknown'}`
    const existing = byModel.get(key) || {
      provider: providerId || 'unknown',
      model: modelId || 'unknown',
      usage: usageZero(),
      tokenCountEvents: 0,
      byMonth: new Map()
    }
    existing.usage = addUsage(existing.usage, usage)
    existing.tokenCountEvents += 1
    const month = monthKey(timestamp)
    const monthly = existing.byMonth.get(month) || {
      month,
      usage: usageZero(),
      tokenCountEvents: 0
    }
    monthly.usage = addUsage(monthly.usage, usage)
    monthly.tokenCountEvents += 1
    existing.byMonth.set(month, monthly)
    byModel.set(key, existing)
  }

  for (const line of lines) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch (_err) {
      malformedLines += 1
      continue
    }
    if (row.timestamp) {
      if (!firstTimestamp) firstTimestamp = row.timestamp
      lastTimestamp = row.timestamp
    }
    const payload = row.payload || {}
    if (row.type === 'session_meta') {
      sessionId = payload.id || sessionId
      title = sessionTitle(payload) || title
      cwd = payload.cwd || cwd
      provider = payload.model_provider || provider
      model = payload.model || model
    }
    if (row.type === 'turn_context') {
      provider = payload.model_provider || provider
      model = payload.model || model
    }
    if (payload.model) model = payload.model
    if (payload.model_provider) provider = payload.model_provider
    if (payload.type === 'token_count' && payload.info) {
      const usage = usageFromTokenInfo(payload.info, previousTotal)
      previousTotal = payload.info.total_token_usage || previousTotal
      addModelUsage(model, provider, usage, row.timestamp)
      tokenCountEvents += 1
    }
  }

  return {
    path: file,
    sessionId,
    title,
    cwd,
    firstTimestamp,
    lastTimestamp,
    tokenCountEvents,
    malformedLines,
    byModel: [...byModel.values()].map(item => ({
      ...item,
      byMonth: [...item.byMonth.values()]
    }))
  }
}

const sessionCachePath = cacheDir => path.join(cacheDir, 'session-usage-cache.json')

const loadSessionCache = cacheDir => {
  const cached = readJsonIfExists(sessionCachePath(cacheDir))
  if (!cached || cached.schema !== CACHE_SCHEMA) return { schema: CACHE_SCHEMA, entries: {} }
  return cached
}

const fileStamp = file => {
  const stat = fs.statSync(file)
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: stat.mtime.toISOString()
  }
}

const scanSessions = opts => {
  const files = walkJsonl(opts.sessionsRoot)
  const cache = loadSessionCache(opts.cacheDir)
  const sessions = []
  const stats = {
    files: files.length,
    scanned: 0,
    reusedFromCache: 0,
    malformedLines: 0
  }

  for (const file of files) {
    const stamp = fileStamp(file)
    const cached = !opts.noSessionCache && cache.entries[file]
    if (cached && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) {
      sessions.push(cached.result)
      stats.reusedFromCache += 1
      stats.malformedLines += cached.result.malformedLines || 0
      continue
    }
    const result = scanSessionFile(file)
    const after = fileStamp(file)
    sessions.push(result)
    stats.scanned += 1
    stats.malformedLines += result.malformedLines || 0
    if (!opts.noSessionCache && after.size === stamp.size && after.mtimeMs === stamp.mtimeMs) {
      cache.entries[file] = {
        path: file,
        size: stamp.size,
        mtimeMs: stamp.mtimeMs,
        mtime: stamp.mtime,
        cachedAt: new Date().toISOString(),
        result
      }
    }
  }

  if (!opts.noSessionCache) {
    cache.updatedAt = new Date().toISOString()
    writeJsonAtomic(sessionCachePath(opts.cacheDir), cache)
  }

  return { sessions, stats }
}

const pricingCachePath = cacheDir => path.join(cacheDir, 'models-dev-api.json')

const fetchJson = async url => {
  if (typeof fetch !== 'function') throw new Error('global fetch is not available in this Node.js runtime')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to fetch ${url}: HTTP ${response.status}`)
  return response.json()
}

const loadCatalog = async opts => {
  if (opts.pricingFile) {
    return {
      catalog: readJson(opts.pricingFile),
      pricingSource: {
        url: opts.pricingFile,
        status: 'file',
        fetchedAt: null
      }
    }
  }
  const file = pricingCachePath(opts.cacheDir)
  const cached = readJsonIfExists(file)
  const fresh = cached && cached.catalog && Date.now() - Date.parse(cached.fetchedAt || 0) < PRICING_TTL_MS
  if (fresh && !opts.refreshPricing) {
    return {
      catalog: cached.catalog,
      pricingSource: {
        url: MODELS_DEV_API_URL,
        status: 'cached',
        fetchedAt: cached.fetchedAt
      }
    }
  }
  const catalog = await fetchJson(MODELS_DEV_API_URL)
  const fetchedAt = new Date().toISOString()
  writeJsonAtomic(file, {
    schema: 'codex-usage.models-dev-cache.v1',
    url: MODELS_DEV_API_URL,
    fetchedAt,
    catalog
  })
  return {
    catalog,
    pricingSource: {
      url: MODELS_DEV_API_URL,
      status: 'fetched',
      fetchedAt
    }
  }
}

const modelRecords = catalog => Object.entries(catalog || {}).flatMap(([providerId, provider]) => {
  const models = provider && provider.models || {}
  return Object.entries(models).map(([modelId, model]) => ({
    provider: providerId,
    providerName: provider.name || providerId,
    modelId,
    id: model.id || modelId,
    name: model.name || modelId,
    cost: model.cost || {},
    raw: model
  }))
})

const cleanKey = value => String(value || '').trim().toLowerCase()

const inferProvider = model => {
  const text = cleanKey(model)
  if (/^(gpt-|o[0-9]|chatgpt|openai[/:])/.test(text)) return 'openai'
  if (/^(claude|anthropic[/:])/.test(text)) return 'anthropic'
  if (/^(gemini|google[/:])/.test(text)) return 'google'
  return ''
}

const resolvePricing = ({ catalog, provider, model }) => {
  const providerHint = cleanKey(provider || inferProvider(model))
  const modelKey = cleanKey(String(model || '').replace(/^[^/:]+[/:]/, ''))
  const records = modelRecords(catalog)
  const candidates = records.filter(record => {
    if (providerHint && cleanKey(record.provider) !== providerHint) return false
    return [
      record.modelId,
      record.id,
      record.name,
      `${record.provider}/${record.modelId}`,
      `${record.provider}:${record.modelId}`
    ].some(value => cleanKey(value) === modelKey || cleanKey(value) === cleanKey(model))
  })
  const record = candidates[0]
  if (!record) return null
  const cost = record.cost || {}
  return {
    provider: record.provider,
    providerName: record.providerName,
    model: record.modelId,
    id: record.id,
    name: record.name,
    cost: {
      input: number(cost.input),
      output: number(cost.output),
      cache_read: number(cost.cache_read ?? cost.cached_input ?? cost.input_cache_read),
      cache_write: number(cost.cache_write ?? cost.cache_creation ?? cost.input_cache_write),
      reasoning: number(cost.reasoning)
    },
    rawCost: cost
  }
}

const charge = (tokens, ratePerMillionUsd) => tokens * ratePerMillionUsd / USD_PER_TOKEN_UNIT

const estimateCost = ({ usage, pricing }) => {
  const normalized = normalizeUsage(usage)
  const cost = pricing && pricing.cost || {}
  const inputBase = Math.max(0, normalized.input_tokens - normalized.cached_input_tokens - normalized.cache_write_input_tokens)
  const cacheReadRate = cost.cache_read || cost.input || 0
  const cacheWriteRate = cost.cache_write || cost.input || 0
  const hasReasoningRate = Boolean(cost.reasoning)
  const outputBase = hasReasoningRate
    ? Math.max(0, normalized.output_tokens - normalized.reasoning_output_tokens)
    : normalized.output_tokens
  const breakdown = {
    input: { tokens: inputBase, rate_per_million_usd: cost.input || 0, cost_usd: charge(inputBase, cost.input || 0) },
    cache_read: { tokens: normalized.cached_input_tokens, rate_per_million_usd: cacheReadRate, cost_usd: charge(normalized.cached_input_tokens, cacheReadRate) },
    cache_write: { tokens: normalized.cache_write_input_tokens, rate_per_million_usd: cacheWriteRate, cost_usd: charge(normalized.cache_write_input_tokens, cacheWriteRate) },
    output: { tokens: outputBase, rate_per_million_usd: cost.output || 0, cost_usd: charge(outputBase, cost.output || 0) },
    reasoning: { tokens: normalized.reasoning_output_tokens, rate_per_million_usd: hasReasoningRate ? cost.reasoning : 0, cost_usd: hasReasoningRate ? charge(normalized.reasoning_output_tokens, cost.reasoning) : 0 },
    unallocated: { tokens: normalized.unallocated_tokens, rate_per_million_usd: cost.input || 0, cost_usd: charge(normalized.unallocated_tokens, cost.input || 0) }
  }
  const total = Object.values(breakdown).reduce((sum, item) => sum + item.cost_usd, 0)
  const assumptions = []
  if (!cost.cache_read && normalized.cached_input_tokens) assumptions.push('cached_input_tokens priced at input rate')
  if (!cost.cache_write && normalized.cache_write_input_tokens) assumptions.push('cache_write_input_tokens priced at input rate')
  if (!hasReasoningRate && normalized.reasoning_output_tokens) assumptions.push('reasoning_output_tokens treated as included in output')
  if (normalized.unallocated_tokens) assumptions.push('total_tokens exceeded input_tokens + output_tokens; unallocated_tokens priced at input rate')
  return {
    usage: normalized,
    breakdown,
    total_cost_usd: total,
    assumptions
  }
}

const aggregateUsage = sessions => {
  const models = new Map()
  for (const session of sessions) {
    for (const item of session.byModel || []) {
      const key = `${item.provider || 'unknown'}/${item.model || 'unknown'}`
      const existing = models.get(key) || {
        provider: item.provider || 'unknown',
        model: item.model || 'unknown',
        usage: usageZero(),
        tokenCountEvents: 0,
        sessionCount: 0,
        sessions: []
      }
      existing.usage = addUsage(existing.usage, item.usage)
      existing.tokenCountEvents += item.tokenCountEvents || 0
      existing.sessionCount += 1
      existing.sessions.push({
        path: session.path,
        sessionId: session.sessionId,
        title: session.title,
        cwd: session.cwd,
        firstTimestamp: session.firstTimestamp,
        lastTimestamp: session.lastTimestamp,
        tokenCountEvents: item.tokenCountEvents || 0,
        usage: normalizeUsage(item.usage)
      })
      models.set(key, existing)
    }
  }
  return [...models.values()]
}

const pricedAggregate = ({ catalog, provider, model, usage }) => {
  const pricing = resolvePricing({ catalog, provider, model })
  const cost = pricing ? estimateCost({ usage, pricing }) : null
  return { pricing, cost }
}

const aggregateMonthlyUsage = ({ sessions, catalog }) => {
  const months = new Map()
  for (const session of sessions) {
    for (const item of session.byModel || []) {
      const monthRows = item.byMonth && item.byMonth.length
        ? item.byMonth
        : [{ month: monthKey(session.lastTimestamp || session.firstTimestamp), usage: item.usage, tokenCountEvents: item.tokenCountEvents || 0 }]
      for (const row of monthRows) {
        const month = row.month || 'unknown'
        const modelKey = `${item.provider || 'unknown'}/${item.model || 'unknown'}`
        const usage = normalizeUsage(row.usage)
        const { pricing, cost } = pricedAggregate({
          catalog,
          provider: item.provider,
          model: item.model,
          usage
        })
        const existing = months.get(month) || {
          month,
          usage: usageZero(),
          tokenCountEvents: 0,
          totalCostUsd: 0,
          sessionIds: new Set(),
          unpricedModels: new Set(),
          models: new Map()
        }
        const modelRecord = existing.models.get(modelKey) || {
          provider: item.provider || 'unknown',
          model: item.model || 'unknown',
          usage: usageZero(),
          tokenCountEvents: 0,
          totalCostUsd: 0,
          pricing
        }
        modelRecord.usage = addUsage(modelRecord.usage, usage)
        modelRecord.tokenCountEvents += row.tokenCountEvents || 0
        modelRecord.totalCostUsd += cost && cost.total_cost_usd || 0
        if (!modelRecord.pricing && pricing) modelRecord.pricing = pricing
        existing.models.set(modelKey, modelRecord)
        existing.usage = addUsage(existing.usage, usage)
        existing.tokenCountEvents += row.tokenCountEvents || 0
        existing.totalCostUsd += cost && cost.total_cost_usd || 0
        if (!pricing) existing.unpricedModels.add(modelKey)
        if (session.sessionId || session.path) existing.sessionIds.add(session.sessionId || session.path)
        months.set(month, existing)
      }
    }
  }
  return [...months.values()]
    .map(item => ({
      month: item.month,
      usage: normalizeUsage(item.usage),
      tokenCountEvents: item.tokenCountEvents,
      sessionCount: item.sessionIds.size,
      modelCount: item.models.size,
      totalCostUsd: item.totalCostUsd,
      unpricedModels: [...item.unpricedModels],
      byModel: [...item.models.values()]
        .map(model => ({
          provider: model.provider,
          model: model.model,
          usage: normalizeUsage(model.usage),
          tokenCountEvents: model.tokenCountEvents,
          totalCostUsd: model.totalCostUsd,
          pricing: model.pricing
        }))
        .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.usage.total_tokens - a.usage.total_tokens)
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

const buildReport = async opts => {
  const { sessions, stats } = scanSessions(opts)
  const { catalog, pricingSource } = await loadCatalog(opts)
  const byModel = aggregateUsage(sessions).map(item => {
    const { pricing, cost } = pricedAggregate({
      catalog,
      provider: item.provider,
      model: item.model,
      usage: item.usage
    })
    const sessionsByTokens = item.sessions
      .map(session => ({
        ...session,
        total_tokens: session.usage.total_tokens
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .slice(0, opts.topSessions || 0)
    return {
      provider: item.provider,
      model: item.model,
      usage: normalizeUsage(item.usage),
      tokenCountEvents: item.tokenCountEvents,
      sessionCount: item.sessionCount,
      pricing,
      cost,
      topSessions: sessionsByTokens
    }
  }).sort((a, b) => (b.cost && b.cost.total_cost_usd || 0) - (a.cost && a.cost.total_cost_usd || 0) ||
    b.usage.total_tokens - a.usage.total_tokens ||
    a.model.localeCompare(b.model))

  const totalUsage = addUsage(...byModel.map(item => item.usage))
  const totalCostUsd = byModel.reduce((sum, item) => sum + (item.cost && item.cost.total_cost_usd || 0), 0)
  const unpricedModels = byModel.filter(item => !item.pricing).map(item => `${item.provider}/${item.model}`)
  const byMonth = aggregateMonthlyUsage({ sessions, catalog })
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    sessionsRoot: opts.sessionsRoot,
    cacheDir: opts.cacheDir,
    pricingSource,
    cache: stats,
    sessionCount: sessions.length,
    tokenCountEvents: byModel.reduce((sum, item) => sum + item.tokenCountEvents, 0),
    totalUsage,
    totalCostUsd,
    unpricedModels,
    byMonth,
    byModel
  }
}

const formatInt = value => Math.round(number(value)).toLocaleString('en-US')
const formatMoney = value => `$${number(value).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`

const escapeMarkdownCell = value => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|')
  .replace(/\n/g, '<br>')

const markdownTable = (headers, rows) => [
  `| ${headers.map(escapeMarkdownCell).join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`)
].join('\n')

const usageCells = usage => [
  formatInt(usage.input_tokens),
  formatInt(usage.cached_input_tokens),
  formatInt(usage.output_tokens),
  formatInt(usage.reasoning_output_tokens),
  formatInt(usage.unallocated_tokens),
  formatInt(usage.total_tokens)
]

const formatReport = report => {
  const lines = []
  lines.push('# Codex Usage')
  lines.push('')
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(`Sessions: ${formatInt(report.sessionCount)} (${formatInt(report.cache.scanned)} scanned, ${formatInt(report.cache.reusedFromCache)} cached)`)
  lines.push(`Pricing: ${report.pricingSource.status} from ${report.pricingSource.url}${report.pricingSource.fetchedAt ? ` at ${report.pricingSource.fetchedAt}` : ''}`)
  lines.push(`Total tokens: ${formatInt(report.totalUsage.total_tokens)}`)
  lines.push(`Estimated cost: ${formatMoney(report.totalCostUsd)}`)
  if (report.totalUsage.unallocated_tokens) lines.push(`Unallocated tokens: ${formatInt(report.totalUsage.unallocated_tokens)} priced at each model's input rate`)
  lines.push('')
  lines.push('## By Model')
  lines.push('')
  lines.push(markdownTable(
    ['Model', 'Sessions', 'Events', 'Input', 'Cached', 'Output', 'Reasoning', 'Unknown', 'Total', 'Cost'],
    report.byModel.map(item => [
      `${item.provider}/${item.model}`,
      formatInt(item.sessionCount),
      formatInt(item.tokenCountEvents),
      ...usageCells(item.usage),
      item.cost ? formatMoney(item.cost.total_cost_usd) : 'unpriced'
    ])
  ))
  lines.push('')
  lines.push('## By Month')
  lines.push('')
  lines.push(markdownTable(
    ['Month', 'Sessions', 'Models', 'Events', 'Input', 'Cached', 'Output', 'Reasoning', 'Unknown', 'Total', 'Cost'],
    (report.byMonth || []).map(item => [
      item.month,
      formatInt(item.sessionCount),
      formatInt(item.modelCount),
      formatInt(item.tokenCountEvents),
      ...usageCells(item.usage),
      formatMoney(item.totalCostUsd)
    ])
  ))
  if (report.unpricedModels.length) {
    lines.push('')
    lines.push(`Unpriced models: ${report.unpricedModels.join(', ')}`)
  }
  return lines.join('\n')
}

const main = async argv => {
  if (['install-skill', 'uninstall-skill', 'skill-status'].includes(argv[0])) {
    runSkillCommand(argv[0], argv.slice(1))
    return
  }
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(usageText())
    return
  }
  const report = await buildReport(opts)
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report))
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = {
  addUsage,
  buildReport,
  copySkillPackage,
  estimateCost,
  formatReport,
  formatSkillStatus,
  parseSkillCommandArgs,
  markdownTable,
  normalizeUsage,
  parseArgs,
  resolvePricing,
  runSkillCommand,
  scanSessionFile,
  scanSessions,
  skillStatus,
  usageFromTokenInfo
}
