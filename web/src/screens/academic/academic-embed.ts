/** Control DOM autenticado por origen/ventana/instancia; nunca autoriza contexto. */
export const connectAcademicFrame = (parentOrigin: string, stop: () => void, showPanelLayout?: () => void) => {
  let instance: string | undefined
  let panel = false
  const send = (type: string) => {
    if (instance && window.parent !== window) window.parent.postMessage({ type, version: 1, instance }, parentOrigin)
  }
  const stopAndClose = () => { try { stop() } finally { send('academic:close') } }
  const listener = (event: MessageEvent<unknown>) => {
    const data = event.data
    if (event.origin !== parentOrigin || event.source !== window.parent || !data || typeof data !== 'object' || !('type' in data) || !('version' in data) || data.version !== 1 || !('instance' in data) || typeof data.instance !== 'string' || !/^[a-f0-9-]{36}$/.test(data.instance)) return
    if (data.type === 'academic:hello') {
      instance = data.instance
      panel = 'layout' in data && data.layout === 'lesson-panel'
      if (panel) showPanelLayout?.()
      send('academic:ready')
    } else if (data.type === 'academic:stop' && instance && data.instance === instance) {
      stopAndClose()
    }
  }
  window.addEventListener('message', listener)
  const escape = (event: KeyboardEvent) => {
    if (panel && instance && event.key === 'Escape' && !event.isComposing) {
      event.preventDefault()
      stopAndClose()
    }
  }
  window.addEventListener('keydown', escape)
  return { close: () => send('academic:close'), error: () => send('academic:error'), dispose: () => { window.removeEventListener('message', listener); window.removeEventListener('keydown', escape) } }
}
