/**
 * @file lib/hexical/recon.ts
 * Mechanical, deterministic signal extraction from the submitted `logic`
 * payload. Everything here is a real regex match against the actual input —
 * nothing is a placeholder. If nothing matches, we return undefined/[] and
 * the caller must render an honest empty state, never a backfilled default.
 */

const TECH_SIGNATURES: Record<string, RegExp> = {
  'Express.js': /require\(['"]express['"]\)|from\s+['"]express['"]|express\(\)/i,
  'Next.js': /from\s+['"]next\//i.test('') ? /from\s+['"]next\//i : /from\s+['"]next\//i,
  React: /from\s+['"]react['"]|useState\(|useEffect\(/i,
  Django: /from\s+django|django\.db\.models/i,
  Flask: /from\s+flask\s+import|Flask\(__name__\)/i,
  'Spring Boot': /@RestController|@SpringBootApplication/i,
  PostgreSQL: /postgres:\/\/|psycopg2|pg_query/i,
  MongoDB: /mongoose\.|MongoClient|mongodb:\/\//i,
  MySQL: /mysql:\/\/|mysqli_|PDO::MYSQL/i,
  Laravel: /Illuminate\\|artisan/i,
  'ASP.NET': /using\s+System\.Web|\[HttpGet\]|\[HttpPost\]/i,
}

export function detectTechnologies(logic: string): string[] {
  const found: string[] = []
  for (const [name, pattern] of Object.entries(TECH_SIGNATURES)) {
    if (pattern.test(logic)) found.push(name)
  }
  return found // empty array if nothing matched — never backfilled
}

export function measureAttackSurface(
  logic: string,
): { endpoints: number; forms: number; authRoutes: number } | undefined {
  const endpoints = (logic.match(/\b(app|router)\.(get|post|put|delete|patch)\s*\(/gi) || []).length
  const forms = (logic.match(/<form\b/gi) || []).length
  const authRoutes = (logic.match(/\/(login|auth|signin|signup|oauth|token)\b/gi) || []).length

  if (endpoints === 0 && forms === 0 && authRoutes === 0) return undefined
  return { endpoints, forms, authRoutes }
}

export function buildReconEvent(logic: string, id: string) {
  const attackSurfaceMetrics = measureAttackSurface(logic)
  return {
    id,
    type: 'recon' as const,
    label: 'Attack Surface Mapping',
    detail: attackSurfaceMetrics
      ? `Pattern-matched ${attackSurfaceMetrics.endpoints} route handler(s), ${attackSurfaceMetrics.forms} form(s), ${attackSurfaceMetrics.authRoutes} auth-related path(s) in the submitted input.`
      : 'No route handlers, forms, or auth paths were pattern-matched in the submitted input.',
    status: 'completed' as const,
    attackSurfaceMetrics,
  }
}

export function buildFingerprintEvent(logic: string, id: string) {
  const technologies = detectTechnologies(logic)
  return {
    id,
    type: 'fingerprint' as const,
    label: 'Technology Stack Fingerprinting',
    detail:
      technologies.length > 0
        ? 'Static signature match against known framework/library patterns in the submitted input.'
        : 'No known framework signatures matched in the submitted input.',
    status: 'completed' as const,
    technologies: technologies.length > 0 ? technologies : undefined,
  }
}
