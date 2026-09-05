const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')

const AGENTS = {
	http: new http.Agent({ keepAlive: true, maxSockets: 64 }),
	https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
}

const STALL_TIMEOUT = 20000 // нет данных дольше этого — считаем зависшим

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

async function downloadFile(url, destPath, {
	headers = {},
	expectedSha256 = null,
	expectedSha1 = null,
	expectedSha512 = null,
	expectedSize = null,
	onChunk = null,       // (bytes) => void — для общего счётчика
	signal = null,        // { cancelled: boolean }
	resume = true,
	maxRedirects = 5,
	stallMs = STALL_TIMEOUT,
	attempts,
} = {}) {
	url = assertHttpUrl(url)
	fs.mkdirSync(path.dirname(destPath), { recursive: true })
	const partPath = destPath + '.part'

	let startAt = 0
	if (resume && fs.existsSync(partPath)) {
		const sz = fs.statSync(partPath).size
		// Докачиваем только если знаем, сколько всего, и не перекачали
		if (expectedSize && sz > 0 && sz < expectedSize) startAt = sz
		else if (sz > 0 && !expectedSize) startAt = sz
		else fs.unlinkSync(partPath)
	}

	let target = url
	let redirected = false
	await new Promise((resolve, reject) => {
		const reqHeaders = { ...headers }
		if (startAt > 0) reqHeaders['Range'] = `bytes=${startAt}-`

		const req = libFor(target).get(target, { headers: reqHeaders, agent: agentFor(target), timeout: stallMs }, (res) => {
			// Adoptium и CDN отвечают редиректами — идём по ним
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume()
				if (maxRedirects <= 0) return reject(new Error('Слишком много редиректов'))
				redirected = true
				const next = new URL(res.headers.location, target).toString()
				return downloadFile(next, destPath, {
					headers, expectedSha256, expectedSha1, expectedSha512, expectedSize, onChunk, signal, resume,
					maxRedirects: maxRedirects - 1, stallMs,
				}).then(resolve, reject)
			}
			if (res.statusCode === 416) {
				// Сервер говорит, что докачивать нечего — начинаем заново
				res.resume()
				try { fs.unlinkSync(partPath) } catch (e) {}
				return reject(Object.assign(new Error('range-reset'), { retryable: true }))
			}
			if (res.statusCode !== 200 && res.statusCode !== 206) {
				res.resume()
				return reject(Object.assign(
					new Error(`HTTP ${res.statusCode} при загрузке ${path.basename(destPath)}`),
					{ retryable: res.statusCode >= 500 || res.statusCode === 429 }
				))
			}
			// Сервер проигнорировал Range — пишем с нуля
			const appending = res.statusCode === 206 && startAt > 0
			if (startAt > 0 && !appending) startAt = 0

			const out = fs.createWriteStream(partPath, appending ? { flags: 'a' } : { flags: 'w' })

			let stallTimer = null
			const resetStall = () => {
				clearTimeout(stallTimer)
				stallTimer = setTimeout(() => {
					req.destroy(Object.assign(new Error('Соединение зависло'), { retryable: true }))
				}, stallMs)
			}
			resetStall()

			res.on('data', (chunk) => {
				resetStall()
				if (onChunk) onChunk(chunk.length)
				if (signal && signal.cancelled) {
					req.destroy(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
				}
			})

			pipeline(res, out)
				.then(() => { clearTimeout(stallTimer); resolve() })
				.catch((e) => { clearTimeout(stallTimer); reject(Object.assign(e, { retryable: !e.cancelled })) })
		})

		req.on('error', (e) => reject(Object.assign(e, { retryable: !e.cancelled })))
		req.on('timeout', () => req.destroy(Object.assign(new Error('Таймаут соединения'), { retryable: true })))
	})

	// Редирект уже всё сделал во вложенном вызове
	if (redirected) return

	// Проверка целостности
	if (expectedSha512) {
		const actual = await hashFile(partPath, 'sha512')
		if (actual !== expectedSha512) {
			try { fs.unlinkSync(partPath) } catch (e) {}
			throw Object.assign(new Error(`Файл повреждён при загрузке: ${path.basename(destPath)}`), { retryable: true })
		}
	} else if (expectedSha256) {
		const actual = await hashFile(partPath, 'sha256')
		if (actual !== expectedSha256) {
			try { fs.unlinkSync(partPath) } catch (e) {}
			throw Object.assign(new Error(`Файл повреждён при загрузке: ${path.basename(destPath)}`), { retryable: true })
		}
	} else if (expectedSha1) {
		const actual = await hashFile(partPath, 'sha1')
		if (actual !== expectedSha1) {
			try { fs.unlinkSync(partPath) } catch (e) {}
			throw Object.assign(new Error(`Файл повреждён при загрузке: ${path.basename(destPath)}`), { retryable: true })
		}
	} else if (expectedSize != null) {
		const sz = fs.statSync(partPath).size
		if (sz !== expectedSize) {
			try { fs.unlinkSync(partPath) } catch (e) {}
			throw Object.assign(new Error(`Неверный размер: ${path.basename(destPath)}`), { retryable: true })
		}
	}

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
