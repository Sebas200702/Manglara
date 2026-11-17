/** Traduce únicamente códigos públicos; nunca muestra errores crudos del proveedor. */
export const academicError = (code: string): string => {
  switch (code) {
    case 'RESPONSE_BLOCKED':
      return 'Esa respuesta no pasó la revisión de la lección. No se reprodujo. Inicia otra tutoría para continuar con habilidades verdes.'
    case 'REVIEW_UNAVAILABLE':
      return 'No pudimos revisar la respuesta. No se reprodujo. Puedes reintentar o continuar la actividad en Moodle.'
    case 'TURN_LIMIT':
    case 'TURN_TIMEOUT':
      return 'La respuesta superó el límite de revisión. Prueba con una pregunta más breve al iniciar otra tutoría.'
    case 'TURN_BUSY':
      return 'Se cruzaron dos preguntas. Inicia otra tutoría y espera la respuesta antes de preguntar de nuevo.'
    default:
      return 'Tutoría no disponible. Puedes seguir la actividad en Moodle.'
  }
}
