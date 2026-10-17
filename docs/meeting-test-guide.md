# Guía de pruebas — Live Meeting con Manglara

Toda la validación del bot de reuniones se hace contra **reuniones reales vacías** creadas por el equipo. No hay harness fake.

## Crear reuniones de prueba

| Proveedor | Cómo crear una vacía |
|-----------|----------------------|
| Teams | App de Teams → **Reunir ahora** → copiar el link de invitación |
| Zoom | App/web de Zoom → **New Meeting** → copiar el link de invitación |
| Meet | [meet.google.com](https://meet.google.com) → **Nueva reunión** → copiar el link |

Reglas:

- El host (tú) debe estar en la reunión para **admitir al bot** desde la sala de espera.
- La reunión debe permitir invitados. Si Meet exige cuenta del workspace, usar perfil logueado (ver T5.1).
- El bot se une con el nombre `Manglara` (o `MEETING_BOT_NAME`).

## Checklist Hito A — join y controles sin voz (Fase 1)

Repetir por proveedor (Teams, Zoom, Meet):

- [ ] `POST /meetings/join` con el link → estado `joining`
- [ ] El bot aparece en la sala de espera (visible para el host)
- [ ] Host admite → estado `in_meeting`
- [ ] El bot aparece como participante con cámara (logo/imagen Fase 1)
- [ ] `POST /meetings/{id}/mic {enabled:false}` → el bot queda silenciado en la reunión
- [ ] `POST /meetings/{id}/mic {enabled:true}` → el bot vuelve a estar audible
- [ ] `POST /meetings/{id}/cam {enabled:false/true}` → video se apaga/enciende
- [ ] `POST /meetings/{id}/leave` → el bot sale, estado `closed`

## Checklist Hito B — interacción con Gemini (Fase 2 + 3)

- [ ] Desde `/reunion`: pegar link → badge detecta el proveedor → **Conectar**
- [ ] En la reunión se ve a Manglara dormida (avatar idle, muda)
- [ ] Pulsar **▶ Iniciar Manglara Meeting Live** → estado activa
- [ ] Con una 2ª persona en la reunión (otro dispositivo): habla → Manglara responde audible
- [ ] **Silenciar** desde la web: su voz se corta pero sigue escuchando (responde al reactivar)
- [ ] **Apagar interacción**: deja de responder, sigue en la reunión; **▶** la reactiva
- [ ] **Desconectar**: sale de la reunión y libera todo

## Checklist Hito C — avatar en video (Fase 4)

- [ ] Los participantes ven el avatar animado (no imagen estática)
- [ ] Cuando Manglara habla, la boca se mueve sincronizada con su voz
- [ ] Al silenciar desde la web, el avatar queda idle pero visible

## Checklist Hito D — resiliencia (Fase 5)

- [ ] La reunión termina (host cierra) → la UI muestra estado coherente, backend limpio
- [ ] Matar el browser a mano → error claro en UI, sin procesos colgados
- [ ] Superar `MEETING_MAX_DURATION_MIN` → salida ordenada con aviso
- [ ] Join a Meet de workspace con perfil logueado

## Registro de resultados

Anotar cada prueba real aquí; los cambios de selectores van en `docs/meeting-provider-recipes.md`:

| Fecha | Proveedor | Prueba | Resultado | Notas |
|-------|-----------|--------|-----------|-------|
|       |           |        |           |       |

## Notas

- Usar siempre cuenta propia y nombre identificable ("Manglara").
- Los bots automáticos pueden violar los términos de los proveedores: probar solo en reuniones propias.
