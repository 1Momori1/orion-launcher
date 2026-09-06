const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { hashFile, runPool, SpeedMeter } = require('./net')
const { downloadWithRetryMirrored, fetchJsonMirrored, UA } = require('./mirrors')
const { downloadAssets } = require('./assets')
const { extractZip } = require('./archive')
const { findJava, installJava } = require('./java')
const { offlineUUID } = require('./launcher')
const { isFatJar, linkOrCopy } = require('./fsutil')
const validate = require('./installvalidate')
const { openLog } = require('./installlog')
const crypto = require('crypto')

const META_NAME = 'orion-instance.json'
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const LIB_CONCURRENCY = 12

function dlHeaders() {
	return { 'User-Agent': UA }
}

function neededJavaMajor(mc) {
	const s = String(mc || '')
	if (/^\d{2}w/.test(s)) return 21
	const m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
	if (!m) return 21
	const epoch = parseInt(m[1], 10)
	const minor = parseInt(m[2], 10)
	const patch = parseInt(m[3] || '0', 10)
	if (epoch >= 21) return 21
	if (epoch !== 1) return 21
	if (minor > 20) return 21
	if (minor === 20 && patch >= 5) return 21
	return 17
}

function readMeta(dir) {
	const p = path.join(dir, META_NAME)
	if (!fs.existsSync(p)) return null
	try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

function writeMeta(dir, meta) {
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, META_NAME), JSON.stringify(meta, null, 2))
}

function ensureLauncherProfiles(mcRoot) {
	fs.mkdirSync(mcRoot, { recursive: true })
	const stub = {
		profiles: {},
		settings: {},
		version: 3,
	}
	for (const name of ['launcher_profiles.json', 'launcher_profiles_microsoft_store.json']) {
		const p = path.join(mcRoot, name)
		if (fs.existsSync(p)) continue
		fs.writeFileSync(p, JSON.stringify(stub, null, 2))
	}
}

function osName() {
	if (process.platform === 'win32') return 'windows'
	if (process.platform === 'darwin') return 'osx'
	return 'linux'
}

function rulesAllow(rules, features = {}) {
	if (!rules || !rules.length) return true
	let allowed = false
	for (const rule of rules) {
		let match = true
		if (rule.os) {
			if (rule.os.name && rule.os.name !== osName()) match = false
			if (rule.os.arch && rule.os.arch !== process.arch) match = false
		}
		if (rule.features) {
			for (const [k, v] of Object.entries(rule.features)) {
				if (Boolean(features[k]) !== Boolean(v)) match = false
			}
		}
		if (match) allowed = rule.action === 'allow'
	}
	return allowed
}

function mavenRel(name) {
	const parts = String(name).split(':')
	const grp = parts[0], art = parts[1], ver = parts[2], classifier = parts[3]
	const file = classifier ? `${art}-${ver}-${classifier}.jar` : `${art}-${ver}.jar`
	return `${grp.replace(/\./g, '/')}/${art}/${ver}/${file}`
}

function artifactOf(lib) {
	if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) return lib.downloads.artifact
	const rel = mavenRel(lib.name)
	const base = (lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/')
	return { path: rel, url: base + rel, size: lib.downloads && lib.downloads.artifact ? lib.downloads.artifact.size : null, sha1: null }
}

function nativeKey(lib) {
	if (!lib.natives) return null
	const raw = lib.natives[osName()]
	if (!raw) return null
	return raw.replace('${arch}', process.arch === 'ia32' ? '32' : '64')
}

async function getMojangVersion(mcVersion) {
	const man = await fetchJsonMirrored(MOJANG_MANIFEST, { headers: dlHeaders(), timeout: 20000 })
	const found = (man.versions || []).find(v => v.id === mcVersion)
	if (!found) throw new Error(`Нет такой версии Minecraft: ${mcVersion}`)
	return fetchJsonMirrored(found.url, { headers: dlHeaders(), timeout: 20000 })
}

function mergeVersions(child, parent) {
	const game = [...(parent.arguments && parent.arguments.game || []), ...(child.arguments && child.arguments.game || [])]
	const jvm = [...(parent.arguments && parent.arguments.jvm || []), ...(child.arguments && child.arguments.jvm || [])]
	return {
		...parent,
		...child,
		libraries: [...(parent.libraries || []), ...(child.libraries || [])],
		arguments: {
			game: game.length ? game : undefined,
			jvm: jvm.length ? jvm : undefined,
		},
		minecraftArguments: child.minecraftArguments || parent.minecraftArguments,
		downloads: { ...(parent.downloads || {}), ...(child.downloads || {}) },
		assetIndex: child.assetIndex || parent.assetIndex,
		assets: child.assets || parent.assets,
		mainClass: child.mainClass || parent.mainClass,
		id: child.id || parent.id,
		inheritsFrom: undefined,
	}
}

async function resolveVersionJson(json, versionsDir) {
	let cur = json
	const seen = new Set()
	while (cur.inheritsFrom) {
		if (seen.has(cur.inheritsFrom)) throw new Error('Цикл inheritsFrom в версии Minecraft')
		seen.add(cur.inheritsFrom)
		const parentPath = path.join(versionsDir, cur.inheritsFrom, cur.inheritsFrom + '.json')
		let parent
		if (fs.existsSync(parentPath)) parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'))
		else parent = await getMojangVersion(cur.inheritsFrom)
		fs.mkdirSync(path.dirname(parentPath), { recursive: true })
		fs.writeFileSync(parentPath, JSON.stringify(parent, null, 2))
		cur = mergeVersions(cur, parent)
	}
	return cur
}

function emit(onProgress, patch) {
	if (onProgress) onProgress(patch)
}

async function downloadLibraries(libs, librariesDir, onProgress, signal) {
	const jobs = []
	for (const lib of libs) {
		if (!rulesAllow(lib.rules)) continue
		const art = artifactOf(lib)
		if (art && art.path) {
			jobs.push({ kind: 'lib', lib, art })
		}
		const nk = nativeKey(lib)
		if (nk && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[nk]) {
			jobs.push({ kind: 'native', lib, art: lib.downloads.classifiers[nk], classifier: nk })
		}
	}

	const missing = []
	for (const job of jobs) {
		const dest = path.join(librariesDir, job.art.path || mavenRel(job.lib.name + (job.classifier ? ':' + job.classifier : '')))
		job.dest = dest
		let ok = false
		try { ok = fs.existsSync(dest) && (!job.art.size || fs.statSync(dest).size === job.art.size) } catch (e) { ok = false }
		if (!ok) missing.push(job)
	}

	if (!missing.length) return { downloaded: 0, total: jobs.length }

	const totalBytes = missing.reduce((s, j) => s + (j.art.size || 0), 0)
	const meter = new SpeedMeter()
	let doneBytes = 0
	let last = 0
	const report = (force = false) => {
		const now = Date.now()
		if (!force && now - last < 400) return
		last = now
		const bps = meter.bps
		emit(onProgress, {
			stage: 'libraries',
			stageLabel: 'Библиотеки',
			detail: `${missing.length} файлов`,
			bytesDone: doneBytes,
			bytesTotal: totalBytes || doneBytes,
			percent: totalBytes ? Math.min(100, (doneBytes / totalBytes) * 100) : 0,
			bps,
			etaSec: bps > 1024 && totalBytes ? Math.round((totalBytes - doneBytes) / bps) : null,
		})
	}

	await runPool(missing, LIB_CONCURRENCY, async (job) => {
		if (!job.art.url) throw new Error(`Нет URL у библиотеки ${job.lib.name}`)
		await downloadWithRetryMirrored(job.art.url, job.dest, {
			headers: dlHeaders(),
			expectedSha1: job.art.sha1 || null,
			expectedSize: job.art.size || null,
			signal,
			onChunk: (n) => { meter.add(n); doneBytes += n; report() },
		})
	}, { signal })
	report(true)
	return { downloaded: missing.length, total: jobs.length }
}

async function extractNatives(libs, librariesDir, nativesDir, signal) {
	fs.mkdirSync(nativesDir, { recursive: true })
	for (const lib of libs) {
		if (signal && signal.cancelled) throw Object.assign(new Error('Отменено пользователем'), { cancelled: true })
		if (!rulesAllow(lib.rules)) continue
		const nk = nativeKey(lib)
		if (!nk || !lib.downloads || !lib.downloads.classifiers || !lib.downloads.classifiers[nk]) continue
		const art = lib.downloads.classifiers[nk]
		const jar = path.join(librariesDir, art.path)
		if (!fs.existsSync(jar)) continue
		const tmp = nativesDir + '-tmp-' + Date.now()
		try {
			await extractZip(jar, tmp, { signal })
			copyDirFiltered(tmp, nativesDir)
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	}
	fs.rmSync(path.join(nativesDir, 'META-INF'), { recursive: true, force: true })
}

function copyDirFiltered(src, dest) {
	fs.mkdirSync(dest, { recursive: true })
	if (!fs.existsSync(src)) return
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		if (e.name === 'META-INF') continue
		const s = path.join(src, e.name)
		const d = path.join(dest, e.name)
		if (e.isDirectory()) copyDirFiltered(s, d)
		else fs.copyFileSync(s, d)
	}
}

async function ensureVanilla(mcVersion, dataPaths, onProgress, signal) {
	emit(onProgress, { stage: 'minecraft', stageLabel: 'Minecraft ' + mcVersion, detail: 'Манифест', percent: 2 })
	const json = await getMojangVersion(mcVersion)
	const dir = path.join(dataPaths.versions, mcVersion)
	fs.mkdirSync(dir, { recursive: true })
	const jsonPath = path.join(dir, mcVersion + '.json')
	fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2))

	const client = json.downloads && json.downloads.client
	if (client && client.url) {
		const jar = path.join(dir, mcVersion + '.jar')
		let ok = false
		try { ok = fs.existsSync(jar) && fs.statSync(jar).size === client.size } catch (e) { ok = false }
		if (!ok) {
			emit(onProgress, { stage: 'minecraft', stageLabel: 'Minecraft', detail: 'Клиент ' + mcVersion, percent: 8 })
			await downloadWithRetryMirrored(client.url, jar, {
				headers: dlHeaders(),
				expectedSha1: client.sha1,
				expectedSize: client.size,
				signal,
				onChunk: () => {},
			})
		}
	}

	await downloadLibraries(json.libraries || [], dataPaths.libraries, onProgress, signal)

	if (json.assetIndex && json.assetIndex.url) {
		const idx = json.assetIndex
		const idxPath = path.join(dataPaths.assetIndexes, idx.id + '.json')
		let idxOk = false
		try {
			idxOk = fs.existsSync(idxPath) && (!idx.sha1 || await hashFile(idxPath, 'sha1') === idx.sha1)
		} catch (e) { idxOk = false }
		if (!idxOk) {
			emit(onProgress, { stage: 'assets', stageLabel: 'Индекс ресурсов', detail: idx.id, percent: 40 })
			await downloadWithRetryMirrored(idx.url, idxPath, {
				headers: dlHeaders(),
				expectedSha1: idx.sha1 || null,
				expectedSize: idx.size || null,
				signal,
			})
		}
		emit(onProgress, { stage: 'assets', stageLabel: 'Ресурсы Minecraft', detail: idx.id, percent: 45 })
		await downloadAssets(dataPaths, idx.id, (p) => {
			emit(onProgress, {
				...p,
				stage: 'assets',
				stageLabel: 'Ресурсы Minecraft',
				percent: 45 + Math.min(40, (p.percent || 0) * 0.4),
			})
		}, signal)
	}
	return json
}

async function fetchFabricProfile(mc, loader) {
	const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`
	return fetchJsonMirrored(url, { headers: dlHeaders(), timeout: 20000 })
}

async function fetchQuiltProfile(mc, loader) {
	const url = `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`
	return fetchJsonMirrored(url, { headers: dlHeaders(), timeout: 20000 })
}

async function latestFabric(mc) {
	const list = await fetchJsonMirrored(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`, { headers: dlHeaders(), timeout: 15000 })
	const stable = (list || []).find(x => x.loader && x.loader.stable)
	const first = (list || [])[0]
	const hit = stable || first
	if (!hit || !hit.loader) throw new Error('Не нашёл Fabric Loader для ' + mc)
	return hit.loader.version
}

async function latestQuilt(mc) {
	const list = await fetchJsonMirrored(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`, { headers: dlHeaders(), timeout: 15000 })
	const first = (list || [])[0]
	if (!first || !first.loader) throw new Error('Не нашёл Quilt Loader для ' + mc)
	return first.loader.version
}

function versionJsonPath(versionsDir, id) {
	return path.join(versionsDir, id, id + '.json')
}

function findInstalledId(versionsDir, pred) {
	if (!fs.existsSync(versionsDir)) return null
	for (const d of fs.readdirSync(versionsDir)) {
		if (pred(d) && fs.existsSync(versionJsonPath(versionsDir, d))) return d
	}
	return null
}

function runJava(javaPath, args, { cwd, timeout = 600000, onLine, signal } = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(javaPath, args, { cwd, windowsHide: true })
		let out = ''
		const onData = (buf) => {
			const t = buf.toString()
			out += t
			if (onLine) {
				for (const line of t.split(/\r?\n/)) if (line.trim()) onLine(line.trim().slice(0, 200))
			}
		}
		proc.stdout.on('data', onData)
		proc.stderr.on('data', onData)
		let killed = false
		const cancelCheck = signal ? setInterval(() => {
			if (signal.cancelled && !killed) { killed = true; proc.kill() }
		}, 400) : null
		const timer = setTimeout(() => {
			killed = true
			proc.kill()
			reject(new Error('Установщик загрузчика завис'))
		}, timeout)
		proc.on('error', (e) => {
			clearTimeout(timer)
			if (cancelCheck) clearInterval(cancelCheck)
			reject(e)
		})
		proc.on('close', (code) => {
			clearTimeout(timer)
			if (cancelCheck) clearInterval(cancelCheck)
			if (killed && signal && signal.cancelled) {
				return reject(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
			}
			if (code !== 0) return reject(new Error(`Установщик завершился с кодом ${code}. ${out.slice(-900)}`))
			resolve(out)
		})
	})
}

async function ensureJava(dataPaths, preferredPath, minMajor, onProgress, signal) {
	let java = await findJava(dataPaths, preferredPath, { minMajor, preferMajor: minMajor === 17 ? 17 : minMajor })
	if (java) return java
	emit(onProgress, {
		stage: 'java',
		stageLabel: 'Java ' + minMajor,
		detail: 'Скачиваю Adoptium JRE ' + minMajor,
		percent: 1,
	})
	java = await installJava(dataPaths, (p) => {
		emit(onProgress, {
			stage: 'java',
			stageLabel: 'Java ' + minMajor,
			detail: p.stage === 'java-extract' ? 'Распаковка' : 'Скачивание',
			bytesDone: p.bytes || 0,
			bytesTotal: 0,
			percent: null,
		})
	}, signal, minMajor)
	return java
}

async function installForgeLike({ kind, mc, loaderVersion, dataPaths, javaPath, onProgress, signal }) {
	const versionsDir = dataPaths.versions
	const already = findInstalledId(versionsDir, (id) => {
		const v = loaderVersion.replace(/^neoforge-/i, '')
		if (kind === 'neoforge') return id.toLowerCase().includes('neoforge') && id.includes(v.split('.').slice(0, 2).join('.'))
		return (id.includes('forge') && !id.toLowerCase().includes('neoforge')) && (id.includes(loaderVersion) || id.includes(`${mc}-${loaderVersion}`))
	})
	if (already) return already

	emit(onProgress, { stage: 'loader', stageLabel: kind === 'neoforge' ? 'NeoForge' : 'Forge', detail: 'Установщик ' + loaderVersion, percent: 82 })

	let url, jarName, expectId
	if (kind === 'neoforge') {
		const ver = loaderVersion.replace(/^neoforge-/i, '')
		url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(ver)}/neoforge-${ver}-installer.jar`
		jarName = `neoforge-${ver}-installer.jar`
		expectId = `${mc}-neoforge-${ver}`
	} else {
		const combo = `${mc}-${loaderVersion}`
		url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${combo}/forge-${combo}-installer.jar`
		jarName = `forge-${combo}-installer.jar`
		expectId = `${mc}-forge-${loaderVersion}`
	}

	const installer = path.join(dataPaths.cache, jarName)
	await downloadWithRetryMirrored(url, installer, { headers: dlHeaders(), signal, attempts: 2, stallMs: 15000 })

	const mcRoot = dataPaths.root
	ensureLauncherProfiles(mcRoot)
	await runJava(javaPath, ['-Djava.awt.headless=true', '-jar', installer, '--installClient', mcRoot], {
		cwd: mcRoot,
		timeout: 12 * 60 * 1000,
		signal,
		onLine: (line) => emit(onProgress, {
			stage: 'loader',
			stageLabel: kind === 'neoforge' ? 'NeoForge' : 'Forge',
			detail: line,
			percent: 88,
		}),
	})

	const found = findInstalledId(versionsDir, (id) => id === expectId)
		|| findInstalledId(versionsDir, (id) => id.includes(loaderVersion) && id.toLowerCase().includes(kind === 'neoforge' ? 'neoforge' : 'forge'))
	if (!found) throw new Error(`Установщик ${kind} отработал, но профиль версии не найден`)
	return found
}

async function ensureLoader({ minecraft, loader, loaderVersion, dataPaths, javaPath, onProgress, signal }) {
	const type = String(loader || 'vanilla').toLowerCase()
	const mc = String(minecraft)
	await ensureVanilla(mc, dataPaths, onProgress, signal)

	if (!type || type === 'vanilla') return mc

	if (type === 'fabric' || type === 'legacyfabric') {
		let ver = loaderVersion
		if (!ver || ver === 'latest') ver = await latestFabric(mc)
		const id = `fabric-loader-${ver}-${mc}`
		const jsonPath = versionJsonPath(dataPaths.versions, id)
		if (!fs.existsSync(jsonPath)) {
			emit(onProgress, { stage: 'loader', stageLabel: 'Fabric', detail: ver, percent: 85 })
			const profile = await fetchFabricProfile(mc, ver)
			fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
			fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2))
		}
		const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
		const merged = await resolveVersionJson(raw, dataPaths.versions)
		await downloadLibraries(merged.libraries || [], dataPaths.libraries, onProgress, signal)
		return id
	}

	if (type === 'quilt') {
		let ver = loaderVersion
		if (!ver || ver === 'latest') ver = await latestQuilt(mc)
		const id = `quilt-loader-${ver}-${mc}`
		const jsonPath = versionJsonPath(dataPaths.versions, id)
		if (!fs.existsSync(jsonPath)) {
			emit(onProgress, { stage: 'loader', stageLabel: 'Quilt', detail: ver, percent: 85 })
			const profile = await fetchQuiltProfile(mc, ver)
			fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
			fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2))
		}
		const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
		const merged = await resolveVersionJson(raw, dataPaths.versions)
		await downloadLibraries(merged.libraries || [], dataPaths.libraries, onProgress, signal)
		return id
	}

	if (type === 'forge' || type === 'neoforge') {
		if (!loaderVersion) throw new Error('В сборке не указана версия ' + type)
		return installForgeLike({
			kind: type,
			mc,
			loaderVersion,
			dataPaths,
			javaPath,
			onProgress,
			signal,
		})
	}

	throw new Error('Неизвестный загрузчик: ' + type)
}

function flattenArgs(list, features) {
	const out = []
	for (const item of list || []) {
		if (typeof item === 'string') {
			out.push(item)
			continue
		}
		if (!item || typeof item !== 'object') continue
		if (!rulesAllow(item.rules, features)) continue
		const v = item.value
		if (Array.isArray(v)) out.push(...v)
		else if (typeof v === 'string') out.push(v)
	}
	return out
}

function resolveClientJar(version, dataPaths, mcVersion, log) {
	const profile = validate.readVersionProfile(dataPaths.versions, version.id) || version
	const expectedName = validate.expectedClientJarName(profile) || (version.id + '.jar')
	const named = path.join(dataPaths.versions, profile.id || version.id, expectedName)
	if (isFatJar(named)) {
		if (log) log.write('client-jar', { expected: expectedName, actual: expectedName, method: 'exists' })
		return { path: named, method: 'exists', expected: expectedName }
	}
	const vanilla = mcVersion ? path.join(dataPaths.versions, mcVersion, mcVersion + '.jar') : null
	if (!vanilla || !isFatJar(vanilla)) {
		if (log) log.write('client-jar-missing', { expected: expectedName, vanilla })
		return { path: null, method: 'missing', expected: expectedName }
	}
	if (path.resolve(named) === path.resolve(vanilla)) {
		if (log) log.write('client-jar', { expected: expectedName, actual: path.basename(vanilla), method: 'vanilla-same' })
		return { path: vanilla, method: 'vanilla-same', expected: expectedName }
	}
	try {
		const copied = linkOrCopy(vanilla, named)
		if (isFatJar(named)) {
			if (log) log.write('client-jar', { expected: expectedName, actual: expectedName, method: copied.method, reason: copied.reason || null })
			return { path: named, method: copied.method, expected: expectedName }
		}
	} catch (e) {
		if (log) log.write('client-jar-copy-fail', { expected: expectedName, error: e.message })
	}
	if (log) log.write('client-jar-fallback', { expected: expectedName, actual: path.basename(vanilla) })
	return { path: vanilla, method: 'vanilla-fallback', expected: expectedName }
}

function classpathFor(version, dataPaths, mcVersion) {
	const parts = []
	const seen = new Set()
	for (const lib of version.libraries || []) {
		if (!rulesAllow(lib.rules)) continue
		const art = artifactOf(lib)
		if (!art || !art.path) continue
		const p = path.join(dataPaths.libraries, art.path)
		if (seen.has(p)) continue
		seen.add(p)
		parts.push(p)
	}
	const resolved = resolveClientJar(version, dataPaths, mcVersion)
	if (resolved.path) parts.push(resolved.path)
	return { classpath: parts.join(path.delimiter), clientJar: resolved.path, clientMeta: resolved }
}

function patchIgnoreList(args, clientJar, log) {
	if (!clientJar) return { added: null, ignoreList: [] }
	const base = path.basename(clientJar)
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (typeof a !== 'string' || !a.startsWith('-DignoreList=')) continue
		const items = a.slice('-DignoreList='.length).split(',').filter(Boolean)
		let added = null
		if (!items.includes(base)) {
			items.push(base)
			args[i] = '-DignoreList=' + items.join(',')
			added = base
		}
		if (log) log.write('ignore-list', { expected: base, added, ignoreList: items })
		return { added, ignoreList: items }
	}
	if (log) log.write('ignore-list-absent', { expected: base })
	return { added: null, ignoreList: [] }
}

function substitute(arg, vars) {
	return String(arg).replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
}

async function loadMergedVersion(dataPaths, versionId) {
	const jsonPath = versionJsonPath(dataPaths.versions, versionId)
	if (!fs.existsSync(jsonPath)) throw new Error('Нет профиля версии: ' + versionId)
	const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
	return resolveVersionJson(raw, dataPaths.versions)
}

function buildLaunchArgs(version, dataPaths, instanceDir, nativesDir, opts) {
	const features = {
		has_custom_resolution: true,
		is_demo_user: false,
		has_quick_plays_support: false,
		is_quick_play_singleplayer: false,
		is_quick_play_multiplayer: false,
		is_quick_play_realms: false,
	}
	const { classpath: cp, clientJar } = classpathFor(version, dataPaths, opts.minecraft)
	if (opts.log) {
		opts.log.write('classpath-client', {
			expected: version.id + '.jar',
			profileId: version.id,
			actual: clientJar ? path.basename(clientJar) : null,
		})
	}
	let curLauncherVer = '1.7.0'
	try { curLauncherVer = require('electron').app.getVersion() } catch (_) {}
	const vars = {
		auth_player_name: opts.username,
		version_name: version.id,
		game_directory: instanceDir,
		assets_root: dataPaths.assets,
		assets_index_name: (version.assetIndex && version.assetIndex.id) || version.assets || 'legacy',
		auth_uuid: offlineUUID(opts.username),
		auth_access_token: '0',
		clientid: 'orion',
		auth_xuid: '0',
		user_type: 'legacy',
		version_type: version.type || 'release',
		natives_directory: nativesDir,
		launcher_name: 'orion-launcher',
		launcher_version: curLauncherVer,
		classpath: cp,
		library_directory: dataPaths.libraries,
		classpath_separator: path.delimiter,
		user_properties: '{}',
		auth_session: '0',
		resolution_width: String(opts.width || 1280),
		resolution_height: String(opts.height || 720),
	}

	const memMax = String(opts.memoryMB || 6144)
	const memMin = String(Math.min(Number(memMax), Math.max(1024, Math.floor(Number(memMax) / 2))))
	const args = [
		`-Xmx${memMax}M`,
		`-Xms${memMin}M`,
		`-Djava.library.path=${nativesDir}`,
		`-Dminecraft.launcher.brand=orion`,
		`-Dminecraft.launcher.version=${curLauncherVer}`,
	]

	if (version.arguments && version.arguments.jvm) {
		for (const a of flattenArgs(version.arguments.jvm, features)) args.push(substitute(a, vars))
	} else {
		args.push(`-Djava.library.path=${nativesDir}`, '-cp', cp)
	}

	if (!args.includes('-cp') && !args.includes('-classpath')) {
		args.push('-cp', cp)
	}
	patchIgnoreList(args, clientJar, opts.log)

	args.push(version.mainClass)

	if (version.arguments && version.arguments.game) {
		for (const a of flattenArgs(version.arguments.game, features)) args.push(substitute(a, vars))
	} else if (version.minecraftArguments) {
		for (const a of version.minecraftArguments.split(/\s+/)) {
			if (a) args.push(substitute(a, vars))
		}
		args.push('--width', vars.resolution_width, '--height', vars.resolution_height)
	} else {
		args.push(
			'--username', vars.auth_player_name,
			'--version', vars.version_name,
			'--gameDir', vars.game_directory,
			'--assetsDir', vars.assets_root,
			'--assetIndex', vars.assets_index_name,
			'--uuid', vars.auth_uuid,
			'--accessToken', vars.auth_access_token,
			'--userType', vars.user_type,
			'--versionType', vars.version_type,
			'--width', vars.resolution_width,
			'--height', vars.resolution_height,
		)
	}
	return args
}

function appendJoinArgs(args, opts) {
	const host = String((opts && opts.joinHost) || '').trim()
	if (!host) return args
	const port = String((opts && opts.joinPort) || '').trim()
	args.push('--server', host)
	if (port) args.push('--port', port)
	return args
}

async function ensureRuntime({ paths: dataPaths, minecraft, loader, loaderVersion, javaPath, onProgress, signal }) {
	const minMajor = neededJavaMajor(minecraft)
	const java = await ensureJava(dataPaths, javaPath, minMajor, onProgress, signal)
	const versionId = await ensureLoader({
		minecraft,
		loader,
		loaderVersion,
		dataPaths,
		javaPath: java.path,
		onProgress,
		signal,
	})
	const merged = await loadMergedVersion(dataPaths, versionId)
	const nativesDir = path.join(dataPaths.natives, versionId)
	await extractNatives(merged.libraries || [], dataPaths.libraries, nativesDir, signal)
	return { java, versionId, nativesDir }
}

async function launchCatalog(launcher, meta, opts, onEvent) {
	const dataPaths = launcher.paths
	const dir = launcher.instanceDir(meta.id || meta.instanceId)
	try {
		const { ensureSkinLoader } = require('./skinsync')
		ensureSkinLoader(dir, opts.serverUrl, dataPaths.games)
	} catch (e) { /* skip */ }
	const minMajor = neededJavaMajor(meta.minecraft)
	let java
	try {
		java = await ensureJava(dataPaths, opts.javaPath, minMajor, (p) => {
			onEvent({ stage: 'starting', java: '', detail: (p.stageLabel || 'Java') + (p.detail ? ' · ' + p.detail : '') })
		}, { cancelled: false })
	} catch (e) {
		return { error: e.message || String(e) }
	}
	if (!java) {
		return { error: `Нужна Java ${minMajor} для Minecraft ${meta.minecraft}.` }
	}

	let versionId = meta.versionId
	if (!versionId || !fs.existsSync(versionJsonPath(dataPaths.versions, versionId))) {
		onEvent({ stage: 'starting', java: java.path, detail: 'Догоняю Minecraft…' })
		const ensured = await ensureRuntime({
			paths: dataPaths,
			minecraft: meta.minecraft,
			loader: meta.loader,
			loaderVersion: meta.loaderVersion,
			javaPath: java.path,
			onProgress: (p) => onEvent({ stage: 'starting', java: java.path, detail: (p.stageLabel || '') + (p.detail ? ' · ' + p.detail : '') }),
			signal: { cancelled: false },
		})
		versionId = ensured.versionId
		meta.versionId = versionId
		writeMeta(dir, { ...meta, versionId })
	}

	const installLog = openLog(dir, 'orion-install.log')
	try {
		onEvent({ stage: 'starting', java: java.path, detail: 'Проверка установки…' })
		resolveClientJar({ id: versionId }, dataPaths, meta.minecraft, installLog)
		const pre = await validate.preflightLaunch(dataPaths, { ...meta, versionId }, dir)
		installLog.write('preflight-ok', {
			expectedJar: pre.layout.expectedJar,
			actualJar: pre.layout.actualName,
			ignoreList: pre.layout.ignoreList,
		})
	} catch (e) {
		installLog.write('preflight-fail', { error: e.message, issues: e.issues || [] })
		installLog.close()
		try { require('./telemetry').reportQuiet(opts.serverUrl, 'launch_preflight_fail', { pack: meta.id, reason: e.message }) } catch (_) {}
		return { error: e.message || String(e) }
	}

	const merged = await loadMergedVersion(dataPaths, versionId)
	const nativesDir = path.join(dataPaths.natives, versionId)
	if (!fs.existsSync(nativesDir)) {
		await extractNatives(merged.libraries || [], dataPaths.libraries, nativesDir, null)
	}

	const args = buildLaunchArgs(merged, dataPaths, dir, nativesDir, { ...opts, minecraft: meta.minecraft, log: installLog })
	appendJoinArgs(args, opts)
	fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
	const logPath = path.join(dir, 'logs', 'orion-latest.log')
	const logStream = fs.createWriteStream(logPath, { flags: 'w' })
	logStream.write(`[orion-catalog] java: ${java.path} (${java.raw})\n[orion-catalog] ник: ${opts.username}\n[orion-catalog] version: ${versionId}\n\n`)
	installLog.close()

	onEvent({ stage: 'starting', java: java.path })

	const proc = spawn(java.path, args, { cwd: dir, windowsHide: false })
	launcher.current = { proc, modpack: meta.id, username: opts.username, startedAt: Date.now() }

	const tail = []
	const keepTail = (buf) => {
		const text = buf.toString()
		logStream.write(text)
		for (const line of text.split('\n')) {
			if (line.trim()) tail.push(line.trim())
		}
		while (tail.length > 40) tail.shift()
	}
	proc.stdout.on('data', keepTail)
	proc.stderr.on('data', keepTail)

	let windowTimer = setTimeout(() => {
		if (launcher.isRunning) onEvent({ stage: 'running', pid: proc.pid })
	}, 4000)

	proc.on('error', (err) => {
		clearTimeout(windowTimer)
		logStream.end()
		launcher.current = null
		onEvent({ stage: 'error', error: `Не удалось запустить Java: ${err.message}` })
	})

	proc.on('exit', (code) => {
		clearTimeout(windowTimer)
		logStream.end()
		const elapsed = Date.now() - (launcher.current ? launcher.current.startedAt : Date.now())
		launcher.current = null
		if (code === 0) onEvent({ stage: 'exited', code, elapsed })
		else {
			onEvent({
				stage: 'crashed',
				code,
				elapsed,
				logPath,
				tail: tail.slice(-15),
				hint: elapsed < 20000
					? 'Игра закрылась сразу — часто это нехватка памяти, другой загрузчик или битые моды.'
					: null,
			})
		}
	})

	return { success: true, pid: proc.pid, java: java.path, logPath, catalog: true }
}

module.exports = {
	META_NAME,
	neededJavaMajor,
	readMeta,
	writeMeta,
	ensureRuntime,
	launchCatalog,
	ensureJava,
	appendJoinArgs,
	resolveClientJar,
	classpathFor,
	buildLaunchArgs,
	versionJsonPath,
	loadMergedVersion,
	patchIgnoreList,
}
