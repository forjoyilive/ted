export class RequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class AnswerSavedError extends RequestError {
  constructor(message: string) {
    super(409, message)
  }
}

export class AlreadyStartedError extends RequestError {
  constructor(message: string) {
    super(409, message)
  }
}
