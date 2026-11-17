import { useCallback, useEffect, useRef, useState } from 'react'
import { AvatarController } from '../../components/avatar/avatar-controller'
import { VoiceClient } from '../../lib/voice-client'
import type { AcademicContext, AcademicMessage } from './academic-types'
import { getAcademicContext } from './academic-service'
import { connectAcademicFrame } from './academic-embed'
import { academicError } from './academic-error'

/** Gestiona tutor incrustado y libera captura/conexiones al salir de actividad. */
export const useAcademicTutor = () => {
  const container = useRef<HTMLDivElement | null>(null)
  const conversation = useRef<HTMLDivElement | null>(null)
  const avatar = useRef<AvatarController | null>(null)
  const client = useRef<VoiceClient | null>(null)
  const heartbeat = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const connectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const responseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = useRef(false)
  const awaiting = useRef(false)
  const speakingNow = useRef(false)
  const frame = useRef<ReturnType<typeof connectAcademicFrame> | null>(null)
  const [academic, setAcademic] = useState<AcademicContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState(false)
  const [avatarReady, setAvatarReady] = useState(false)
  const [connected, setConnected] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [panelLayout, setPanelLayout] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [responding, setResponding] = useState(false)
  const [hasResponse, setHasResponse] = useState(false)
  const [messages, setMessages] = useState<AcademicMessage[]>([])

  useEffect(() => {
    if (messages.length > 0 && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight
  }, [messages])

  const stop = useCallback(() => {
    active.current = false
    awaiting.current = false
    speakingNow.current = false
    clearInterval(heartbeat.current)
    clearTimeout(connectionTimer.current)
    clearTimeout(responseTimer.current)
    client.current?.disconnect()
    client.current = null
    avatar.current?.stopStream()
    setConnected(false)
    setSpeaking(false)
    setConnecting(false)
    setResponding(false)
  }, [])

  useEffect(() => {
    if (!academic) return
    const embedded = connectAcademicFrame(academic.parentOrigin, stop, () => setPanelLayout(true))
    frame.current = embedded
    return () => { embedded.dispose(); frame.current = null }
  }, [academic, stop])

  useEffect(() => {
    if (error) frame.current?.error()
  }, [error])

  useEffect(() => {
    const abort = new AbortController()
    void getAcademicContext(abort.signal).then(setAcademic)
      .catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'No se pudo validar sesión.') })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (!container.current) return
    const controller = new AvatarController(container.current, {
      onReady: () => setAvatarReady(true),
      onError: () => setAvatarError(true),
      onSpeakingChange: (speaking) => {
        speakingNow.current = speaking
        setSpeaking(speaking)
        client.current?.setInputSuppressed(speaking || awaiting.current)
      },
    })
    avatar.current = controller
    void controller.init().catch(() => setAvatarError(true))
    return () => { stop(); controller.dispose(); avatar.current = null }
  }, [stop])

  useEffect(() => {
    avatar.current?.setState(speaking ? 'speaking' : connected ? 'listening' : 'idle')
  }, [speaking, connected])

  useEffect(() => {
    client.current?.setInputSuppressed(speaking || responding)
  }, [speaking, responding])

  useEffect(() => {
    window.addEventListener('pagehide', stop)
    return () => window.removeEventListener('pagehide', stop)
  }, [stop])

  const prepareResponse = () => {
    awaiting.current = true
    setResponding(true)
    setHasResponse(false)
    client.current?.setInputSuppressed(true)
    clearTimeout(responseTimer.current)
    responseTimer.current = setTimeout(() => {
      setError('Respuesta tardó demasiado. Vuelve a iniciar tutoría desde Moodle. Código: RESPONSE_TIMEOUT')
      stop()
    }, 90000)
  }

  const start = async (voice: boolean) => {
    if (!academic || active.current) return
    active.current = true
    setError(null)
    setConnecting(true)
    connectionTimer.current = setTimeout(() => {
      setError('Conexión tardó demasiado. Puedes continuar actividad Moodle. Código: CONNECTION_TIMEOUT')
      stop()
    }, 30000)
    const origin = window.location.origin.replace(/^https:/, 'wss:')
    const connection = new VoiceClient({
      onSessionReady: () => { clearTimeout(connectionTimer.current); if (active.current) { setConnected(true); setConnecting(false) } },
      onTranscript: (role, text) => {
        setMessages((items) => {
          const last = items.at(-1)
          if (last?.role === role) return [...items.slice(0, -1), { ...last, text: (last.text + text).slice(-20000) }]
          return [...items.slice(-99), { role, text }]
        })
        if (role === 'model') avatar.current?.feedTranscript(text)
      },
      onTurnComplete: () => {
        avatar.current?.notifyEnd()
        clearTimeout(responseTimer.current)
        awaiting.current = false
        setResponding(false)
        setHasResponse(true)
      },
      onResponsePending: prepareResponse,
      onSpeakingChange: (speaking) => { speakingNow.current = speaking; setSpeaking(speaking) },
      onInterrupted: () => {
        avatar.current?.interrupt()
        clearTimeout(responseTimer.current)
        awaiting.current = false
        setResponding(false)
      },
      onError: (message) => { setError(academicError(message)); stop() },
      onConnectionChange: (state) => {
        if (state === 'disconnected' && active.current) {
          setError('Conexión finalizada. Puedes volver a iniciar desde Moodle.'); stop()
        }
      },
    }, `${origin}/academic/ws/voice?view=${academic.viewKey}`)
    client.current = connection
    try {
      // La salida de voz es común a ambos modos; solo entrada por voz pide micrófono.
      if (avatar.current?.isReady) {
        await avatar.current.startStream()
        connection.setAudioChunkSink((pcm) => avatar.current?.feedAudio(pcm))
      } else if (!voice) await connection.startPlayback()
      if (!active.current) { connection.disconnect(); avatar.current?.stopStream(); return }
      await connection.connect()
      if (!active.current) { connection.disconnect(); return }
      if (voice) {
        await connection.startMic({ camera: false })
        if (!active.current) { connection.disconnect(); return }
      }
      heartbeat.current = setInterval(() => connection.sendHeartbeat(), 10000)
    } catch {
      if (active.current) setError('No se pudo iniciar tutoría o sonido. Reintenta y revisa permisos de audio.')
      stop()
    }
  }

  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > 4000 || awaiting.current || speakingNow.current || !client.current?.sendText(trimmed)) return false
    prepareResponse()
    setMessages((items) => [...items.slice(-99), { role: 'user', text: trimmed }])
    return true
  }
  const close = () => { stop(); frame.current?.close() }
  const canStart = Boolean(academic && (avatarReady || avatarError) && !connected && !connecting)
  return { container, conversation, academic, error, avatarError, avatarReady, canStart, panelLayout, connected, speaking, connecting, responding, hasResponse, messages, start, close, stop, send }
}
