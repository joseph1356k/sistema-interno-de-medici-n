/**
 * Ruta a la que envia de verdad el collector de cada PC: los eventos de Claude
 * Code y Codex. Ver la explicacion en ../metrics/route.ts.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export { POST } from '../../route'
