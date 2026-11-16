import { execFile } from 'node:child_process'
import { createHash, createPublicKey, randomUUID, X509Certificate } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { privateDirectory, readPrivate, writePrivate } from './files.ts'

const run = promisify(execFile)
export function publicKeyPin(key: string | Buffer): string {
  return createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('hex')
}
export function certificatePin(cert: string | Buffer): string {
  return createHash('sha256')
    .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
}
async function openssl(args: string[]): Promise<string> {
  try {
    const result = await run('/usr/bin/openssl', args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      timeout: 15_000,
      maxBuffer: 32 * 1024,
    })
    if (args.includes('-verify') && !/verify OK/i.test(result.stdout + result.stderr))
      throw new Error('Certificate request signature did not verify')
    return result.stdout
  } catch {
    throw new Error(
      'Execution certificates require a working /usr/bin/openssl; certificate operation failed',
    )
  }
}
async function scratch<T>(root: string, work: (folder: string) => Promise<T>): Promise<T> {
  await privateDirectory(root)
  const folder = await mkdtemp(path.join(root, 'certificate-'))
  async function cleanup() {
    if (
      path.dirname(folder) !== root ||
      !(await lstat(folder)).isDirectory() ||
      (await realpath(folder)) !== folder ||
      !path.basename(folder).startsWith('certificate-')
    )
      throw new Error('Unsafe certificate cleanup')
    await rm(folder, { recursive: true })
  }
  try {
    return await work(folder)
  } finally {
    await cleanup()
  }
}
export interface ExecutionIdentity {
  key: string
  cert: string
  pin: string
}
export async function controllerIdentity(root: string): Promise<ExecutionIdentity> {
  await privateDirectory(root)
  const folder = path.join(root, 'identity')
  const found = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!found)
    await scratch(root, async (stage) => {
      await writePrivate(
        stage,
        'ca.conf',
        '[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\n',
      )
      await openssl([
        'req',
        '-config',
        path.join(stage, 'ca.conf'),
        '-x509',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-days',
        '3650',
        '-subj',
        '/CN=Ted execution controller',
        '-keyout',
        path.join(stage, 'key.pem'),
        '-out',
        path.join(stage, 'cert.pem'),
      ])
      // OpenSSL's output mode depends on its version and umask; normalize before publication.
      const { chmod } = await import('node:fs/promises')
      await chmod(path.join(stage, 'key.pem'), 0o600)
      await chmod(path.join(stage, 'cert.pem'), 0o600)
      await mkdir(folder, { mode: 0o700 })
      await rename(path.join(stage, 'key.pem'), path.join(folder, 'key.pem'))
      await rename(path.join(stage, 'cert.pem'), path.join(folder, 'cert.pem'))
    })
  await privateDirectory(folder)
  const key = await readPrivate(folder, 'key.pem'),
    cert = await readPrivate(folder, 'cert.pem')
  if (publicKeyPin(key) !== certificatePin(cert))
    throw new Error('Controller certificate does not match its key')
  return { key, cert, pin: certificatePin(cert) }
}
export async function workerIdentity(
  root: string,
): Promise<{ key: string; csr: string; pin: string }> {
  await privateDirectory(root)
  let key: string, csr: string
  try {
    key = await readPrivate(root, 'worker-key.pem')
    csr = await readPrivate(root, 'worker.csr')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const existingKey = await lstat(path.join(root, 'worker-key.pem')).catch(() => undefined)
    if (existingKey)
      throw new Error('Worker identity is incomplete; refusing to replace an existing key')
    await scratch(root, async (stage) => {
      await openssl([
        'req',
        '-new',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-subj',
        `/CN=${randomUUID()}`,
        '-keyout',
        path.join(stage, 'key.pem'),
        '-out',
        path.join(stage, 'request.csr'),
      ])
      const { chmod } = await import('node:fs/promises')
      await chmod(path.join(stage, 'key.pem'), 0o600)
      await chmod(path.join(stage, 'request.csr'), 0o600)
      await writePrivate(root, 'worker-key.pem', await readPrivate(stage, 'key.pem'))
      await writePrivate(root, 'worker.csr', await readPrivate(stage, 'request.csr'))
    })
    key = await readPrivate(root, 'worker-key.pem')
    csr = await readPrivate(root, 'worker.csr')
  }
  if ((await csrPin(root, csr)) !== publicKeyPin(key))
    throw new Error('Worker request does not match its private key')
  return { key, csr, pin: publicKeyPin(key) }
}
export async function csrPin(root: string, csr: string): Promise<string> {
  return scratch(root, async (folder) => {
    await writePrivate(folder, 'request.csr', csr)
    await openssl(['req', '-in', path.join(folder, 'request.csr'), '-verify', '-noout'])
    return publicKeyPin(
      await openssl(['req', '-in', path.join(folder, 'request.csr'), '-pubkey', '-noout']),
    )
  })
}
export async function issueCertificate(
  root: string,
  csr: string,
  grantId: string,
): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(grantId)) throw new Error('Invalid execution grant')
  return scratch(root, async (folder) => {
    await writePrivate(folder, 'request.csr', csr)
    await writePrivate(
      folder,
      'extensions',
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n',
    )
    await openssl([
      'x509',
      '-req',
      '-in',
      path.join(folder, 'request.csr'),
      '-CA',
      path.join(root, 'identity', 'cert.pem'),
      '-CAkey',
      path.join(root, 'identity', 'key.pem'),
      '-set_serial',
      `0x${randomUUID().replaceAll('-', '')}`,
      '-days',
      '365',
      '-extfile',
      path.join(folder, 'extensions'),
      '-out',
      path.join(folder, 'client.pem'),
    ])
    const { chmod } = await import('node:fs/promises')
    await chmod(path.join(folder, 'client.pem'), 0o600)
    return readPrivate(folder, 'client.pem')
  })
}
