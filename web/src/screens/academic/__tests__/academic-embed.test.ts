import { afterEach, expect, test } from 'bun:test'
import { connectAcademicFrame } from '../academic-embed'

const originalWindow = globalThis.window
afterEach(() => { globalThis.window = originalWindow })

test('solo padre autorizado puede detener audio de instancia actual', () => {
  const sent: { value: unknown; origin: string }[] = []
  const parent = { postMessage: (value: unknown, origin: string) => sent.push({ value, origin }) }
  const mock = Object.assign(new EventTarget(), { parent })
  globalThis.window = mock as unknown as Window & typeof globalThis
  let stopped = 0
  const origin = 'https://aula.academia.localhost:8443'
  const instance = '123e4567-e89b-42d3-a456-426614174000'
  const bridge = connectAcademicFrame(origin, () => { stopped++ })
  const emit = (from: string, source: unknown, type: string, id = instance) => {
    const event = new Event('message')
    Object.defineProperties(event, {
      origin: { value: from }, source: { value: source },
      data: { value: { type, version: 1, instance: id, layout: 'lesson-panel' } },
    })
    mock.dispatchEvent(event)
  }
  emit(origin, parent, 'academic:hello')
  expect(sent.at(-1)?.value).toEqual({ type: 'academic:ready', version: 1, instance })
  emit('https://untrusted.invalid', parent, 'academic:stop')
  emit(origin, {}, 'academic:stop')
  emit(origin, parent, 'academic:stop', 'obsolete')
  expect(stopped).toBe(0)
  emit(origin, parent, 'academic:stop')
  expect(stopped).toBe(1)
  expect(sent.at(-1)).toEqual({ value: { type: 'academic:close', version: 1, instance }, origin })
  const escape = new Event('keydown', { cancelable: true })
  Object.defineProperties(escape, { key: { value: 'Escape' }, isComposing: { value: false } })
  mock.dispatchEvent(escape)
  expect(stopped).toBe(2)
  expect(escape.defaultPrevented).toBe(true)
  bridge.dispose()
  emit(origin, parent, 'academic:stop')
  expect(stopped).toBe(2)
})
