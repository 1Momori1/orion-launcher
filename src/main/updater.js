const fs = require('fs')
const path = require('path')
const { fetchJson, request, downloadWithRetry, runPool, hashFile, SpeedMeter } = require('./net')
const { extractZip } = require('./archive')
const { planAssets, downloadAssets } = require('./assets')
const { findJava, installJava } = require('./java')

const RUNTIME_PACK = '_runtime'
const ASSET_INDEX = '5'
const FILE_CONCURRENCY = 8

// Личные файлы игрока — их никогда не трогаем при обновлении
const PROTECTED = [
	'saves/', 'logs/', 'screenshots/', 'crash-reports/', 'backups/',
	'local/', 'xaero/', 'journeymap/', 'schematics/', 'resourcepacks/cache/',
	'options.txt', 'optionsof.txt', 'servers.dat', 'servers.dat_old',
	'usercache.json', 'usernamecache.json', 'CustomSkinLoader/',
]

function isProtected(rel) {
	const p = rel.replace(/\\/g, '/')
	return PROTECTED.some(pref => pref.endsWith('/') ? p.startsWith(pref) : p === pref)
}

class Updater {
	constructor(serverUrl, dataPaths) {
		this.serverUrl = serverUrl.replace(/\/$/, '')
		this.paths = dataPaths
		this.token = null
		this.signal = { cancelled: false }
	}

	setToken(t) { this.token = t }
	setPaths(p) { this.paths = p }
	cancel() { this.signal.cancelled = true }
	_resetSignal() { this.signal = { cancelled: false } }

	_url(p) { return `${this.serverUrl}${p}` }
	_auth() { return this.token ? { Authorization: `Bearer ${this.token}` } : {} }

	// === API ===
	async listModpacks() {
		const r = await fetchJson(this._url('/api/modpacks/list'))
		const packs = (r.modpacks || []).filter(m => m.name !== RUNTIME_PACK)
		return { modpacks: packs }
	}
	getManifest(name) { return fetchJson(this._url(`/api/modpacks/${encodeURIComponent(name)}/manifest`), { timeout: 60000 }) }
	getArchiveInfo(name) { return fetchJson(this._url(`/api/modpacks/${encodeURIComponent(name)}/archive/info`)) }
	getOnline() { return fetchJson(this._url('/api/modpacks/online')) }
	listPublicServers(voter) {
		const q = voter ? `?voter=${encodeURIComponent(voter)}` : ''
		return fetchJson(this._url('/api/minecraft/public' + q), { timeout: 8000 })
	}
	votePublicServer(serverId, voter) {
		return request('POST', this._url('/api/minecraft/public/vote'), {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ server_id: serverId, voter }),
			timeout: 12000,
		}).then((r) => {
			const data = JSON.parse(r.body)
			if (r.status >= 400) throw new Error(data.detail || data.error || 'Не удалось проголосовать')
			return data
		})
	}
	listSkins() { return fetchJson(this._url('/api/modpacks/skins')) }
	skinUrl(username) { return this._url(`/api/modpacks/skins/${encodeURIComponent(username)}`) }

	login(username, password) {
		return request('POST', this._url('/api/auth/login'), {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password }),
		}).then(r => JSON.parse(r.body))
	}

	heartbeat(username, modpack) {
		return request('POST', this._url('/api/modpacks/heartbeat'), {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, modpack }),
			timeout: 8000,
		})
	}

	goOffline(username) {
		return request('POST', this._url('/api/modpacks/offline'), {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username }),
			timeout: 5000,
		})
	}

	async uploadSkin(username, filePath) {
		const crypto = require('crypto')
		const { allHosts } = require('./hosts')
		const nick = String(username || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)
		if (!nick) throw new Error('Сначала укажите ник')
		const boundary = 'Orion' + crypto.randomBytes(12).toString('hex')
		const data = fs.readFileSync(filePath)
		const head = Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${nick}.png"\r\n` +
			`Content-Type: image/png\r\n\r\n`)
		const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
		const body = Buffer.concat([head, data, tail])
		const hosts = allHosts(this.serverUrl)
		let last = new Error('Не удалось загрузить скин')
		for (const host of hosts) {
			try {
				if (!this.token) throw new Error('Сначала войди в аккаунт Orion в лаунчере')
				const r = await request('POST', `${host}/api/modpacks/skins/upload?username=${encodeURIComponent(nick)}`, {
					headers: {
						'Content-Type': `multipart/form-data; boundary=${boundary}`,
						'Content-Length': String(body.length),
						Authorization: 'Bearer ' + this.token,
					},
					body,
					timeout: 30000,
				})
				try { return JSON.parse(r.body) } catch (e) { return { ok: true } }
			} catch (e) { last = e }
		}
		throw last
	}

	// === Локальное состояние ===
	instanceDir(name) { return path.join(this.paths.games, name) }
	_localManifestPath(dir) { return path.join(dir, '.orion-state.json') }

	_readLocalManifest(dir) {
		const p = this._localManifestPath(dir)
		if (!fs.existsSync(p)) return null
		try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
	}

	// Что нужно сделать, чтобы играть
	async plan(modpackName) {
		const result = { modpack: modpackName, steps: [], totalBytes: 0, ready: false }

		// 1. Runtime (библиотеки Forge + индекс ассетов)
		const rtDir = this.paths.libraries
		const rtState = this._readLocalManifest(this.paths.root)
		let rtManifest = null
		try { rtManifest = await this.getManifest(RUNTIME_PACK) } catch (e) {}
		if (rtManifest) {
			const needFull = !rtState || rtState.build !== rtManifest.build
			const criticalMissing = [
				path.join(this.paths.libraries, 'net', 'minecraftforge', 'forge', '1.20.1-47.4.10', 'forge-1.20.1-47.4.10-client.jar'),
				path.join(this.paths.libraries, 'net', 'minecraft', 'client', '1.20.1-20230612.114412', 'client-1.20.1-20230612.114412-srg.jar'),
			].some(p => !fs.existsSync(p))
			if (needFull || criticalMissing) {
				const info = await this.getArchiveInfo(RUNTIME_PACK).catch(() => null)
				result.steps.push({ id: 'runtime', label: 'Библиотеки Forge', bytes: info ? info.size : rtManifest.totalSize, mode: info ? 'archive' : 'files' })
				result.totalBytes += info ? info.size : rtManifest.totalSize
			}
		}

		// 2. Сборка
		const dir = this.instanceDir(modpackName)
		const manifest = await this.getManifest(modpackName)
		const local = this._readLocalManifest(dir)

		if (!local) {
			const info = await this.getArchiveInfo(modpackName).catch(() => null)
			const bytes = info ? info.size : manifest.totalSize
			result.steps.push({ id: 'pack', label: 'Сборка DeceasedCraft', bytes, mode: info ? 'archive' : 'files', fileCount: manifest.fileCount })
			result.totalBytes += bytes
		} else {
			const changed = this._diff(local, manifest)
			const versionChanged = local.build !== manifest.build || local.version !== manifest.version
			if (changed.download.length || changed.remove.length) {
				const bytes = changed.download.reduce((s, f) => s + f.size, 0)
				result.steps.push({
					id: 'pack', label: 'Обновление сборки', bytes, mode: 'files',
					fileCount: changed.download.length, removeCount: changed.remove.length,
				})
				result.totalBytes += bytes
			} else if (versionChanged) {
				// Файлы те же, но на сервере новый номер версии/build — просто обновим локальный стейт
				result.steps.push({
					id: 'pack', label: `Версия ${local.version || '?'} → ${manifest.version}`, bytes: 0, mode: 'state',
					fileCount: 0,
				})
			}
		}

		// 3. Ассеты (текстуры, звуки, языки)
		try {
			const ap = planAssets(this.paths, ASSET_INDEX)
			if (ap.missing.length) {
				result.steps.push({ id: 'assets', label: 'Ресурсы Minecraft', bytes: ap.missingBytes, fileCount: ap.missing.length })
				result.totalBytes += ap.missingBytes
			}
		} catch (e) {
			// индекса ещё нет — он приедет вместе с runtime, оценим на глаз
			result.steps.push({ id: 'assets', label: 'Ресурсы Minecraft', bytes: 610 * 1024 * 1024, estimated: true })
			result.totalBytes += 610 * 1024 * 1024
		}

		// 4. Java
		const cfg = require('./config').load()
		const java = await findJava(this.paths, cfg.javaPath)
		if (!java) {
			result.steps.push({ id: 'java', label: 'Java 17', bytes: 45 * 1024 * 1024, estimated: true })
			result.totalBytes += 45 * 1024 * 1024
		} else {
			result.java = java
		}

		result.ready = result.steps.length === 0
		result.version = manifest.version
		result.build = manifest.build
		result.localVersion = local ? local.version : null
		return result
	}

	_diff(local, remote) {
		const localMap = new Map((local.files || []).map(f => [f.path, f]))
		const remoteMap = new Map(remote.files.map(f => [f.path, f]))
		const download = []
		const remove = []
		for (const [p, rf] of remoteMap) {
			const lf = localMap.get(p)
			if (!lf || lf.sha256 !== rf.sha256) download.push(rf)
		}
		for (const p of localMap.keys()) {
			if (!remoteMap.has(p) && !isProtected(p)) remove.push(p)
		}
		return { download, remove }
	}

	// === Установка ===
	// mode: 'resume' — досинхронизировать, 'restart' — снести и поставить заново
	async install(modpackName, onProgress, mode = 'resume') {
		this._resetSignal()
		const signal = this.signal

		if (mode === 'restart') {
			const dir = this.instanceDir(modpackName)
			// Сохраняем миры и настройки игрока даже при переустановке
			const keep = path.join(this.paths.cache, `keep-${Date.now()}`)
			let kept = []
			if (fs.existsSync(dir)) {
				for (const item of PROTECTED) {
					const name = item.replace(/\/$/, '')
					const src = path.join(dir, name)
					if (fs.existsSync(src)) {
						const dst = path.join(keep, name)
						fs.mkdirSync(path.dirname(dst), { recursive: true })
						fs.renameSync(src, dst)
						kept.push(name)
					}
				}
				fs.rmSync(dir, { recursive: true, force: true })
			}
			this._keptDir = kept.length ? keep : null
			this._keptItems = kept
		}

		const plan = await this.plan(modpackName)
		const totalBytes = Math.max(plan.totalBytes, 1)
		let doneBytes = 0
		const meter = new SpeedMeter()
		let lastReport = 0
		let currentStep = null

		const emit = (extra = {}, force = false) => {
			const now = Date.now()
			if (!force && now - lastReport < 300) return
			lastReport = now
			const bps = meter.bps
			const remaining = totalBytes - doneBytes
			onProgress({
				stage: currentStep ? currentStep.id : 'prepare',
				stageLabel: currentStep ? currentStep.label : 'Подготовка',
				percent: Math.min(100, (doneBytes / totalBytes) * 100),
				bytesDone: doneBytes,
				bytesTotal: totalBytes,
				bps,
				etaSec: bps > 1024 ? Math.round(remaining / bps) : null,
				steps: plan.steps.map(s => s.id),
				...extra,
			})
		}

		const countBytes = (n) => { meter.add(n); doneBytes += n; emit() }

		for (const step of plan.steps) {
			if (signal.cancelled) throw Object.assign(new Error('Отменено пользователем'), { cancelled: true })
			currentStep = step
			emit({ detail: step.label }, true)
			const before = doneBytes

			if (step.id === 'runtime') {
				await this._installRuntime(step, countBytes, emit, signal)
			} else if (step.id === 'pack') {
				await this._installPack(modpackName, step, countBytes, emit, signal)
			} else if (step.id === 'assets') {
				let seen = 0
				await downloadAssets(this.paths, ASSET_INDEX, (p) => {
					// downloadAssets отдаёт накопленный объём — переводим в приращение
					const delta = p.bytesDone - seen
					seen = p.bytesDone
					if (delta > 0) { meter.add(delta); doneBytes += delta }
					emit({ detail: `${p.current} из ${p.total} файлов` })
				}, signal)
			} else if (step.id === 'java') {
				emit({ detail: 'Скачиваю Java 17' }, true)
				const info = await installJava(this.paths, () => {}, signal)
				require('./config').save({ javaPath: info.path })
			}

			// Выравниваем счётчик на границе шага, чтобы прогресс не «отставал»
			const expected = before + step.bytes
			if (doneBytes < expected) doneBytes = expected
			emit({}, true)
		}

		// Возвращаем сохранённое личное после переустановки
		if (this._keptDir && fs.existsSync(this._keptDir)) {
			const dir = this.instanceDir(modpackName)
			for (const name of this._keptItems) {
				const src = path.join(this._keptDir, name)
				const dst = path.join(dir, name)
				if (fs.existsSync(src)) {
					fs.mkdirSync(path.dirname(dst), { recursive: true })
					fs.rmSync(dst, { recursive: true, force: true })
					fs.renameSync(src, dst)
				}
			}
			fs.rmSync(this._keptDir, { recursive: true, force: true })
			this._keptDir = null
		}

		currentStep = null
		doneBytes = totalBytes
		emit({ detail: 'Готово', done: true }, true)
		return { success: true, version: plan.version }
	}

	async _installRuntime(step, countBytes, emit, signal) {
		const manifest = await this.getManifest(RUNTIME_PACK)

		if (step.mode === 'archive') {
			const zip = path.join(this.paths.cache, '_runtime.zip')
			emit({ detail: 'Скачиваю библиотеки Forge' }, true)
			await downloadWithRetry(this._url(`/api/modpacks/${RUNTIME_PACK}/archive`), zip, {
				expectedSize: step.bytes, signal, onChunk: countBytes,
			})
			emit({ detail: 'Распаковываю библиотеки' }, true)
			// runtime содержит libraries/ и assets/ — кладём прямо в корень данных
			await extractZip(zip, this.paths.root, {
				onEntry: (name, n) => { if (n % 20 === 0) emit({ detail: `Распаковка: ${n} файлов` }) },
				signal,
			})
			fs.rmSync(zip, { force: true })
		} else {
			await runPool(manifest.files, FILE_CONCURRENCY, async (f) => {
				const dest = path.join(this.paths.root, f.path)
				await downloadWithRetry(
					this._url(`/api/modpacks/${RUNTIME_PACK}/files/${encodeURI(f.path)}`),
					dest, { expectedSha256: f.sha256, signal, onChunk: countBytes })
			}, { signal })
		}

		fs.writeFileSync(this._localManifestPath(this.paths.root),
			JSON.stringify({ name: RUNTIME_PACK, version: manifest.version, build: manifest.build }))
	}

	async _installPack(modpackName, step, countBytes, emit, signal) {
		const dir = this.instanceDir(modpackName)
		fs.mkdirSync(dir, { recursive: true })
		const manifest = await this.getManifest(modpackName)

		if (step.mode === 'state') {
			// Только обновить локальный стейт до серверной версии
			fs.writeFileSync(this._localManifestPath(dir), JSON.stringify({
				name: manifest.name, version: manifest.version, build: manifest.build,
				files: manifest.files,
			}))
			return
		}

		if (step.mode === 'archive') {
			const zip = path.join(this.paths.cache, `${modpackName}.zip`)
			emit({ detail: 'Скачиваю сборку' }, true)
			await downloadWithRetry(this._url(`/api/modpacks/${encodeURIComponent(modpackName)}/archive`), zip, {
				expectedSize: step.bytes, signal, onChunk: countBytes,
			})
			emit({ detail: `Распаковываю ${step.fileCount || ''} файлов` }, true)
			await extractZip(zip, dir, {
				onEntry: (name, n) => { if (n % 200 === 0) emit({ detail: `Распаковка: ${n} из ${step.fileCount}` }) },
				signal,
			})
			fs.rmSync(zip, { force: true })
		} else {
			const local = this._readLocalManifest(dir)
			const { download, remove } = this._diff(local || { files: [] }, manifest)

			for (const rel of remove) {
				const p = path.join(dir, rel)
				try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch (e) {}
			}

			let n = 0
			await runPool(download, FILE_CONCURRENCY, async (f) => {
				const dest = path.join(dir, f.path)
				await downloadWithRetry(
					this._url(`/api/modpacks/${encodeURIComponent(modpackName)}/files/${encodeURI(f.path)}`),
					dest, { expectedSha256: f.sha256, signal, onChunk: countBytes })
				n++
				emit({ detail: `${n} из ${download.length} файлов` })
			}, { signal })
		}

		fs.writeFileSync(this._localManifestPath(dir), JSON.stringify({
			name: manifest.name, version: manifest.version, build: manifest.build,
			files: manifest.files,
		}))
	}
}

module.exports = { Updater, RUNTIME_PACK, ASSET_INDEX }
