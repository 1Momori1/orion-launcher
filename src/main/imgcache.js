const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { fetchBuffer } = require('./net')
const { candidates, headers } = require('./mirrors')

const TTL_MS = 14 * 24 * 60 * 60 * 1000
const MAX_BYTES = 250 * 1024 * 1024
const inflight = new Map()

function rootDir() {
	const { paths, ensureDirs } = require('./config')
	ensureDirs()
	const dir = path.join(paths().cache, 'img')
	fs.mkdirSync(dir, { recursive: true })
	return dir
}

function hashUrl(url) {
	return crypto.createHash('sha1').update(String(url || '')).digest('hex')
}

function fileForHash(hash) {
	const h = String(hash || '').replace(/[^a-f0-9]/gi, '')
	if (h.length < 16) return null
	return path.join(rootDir(), h)
}

function fileForRequest(requestUrl) {
	const raw = String(requestUrl || '').replace(/^orionimg:\/\//i, '').replace(/\/$/, '').split('?')[0]
	return fileForHash(raw)
}

function localHref(hash) {
	return 'orionimg://' + hash
}

function peek(url) {
	if (!url || url.startsWith('orionimg:') || url.startsWith('data:') || url === 'logo.png') return url || ''
	const hash = hashUrl(url)
	const file = fileForHash(hash)
	if (file && fs.existsSync(file) && fs.statSync(file).size > 32) return localHref(hash)
	return null
}

function extFrom(headers, url) {
	const ct = String((headers && (headers['content-type'] || headers['Content-Type'])) || '').toLowerCase()
	if (ct.includes('png')) return '.png'
	if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
	if (ct.includes('webp')) return '.webp'
	if (ct.includes('gif')) return '.gif'
	const m = String(url).match(/\.(png|jpe?g|webp|gif)(\?|$)/i)
	return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : ''
}

async function downloadOnce(url) {
	let last = null
	const list = candidates(url)
	for (const u of list) {
		try {
			const r = await fetchBuffer(u, {
				headers: headers({ Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }),
				timeout: 10000,
			})
			if (r && r.buffer && r.buffer.length > 32) return r
		} catch (e) {
			last = e
		}
	}
	throw last || new Error('Картинка не скачалась')
}

function isFresh(file) {
	try {
		const st = fs.statSync(file)
		return st.size > 32 && (Date.now() - st.mtimeMs) < TTL_MS
	} catch (e) {
		return false
	}
}

async function ensure(url) {
	if (!url || url.startsWith('orionimg:') || url.startsWith('data:') || url === 'logo.png') return url || ''
	const hash = hashUrl(url)
	const file = fileForHash(hash)
	if (isFresh(file)) return localHref(hash)
	if (file && fs.existsSync(file) && fs.statSync(file).size > 32) {
		refresh(url, file).catch(() => {})
		return localHref(hash)
	}
	if (inflight.has(hash)) return inflight.get(hash)
	const job = (async () => {
		try {
			const r = await downloadOnce(url)
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, r.buffer)
			sweep()
			return localHref(hash)
		} finally {
			inflight.delete(hash)
		}
	})()
	inflight.set(hash, job)
	return job
}

async function refresh(url, file) {
	const r = await downloadOnce(url)
	if (r && r.buffer && r.buffer.length > 32) fs.writeFileSync(file, r.buffer)
}

function sweep() {
	let files
	try { files = fs.readdirSync(rootDir()).map((n) => path.join(rootDir(), n)) } catch (e) { return }
	let total = 0
	const stats = []
	for (const f of files) {
		try {
			const st = fs.statSync(f)
			if (!st.isFile()) continue
			total += st.size
			stats.push({ f, mtime: st.mtimeMs, size: st.size })
		} catch (e) { /* skip */ }
	}
	if (total <= MAX_BYTES) return
	stats.sort((a, b) => a.mtime - b.mtime)
	for (const s of stats) {
		if (total <= MAX_BYTES) break
		try { fs.unlinkSync(s.f); total -= s.size } catch (e) { /* skip */ }
	}
}

async function cacheList(urls, { waitMs = 1600 } = {}) {
	const out = []
	await Promise.all((urls || []).map(async (url, i) => {
		if (!url) { out[i] = url; return }
		const ready = peek(url)
		if (ready) { out[i] = ready; return }
		const job = ensure(url).catch(() => url)
		const got = await Promise.race([
			job,
			new Promise((r) => setTimeout(() => r(null), waitMs)),
		])
		out[i] = got || url
	}))
	return out
}

module.exports = {
	peek,
	ensure,
	cacheList,
	fileForHash,
	fileForRequest,
	localHref,
	hashUrl,
}
