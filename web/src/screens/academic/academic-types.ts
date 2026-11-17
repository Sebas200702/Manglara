export interface AcademicContext {
  lessonCode: string
  sourceVersion: string
  mode: 'learner' | 'instructor'
  parentOrigin: string
  viewKey: string
}

export interface AcademicMessage {
  role: string
  text: string
}
