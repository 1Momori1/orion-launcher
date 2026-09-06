const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { Transform } = require('stream')

const AGENTS = {
	http: new http.Agent({ keepAlive: true, maxSockets: 64 }),
	https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
}

const CONNECT_TIMEOUT_MS = 15000
const STALL_WINDOW_MS = 15000
const STALL_MIN_BYTES = 64 * 1024
const CHUNK_SIZE = 12 * 1024 * 1024
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024
const MAX_RETRIES_PER_CHUNK = 5
const CANCEL_POLL_MS = 250

function assertHttpUrl(url) {
	let parsed
	try { parsed = new URL(String(url || '')) } catch (e) {
		throw Object.assign(new Error('Некорректная ссылка'), { retryable: false })
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw Object.assign(new Error('Запрещённый протокол загрузки'), { retryable: false })
	}
	return parsed.toString()
}

function libFor(url) { return url.startsWith('https') ? https : http }
function agentFor(url) { return url.startsWith('https') ? AGENTS.https : AGENTS.http }

function fetchJson(url, { headers = {}, timeout = 20000, signal = null } = {}) {
	url = assertHttpUrl(url)
	return request('GET', url, { headers, timeout, signal }).then(r => {
		try { return JSON.parse(r.body) } catch (e) { return r.body }
	})
}

function fetchBuffer(url, { headers = {}, timeout = 20000, maxRedirects = 5, signal = null } = {}) {
	url = assertHttpUrl(url)
	return new Promise((resolve, reject) => {
		if (signal && signal.cancelled) {
			return reject(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
		}
		const req = libFor(url).request(url, { method: 'GET', headers, agent: agentFor(url), timeout }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume()
				if (maxRedirects <= 0) return reject(new Error('Слишком много редиректов'))
				const next = new URL(res.headers.location, url).toString()
				return fetchBuffer(next, { headers, timeout, maxRedirects: maxRedirects - 1, signal }).then(resolve, reject)
			}
			const chunks = []
			res.on('data', c => chunks.push(c))
			res.on('end', () => {
				const buf = Buffer.concat(chunks)
				if (res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode} GET ${url}`))
				} else {
					resolve({ status: res.statusCode, headers: res.headers, buffer: buf })
				}
			})
		})
		const tick = signal ? setInterval(() => {
			if (signal.cancelled) {
				clearInterval(tick)
				req.destroy(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
			}
		}, 200) : null
		req.on('timeout', () => req.destroy(new Error(`Таймаут запроса: ${url}`)))
		req.on('error', (e) => {
			if (tick) clearInterval(tick)
			reject(e)
		})
		req.on('close', () => { if (tick) clearInterval(tick) })
		req.end()
	})
}

function request(method, url, { headers = {}, body = null, timeout = 20000, maxRedirects = 5, signal = null } = {}) {
	url = assertHttpUrl(url)
	return new Promise((resolve, reject) => {
		if (signal && signal.cancelled) {
			return reject(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
		}
		const req = libFor(url).request(url, { method, headers, agent: agentFor(url), timeout }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume()
				if (maxRedirects <= 0) return reject(new Error('Слишком много редиректов'))
				const next = new URL(res.headers.location, url).toString()
				return request(method, next, { headers, body: method === 'GET' ? null : body, timeout, maxRedirects: maxRedirects - 1, signal }).then(resolve, reject)
			}
			const chunks = []
			res.on('data', c => chunks.push(c))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				if (res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode} ${method} ${url} — ${text.slice(0, 200)}`))
				} else {
					resolve({ status: res.statusCode, headers: res.headers, body: text })
				}
			})
		})
		const tick = signal ? setInterval(() => {
			if (signal.cancelled) {
				clearInterval(tick)
				req.destroy(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
			}
		}, 200) : null
		req.on('timeout', () => req.destroy(new Error(`Таймаут запроса: ${url}`)))
		req.on('error', (e) => {
			if (tick) clearInterval(tick)
			reject(e.cancelled ? e : e)
		})
		req.on('close', () => { if (tick) clearInterval(tick) })
		if (body) req.write(body)
		req.end()
	})
}

function throwIfCancelled(signal) {
	if (signal && signal.cancelled) {
		throw Object.assign(new Error('Отменено пользователем'), { cancelled: true })
	}
}

function ensurePartFile(partPath) {
	const fd = fs.openSync(partPath, 'a+')
	fs.closeSync(fd)
}

function unlinkQuiet(p) {
	try { fs.unlinkSync(p) } catch (e) {}
}

function partSize(partPath) {
	try { return fs.statSync(partPath).size } catch (e) { return 0 }
}

function fsyncPath(p) {
	const fd = fs.openSync(p, 'r+')
	try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function downloadHeaders(headers) {
	return { 'Accept-Encoding': 'identity', ...headers }
}

function probeContentLength(url, headers, maxRedirects = 5, method = 'HEAD') {
	url = assertHttpUrl(url)
	return new Promise((resolve, reject) => {
		const reqHeaders = downloadHeaders(headers)
		if (method === 'GET') reqHeaders.Range = 'bytes=0-0'
		const req = libFor(url).request(url, {
			method,
			headers: reqHeaders,
			agent: agentFor(url),
		}, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume()
				if (maxRedirects <= 0) return resolve({ size: null, url, acceptRanges: false })
				const next = new URL(res.headers.location, url).toString()
				return probeContentLength(next, headers, maxRedirects - 1, method).then(resolve, reject)
			}
			if (res.statusCode >= 400) {
				res.resume()
				if (method === 'HEAD') {
					return probeContentLength(url, headers, maxRedirects, 'GET').then(resolve, reject)
				}
				return resolve({ size: null, url, acceptRanges: false })
			}
			const cr = res.headers['content-range']
			const ranged = /\/(\d+)\s*$/.exec(cr || '')
			const len = parseInt(res.headers['content-length'], 10)
			const acceptRanges = /bytes/i.test(res.headers['accept-ranges'] || '') || res.statusCode === 206
			// 200 на GET с Range = сервер игнорит Range и может слать весь файл — сразу рвём, не вычитываем гигабайты
			if (method === 'GET' && res.statusCode === 200) {
				req.destroy()
				return resolve({
					size: Number.isFinite(len) ? len : null,
					url,
					acceptRanges: false,
				})
			}
			res.resume()
			if (ranged) return resolve({ size: parseInt(ranged[1], 10), url, acceptRanges: true })
			resolve({
				size: Number.isFinite(len) ? len : null,
				url,
				acceptRanges,
			})
		})
		const timer = setTimeout(() => req.destroy(Object.assign(new Error('Таймаут HEAD/probe'), { retryable: true })), CONNECT_TIMEOUT_MS)
		req.on('error', (e) => { clearTimeout(timer); reject(e) })
		req.on('close', () => clearTimeout(timer))
		req.end()
	}).catch((e) => {
		if (method === 'HEAD' && !(e && e.cancelled)) {
			return probeContentLength(url, headers, maxRedirects, 'GET')
		}
		throw e
	})
}

function fetchRange({
	url,
	headers,
	startByte,
	endByte,
	writeStreamFactory,
	onBytes,
	signal,
	maxRedirects = 5,
	stallMs = STALL_WINDOW_MS,
	label = '',
}) {
	url = assertHttpUrl(url)
	return new Promise((resolve, reject) => {
		if (signal && signal.cancelled) {
			return reject(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
		}

		const reqHeaders = downloadHeaders(headers)
		if (startByte != null) {
			reqHeaders.Range = `bytes=${startByte}-${endByte != null ? endByte : ''}`
		}

		let settled = false
		let handedOff = false
		let connectTimer = null
		let stallInterval = null
		let cancelInterval = null
		let req = null

		const finish = (err, value) => {
			if (settled) return
			settled = true
			clearTimeout(connectTimer)
			clearInterval(stallInterval)
			clearInterval(cancelInterval)
			if (err) reject(err)
			else resolve(value)
		}

		const fail = (err, extra = {}) => {
			finish(Object.assign(err, extra))
		}

		req = libFor(url).get(url, { headers: reqHeaders, agent: agentFor(url) }, (res) => {
			clearTimeout(connectTimer)
			if (req.socket) req.socket.setTimeout(0)

			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume()
				if (maxRedirects <= 0) return fail(new Error('Слишком много редиректов'), { retryable: false })
				handedOff = true
				const next = new URL(res.headers.location, url).toString()
				return fetchRange({
					url: next, headers, startByte, endByte, writeStreamFactory, onBytes, signal,
					maxRedirects: maxRedirects - 1, stallMs, label,
				}).then((v) => finish(null, v), (e) => finish(e))
			}

			if (res.statusCode === 416) {
				res.resume()
				return fail(Object.assign(new Error('range-reset'), { retryable: true, rangeReset: true }))
			}

			const askedRange = startByte != null
			if (res.statusCode !== 200 && res.statusCode !== 206) {
				res.resume()
				// Часть CDN (forgecdn) отвечает 404 именно на Range, а полный GET живой.
				// Иначе большой zip падает на первом чанке, не дойдя до однопоточного отката.
				if (askedRange && (res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 501)) {
					return fail(Object.assign(new Error('no-range'), { retryable: false, noRange: true, status: res.statusCode }))
				}
				return fail(
					new Error(`HTTP ${res.statusCode} при загрузке${label ? ': ' + label : ''}`),
					{ retryable: res.statusCode >= 500 || res.statusCode === 429 || res.statusCode === 404, status: res.statusCode }
				)
			}
			const gotRange = res.statusCode === 206
			if (askedRange && !gotRange && startByte > 0) {
				res.resume()
				return fail(Object.assign(new Error('no-range'), { retryable: false, noRange: true }))
			}
			if (gotRange && startByte != null) {
				const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers['content-range'] || '')
				if (!cr || parseInt(cr[1], 10) !== startByte) {
					res.resume()
					return fail(Object.assign(new Error('no-range'), { retryable: false, noRange: true }))
				}
			}

			let bytesSinceCheck = 0
			let counted = 0
			const meter = new Transform({
				transform(chunk, _enc, cb) {
					bytesSinceCheck += chunk.length
					counted += chunk.length
					if (onBytes) onBytes(chunk.length)
					cb(null, chunk)
				},
			})

			stallInterval = setInterval(() => {
				if (bytesSinceCheck < STALL_MIN_BYTES) {
					req.destroy(Object.assign(new Error('Соединение зависло (мало данных за окно)'), { retryable: true }))
					return
				}
				bytesSinceCheck = 0
			}, stallMs)

			let out
			try { out = writeStreamFactory({ gotRange, status: res.statusCode }) }
			catch (e) {
				res.resume()
				return fail(e, { retryable: true })
			}

			pipeline(res, meter, out)
				.then(() => finish(null, { gotRange, fullDownload: !gotRange, finalUrl: url, bytes: counted }))
				.catch((e) => fail(e, { retryable: !e.cancelled }))
		})

		connectTimer = setTimeout(() => {
			req.destroy(Object.assign(new Error('Таймаут подключения'), { retryable: true }))
		}, CONNECT_TIMEOUT_MS)

		cancelInterval = setInterval(() => {
			if (signal && signal.cancelled) {
				req.destroy(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
			}
		}, CANCEL_POLL_MS)

		req.on('error', (e) => {
			if (handedOff) return
			fail(e, { retryable: !e.cancelled })
		})
	})
}

async function fetchRangeWithRetry(params, attempts = MAX_RETRIES_PER_CHUNK) {
	let lastErr = null
	for (let i = 0; i < attempts; i++) {
		throwIfCancelled(params.signal)
		try {
			return await fetchRange(params)
		} catch (e) {
			if (e.cancelled || e.noRange || !e.retryable) throw e
			lastErr = e
			await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** i, 10000)))
		}
	}
	throw lastErr
}

async function downloadSingle(url, partPath, {
	headers, startAt, onChunk, signal, maxRedirects, stallMs,
}) {
	const result = await fetchRange({
		url,
		headers,
		startByte: startAt > 0 ? startAt : null,
		endByte: null,
		writeStreamFactory: ({ gotRange }) => {
			const appending = gotRange && startAt > 0
			return fs.createWriteStream(partPath, appending ? { flags: 'a' } : { flags: 'w' })
		},
		onBytes: onChunk,
		signal,
		maxRedirects,
		stallMs,
		label: path.basename(partPath, '.part'),
	})
	return result
}

async function downloadChunked(url, partPath, {
	headers, total, onChunk, signal, maxRedirects, stallMs,
}) {
	ensurePartFile(partPath)
	let start = partSize(partPath)
	if (start > total) {
		fs.truncateSync(partPath, 0)
		start = 0
	}

	let target = url
	while (start < total) {
		throwIfCancelled(signal)
		const chunkStart = start
		const end = Math.min(chunkStart + CHUNK_SIZE - 1, total - 1)
		const need = end - chunkStart + 1

		const result = await fetchRangeWithRetry({
			url: target,
			headers,
			startByte: chunkStart,
			endByte: end,
			writeStreamFactory: () => fs.createWriteStream(partPath, { flags: 'r+', start: chunkStart }),
			onBytes: onChunk,
			signal,
			maxRedirects,
			stallMs,
			label: path.basename(partPath, '.part'),
		})

		if (result.finalUrl) target = result.finalUrl
		fsyncPath(partPath)

		// CDN после редиректа часто отвечает 200 на весь файл — только с нуля,
		// иначе смещения Range уже не сходятся и нужен однопоточный откат.
		if (result.fullDownload) {
			if (chunkStart !== 0) {
				throw Object.assign(new Error('no-range'), { retryable: false, noRange: true })
			}
			return result
		}

		const onDisk = partSize(partPath)
		if (!result.gotRange || result.bytes !== need || onDisk !== end + 1) {
			throw Object.assign(new Error('chunk-short'), { retryable: true })
		}
		start = onDisk
	}
	return { finalUrl: target }
}

async function verifyDownload(partPath, destPath, {
	expectedSha512, expectedSha256, expectedSha1, expectedSize,
}) {
	if (expectedSize != null) {
		const sz = fs.statSync(partPath).size
		if (sz !== expectedSize) {
			unlinkQuiet(partPath)
			throw Object.assign(new Error(`Неверный размер: ${path.basename(destPath)}`), { retryable: true })
		}
	}
	const expected = expectedSha512 || expectedSha256 || expectedSha1
	const algo = expectedSha512 ? 'sha512' : expectedSha256 ? 'sha256' : expectedSha1 ? 'sha1' : null
	if (algo && expected) {
		const actual = await hashFile(partPath, algo)
		if (actual !== String(expected).toLowerCase()) {
			unlinkQuiet(partPath)
			throw Object.assign(new Error(`Файл повреждён при загрузке: ${path.basename(destPath)}`), { retryable: true })
		}
	}
}

async function downloadFile(url, destPath, {
	headers = {},
	expectedSha256 = null,
	expectedSha1 = null,
	expectedSha512 = null,
	expectedSize = null,
	onChunk = null,
	signal = null,
	resume = true,
	maxRedirects = 5,
	stallMs = STALL_WINDOW_MS,
	forceSingle = false,
	attempts,
} = {}) {
	url = assertHttpUrl(url)
	throwIfCancelled(signal)
	fs.mkdirSync(path.dirname(destPath), { recursive: true })
	const partPath = destPath + '.part'

	let total = expectedSize || null
	if (total == null && !forceSingle) {
		try {
			const probed = await probeContentLength(url, headers, maxRedirects)
			if (probed.size) total = probed.size
			if (probed.url) url = probed.url
		} catch (e) {
			if (e && e.cancelled) throw e
		}
	}

	if (!resume) unlinkQuiet(partPath)

	let startAt = 0
	if (resume && fs.existsSync(partPath)) {
		const sz = fs.statSync(partPath).size
		if (total && sz > 0 && sz < total) startAt = sz
		else if (sz > 0 && !total) startAt = sz
		else unlinkQuiet(partPath)
	}

	const common = { headers, onChunk, signal, maxRedirects, stallMs }
	const useChunks = !forceSingle && resume && total != null && total > LARGE_FILE_THRESHOLD

	try {
		if (useChunks) {
			await downloadChunked(url, partPath, { ...common, total })
		} else {
			await downloadSingle(url, partPath, { ...common, startAt })
		}
	} catch (e) {
		if (e && e.rangeReset) {
			unlinkQuiet(partPath)
			return downloadFile(url, destPath, {
				headers, expectedSha256, expectedSha1, expectedSha512,
				expectedSize: total, onChunk, signal, maxRedirects, stallMs,
				resume: false, forceSingle: true,
			})
		}
		if (e && e.noRange) {
			unlinkQuiet(partPath)
			return downloadFile(url, destPath, {
				headers, expectedSha256, expectedSha1, expectedSha512,
				expectedSize: total, onChunk, signal, maxRedirects, stallMs,
				resume: false, forceSingle: true,
			})
		}
		throw e
	}

	await verifyDownload(partPath, destPath, { expectedSha512, expectedSha256, expectedSha1, expectedSize: total })
	if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
	fs.renameSync(partPath, destPath)
}

async function downloadWithRetry(url, destPath, opts = {}, attempts = 4) {
	const tries = opts.attempts || attempts
	let lastErr
	for (let i = 0; i < tries; i++) {
		if (opts.signal && opts.signal.cancelled) throw Object.assign(new Error('Отменено пользователем'), { cancelled: true })
		try {
			return await downloadFile(url, destPath, opts)
		} catch (e) {
			if (e.cancelled) throw e
			lastErr = e
			if (!e.retryable && i > 0) break
			await new Promise(r => setTimeout(r, Math.min(500 * 2 ** i, 5000)))
		}
	}
	throw lastErr
}

function hashFile(filePath, algo = 'sha256') {
	return new Promise((resolve, reject) => {
		const h = crypto.createHash(algo)
		const s = fs.createReadStream(filePath, { highWaterMark: 1 << 20 })
		s.on('data', d => h.update(d))
		s.on('end', () => resolve(h.digest('hex')))
		s.on('error', reject)
	})
}

async function runPool(items, concurrency, worker, { signal = null } = {}) {
	const queue = items.slice()
	const errors = []
	let active = 0

	return new Promise((resolve, reject) => {
		let finished = false
		const next = () => {
			if (finished) return
			if (signal && signal.cancelled) {
				finished = true
				return reject(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
			}
			if (queue.length === 0 && active === 0) {
				finished = true
				return errors.length ? reject(errors[0]) : resolve()
			}
			while (active < concurrency && queue.length > 0) {
				const item = queue.shift()
				active++
				Promise.resolve(worker(item))
					.then(() => { active--; next() })
					.catch((e) => {
						active--
						errors.push(e)
						finished = true
						reject(e)
					})
			}
		}
		next()
	})
}

class SpeedMeter {
	constructor(windowMs = 4000) {
		this.windowMs = windowMs
		this.samples = []
		this.total = 0
	}
	add(bytes) {
		this.total += bytes
		const now = Date.now()
		this.samples.push([now, bytes])
		const cutoff = now - this.windowMs
		while (this.samples.length && this.samples[0][0] < cutoff) this.samples.shift()
	}
	// байт в секунду
	get bps() {
		if (this.samples.length < 2) return 0
		const span = (Date.now() - this.samples[0][0]) / 1000
		if (span <= 0.1) return 0
		const sum = this.samples.reduce((s, [, b]) => s + b, 0)
		return sum / span
	}
}

module.exports = { fetchJson, fetchBuffer, request, downloadFile, downloadWithRetry, hashFile, runPool, SpeedMeter }
