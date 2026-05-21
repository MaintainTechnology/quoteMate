// GET /api/admin/loader/template?csv=services|materials — download a CSV
// template with the exact header row (spec §7 — "admins never guess column
// names").
//
// Intentionally NOT admin-gated: the response is only the column-name
// header (the same list published in the spec), zero tenant/business data.
// Keeping it open lets the dashboard offer a plain <a download> link
// instead of an authenticated fetch+blob dance.

import { SERVICES_CSV_COLUMNS } from '@/lib/admin-loader/services-csv'
import { MATERIALS_CSV_COLUMNS } from '@/lib/admin-loader/materials-csv'

export const dynamic = 'force-dynamic'

const TEMPLATES: Record<string, readonly string[]> = {
  services: SERVICES_CSV_COLUMNS,
  materials: MATERIALS_CSV_COLUMNS,
}

export async function GET(req: Request) {
  const csv = new URL(req.url).searchParams.get('csv') ?? ''
  const columns = TEMPLATES[csv]
  if (!columns) {
    return Response.json(
      { error: 'unknown template — use ?csv=services or ?csv=materials' },
      { status: 400 },
    )
  }
  // Header row only — the exact template. No example data row, so an admin
  // cannot accidentally upload the sample.
  const body = `${columns.join(',')}\n`
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csv}-template.csv"`,
      'cache-control': 'no-store',
    },
  })
}
