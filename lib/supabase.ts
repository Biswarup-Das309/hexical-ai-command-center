/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║                                     HEXICAL SECURITY OPERATING SYSTEM                                ║
 * ║                                  PRODUCTION DATABASE UTILITY ACCESS LAYER                            ║
 * ║                         SERVER-ONLY, FAULT-TOLERANT, STRICT BOUNDARIES (v4.0)                        ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types' // Generated via Supabase CLI
import {
  ScanRecord,
  ProjectId,
  UserId,
  ScanId,
  RiskLevelType,
  ExecutionProfile,
  ASTContext,
  Finding,
  ScanPerformanceMetrics,
  ModelConfiguration,
  PluginId,
  PaginatedResult,
  SwarmExecution,
} from './hexical-types'

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ CUSTOM ERROR CLASSES & DEPENDENCY INJECTED LOGGING
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DatabaseError'
  }
}

// Logger Interface enables swapping console for Datadog/Winston in production
export interface HexicalLogger {
  info: (msg: string, meta?: unknown) => void
  warn: (msg: string, meta?: unknown) => void
  error: (msg: string, meta?: unknown) => void
}

let logger: HexicalLogger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'INFO', msg, meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: 'WARN', msg, meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'ERROR', msg, meta })),
}

export const setLogger = (customLogger: HexicalLogger) => {
  logger = customLogger
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ CLIENT INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new ConfigurationError('CRITICAL: Supabase deployment environment variables are missing.')
}

const globalForSupabase = globalThis as unknown as {
  supabasePublicSingleton: SupabaseClient<Database> | undefined
}

export const createSupabaseClient = (token?: string): SupabaseClient<Database> => {
  const clientOptions = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey:
        process.env.NODE_ENV === 'development'
          ? `hexical-dev-bypass-${crypto.randomUUID().substring(0, 8)}`
          : 'hexical-prod-auth',
    },
  }

  if (token) {
    return createClient<Database>(supabaseUrl, supabaseAnonKey, {
      ...clientOptions,
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
  }

  if (!globalForSupabase.supabasePublicSingleton) {
    globalForSupabase.supabasePublicSingleton = createClient<Database>(supabaseUrl, supabaseAnonKey, clientOptions)
  }

  return globalForSupabase.supabasePublicSingleton
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ TYPE GUARDS, MAPPERS & RESILIENCE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

// Replaces `as any` by safely asserting complex objects to Supabase's expected JSON interface
type DbJson = Database['public']['Tables']['scan_history']['Insert']['ast_context']
const toDbJson = <T>(data: T): DbJson => data as unknown as DbJson

/**
 * Validates complex JSON structures at the database boundary.
 * (Integration point: Replace with Zod schemas e.g., `return FindingSchema.parse(data)` for runtime safety)
 */
function validateBoundary<T>(data: unknown, fallback: T): T {
  if (!data || typeof data !== 'object') return fallback
  return data as T
}

/**
 * Centralized mapper to convert raw Supabase Postgres rows into strict TypeScript Domain Models.
 */
function mapScanRecordRow(row: Database['public']['Tables']['scan_history']['Row']): ScanRecord {
  return {
    id: row.id as ScanId,
    projectId: row.project_id as ProjectId,
    userId: row.user_id as UserId,
    createdAt: row.created_at,
    executionProfileUsed: row.execution_profile_used as ExecutionProfile,
    activePlugins: validateBoundary<PluginId[]>(row.active_plugins, []),
    modelConfigUsed: validateBoundary<ModelConfiguration>(row.model_config_used, {} as ModelConfiguration),
    astContext: validateBoundary<ASTContext>(row.ast_context, {} as ASTContext),
    scanSizeBytes: row.scan_size_bytes,
    filesScannedCount: row.files_scanned_count,
    skippedFilesCount: row.skipped_files_count,
    findingsList: validateBoundary<Finding[]>(row.findings_list, []),
    overallRisk: row.overall_risk as RiskLevelType,
    performance: validateBoundary<ScanPerformanceMetrics>(row.performance, {} as ScanPerformanceMetrics),
    swarmExecutionData: row.swarm_execution_data
      ? validateBoundary<SwarmExecution>(row.swarm_execution_data, {} as SwarmExecution)
      : undefined,
  }
}

/**
 * Centralized fault-tolerance policy for database operations.
 */
function isTransientError(error: any): boolean {
  if (!error) return false
  const transientCodes = new Set([
    '53300', // too_many_connections
    '40001', // serialization_failure
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
  ])
  return transientCodes.has(error.code) || (error.message && error.message.includes('fetch'))
}

async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3, baseDelayMs = 500): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error: any) {
      if (attempt === maxRetries || !isTransientError(error)) throw error

      const delay = baseDelayMs * Math.pow(2, attempt - 1)
      logger.warn(
        `[Supabase Engine] Transient DB failure (Attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`,
        { code: error.code },
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable execution path')
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ DATA ACCESSIBILITY LEDGER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

export async function getLatestProjectScan(
  client: SupabaseClient<Database>,
  projectId: ProjectId,
): Promise<ScanRecord | null> {
  return withRetry(async () => {
    const { data, error } = await client
      .from('scan_history')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      throw new DatabaseError('Failed to fetch previous scan baseline.', error.code, error.details)
    }

    return data ? mapScanRecordRow(data) : null
  })
}

export async function getProjectScansPaginated(
  client: SupabaseClient<Database>,
  projectId: ProjectId,
  pageNumber: number = 1,
  pageSize: number = 10,
): Promise<PaginatedResult<ScanRecord>> {
  return withRetry(async () => {
    const from = (pageNumber - 1) * pageSize
    const to = from + pageSize - 1

    const { data, error, count } = await client
      .from('scan_history')
      .select('*', { count: 'exact' })
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) {
      throw new DatabaseError('Failed to fetch paginated scan history.', error.code, error.details)
    }

    const totalCount = count || 0
    return {
      data: (data || []).map(mapScanRecordRow),
      totalCount,
      pageSize,
      pageNumber,
      hasNextPage: from + pageSize < totalCount,
    }
  })
}

/**
 * Persists a scan record to the ledger.
 * Note: If future architectures require atomic multi-table writes (e.g. Findings + Audit Log),
 * transition this logic to a Postgres Stored Procedure and invoke via `client.rpc('commit_scan_transaction', payload)`.
 */
export async function saveScanRecord(
  client: SupabaseClient<Database>,
  scanData: Omit<ScanRecord, 'id' | 'createdAt'>,
): Promise<ScanId> {
  return withRetry(async () => {
    const { data, error } = await client
      .from('scan_history')
      .insert([
        {
          project_id: scanData.projectId,
          user_id: scanData.userId,
          execution_profile_used: scanData.executionProfileUsed,
          active_plugins: toDbJson(scanData.activePlugins),
          model_config_used: toDbJson(scanData.modelConfigUsed),
          ast_context: toDbJson(scanData.astContext),
          scan_size_bytes: scanData.scanSizeBytes,
          files_scanned_count: scanData.filesScannedCount,
          skipped_files_count: scanData.skippedFilesCount,
          findings_list: toDbJson(scanData.findingsList),
          overall_risk: scanData.overallRisk,
          swarm_execution_data: toDbJson(scanData.swarmExecutionData),
          performance: toDbJson(scanData.performance),
        },
      ])
      .select('id')
      .single()

    if (error) {
      throw new DatabaseError('Failed to commit secure scan record.', error.code, error.details)
    }

    return data.id as ScanId
  })
}
