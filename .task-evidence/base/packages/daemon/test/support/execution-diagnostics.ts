import { redactSecrets } from '../../src/redact.ts'

export class ExecutionDiagnostics {
  #partial = ''
  #text = ''
  #dropping = false
  #truncated = false

  push(chunk: string) {
    for (const [index, part] of chunk.split('\n').entries()) {
      if (index > 0) {
        this.#append(this.#dropping ? '[overlong diagnostic line omitted]' : this.#partial)
        this.#partial = ''
        this.#dropping = false
      }
      if (this.#dropping) continue
      this.#partial += part
      if (Buffer.byteLength(this.#partial) > 64 * 1024) {
        this.#partial = ''
        this.#dropping = true
        this.#truncated = true
      }
    }
  }
  #append(line: string) {
    this.#text += `${redactSecrets(line)}\n`
    while (Buffer.byteLength(this.#text) > 192 * 1024) {
      this.#text = this.#text.slice(this.#text.indexOf('\n') + 1)
      this.#truncated = true
    }
  }
  get text() {
    const tail = this.#dropping
      ? '[overlong diagnostic line omitted]'
      : redactSecrets(this.#partial)
    return `${this.#truncated ? '[diagnostics truncated]\n' : ''}${this.#text}${tail}`
  }
}
