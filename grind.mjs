// Generates Solana keypairs whose address ends with SUFFIX and uploads each one to the localpad address pool.
// Runs on every CPU core. Usage (GitHub Actions sets these): SITE_URL=https://… ADMIN_TOKEN=… SUFFIX=LP node grind.mjs
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { cpus } from 'node:os'

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function b58(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  while (n > 0n) {
    s = ALPH[Number(n % 58n)] + s
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    s = '1' + s
  }
  return s
}

if (isMainThread) {
  const SITE = (process.env.SITE_URL || '').replace(/\/$/, '')
  const TOKEN = process.env.ADMIN_TOKEN || ''
  const SUFFIX = process.env.SUFFIX || 'LP'
  const MINUTES = Number(process.env.MINUTES || 340)
  const MAX = Number(process.env.MAX || 0) // stop after this many addresses (0 = no limit)
  if (!SITE || !TOKEN) {
    console.error('SITE_URL and ADMIN_TOKEN are required')
    process.exit(1)
  }
  if ([...SUFFIX].some((c) => !ALPH.includes(c))) {
    console.error('SUFFIX contains characters that never appear in Solana addresses (0 O I l)')
    process.exit(1)
  }
  const threads = Math.max(1, cpus().length)
  console.log(`grinding …${SUFFIX} on ${threads} threads for ${MINUTES} minutes`)
  let tries = 0, found = 0
  const started = Date.now()
  const upload = async (secret) => {
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetch(`${SITE}/api/admin?a=add`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN }, body: JSON.stringify({ keys: [secret] }) })
        const j = await r.json()
        if (j.success) return console.log(`uploaded (pool now ${j.left})`)
        console.error('upload refused:', j.msg)
        return
      } catch (e) {
        console.error('upload failed, retrying:', e.message)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }
  const workers = Array.from({ length: threads }, () => {
    const w = new Worker(new URL(import.meta.url), { workerData: { suffix: SUFFIX } })
    w.on('message', async (m) => {
      if (m.count) tries += m.count
      if (m.secret) {
        if (MAX && found >= MAX) return
        found++
        console.log(`found ${m.address}`)
        await upload(m.secret)
        if (MAX && found >= MAX) {
          console.log(`reached ${MAX} addresses, stopping`)
          workers.forEach((x) => x.terminate())
          setTimeout(() => process.exit(0), 5000)
        }
      }
    })
    return w
  })
  const tick = setInterval(() => {
    const s = (Date.now() - started) / 1000
    console.log(`${Math.round(tries / s).toLocaleString()} keys/s · ${found} found · ${Math.round(s / 60)} min`)
  }, 60_000)
  setTimeout(() => {
    clearInterval(tick)
    workers.forEach((w) => w.terminate())
    console.log(`done: ${found} addresses`)
    setTimeout(() => process.exit(0), 20_000)
  }, MINUTES * 60_000)
} else {
  const { subtle } = globalThis.crypto
  const suffix = workerData.suffix
  const n = suffix.length
  let target = 0
  for (const ch of suffix) target = target * 58 + ALPH.indexOf(ch)
  const M = 58 ** n
  const pw = new Array(32)
  let p = 1
  for (let i = 31; i >= 0; i--) {
    pw[i] = p
    p = (p * 256) % M
  }
  const BATCH = 128
  let count = 0, last = Date.now()
  for (;;) {
    const keys = await Promise.all(Array.from({ length: BATCH }, () => subtle.generateKey({ name: 'Ed25519' }, true, ['sign'])))
    const pubs = await Promise.all(keys.map((k) => subtle.exportKey('raw', k.publicKey)))
    for (let i = 0; i < BATCH; i++) {
      const pub = new Uint8Array(pubs[i])
      let r = 0
      for (let j = 0; j < 32; j++) r += pub[j] * pw[j]
      if (r % M === target) {
        const pk8 = new Uint8Array(await subtle.exportKey('pkcs8', keys[i].privateKey))
        const secret = new Uint8Array(64)
        secret.set(pk8.slice(-32), 0)
        secret.set(pub, 32)
        parentPort.postMessage({ secret: b58(secret), address: b58(pub) })
      }
    }
    count += BATCH
    if (Date.now() - last > 5000) {
      parentPort.postMessage({ count })
      count = 0
      last = Date.now()
    }
  }
}
