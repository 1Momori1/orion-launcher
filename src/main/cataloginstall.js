const fs = require('fs')
const path = require('path')
const { runPool, SpeedMeter, hashFile } = require('./net')
const { downloadWithRetryMirrored } = require('./mirrors')
const { extractZip } = require('./archive')
const catalog = require('./catalog')
const mclaunch = require('./mclaunch')

const FILE_CONCURRENCY = 8
const DL_OPTS = { attempts: 2, stallMs: 15000 }

function phasePercent(phase, inner = 0) {
	const map = {
		archive: [2, 18],
		unpack: [18, 24],
		resolve: [24, 30],
		mods: [30, 88],
		loader: [88, 98],
		done: [100, 100],
	}
	const [a, b] = map[phase] || [0, 100]
	return a + (b - a) * Math.max(0, Math.min(1, inner))
}

let currentSignal = { cancelled: false }

function cancel() {
	currentSignal.cancelled = true
}

function freshSignal() {
	currentSignal = { cancelled: false }
	return currentSignal
}

function instanceIdFor(source, slug, projectId) {
	const raw = String(slug || projectId || 'pack').toLowerCase()
	const s = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'pack'
	const prefix = source === 'curseforge' ? 'cf' : source === 'ftb' ? 'ftb' : source === 'vanilla' ? 'mc' : 'mr'
	return `catalog-${prefix}-${s}`
}

function instanceDir(paths, id) {
	return path.join(paths.games, id)
}

function isOrionPackDir(dir) {
	return fs.existsSync(path.join(dir, 'launch_args.template.txt')) && !fs.existsSync(path.join(dir, mclaunch.META_NAME))
}

function listInstances(paths) {
	const games = paths.games
	if (!fs.existsSync(games)) return []
	const out = []
	for (const name of fs.readdirSync(games)) {
		const dir = path.join(games, name)
		let st
		try { st = fs.statSync(dir) } catch (e) { continue }
		if (!st.isDirectory()) continue
		const meta = mclaunch.readMeta(dir)
		if (meta) out.push({ id: name, ...meta, dir })
	}
	out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru'))
	return out
}

function listOrionPacks(paths) {
	const games = paths.games
	if (!fs.existsSync(games)) return []
	const out = []
	for (const name of fs.readdirSync(games)) {
		const dir = path.join(games, name)
		if (isOrionPackDir(dir)) out.push({ id: name, name, dir, kind: 'orion' })
	}
	return out
}

function safeJoin(root, rel) {
	const n = path.normalize(String(rel).replace(/\\/g, '/')).replace(/^([/\\])+/, '')
	if (n.split(/[/\\]/).includes('..')) throw new Error('Некорректный путь в сборке: ' + rel)
	const full = path.resolve(root, n)
	const rootN = path.resolve(root)
	if (full !== rootN && !full.startsWith(rootN + path.sep)) throw new Error('Некорректный путь в сборке: ' + rel)
	return full
}

function copyDir(src, dest) {
	if (!fs.existsSync(src)) return
	fs.mkdirSync(dest, { recursive: true })
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, e.name)
		const d = path.join(dest, e.name)
		if (e.isDirectory()) copyDir(s, d)
		else fs.copyFileSync(s, d)
	}
}

function loadersFromDeps(deps) {
	const d = deps || {}
	const mc = d.minecraft
	if (d['fabric-loader']) return { minecraft: mc, loader: 'fabric', loaderVersion: d['fabric-loader'] }
	if (d['quilt-loader']) return { minecraft: mc, loader: 'quilt', loaderVersion: d['quilt-loader'] }
	if (d.neoforge) return { minecraft: mc, loader: 'neoforge', loaderVersion: d.neoforge }
	if (d.forge) return { minecraft: mc, loader: 'forge', loaderVersion: d.forge }
	return { minecraft: mc, loader: 'vanilla', loaderVersion: null }
}

function loadersFromCfManifest(man) {
	const mc = man.minecraft && man.minecraft.version
	const loaders = (man.minecraft && man.minecraft.modLoaders) || []
	const primary = loaders.find(l => l.primary) || loaders[0]
	const id = String((primary && primary.id) || '')
	const m = id.match(/^(neoforge|forge|fabric|quilt)-(.+)$/i)
	if (m) return { minecraft: mc, loader: m[1].toLowerCase(), loaderVersion: m[2] }
	return { minecraft: mc, loader: 'vanilla', loaderVersion: null }
}

function reportWrap(onProgress, extra) {
	if (onProgress) onProgress(extra)
}

async function downloadListedFiles(files, destRoot, onProgress, signal, headers) {
	const meter = new SpeedMeter()
	const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0)
	let doneBytes = 0
	let done = 0
	let last = 0
	const report = (force = false) => {
		const now = Date.now()
		if (!force && now - last < 350) return
		last = now
		const bps = meter.bps
		reportWrap(onProgress, {
			stage: 'mods',
			stageLabel: 'Моды',
			detail: `${done} / ${files.length}`,
			bytesDone: doneBytes,
			bytesTotal: totalBytes || doneBytes,
			percent: phasePercent('mods', totalBytes ? doneBytes / totalBytes : (files.length ? done / files.length : 1)),
			bps,
			etaSec: bps > 1024 && totalBytes ? Math.round((totalBytes - doneBytes) / bps) : null,
		})
	}

	await runPool(files, FILE_CONCURRENCY, async (f) => {
		const dest = safeJoin(destRoot, f.path)
		const hashes = f.hashes || {}
		let ok = false
		try {
			if (fs.existsSync(dest) && f.size && fs.statSync(dest).size === f.size) {
				if (hashes.sha1) ok = (await hashFile(dest, 'sha1')) === hashes.sha1
				else if (hashes.sha512) ok = (await hashFile(dest, 'sha512')) === hashes.sha512
				else ok = true
			}
		} catch (e) { ok = false }
		if (!ok) {
			const urls = (f.urls || []).filter(Boolean)
			const url = f.url || urls[0]
			if (!url) throw new Error('Нет ссылки на файл: ' + f.path)
			await downloadWithRetryMirrored(url, dest, {
				headers,
				urls,
				expectedSha1: hashes.sha1 || null,
				expectedSha512: hashes.sha512 || null,
				expectedSize: f.size || null,
				signal,
				...DL_OPTS,
				onChunk: (n) => { meter.add(n); doneBytes += n; report() },
			})
		} else if (f.size) {
			doneBytes += f.size
		}
		done++
		report()
	}, { signal })
	report(true)
}

async function installMrpack(mrpackPath, destDir, onProgress, signal) {
	const tmp = destDir + '-mrpack-tmp'
	fs.rmSync(tmp, { recursive: true, force: true })
	reportWrap(onProgress, { stage: 'pack', stageLabel: 'Сборка', detail: 'Распаковка .mrpack', percent: phasePercent('unpack', 0) })
	await extractZip(mrpackPath, tmp, {
		signal,
		onEntry: (name, n) => {
			reportWrap(onProgress, { stage: 'pack', stageLabel: 'Сборка', detail: 'Распаковка ' + n, percent: phasePercent('unpack', 0.4) })
		},
	})
	const indexPath = path.join(tmp, 'modrinth.index.json')
	if (!fs.existsSync(indexPath)) {
		fs.rmSync(tmp, { recursive: true, force: true })
		throw new Error('Это не Modrinth-сборка (нет modrinth.index.json)')
	}
	const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
	const deps = loadersFromDeps(index.dependencies)
	const files = []
	for (const f of index.files || []) {
		const env = (f.env && f.env.client) || 'required'
		if (env === 'unsupported') continue
		const downloads = (f.downloads || []).filter(Boolean)
		files.push({
			path: f.path,
			url: downloads[0] || '',
			urls: downloads,
			size: f.fileSize || 0,
			hashes: f.hashes || {},
		})
	}
	fs.mkdirSync(destDir, { recursive: true })
	await downloadListedFiles(files, destDir, onProgress, signal, catalog.headers())
	copyDir(path.join(tmp, 'overrides'), destDir)
	copyDir(path.join(tmp, 'client-overrides'), destDir)
	fs.rmSync(tmp, { recursive: true, force: true })
	return { name: index.name, deps, format: 'mrpack' }
}

function listedFromCfInfo(info, entry) {
	const fileName = info.fileName || `file-${info.id}.jar`
	const url = info.downloadUrl || ''
	const urls = catalog.cfDownloadCandidates(
		info.modId || entry.projectID || entry.projectId,
		info.id,
		fileName,
		url,
	)
	return {
		path: path.posix.join('mods', fileName),
		url: url || urls[0] || '',
		urls,
		size: info.fileLength || 0,
		hashes: {},
		_id: info.id,
	}
}

async function installCfZip(zipPath, destDir, apiKey, onProgress, signal) {
	const tmp = destDir + '-cf-tmp'
	fs.rmSync(tmp, { recursive: true, force: true })
	reportWrap(onProgress, { stage: 'pack', stageLabel: 'Сборка', detail: 'Распаковка CurseForge zip', percent: phasePercent('unpack', 0) })
	await extractZip(zipPath, tmp, {
		signal,
		onEntry: (name, n) => {
			reportWrap(onProgress, { stage: 'pack', stageLabel: 'Сборка', detail: 'Распаковка ' + n, percent: phasePercent('unpack', 0.4) })
		},
	})
	const manPath = path.join(tmp, 'manifest.json')
	if (!fs.existsSync(manPath)) {
		fs.rmSync(tmp, { recursive: true, force: true })
		throw new Error('Это не CurseForge-сборка (нет manifest.json)')
	}
	const man = JSON.parse(fs.readFileSync(manPath, 'utf8'))
	const deps = loadersFromCfManifest(man)
	const wanted = (man.files || []).filter(f => f.required !== false)
	const files = []
	if (wanted.length && apiKey) {
		try {
			const fileIds = wanted.map(f => f.fileID || f.fileId)
			const infos = await catalog.resolveCfFileInfos(fileIds, apiKey)
			const byId = new Map(infos.map(f => [f.id, f]))
			for (const entry of wanted) {
				const info = byId.get(entry.fileID || entry.fileId)
				if (!info) continue
				files.push(listedFromCfInfo(info, entry))
			}
		} catch (e) { /* качаем по зеркалам без имён файлов */ }
	}
	if (files.length !== wanted.length) {
		const have = new Set(files.map(f => f._id))
		const rest = wanted.filter(e => !have.has(e.fileID || e.fileId))
		reportWrap(onProgress, {
			stage: 'pack',
			stageLabel: 'CurseForge',
			detail: `Файлы сборки ${rest.length}`,
			percent: phasePercent('resolve', 1),
		})
		for (const entry of rest) {
			const modId = entry.projectID || entry.projectId
			const fileId = entry.fileID || entry.fileId
			const urls = catalog.cfDownloadCandidates(modId, fileId, '', '')
			if (!urls.length) throw new Error(`Нет ссылки на ${modId}/${fileId}`)
			files.push({
				path: path.posix.join('mods', `cf-${modId}-${fileId}.jar`),
				url: urls[0],
				urls,
				size: 0,
				hashes: {},
				_id: fileId,
			})
		}
	}
	fs.mkdirSync(destDir, { recursive: true })
	await downloadListedFiles(files, destDir, onProgress, signal, catalog.headers(apiKey ? { 'x-api-key': apiKey } : {}))
	const ov = man.overrides || 'overrides'
	copyDir(path.join(tmp, ov), destDir)
	fs.rmSync(tmp, { recursive: true, force: true })
	return { name: man.name, deps, format: 'curseforge' }
}

function ftbRel(f) {
	let p = String(f.path || '').replace(/^\.\//, '').replace(/\\/g, '/')
	const name = f.name || ''
	if (name && p !== name && !p.endsWith('/' + name) && !p.endsWith(name)) {
		if (p && !p.endsWith('/')) p += '/'
		p += name
	}
	return p.replace(/^\/+/, '')
}

function depsFromFtbTargets(targets) {
	const t = catalog.ftbTargets({ targets: targets || [] })
	return { minecraft: t.minecraft, loader: t.loader || 'vanilla', loaderVersion: t.loaderVersion }
}

async function installFtbPack(paths, project, versionId, javaPath, onProgress, signal) {
	const versions = await catalog.getVersions({ source: 'ftb', projectId: project.projectId })
	const version = versionId
		? versions.find(v => String(v.id) === String(versionId))
		: versions[0]
	if (!version) throw new Error('Версия FTB не найдена')
	reportWrap(onProgress, { stage: 'pack', stageLabel: 'FTB', detail: 'Манифест ' + (version.name || ''), percent: 4 })
	const man = await catalog.getFtbVersion(project.projectId, version.id)
	const deps = depsFromFtbTargets(man.targets)
	if (!deps.minecraft) throw new Error('В сборке FTB нет версии Minecraft')
	const id = instanceIdFor('ftb', project.slug, project.projectId)
	const destDir = instanceDir(paths, id)
	if (isOrionPackDir(destDir)) throw new Error('Нельзя ставить каталог поверх нашей сборки Orion')
	const files = []
	for (const f of man.files || []) {
		if (f.serveronly) continue
		if (!f.url) continue
		const rel = ftbRel(f)
		if (!rel) continue
		files.push({
			path: rel,
			url: f.url,
			size: f.size || 0,
			hashes: f.sha1 ? { sha1: f.sha1 } : {},
		})
	}
	fs.mkdirSync(destDir, { recursive: true })
	await downloadListedFiles(files, destDir, onProgress, signal, catalog.headers())
	return { id, destDir, deps, name: project.title, packVersion: version.versionNumber || version.name, packVersionId: String(version.id) }
}

async function installVanillaPack(paths, projectId, javaPath, onProgress, signal) {
	const mc = String(projectId)
	const id = instanceIdFor('vanilla', mc, mc)
	const destDir = instanceDir(paths, id)
	if (isOrionPackDir(destDir)) throw new Error('Нельзя ставить каталог поверх нашей сборки Orion')
	fs.mkdirSync(path.join(destDir, 'mods'), { recursive: true })
	return {
		id,
		destDir,
		deps: { minecraft: mc, loader: 'vanilla', loaderVersion: null },
		name: 'Minecraft ' + mc,
		packVersion: mc,
		packVersionId: mc,
	}
}

async function finishInstall({ paths, source, project, unpacked, javaPath, onProgress, signal }) {
	const destDir = unpacked.destDir
	const deps = unpacked.deps || {}
	if (!deps.minecraft) throw new Error('Не понял версию Minecraft у этой сборки')
	const ensured = await mclaunch.ensureRuntime({
		paths,
		minecraft: deps.minecraft,
		loader: deps.loader,
		loaderVersion: deps.loaderVersion,
		javaPath,
		onProgress: (p) => {
			if (!onProgress) return
			if (p && (p.stage === 'loader' || p.stage === 'java' || p.stage === 'vanilla')) {
				onProgress({ ...p, percent: phasePercent('loader', p.percent != null ? Number(p.percent) / 100 : 0.5) })
				return
			}
			onProgress(p)
		},
		signal,
	})
	const id = unpacked.id
	const meta = {
		kind: 'catalog',
		id,
		source,
		projectId: String(project.projectId || unpacked.packVersionId),
		slug: project.slug || id,
		name: unpacked.name || project.title,
		iconUrl: project.iconUrl || '',
		versionId: ensured.versionId,
		packVersionId: String(unpacked.packVersionId || ''),
		packVersion: unpacked.packVersion,
		minecraft: deps.minecraft,
		loader: deps.loader,
		loaderVersion: deps.loaderVersion,
		installedAt: new Date().toISOString(),
	}
	mclaunch.writeMeta(destDir, meta)
	try {
		const { ensureSkinLoader } = require('./skinsync')
		const { PUBLIC_URL } = require('./hosts')
		ensureSkinLoader(destDir, PUBLIC_URL, paths.games)
	} catch (e) { /* skip */ }
	reportWrap(onProgress, { stage: 'done', stageLabel: 'Готово', detail: meta.name, percent: 100 })
	return { id, meta, dir: destDir }
}

async function installPack({ paths, source, projectId, versionId, apiKey, javaPath, onProgress }) {
	const signal = freshSignal()
	if (source === 'vanilla') {
		const project = await catalog.getProject({ source, projectId })
		const unpacked = await installVanillaPack(paths, projectId, javaPath, onProgress, signal)
		return finishInstall({ paths, source, project, unpacked, javaPath, onProgress, signal })
	}
	if (source === 'ftb') {
		const project = await catalog.getProject({ source, projectId })
		const unpacked = await installFtbPack(paths, project, versionId, javaPath, onProgress, signal)
		return finishInstall({ paths, source, project, unpacked, javaPath, onProgress, signal })
	}

	const project = await catalog.getProject({ source, projectId, apiKey })
	const versions = await catalog.getVersions({ source, projectId, apiKey })
	const version = versionId
		? versions.find(v => String(v.id) === String(versionId))
		: versions[0]
	if (!version) throw new Error('Версия сборки не найдена')
	const file = catalog.pickPrimaryFile(version)
	if (!file) throw new Error('У версии нет файла для скачивания')

	let url = file.url
	const extraUrls = (file.urls && file.urls.length)
		? file.urls
		: (source === 'curseforge' ? catalog.cfDownloadCandidates(projectId, file.fileId || version.id, file.filename, url) : [])
	if (source === 'curseforge' && !url) {
		url = extraUrls[0] || await catalog.resolveCfDownloadUrl({ ...file, modId: Number(projectId), fileId: file.fileId || version.id }, apiKey)
	}
	if (!url) throw new Error('Нет ссылки на файл сборки')

	const id = instanceIdFor(source, project.slug, projectId)
	const destDir = instanceDir(paths, id)
	if (isOrionPackDir(destDir)) {
		throw new Error('Нельзя ставить каталог поверх нашей сборки Orion')
	}

	fs.mkdirSync(paths.cache, { recursive: true })
	const archivePath = path.join(paths.cache, file.filename || (id + '.zip'))
	reportWrap(onProgress, { stage: 'pack', stageLabel: 'Сборка', detail: 'Скачиваю ' + (file.filename || 'архив'), percent: phasePercent('archive', 0) })
	let got = 0
	await downloadWithRetryMirrored(url, archivePath, {
		headers: catalog.headers(source === 'curseforge' && apiKey ? { 'x-api-key': apiKey } : {}),
		urls: extraUrls,
		expectedSha1: (file.hashes && file.hashes.sha1) || null,
		expectedSha512: (file.hashes && file.hashes.sha512) || null,
		expectedSize: file.size || null,
		signal,
		...DL_OPTS,
		onChunk: (n) => {
			got += n
			reportWrap(onProgress, {
				stage: 'pack',
				stageLabel: 'Сборка',
				detail: 'Скачиваю ' + (file.filename || 'архив'),
				percent: phasePercent('archive', file.size ? got / file.size : 0.3),
				bytesDone: got,
				bytesTotal: file.size || got,
			})
		},
	})

	const lower = String(file.filename || '').toLowerCase()
	let unpacked
	if (lower.endsWith('.mrpack') || lower.includes('.mrpack')) {
		unpacked = await installMrpack(archivePath, destDir, onProgress, signal)
	} else {
		unpacked = await installCfZip(archivePath, destDir, apiKey, onProgress, signal)
	}

	const deps = unpacked.deps || {}
	if (!deps.minecraft) {
		deps.minecraft = (version.gameVersions || []).find(v => /^\d+\.\d+/.test(v))
	}
	if (!deps.loader || deps.loader === 'vanilla') {
		const l = (version.loaders || [])[0]
		if (l) deps.loader = l
	}

	if (!deps.minecraft) throw new Error('Не понял версию Minecraft у этой сборки')

	const ensured = await mclaunch.ensureRuntime({
		paths,
		minecraft: deps.minecraft,
		loader: deps.loader,
		loaderVersion: deps.loaderVersion,
		javaPath,
		onProgress,
		signal,
	})

	const meta = {
		kind: 'catalog',
		id,
		source,
		projectId: String(projectId),
		slug: project.slug,
		name: unpacked.name || project.title,
		iconUrl: project.iconUrl || '',
		versionId: ensured.versionId,
		packVersionId: String(version.id),
		packVersion: version.versionNumber || version.name,
		minecraft: deps.minecraft,
		loader: deps.loader,
		loaderVersion: deps.loaderVersion,
		installedAt: new Date().toISOString(),
	}
	mclaunch.writeMeta(destDir, meta)
	try { fs.unlinkSync(archivePath) } catch (e) {}
	reportWrap(onProgress, { stage: 'done', stageLabel: 'Готово', detail: meta.name, percent: 100 })
	return { id, meta, dir: destDir }
}

async function installMod({ paths, source, projectId, versionId, instanceId, apiKey, onProgress, kind = 'mod' }) {
	const signal = freshSignal()
	if (!instanceId) throw new Error('Сначала выберите сборку, куда поставить')
	const destDir = instanceDir(paths, instanceId)
	if (!fs.existsSync(destDir)) throw new Error('Сборка не установлена')
	const orion = isOrionPackDir(destDir)
	const catalogInst = !!mclaunch.readMeta(destDir)
	if (!orion && !catalogInst) throw new Error('Неизвестная папка сборки')

	const versions = await catalog.getVersions({ source, projectId, apiKey })
	const version = versionId
		? versions.find(v => String(v.id) === String(versionId))
		: versions[0]
	if (!version) throw new Error('Версия не найдена')
	const file = catalog.pickPrimaryFile(version)
	if (!file) throw new Error('У версии нет файла')
	let url = file.url
	const extraUrls = (file.urls && file.urls.length)
		? file.urls
		: (source === 'curseforge' ? catalog.cfDownloadCandidates(projectId, file.fileId || version.id, file.filename, url) : [])
	if (source === 'curseforge' && !url) {
		url = extraUrls[0] || await catalog.resolveCfDownloadUrl({ ...file, modId: Number(projectId), fileId: file.fileId || version.id }, apiKey)
	}
	if (!url) throw new Error('Нет ссылки на файл')

	const folders = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' }
	const folder = folders[kind] || 'mods'
	const modsDir = path.join(destDir, folder)
	fs.mkdirSync(modsDir, { recursive: true })
	const filename = file.filename || `file-${projectId}.jar`
	const dest = path.join(modsDir, path.basename(filename))
	reportWrap(onProgress, { stage: 'mods', stageLabel: folder, detail: filename, percent: 10 })
	await downloadWithRetryMirrored(url, dest, {
		headers: catalog.headers(source === 'curseforge' && apiKey ? { 'x-api-key': apiKey } : {}),
		urls: extraUrls,
		expectedSha1: (file.hashes && file.hashes.sha1) || null,
		expectedSha512: (file.hashes && file.hashes.sha512) || null,
		expectedSize: file.size || null,
		signal,
		...DL_OPTS,
	})
	reportWrap(onProgress, { stage: 'done', stageLabel: 'Готово', detail: filename, percent: 100 })
	return { filename: path.basename(dest), dest, orion, folder }
}

function listMods(paths, instanceId) {
	const dir = path.join(instanceDir(paths, instanceId), 'mods')
	if (!fs.existsSync(dir)) return []
	return fs.readdirSync(dir)
		.filter(n => /\.jar(\.disabled)?$/i.test(n))
		.map(n => {
			const full = path.join(dir, n)
			let size = 0
			try { size = fs.statSync(full).size } catch (e) {}
			return { filename: n, size, disabled: /\.disabled$/i.test(n) }
		})
}

function removeMod(paths, instanceId, filename) {
	const base = path.basename(String(filename || ''))
	if (!base || base.includes('..')) throw new Error('Некорректное имя файла')
	const full = path.join(instanceDir(paths, instanceId), 'mods', base)
	if (!fs.existsSync(full)) throw new Error('Мод не найден')
	fs.unlinkSync(full)
	return true
}

function uninstallInstance(paths, id) {
	if (!String(id).startsWith('catalog-')) throw new Error('Можно удалять только сборки из каталога')
	const dir = instanceDir(paths, id)
	const meta = mclaunch.readMeta(dir)
	if (!meta) throw new Error('Это не сборка из каталога')
	fs.rmSync(dir, { recursive: true, force: true })
	return true
}

async function downloadCatalogFile({ source, projectId, versionId, destDir, folder, apiKey, onProgress, signal }) {
	const versions = await catalog.getVersions({ source, projectId, apiKey })
	const version = versionId
		? versions.find((v) => String(v.id) === String(versionId))
		: versions[0]
	if (!version) throw new Error('Версия не найдена: ' + (projectId || ''))
	const file = catalog.pickPrimaryFile(version)
	if (!file) throw new Error('У версии нет файла: ' + (projectId || ''))
	let url = file.url
	const extraUrls = (file.urls && file.urls.length)
		? file.urls
		: (source === 'curseforge' ? catalog.cfDownloadCandidates(projectId, file.fileId || version.id, file.filename, url) : [])
	if (source === 'curseforge' && !url) {
		url = extraUrls[0] || await catalog.resolveCfDownloadUrl({ ...file, modId: Number(projectId), fileId: file.fileId || version.id }, apiKey)
	}
	if (!url) throw new Error('Нет ссылки на файл: ' + (projectId || ''))
	const dir = path.join(destDir, folder || 'mods')
	fs.mkdirSync(dir, { recursive: true })
	const filename = path.basename(file.filename || `file-${projectId}.jar`)
	const dest = path.join(dir, filename)
	reportWrap(onProgress, { stage: 'mods', stageLabel: folder || 'mods', detail: filename, percent: 12 })
	await downloadWithRetryMirrored(url, dest, {
		headers: catalog.headers(source === 'curseforge' && apiKey ? { 'x-api-key': apiKey } : {}),
		urls: extraUrls,
		expectedSha1: (file.hashes && file.hashes.sha1) || null,
		expectedSha512: (file.hashes && file.hashes.sha512) || null,
		expectedSize: file.size || null,
		signal,
		...DL_OPTS,
	})
	return dest
}

async function installRecipe({ paths, client, apiKey, javaPath, onProgress }) {
	const signal = freshSignal()
	const id = String(client.instance || 'catalog-orion-vanilla')
	const destDir = instanceDir(paths, id)
	if (isOrionPackDir(destDir)) throw new Error('Нельзя ставить рецепт поверх нашей сборки Orion')
	fs.mkdirSync(path.join(destDir, 'mods'), { recursive: true })
	const minecraft = String(client.minecraft || '')
	const loader = String(client.loader || 'vanilla')
	const loaderVersion = client.loaderVersion || null
	if (!minecraft) throw new Error('В рецепте нет версии Minecraft')
	const ensured = await mclaunch.ensureRuntime({
		paths,
		minecraft,
		loader,
		loaderVersion,
		javaPath,
		onProgress,
		signal,
	})
	const mods = Array.isArray(client.mods) ? client.mods : []
	for (const mod of mods) {
		if (signal.cancelled) throw Object.assign(new Error('Отменено пользователем'), { cancelled: true })
		await downloadCatalogFile({
			source: mod.source || 'modrinth',
			projectId: mod.project || mod.projectId,
			versionId: mod.version || mod.versionId,
			destDir,
			folder: 'mods',
			apiKey,
			onProgress,
			signal,
		})
	}
	const meta = {
		kind: 'catalog',
		id,
		source: 'orion',
		projectId: id,
		slug: id,
		name: client.name || 'Orion Vanilla',
		iconUrl: '',
		versionId: ensured.versionId,
		packVersionId: loaderVersion || minecraft,
		packVersion: (loader === 'vanilla' ? minecraft : `${loader} ${loaderVersion || ''}`).trim(),
		minecraft,
		loader,
		loaderVersion,
		installedAt: new Date().toISOString(),
	}
	mclaunch.writeMeta(destDir, meta)
	try {
		const { ensureSkinLoader } = require('./skinsync')
		const { PUBLIC_URL } = require('./hosts')
		ensureSkinLoader(destDir, PUBLIC_URL, paths.games)
	} catch (e) { /* skip */ }
	reportWrap(onProgress, { stage: 'done', stageLabel: 'Готово', detail: meta.name, percent: 100 })
	return { id, meta, dir: destDir }
}

async function installClient({ paths, client, apiKey, javaPath, onProgress }) {
	if (!client || !client.type) throw new Error('Для этого сервера нет клиентской сборки')
	if (client.type === 'catalog') {
		return installPack({
			paths,
			source: client.source,
			projectId: client.project || client.projectId,
			versionId: client.version || client.versionId,
			apiKey,
			javaPath,
			onProgress,
		})
	}
	if (client.type === 'recipe') {
		return installRecipe({ paths, client, apiKey, javaPath, onProgress })
	}
	throw new Error('Эту сборку нужно ставить из списка Orion, не из каталога')
}

module.exports = {
	cancel,
	installPack,
	installMod,
	installClient,
	installRecipe,
	listInstances,
	listOrionPacks,
	listMods,
	removeMod,
	uninstallInstance,
	instanceIdFor,
	isOrionPackDir,
}
