import type { AcademicContext } from './academic-types'

/** Consulta sesión propia y valida respuesta de pasarela antes de renderizar contexto. */
export const getAcademicContext = async (signal: AbortSignal): Promise<AcademicContext> => {
  const view = new URL(window.location.href).searchParams.get('view')
  if (!view || !/^[a-f0-9]{64}$/.test(view)) throw new Error('Abre Manglara desde esta lección Moodle.')
  const response = await fetch(`/academic/api/context?view=${view}`, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new Error('Sesión cambió o venció. Vuelve a abrir Manglara desde esta lección.')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || !('lessonCode' in value) || typeof value.lessonCode !== 'string' || !('mode' in value) || !['learner', 'instructor'].includes(String(value.mode)) || !('sourceVersion' in value) || typeof value.sourceVersion !== 'string' || !('lessonTitle' in value) || typeof value.lessonTitle !== 'string') throw new Error('Contexto académico inválido.')
  if (!('parentOrigin' in value) || typeof value.parentOrigin !== 'string' || new URL(value.parentOrigin).origin !== value.parentOrigin || !value.parentOrigin.startsWith('https://')) throw new Error('Origen Moodle inválido.')
  if (!('viewKey' in value) || value.viewKey !== view) throw new Error('Contexto cambió. Reabre Manglara en esta lección.')
  return value as AcademicContext
}
