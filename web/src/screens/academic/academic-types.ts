export interface AcademicContext {
  lessonCode: string
  /** Título visible: código del piloto o nombre de la página Moodle. */
  lessonTitle: string
  sourceVersion: string
  mode: 'learner' | 'instructor'
  parentOrigin: string
  viewKey: string
}

export interface AcademicMessage {
  role: string
  text: string
}
