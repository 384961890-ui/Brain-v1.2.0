#!/usr/bin/env node
/**
 * memory-lancedb-pro MCP Server for Claude Code
 *
 * Production-grade hybrid memory system: vector + BM25 + cross-encoder rerank
 * with Weibull decay lifecycle and tier management.
 *
 * Original source: memory-lancedb-pro (CortexReach, MIT)
 * Adapted for Claude Code MCP protocol.
 *
 * Data: ~/.claude/lancedb-pro-data/
 * Config: ~/.claude/.mcp-lancedb-pro.json
 */

// Resolve require paths to brain-v1.1.9 node_modules
const path = require("path");
const brainRoot = path.resolve(__dirname, "..");
const originalRequire = require;
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  try {
    return originalResolve.call(this, request, parent, isMain, options);
  } catch (e) {
    // Try brainRoot node_modules as fallback
    const alt = path.join(brainRoot, "node_modules", request);
    try {
      return originalResolve.call(this, alt, { paths: [path.join(brainRoot, "node_modules")] }, isMain, options);
    } catch {
      throw e;
    }
  }
};

const fs = require("fs");

// jiti loader for importing TypeScript modules from the plugin
const jiti = require("jiti")(__filename);

// ============================================================================
// Config
// ============================================================================

const DB_PATH = path.resolve(process.env.HOME || "/tmp", ".claude", "lancedb-pro-data");
const CONFIG_PATH = path.resolve(process.env.HOME || "/tmp", ".claude", ".mcp-lancedb-pro.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

const cfg = loadConfig();

// SiliconFlow as default embedding provider (爸爸的 key)
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY || cfg.siliconflowApiKey || "";
const EMBEDDING_MODEL = "BAAI/bge-m3"; // 1024-dim, good CJK support
const EMBEDDING_DIMENSIONS = 1024;
const LLM_MODEL = "deepseek-ai/DeepSeek-V3"; // for smart extraction
const SILICONFLOW_BASE = "https://api.siliconflow.cn/v1";

// ============================================================================
// Import memory-lancedb-pro core modules (sourced from workspace/plugins)
// ============================================================================

const pluginRoot = path.resolve(
  process.env.HOME || "/tmp",
  ".openclaw", "workspace", "plugins", "memory-lancedb-pro"
);

const { MemoryStore, validateStoragePath } = jiti(path.join(pluginRoot, "src/store.ts"));
const { Embedder } = jiti(path.join(pluginRoot, "src/embedder.ts"));
const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti(path.join(pluginRoot, "src/retriever.ts"));
const { createDecayEngine } = jiti(path.join(pluginRoot, "src/decay-engine.ts"));
const { createTierManager } = jiti(path.join(pluginRoot, "src/tier-manager.ts"));
const { AccessTracker } = jiti(path.join(pluginRoot, "src/access-tracker.ts"));
const { filterNoise, isNoise } = jiti(path.join(pluginRoot, "src/noise-filter.ts"));
const { smartChunk } = jiti(path.join(pluginRoot, "src/chunker.ts"));
const { expandQuery } = jiti(path.join(pluginRoot, "src/query-expander.ts"));
const { isMemoryExpired, parseSmartMetadata } = jiti(path.join(pluginRoot, "src/smart-metadata.ts"));
const { createLlmClient } = jiti(path.join(pluginRoot, "src/llm-client.ts"));
const { SmartExtractor, createExtractionRateLimiter } = jiti(path.join(pluginRoot, "src/smart-extractor.ts"));
const { compressTexts, estimateConversationValue } = jiti(path.join(pluginRoot, "src/session-compressor.ts"));
const { normalizeAdmissionControlConfig, ADMISSION_CONTROL_PRESETS } = jiti(path.join(pluginRoot, "src/admission-control.ts"));

// ============================================================================
// MCP Protocol Helpers
// ============================================================================

function createMCPResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function createMCPError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function createMCPNotification(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

// ============================================================================
// Initialize Core Systems
// ============================================================================

let store, embedder, retriever, decayEngine, tierManager, accessTracker, llmClient;
let smartExtractor = null;
let rateLimiter = null;
let initialized = false;
let initPromise = null;

async function initialize() {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = doInitialize().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function doInitialize() {
  console.error("[lancedb-pro] Initializing memory system...");

  // Validate and create DB path
  validateStoragePath(DB_PATH);
  console.error(`[lancedb-pro] DB path: ${DB_PATH}`);

  // Create store
  store = new MemoryStore({
    dbPath: DB_PATH,
    vectorDim: EMBEDDING_DIMENSIONS,
  });

  // Create embedder (SiliconFlow, BGE-M3)
  embedder = new Embedder({
    provider: "openai-compatible",
    apiKey: SILICONFLOW_API_KEY,
    model: EMBEDDING_MODEL,
    baseURL: SILICONFLOW_BASE,
    dimensions: EMBEDDING_DIMENSIONS,
    taskQuery: "retrieval.query",
    taskPassage: "retrieval.passage",
    normalized: true,
  });

  // Warm up: test embedding
  const testResult = await embedder.test();
  console.error(`[lancedb-pro] Embedder test: ${testResult.success ? "OK" : "FAIL"} dim=${testResult.dimensions}`);
  if (!testResult.success) {
    console.error(`[lancedb-pro] Embedder failed: ${testResult.error}`);
  }

  // Create retrieval config adapted for CC
  const retrievalConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    mode: cfg.retrievalMode || "hybrid",
    minScore: cfg.minScore || 0.25,
    hardMinScore: cfg.hardMinScore || 0.30,
    rerank: cfg.rerank || "none", // default: no cross-encoder (use SiliconFlow rerank if configured)
    rerankProvider: cfg.rerankProvider || "siliconflow",
    rerankModel: cfg.rerankModel || "BAAI/bge-reranker-v2-m3",
    rerankEndpoint: `${SILICONFLOW_BASE}/rerank`,
    rerankApiKey: cfg.siliconflowApiKey || SILICONFLOW_API_KEY,
    candidatePoolSize: cfg.candidatePoolSize || 12,
    filterNoise: true,
    lengthNormAnchor: cfg.lengthNormAnchor || 500,
    timeDecayHalfLifeDays: cfg.timeDecayHalfLifeDays || 60,
    recencyHalfLifeDays: cfg.recencyHalfLifeDays || 14,
    recencyWeight: cfg.recencyWeight || 0.1,
    reinforcementFactor: cfg.reinforcementFactor || 0.5,
    maxHalfLifeMultiplier: cfg.maxHalfLifeMultiplier || 3,
    queryExpansion: true,
    tagPrefixes: ["proj", "env", "team", "scope", "cat"],
  };

  // Create decay engine and tier manager
  decayEngine = createDecayEngine({
    recencyHalfLifeDays: 30,
    recencyWeight: 0.4,
    frequencyWeight: 0.3,
    intrinsicWeight: 0.3,
    staleThreshold: 0.3,
    searchBoostMin: 0.3,
    importanceModulation: 1.5,
    betaCore: 0.8,
    betaWorking: 1.0,
    betaPeripheral: 1.3,
    coreDecayFloor: 0.9,
    workingDecayFloor: 0.7,
    peripheralDecayFloor: 0.5,
  });

  tierManager = createTierManager({
    coreAccessThreshold: 10,
    coreCompositeThreshold: 0.7,
    coreImportanceThreshold: 0.8,
    workingAccessThreshold: 3,
    workingCompositeThreshold: 0.4,
    peripheralCompositeThreshold: 0.15,
    peripheralAgeDays: 60,
  });

  // Create retriever with full lifecycle
  retriever = new MemoryRetriever(store, embedder, retrievalConfig, decayEngine);

  // Create access tracker
  accessTracker = new AccessTracker({
    store,
    logger: { warn: (...args) => console.error("[lancedb-pro:access]", ...args) },
    debounceMs: 5000,
  });
  retriever.setAccessTracker(accessTracker);

  // Create LLM client for smart extraction (optional)
  try {
    llmClient = createLlmClient({
      apiKey: SILICONFLOW_API_KEY,
      model: LLM_MODEL,
      baseURL: SILICONFLOW_BASE,
      timeoutMs: 30000,
    });
    console.error("[lancedb-pro] LLM client ready");

    // Initialize SmartExtractor for automatic memory extraction
    try {
      const admissionConfig = normalizeAdmissionControlConfig(cfg.admissionControl || {
        enabled: false,
        preset: "balanced",
      });
      smartExtractor = new SmartExtractor(store, embedder, llmClient, {
        defaultScope: "global",
        extractMinMessages: 3,
        extractMaxChars: 8000,
        admissionControl: admissionConfig.enabled ? admissionConfig : undefined,
        log: (msg) => console.error("[lancedb-pro:extractor]", msg),
        debugLog: (msg) => console.error("[lancedb-pro:extractor:debug]", msg),
      });
      rateLimiter = createExtractionRateLimiter({ maxExtractionsPerHour: 30 });
      console.error("[lancedb-pro] SmartExtractor ready");
    } catch (err) {
      console.error("[lancedb-pro] SmartExtractor init failed:", err.message);
      smartExtractor = null;
    }
  } catch (err) {
    console.error("[lancedb-pro] LLM client init failed (smart extraction disabled):", err.message);
    llmClient = null;
  }

  // Warm up: count rows
  try {
    const count = await store.count();
    console.error(`[lancedb-pro] Ready. ${count} memories in store. Embedder dim: ${embedder.dimensions}, FTS: ${store.hasFtsSupport}`);
  } catch (e) {
    console.error(`[lancedb-pro] Ready (no count yet). Embedder dim: ${embedder.dimensions}`);
  }

  initialized = true;
  console.error("[lancedb-pro] Initialization complete");
}

// ============================================================================
// MCP Tool Handlers
// ============================================================================

const TOOL_DEFINITIONS = {
  memory_recall: {
    name: "memory_recall",
    description: "Search long-term memory via hybrid vector+BM25 retrieval + rerank + decay",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 5, max 20)" },
        scope: { type: "string", description: "Optional scope filter" },
        category: { type: "string", description: "Filter by category: preference|fact|decision|entity|other|reflection" },
        minScore: { type: "number", description: "Minimum relevance score 0-1" },
        source: { type: "string", description: "manual|auto-recall|cli" },
        raw: { type: "boolean", description: "Return raw results (no score merging)" },
      },
      required: ["query"],
    },
  },
  memory_store: {
    name: "memory_store",
    description: "Save information to long-term memory (auto-chunked, noise-filtered, embedded)",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Information to remember" },
        importance: { type: "number", description: "Importance 0-1 (default 0.7)" },
        category: { type: "string", description: "preference|fact|decision|entity|other|reflection (default: fact)" },
        scope: { type: "string", description: "Storage scope (default: global)" },
      },
      required: ["text"],
    },
  },
  memory_forget: {
    name: "memory_forget",
    description: "Delete memories by ID or search query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to locate memory" },
        memoryId: { type: "string", description: "Memory UUID or 8+ char prefix" },
        scope: { type: "string", description: "Scope filter" },
      },
    },
  },
  memory_update: {
    name: "memory_update",
    description: "Update an existing memory (preserves timestamp)",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "Memory UUID or 8+ char prefix" },
        text: { type: "string", description: "New content (triggers re-embedding)" },
        importance: { type: "number", description: "New importance 0-1" },
        category: { type: "string", description: "New category" },
      },
      required: ["memoryId"],
    },
  },
  memory_stats: {
    name: "memory_stats",
    description: "Get memory storage statistics",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Filter by scope" },
      },
    },
  },
  memory_list: {
    name: "memory_list",
    description: "List recent memories",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 10, max 50)" },
        scope: { type: "string", description: "Scope filter" },
        category: { type: "string", description: "Category filter" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
  },
  memory_extract: {
    name: "memory_extract",
    description: "Auto-extract memories from conversation text using LLM. Extracts up to 5 candidates across 6 categories (profile/preferences/entities/events/cases/patterns), deduplicates against existing memories, and persists new/merged entries.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Conversation text to extract memories from" },
        scope: { type: "string", description: "Target scope (default: global)" },
        dryRun: { type: "boolean", description: "Preview what would be extracted without persisting (default: false)" },
      },
      required: ["text"],
    },
  },
  memory_mark_important: {
    name: "memory_mark_important",
    description: "Quick-save an important piece of information to long-term memory. Lightweight alternative to memory_extract when you know something is worth remembering.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Important information to remember" },
        category: { type: "string", description: "preference|fact|decision|entity|other|reflection (default: fact)" },
        importance: { type: "number", description: "Importance 0-1 (default: 0.85)" },
        scope: { type: "string", description: "Storage scope (default: global)" },
      },
      required: ["text"],
    },
  },
};

// ============================================================================
// Tool Implementations
// ============================================================================

async function handleMemoryRecall(params) {
  const { query, limit = 5, scope, category, minScore, source = "manual", raw } = params;

  const scopeFilter = scope ? [scope] : ["global"];

  const results = await retriever.retrieve({
    query,
    limit: Math.min(Math.max(1, limit || 5), 20),
    scopeFilter,
    category,
    source,
  });

  // Get diagnostics for transparency
  const diagnostics = retriever.getLastDiagnostics();

  return {
    results: results.map((r) => ({
      id: r.entry.id,
      text: r.entry.text,
      category: r.entry.category,
      importance: r.entry.importance,
      timestamp: r.entry.timestamp,
      scope: r.entry.scope,
      score: r.score,
      sources: r.sources,
    })),
    count: results.length,
    diagnostics: raw ? diagnostics : undefined,
  };
}

async function handleMemoryStore(params) {
  const { text, importance = 0.7, category = "fact", scope = "global" } = params;

  // Noise filter
  if (isNoise(text)) {
    return { stored: false, reason: "content filtered as noise", id: null };
  }

  // Generate embedding
  const vector = await embedder.embedPassage(text);

  const entry = await store.store({
    text,
    vector,
    category,
    scope,
    importance: Math.min(1, Math.max(0, importance)),
    metadata: JSON.stringify({
      l0_abstract: text.slice(0, 100),
      source: "manual",
      confidence: 0.9,
    }),
  });

  return {
    stored: true,
    id: entry.id,
    timestamp: entry.timestamp,
    dimensions: vector.length,
  };
}

async function handleMemoryForget(params) {
  const { query, memoryId, scope } = params;

  if (memoryId) {
    const scopeFilter = scope ? [scope] : ["global"];
    const result = await store.delete(memoryId, scopeFilter);
    return { deleted: result, id: memoryId };
  }

  if (query) {
    // Find by search first
    const results = await retriever.retrieve({
      query,
      limit: 1,
      scopeFilter: scope ? [scope] : ["global"],
      source: "cli",
    });

    if (results.length === 0) {
      return { deleted: false, reason: "no matching memories found" };
    }

    await store.delete(results[0].entry.id, scope ? [scope] : ["global"]);
    return { deleted: true, id: results[0].entry.id, text: results[0].entry.text.slice(0, 100) };
  }

  throw new Error("Either query or memoryId is required");
}

async function handleMemoryUpdate(params) {
  const { memoryId, text, importance, category } = params;

  const updates = {};
  if (text !== undefined) {
    updates.text = text;
    updates.vector = await embedder.embedPassage(text);
  }
  if (importance !== undefined) updates.importance = importance;
  if (category !== undefined) updates.category = category;

  const result = await store.update(memoryId, updates);
  if (!result) {
    return { updated: false, reason: "memory not found" };
  }

  return {
    updated: true,
    id: result.id,
    text: result.text.slice(0, 200),
    category: result.category,
    importance: result.importance,
  };
}

async function handleMemoryStats(params) {
  const { scope } = params;
  const scopeFilter = scope ? [scope] : ["global"];
  const stats = await store.stats(scopeFilter);

  return {
    totalCount: stats.totalCount,
    scopeCounts: stats.scopeCounts,
    categoryCounts: stats.categoryCounts,
    ftsAvailable: store.hasFtsSupport,
  };
}

async function handleMemoryList(params) {
  const { limit = 10, scope, category, offset = 0 } = params;
  const scopeFilter = scope ? [scope] : ["global"];

  const entries = await store.list(
    scopeFilter,
    category,
    Math.min(limit, 50),
    offset
  );

  return {
    entries: entries.map((e) => ({
      id: e.id,
      text: e.text.slice(0, 300),
      category: e.category,
      importance: e.importance,
      timestamp: e.timestamp,
      scope: e.scope,
    })),
    count: entries.length,
  };
}

async function handleMemoryExtract(params) {
  const { text, scope = "global", dryRun = false } = params;

  if (!smartExtractor || !llmClient) {
    return { error: "SmartExtractor not initialized (check LLM client)" };
  }

  // Rate limit check
  if (rateLimiter && rateLimiter.isRateLimited()) {
    const recentCount = rateLimiter.getRecentCount();
    return { error: `Rate limited: ${recentCount} extractions in the last hour. Wait before extracting again.` };
  }

  // Estimate conversation value — skip very low-value texts
  const textLines = text.split("\n").filter((l) => l.trim());
  const value = estimateConversationValue(textLines);
  if (value < 0.15) {
    return { skipped: true, reason: "Low conversation value score", value };
  }

  // Compress to fit extraction budget
  const compressed = compressTexts(textLines, 8000, { minTexts: 2, minScoreToKeep: 0.2 });
  const conversationText = compressed.texts.join("\n");

  if (dryRun) {
    // Preview: only show compression stats and conversation value — no LLM call, no DB write.
    // Use session-compressor scoring to estimate what would be kept.
    const previewLines = compressed.texts.map((t) => ({
      text: t.slice(0, 120) + (t.length > 120 ? "..." : ""),
      chars: t.length,
    }));
    return {
      dryRun: true,
      conversationValue: value,
      compressedFrom: textLines.length,
      compressedTo: compressed.texts.length,
      inputChars: text.length,
      compressedChars: conversationText.length,
      previewLines,
      note: "Set dryRun=false to run full LLM extraction",
    };
  }

  // Real extraction
  const sessionKey = `cc-session-${Date.now()}`;
  try {
    const stats = await smartExtractor.extractAndPersist(conversationText, sessionKey, {
      scope,
      scopeFilter: [scope],
    });
    rateLimiter.recordExtraction();
    return {
      extraction: stats,
      compressedFrom: textLines.length,
      compressedTo: compressed.texts.length,
      conversationValue: value,
    };
  } catch (err) {
    return { error: `Extraction failed: ${err.message}` };
  }
}

async function handleMemoryMarkImportant(params) {
  const { text, category = "fact", importance = 0.85, scope = "global" } = params;

  // Reject noise
  if (isNoise(text)) {
    return { stored: false, reason: "content filtered as noise" };
  }

  const safeImportance = Math.min(1, Math.max(0, importance));

  // Generate embedding
  const vector = await embedder.embedPassage(text);

  const entry = await store.store({
    text,
    vector,
    category,
    scope,
    importance: safeImportance,
    metadata: JSON.stringify({
      l0_abstract: text.slice(0, 100),
      source: "manual",
      confidence: 0.95,
      state: "confirmed",
      memory_layer: "durable",
    }),
  });

  return {
    stored: true,
    id: entry.id,
    timestamp: entry.timestamp,
    importance: safeImportance,
    category,
  };
}

const HANDLERS = {
  memory_recall: handleMemoryRecall,
  memory_store: handleMemoryStore,
  memory_forget: handleMemoryForget,
  memory_update: handleMemoryUpdate,
  memory_stats: handleMemoryStats,
  memory_list: handleMemoryList,
  memory_extract: handleMemoryExtract,
  memory_mark_important: handleMemoryMarkImportant,
};

// ============================================================================
// MCP Server — Stdio Transport
// ============================================================================

let requestIdCounter = 0;
let buffer = "";

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error("[lancedb-pro] Invalid JSON:", raw.slice(0, 100));
    return;
  }

  const { method, id, params } = msg;

  // Handle initialize — respond immediately, init in background
  if (method === "initialize") {
    const response = createMCPResponse(id || requestIdCounter++, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: "memory-lancedb-pro",
        version: "1.0.0-cc",
      },
    });
    process.stdout.write(response + "\n");
    // Background init (don't block the response)
    initialize().catch((err) => console.error("[lancedb-pro] Init failed:", err));
    return;
  }

  // Handle notifications (no id)
  if (method === "notifications/initialized") {
    // Ensure init completes before tools are used
    await initialize().catch((err) => console.error("[lancedb-pro] Init failed:", err));
    return;
  }

  // Handle tools/list
  if (method === "tools/list") {
    await initialize();
    const response = createMCPResponse(id || requestIdCounter++, {
      tools: Object.values(TOOL_DEFINITIONS),
    });
    process.stdout.write(response + "\n");
    return;
  }

  // Handle tools/call
  if (method === "tools/call") {
    await initialize();
    const { name, arguments: args } = params || {};

    const handler = HANDLERS[name];
    if (!handler) {
      const err = createMCPError(id || requestIdCounter++, -32601, `Unknown tool: ${name}`);
      process.stdout.write(err + "\n");
      return;
    }

    try {
      const result = await handler(args || {});
      const response = createMCPResponse(id || requestIdCounter++, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
      process.stdout.write(response + "\n");
    } catch (err) {
      console.error(`[lancedb-pro] Tool ${name} error:`, err);
      const errResponse = createMCPError(id || requestIdCounter++, -32603, err.message);
      process.stdout.write(errResponse + "\n");
    }
    return;
  }
}

// Read stdin (line-buffered MCP messages)
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    handleMessage(trimmed).catch((err) => {
      console.error("[lancedb-pro] handler error:", err);
    });
  }
});

process.stdin.on("end", () => {
  if (buffer.trim()) {
    handleMessage(buffer.trim()).catch(() => {});
  }
});

// Handle signals
process.on("SIGTERM", () => {
  if (accessTracker) {
    accessTracker.destroy();
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  if (accessTracker) {
    accessTracker.destroy();
  }
  process.exit(0);
});

console.error("[lancedb-pro] MCP server started, waiting for initialization...");
