import { expect, test } from 'bun:test'
import { academicError } from '../academic-error'

test('rechazo indica descarte y permite reiniciar; error privado nunca se muestra', () => {
  expect(academicError('RESPONSE_BLOCKED')).toContain('No se reprodujo')
  expect(academicError('REVIEW_UNAVAILABLE')).toContain('No pudimos revisar')
  expect(academicError('provider error: private-token')).not.toContain('private-token')
})
