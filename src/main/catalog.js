const { fetchJson } = require('./net')
const { UA, headers, preferMirror, fetchFirst, fetchJsonMirrored } = require('./mirrors')

const MR_BASES = [
	'https://mod.mcimirror.top/modrinth/v2',
	'https://api.modrinth.com/v2',
]
const CF_BASES = [
	'https://mod.mcimirror.top/curseforge/v1',
	'https://api.curse.tools/v1/cf',
]
const CF_OFFICIAL = 'https://api.curseforge.com/v1'
const FTB = 'https://api.modpacks.ch'
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const CF_GAME_ID = 432
const CF_CLASS = {
	modpack: 4471,
	mod: 6,
	resourcepack: 12,
	shader: 6552,
	datapack: 6945,
}
const SEARCH_TYPES = new Set(['modpack', 'mod', 'vanilla', 'resourcepack', 'shader', 'datapack'])
const LOADER_HINTS = ['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'rift', 'vanilla']
const MEM_TTL = 10 * 60 * 1000
const memCache = new Map()

function asList(v) {
	if (Array.isArray(v)) return v.map((s) => String(s || '').trim()).filter(Boolean)
	if (v == null || v === '') return []
	return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function searchKind(type) {
	const t = String(type || 'modpack')
	return SEARCH_TYPES.has(t) ? t : 'modpack'
}

function cached(bucket, key, fn) {
	const k = bucket + ':' + key
	const hit = memCache.get(k)
	if (hit && Date.now() - hit.at < MEM_TTL) return Promise.resolve(hit.val)
	return Promise.resolve()
		.then(fn)
		.then((val) => {
			memCache.set(k, { at: Date.now(), val })
			if (memCache.size > 400) {
				const first = memCache.keys().next().value
				memCache.delete(first)
			}
			return val
		})
}

function cfDownloadCandidates(modId, fileId, fileName, officialUrl) {
	const id = Number(fileId)
	const a = Math.floor(id / 1000)
	const b = id % 1000
	const name = String(fileName || '')
	const enc = encodeURIComponent(name).replace(/!/g, '%21')
	const out = []
	if (officialUrl) out.push(String(officialUrl))
	if (id && name) {
		for (const host of [
			'https://mediafilez.forgecdn.net/files',
			'https://edge.forgecdn.net/files',
			'https://media.forgecdn.net/files',
		]) {
			out.push(`${host}/${a}/${b}/${name}`)
			if (enc !== name) out.push(`${host}/${a}/${b}/${enc}`)
		}
	}
	if (modId && fileId) {
		out.push(`https://mod.mcimirror.top/curseforge/v1/mods/${modId}/files/${fileId}/download`)
		out.push(`https://api.curse.tools/v1/cf/mods/${modId}/files/${fileId}/download`)
	}
	const seen = new Set()
	return out.filter((u) => {
		if (!u || seen.has(u)) return false
		seen.add(u)
		return true
	})
}

function cfProjectType(classId, fallback) {
	for (const [k, v] of Object.entries(CF_CLASS)) {
		if (Number(classId) === v) return k
	}
	return fallback || 'modpack'
}

function num(n) {
	const x = Number(n)
	return Number.isFinite(x) ? x : 0
}

function loadersFromTags(tags) {
	const out = []
	for (const t of tags || []) {
		const s = String(t).toLowerCase()
		if (LOADER_HINTS.includes(s) && !out.includes(s)) out.push(s)
	}
	return out
}

async function mrGet(path, timeout = 25000) {
	return fetchFirst(MR_BASES, path, { timeout })
}

async function cfGet(path, apiKey, timeout = 10000, signal = null) {
	const key = String(apiKey || '').trim()
	const bases = CF_BASES.slice()
	if (key) bases.push(CF_OFFICIAL)
	const h = headers(key ? { 'x-api-key': key } : {})
	try {
		return await fetchFirst(bases, path, { timeout, headers: h, signal })
	} catch (e) {
		if (e && e.cancelled) throw e
		throw new Error(
			'CurseForge сейчас не открывается. Попробуйте FTB или Modrinth — из России они обычно живее. '
			+ 'Свой ключ CurseForge Core можно вставить в настройках (console.curseforge.com), если хотите официальный API. '
			+ ((e && e.message) || '')
		)
	}
}

async function cfPost(path, apiKey, body) {
	const { request } = require('./net')
	const key = String(apiKey || '').trim()
	if (!key) throw new Error('Пакетный запрос CurseForge без ключа недоступен')
	const raw = JSON.stringify(body)
	const r = await request('POST', CF_OFFICIAL + path, {
		headers: headers({
			'x-api-key': key,
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(raw),
		}),
		body: raw,
		timeout: 30000,
	})
	try { return JSON.parse(r.body) } catch (e) { return r.body }
}

async function ftbGet(path, timeout = 25000) {
	return fetchJson(FTB + path, { headers: headers(), timeout })
}

function normalizeMrHit(h, projectType) {
	return {
		source: 'modrinth',
		projectId: h.project_id || h.id,
		slug: h.slug,
		title: h.title,
		description: h.description || '',
		iconUrl: preferMirror(h.icon_url || '') || '',
		downloads: num(h.downloads),
		follows: num(h.follows),
		categories: h.categories || [],
		loaders: loadersFromTags(h.categories),
		projectType: h.project_type || projectType,
		author: h.author || '',
		date: h.date_modified || h.date_created || '',
	}
}

function normalizeCfMod(m, projectType) {
	const logo = (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || ''
	const authors = (m.authors || []).map(a => a.name).filter(Boolean)
	const cats = (m.categories || []).map(c => (c.slug || c.name || '').toLowerCase())
	return {
		source: 'curseforge',
		projectId: String(m.id),
		slug: m.slug,
		title: m.name,
		description: m.summary || '',
		iconUrl: preferMirror(logo) || logo,
		downloads: num(m.downloadCount),
		follows: 0,
		categories: cats,
		loaders: loadersFromTags(cats.concat(m.latestFilesIndexes ? m.latestFilesIndexes.map(f => f.modLoader) : [])),
		projectType,
		author: authors[0] || '',
		date: m.dateModified || m.dateCreated || '',
	}
}

function ftbIcon(art) {
	const list = art || []
	const square = list.find(a => a && a.type === 'square' && a.url)
	const any = list.find(a => a && a.url)
	return (square || any || {}).url || ''
}

function ftbTargets(packOrVersion) {
	const targets = packOrVersion.targets || []
	const game = targets.find(t => t.type === 'game' || String(t.name).toLowerCase() === 'minecraft')
	const loader = targets.find(t => t.type === 'modloader')
	return {
		minecraft: game && game.version,
		loader: loader ? String(loader.name).toLowerCase() : 'vanilla',
		loaderVersion: loader && loader.version,
		gameVersions: game ? [game.version] : [],
		loaders: loader ? [String(loader.name).toLowerCase()] : ['vanilla'],
	}
}

function normalizeFtbHit(p) {
	const t = ftbTargets(p.versions && p.versions[0] ? p.versions[0] : p)
	const authors = (p.authors || []).map(a => a.name || a).filter(Boolean)
	return {
		source: 'ftb',
		projectId: String(p.id),
		slug: String(p.id),
		title: p.name,
		description: p.synopsis || '',
		iconUrl: ftbIcon(p.art),
		downloads: num(p.installs || p.plays),
		follows: 0,
		categories: (p.tags || []).map(x => x.name || x).filter(Boolean),
		loaders: t.loaders,
		projectType: 'modpack',
		author: authors[0] || 'FTB',
		date: p.updated ? new Date(p.updated * 1000).toISOString() : '',
	}
}

function normalizeMrVersion(v) {
	const files = (v.files || []).map(f => ({
		url: f.url,
		filename: f.filename,
		size: num(f.size),
		primary: !!f.primary,
		hashes: f.hashes || {},
	}))
	return {
		id: v.id,
		name: v.name || v.version_number,
		versionNumber: v.version_number,
		gameVersions: v.game_versions || [],
		loaders: (v.loaders || []).map(s => String(s).toLowerCase()),
		date: v.date_published || '',
		featured: !!v.featured,
		files,
		dependencies: (v.dependencies || []).map((d) => ({
			projectId: d.project_id,
			type: d.dependency_type || 'optional',
		})).filter((d) => d.projectId),
	}
}

function cfLoaderName(file) {
	const tags = []
	for (const g of file.gameVersions || []) tags.push(g)
	return loadersFromTags(tags)
}

function normalizeCfFile(f) {
	const gameVersions = (f.gameVersions || []).filter(v => /^\d+\.\d+/.test(String(v)))
	const loaders = loadersFromTags(f.gameVersions || [])
	return {
		id: String(f.id),
		name: f.displayName || f.fileName,
		versionNumber: f.displayName || f.fileName,
		gameVersions,
		loaders: loaders.length ? loaders : cfLoaderName(f),
		date: f.fileDate || '',
		featured: f.releaseType === 1,
		files: [{
			url: f.downloadUrl || '',
			urls: cfDownloadCandidates(f.modId, f.id, f.fileName, f.downloadUrl),
			filename: f.fileName,
			size: num(f.fileLength),
			primary: true,
			hashes: {},
			fileId: f.id,
			modId: f.modId,
		}],
		dependencies: (f.dependencies || []).map((d) => ({
			projectId: String(d.modId || d.addonId || ''),
			type: d.relationType === 3 ? 'required' : d.relationType === 5 ? 'incompatible' : 'optional',
		})).filter((d) => d.projectId),
	}
}

function normalizeFtbVersion(v) {
	const t = ftbTargets(v)
	return {
		id: String(v.id),
		name: v.name,
		versionNumber: v.name,
		gameVersions: t.gameVersions,
		loaders: t.loaders,
		date: v.updated ? new Date(v.updated * 1000).toISOString() : '',
		featured: v.type === 'release',
		files: [],
		_ftbTargets: t,
	}
}

const CF_CAT = {
	adventure: 422,
	magic: 419,
	technology: 412,
	decoration: 424,
	optimization: 4843,
	library: 421,
	utility: 5191,
	worldgen: 406,
	food: 436,
	equipment: 434,
	storage: 1336,
	mobs: 411,
	addon: 426,
	quest: 4217,
}

function catAliases(c) {
	const map = {
		adventure: ['adventure', 'rpg'],
		magic: ['magic'],
		technology: ['technology', 'tech'],
		decoration: ['decoration', 'cosmetic'],
		optimization: ['optimization', 'performance'],
		library: ['library', 'api and library'],
		utility: ['utility', 'utilities'],
		worldgen: ['worldgen', 'world generation'],
		food: ['food'],
		equipment: ['equipment', 'armor'],
		storage: ['storage'],
		mobs: ['mobs'],
		addon: ['addon', 'addons', 'add-on'],
		quest: ['quest', 'quests'],
	}
	return map[c] || [c]
}

function hitHasCat(h, cat) {
	const have = (h.categories || []).map((x) => String(x).toLowerCase())
	const blob = (h.title + ' ' + (h.description || '')).toLowerCase()
	if (cat === 'quest') return have.some((x) => x.includes('quest')) || /\bquest/.test(blob)
	return catAliases(cat).some((n) => have.some((x) => x.includes(n)))
}

function hitHasAllCats(h, cats) {
	const need = (cats || []).filter((c) => c && c !== 'addon')
	if (!need.length) return true
	return need.every((c) => hitHasCat(h, c))
}

async function cacheHitIcons(hits, waitMs) {
	try {
		const imgcache = require('./imgcache')
		const urls = (hits || []).map((h) => h.iconUrl || '')
		const local = await imgcache.cacheList(urls, { waitMs: waitMs == null ? 1600 : waitMs })
		;(hits || []).forEach((h, i) => {
			if (local[i]) h.iconUrl = local[i]
		})
	} catch (e) { /* skip */ }
	return hits
}

async function search({ source = 'auto', type = 'modpack', query = '', offset = 0, limit = 20, loader = '', category = '', gameVersion = '', apiKey = '' } = {}) {
	const kind = searchKind(type)
	const cats = asList(category)
	const key = JSON.stringify({
		source: source || 'auto',
		type: kind,
		query: String(query || ''),
		offset: offset || 0,
		limit: limit || 20,
		loader: loader || '',
		cats,
		gameVersion: gameVersion || '',
	})
	return cached('search', key, async () => {
		const r = await searchUncached({ source, type: kind, query, offset, limit, loader, category: cats, gameVersion, apiKey })
		if (r && r.hits) await cacheHitIcons(r.hits)
		return r
	})
}

async function searchUncached({ source = 'auto', type = 'modpack', query = '', offset = 0, limit = 20, loader = '', category = [], gameVersion = '', apiKey = '' } = {}) {
	const kind = searchKind(type)
	if (kind === 'vanilla' || source === 'vanilla') return searchVanilla({ query, offset, limit })
	if (source === 'auto' || !source) {
		return searchAuto({ type: kind, query, offset, limit, loader, category, gameVersion, apiKey })
	}
	if (source === 'curseforge') return searchCurseforge({ type: kind, query, offset, limit, loader, category, gameVersion, apiKey })
	if (source === 'ftb') return searchFtb({ query, offset, limit })
	return searchModrinth({ type: kind === 'mod' ? 'mod' : kind, query, offset, limit, loader, category, gameVersion })
}

function mergeKey(h) {
	return String(h.slug || h.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function withSources(h) {
	return {
		...h,
		primarySource: h.source,
		sources: [{ source: h.source, projectId: h.projectId, slug: h.slug, downloads: h.downloads, iconUrl: h.iconUrl }],
	}
}

function mergeHits(groups) {
	const map = new Map()
	const errors = []
	for (const g of groups) {
		if (g && g.error) errors.push({ source: g.source, error: g.error })
		for (const h of (g && g.hits) || []) {
			const key = mergeKey(h)
			if (!key) continue
			const alt = { source: h.source, projectId: h.projectId, slug: h.slug, downloads: h.downloads, iconUrl: h.iconUrl }
			const prev = map.get(key)
			if (!prev) {
				map.set(key, { ...h, source: 'auto', primarySource: h.source, sources: [alt] })
				continue
			}
			if (!prev.sources.some((s) => s.source === alt.source && String(s.projectId) === String(alt.projectId))) {
				prev.sources.push(alt)
			}
			if ((h.downloads || 0) > (prev.downloads || 0)) {
				prev.downloads = h.downloads
				prev.iconUrl = h.iconUrl || prev.iconUrl
				prev.description = h.description || prev.description
				prev.primarySource = h.source
				prev.projectId = h.projectId
				prev.slug = h.slug || prev.slug
			}
			for (const l of h.loaders || []) {
				if (!prev.loaders.includes(l)) prev.loaders.push(l)
			}
		}
	}
	const hits = [...map.values()].sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
	const total = groups.reduce((n, g) => n + num(g && g.total), 0)
	return { hits, errors, total }
}

async function searchAuto({ type, query, offset, limit, loader, category, gameVersion, apiKey }) {
	const mrType = type === 'modpack' ? 'modpack' : type
	const jobs = [
		searchModrinth({ type: mrType, query, offset, limit, loader, category, gameVersion })
			.catch((e) => ({ source: 'modrinth', hits: [], total: 0, error: e.message })),
		searchCurseforge({ type, query, offset, limit, loader, category, gameVersion, apiKey })
			.catch((e) => ({ source: 'curseforge', hits: [], total: 0, error: e.message })),
	]
	if (type === 'modpack') {
		jobs.push(searchFtb({ query, offset, limit }).catch((e) => ({ source: 'ftb', hits: [], total: 0, error: e.message })))
	}
	const groups = await Promise.all(jobs)
	const merged = mergeHits(groups)
	const cats = asList(category)
	const hits = cats.length > 1 ? merged.hits.filter((h) => hitHasAllCats(h, cats)) : merged.hits
	return {
		source: 'auto',
		total: merged.total || hits.length,
		offset,
		limit: hits.length,
		hits,
		errors: merged.errors,
	}
}

async function searchModrinth({ type, query, offset, limit, loader, category, gameVersion }) {
	const cats = asList(category)
	const facets = [[`project_type:${type}`]]
	if (loader) facets.push([`categories:${loader}`])
	for (const c of cats) {
		if (c === 'addon' || c === 'quest') continue
		facets.push([`categories:${c}`])
	}
	if (gameVersion) facets.push([`versions:${gameVersion}`])
	let q = query || ''
	if (cats.includes('addon') && q && !/addon|дополн/i.test(q)) q = q + ' addon'
	if (cats.includes('quest') && q && !/quest|квест/i.test(q)) q = (q + ' quest').trim()
	if (cats.includes('quest') && !q) q = 'quest'
	const params = new URLSearchParams({
		query: q,
		limit: String(Math.min(50, Math.max(1, limit || 20))),
		offset: String(Math.max(0, offset || 0)),
		index: q ? 'relevance' : 'downloads',
		facets: JSON.stringify(facets),
	})
	const r = await mrGet(`/search?${params}`)
	let hits = (r.hits || []).map(h => normalizeMrHit(h, type))
	if (cats.length > 1) hits = hits.filter((h) => hitHasAllCats(h, cats))
	return { source: 'modrinth', total: num(r.total_hits), offset: num(r.offset), limit: num(r.limit) || hits.length, hits }
}

async function searchCurseforge({ type, query, offset, limit, loader, category, gameVersion, apiKey }) {
	const cats = asList(category)
	const pageSize = Math.min(50, Math.max(1, limit || 20))
	const index = Math.max(0, offset || 0)
	let q = query || ''
	if (cats.includes('addon') && q && !/addon|дополн/i.test(q)) q = q + ' addon'
	if (cats.includes('quest') && q && !/quest|квест/i.test(q)) q = (q + ' quest').trim()
	const params = new URLSearchParams({
		gameId: String(CF_GAME_ID),
		classId: String(CF_CLASS[type] || CF_CLASS.modpack),
		searchFilter: q,
		pageSize: String(pageSize),
		index: String(index),
		sortField: '2',
		sortOrder: 'desc',
	})
	if (loader) {
		const map = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }
		if (map[loader]) params.set('modLoaderType', String(map[loader]))
	}
	if (gameVersion) params.set('gameVersion', gameVersion)
	if (cats.length === 1 && CF_CAT[cats[0]]) params.set('categoryId', String(CF_CAT[cats[0]]))
	else if (cats.length > 1) {
		const first = cats.find((c) => CF_CAT[c])
		if (first) params.set('categoryId', String(CF_CAT[first]))
	}
	const r = await cfGet(`/mods/search?${params}`, apiKey)
	const data = r.data || r.hits || []
	let hits = data.map(m => normalizeCfMod(m, type))
	if (cats.length > 1) hits = hits.filter((h) => hitHasAllCats(h, cats))
	const total = (r.pagination && r.pagination.totalCount) || hits.length
	return { source: 'curseforge', total, offset: index, limit: pageSize, hits }
}

async function searchFtb({ query, offset, limit }) {
	const pageSize = Math.min(20, Math.max(1, limit || 20))
	const off = Math.max(0, offset || 0)
	if (query) {
		const r = await ftbGet(`/public/modpack/search/${pageSize}/detailed?term=${encodeURIComponent(query)}`, 20000)
		const packs = r.packs || []
		const hits = packs.map(normalizeFtbHit)
		return { source: 'ftb', total: num(r.total) || hits.length, offset: 0, limit: pageSize, hits }
	}
	const pop = await ftbGet(`/public/modpack/popular/installs/${off + pageSize}`, 20000)
	const ids = (pop.packs || []).slice(off, off + pageSize)
	const hits = (await Promise.all(ids.map(async (id) => {
		try {
			const p = await ftbGet(`/public/modpack/${id}`, 15000)
			return normalizeFtbHit(p)
		} catch (e) {
			return null
		}
	}))).filter(Boolean)
	return { source: 'ftb', total: num(pop.total) || (off + hits.length + 5), offset: off, limit: pageSize, hits }
}

let vanillaMan = null
let vanillaManAt = 0

async function loadVanillaManifest() {
	if (vanillaMan && Date.now() - vanillaManAt < 60 * 60 * 1000) return vanillaMan
	let last = null
	for (let i = 0; i < 2; i++) {
		try {
			vanillaMan = await fetchJsonMirrored(MOJANG_MANIFEST, { timeout: 20000 })
			vanillaManAt = Date.now()
			return vanillaMan
		} catch (e) {
			last = e
			await new Promise((r) => setTimeout(r, 600))
		}
	}
	throw last || new Error('Манифест Minecraft не открылся')
}

async function searchVanilla({ query, offset, limit }) {
	const man = await loadVanillaManifest()
	const q = String(query || '').trim().toLowerCase()
	let versions = (man.versions || []).filter(v => v.type === 'release' || (q && v.type === 'snapshot'))
	if (q) versions = versions.filter(v => String(v.id).toLowerCase().includes(q))
	const off = Math.max(0, offset || 0)
	const pageSize = Math.min(40, Math.max(1, limit || 20))
	const slice = versions.slice(off, off + pageSize)
	const hits = slice.map(v => ({
		source: 'vanilla',
		projectId: v.id,
		slug: v.id,
		title: 'Minecraft ' + v.id,
		description: v.type === 'release'
			? 'Официальная версия Mojang без модов и загрузчика.'
			: 'Снапшот Mojang. Может быть нестабильным.',
		iconUrl: '',
		downloads: 0,
		follows: 0,
		categories: [v.type],
		loaders: ['vanilla'],
		projectType: 'vanilla',
		author: 'Mojang',
		date: v.releaseTime || v.time || '',
	}))
	return { source: 'vanilla', total: versions.length, offset: off, limit: pageSize, hits }
}

async function getProject({ source, projectId, apiKey = '' }) {
	const key = String(source) + ':' + String(projectId)
	return cached('project', key, () => getProjectUncached({ source, projectId, apiKey }))
}

async function cacheGallery(proj) {
	if (!proj) return proj
	try {
		const imgcache = require('./imgcache')
		if (proj.iconUrl) {
			const icon = await imgcache.ensure(proj.iconUrl).catch(() => proj.iconUrl)
			if (icon) proj.iconUrl = icon
		}
		if (proj.gallery && proj.gallery.length) {
			const urls = proj.gallery.map((g) => g.url)
			const local = await imgcache.cacheList(urls, { waitMs: 3500 })
			proj.gallery.forEach((g, i) => { if (local[i]) g.url = local[i] })
		}
	} catch (e) { /* ок */ }
	return proj
}

async function getProjectUncached({ source, projectId, apiKey = '' }) {
	if (source === 'vanilla') {
		return {
			source: 'vanilla',
			projectId: String(projectId),
			slug: String(projectId),
			title: 'Minecraft ' + projectId,
			description: 'Чистый Minecraft с официальных серверов Mojang (через зеркало, если нужно).',
			body: 'Без модов, Fabric и Forge. Можно потом добавить моды из каталога в эту папку.',
			iconUrl: '',
			downloads: 0,
			loaders: ['vanilla'],
			projectType: 'vanilla',
			author: 'Mojang',
			url: 'https://www.minecraft.net/',
			gallery: [],
		}
	}
	if (source === 'ftb') {
		const p = await ftbGet(`/public/modpack/${encodeURIComponent(projectId)}`, 20000)
		return cacheGallery({
			...normalizeFtbHit(p),
			body: stripHtml(p.description || p.synopsis || ''),
			url: `https://www.feed-the-beast.com/modpack/${p.id}`,
			gallery: (p.art || []).filter((a) => a && a.url && a.type !== 'square').map((a) => ({ url: a.url, title: a.type || '' })),
		})
	}
	if (source === 'curseforge') {
		const r = await cfGet(`/mods/${encodeURIComponent(projectId)}`, apiKey)
		const m = r.data || r
		const body = stripHtml(m.summary || '')
		const gallery = (m.screenshots || []).slice(0, 12).map((s) => ({
			url: preferMirror(s.url || s.thumbnailUrl || '') || s.url,
			title: s.title || '',
		})).filter((s) => s.url)
		return cacheGallery({
			...normalizeCfMod(m, cfProjectType(m.classId, 'modpack')),
			body,
			url: m.links && m.links.websiteUrl,
			gallery,
		})
	}
	const p = await mrGet(`/project/${encodeURIComponent(projectId)}`)
	return cacheGallery({
		...normalizeMrHit(p, p.project_type),
		body: p.body || p.description || '',
		url: `https://modrinth.com/${p.project_type}/${p.slug}`,
		gallery: (p.gallery || []).slice(0, 12).map((g) => ({
			url: preferMirror(g.url || g.raw_url || '') || g.url,
			title: g.title || '',
		})).filter((g) => g.url),
	})
}

async function getVersions({ source, projectId, apiKey = '' }) {
	const key = String(source) + ':' + String(projectId)
	return cached('versions', key, () => getVersionsUncached({ source, projectId, apiKey }))
}

async function getVersionsUncached({ source, projectId, apiKey = '' }) {
	if (source === 'vanilla') {
		return [{
			id: String(projectId),
			name: projectId,
			versionNumber: String(projectId),
			gameVersions: [String(projectId)],
			loaders: ['vanilla'],
			date: '',
			featured: true,
			files: [{ url: '', filename: 'vanilla', size: 0, primary: true, hashes: {} }],
		}]
	}
	if (source === 'ftb') {
		const p = await ftbGet(`/public/modpack/${encodeURIComponent(projectId)}`, 20000)
		const vers = (p.versions || []).slice().sort((a, b) => {
			if (a.type === 'release' && b.type !== 'release') return -1
			if (b.type === 'release' && a.type !== 'release') return 1
			return (b.updated || 0) - (a.updated || 0)
		})
		return vers.map(normalizeFtbVersion)
	}
	if (source === 'curseforge') {
		const r = await cfGet(`/mods/${encodeURIComponent(projectId)}/files?pageSize=50`, apiKey)
		const files = r.data || []
		return files.map(normalizeCfFile)
	}
	const list = await mrGet(`/project/${encodeURIComponent(projectId)}/version`, 40000)
	const arr = Array.isArray(list) ? list : []
	return arr.map(normalizeMrVersion)
}

async function getFtbVersion(packId, versionId) {
	return ftbGet(`/public/modpack/${encodeURIComponent(packId)}/${encodeURIComponent(versionId)}`, 40000)
}

async function getRelated({ source, projectId, apiKey = '' }) {
	const empty = { required: [], optional: [], incompatible: [] }
	if (!source || source === 'vanilla' || source === 'ftb') return empty
	let versions = []
	try { versions = await getVersions({ source, projectId, apiKey }) } catch (e) { return empty }
	const deps = []
	const seen = new Set()
	for (const v of versions.slice(0, 8)) {
		for (const d of v.dependencies || []) {
			const id = String(d.projectId || '')
			if (!id || seen.has(id)) continue
			seen.add(id)
			deps.push(d)
			if (deps.length >= 12) break
		}
		if (deps.length >= 12) break
	}
	const out = { required: [], optional: [], incompatible: [] }
	await Promise.all(deps.map(async (d) => {
		try {
			const p = await getProject({ source, projectId: d.projectId, apiKey })
			const bucket = d.type === 'required' ? 'required' : d.type === 'incompatible' ? 'incompatible' : 'optional'
			out[bucket].push({
				source,
				projectId: p.projectId,
				slug: p.slug,
				title: p.title,
				description: p.description || '',
				iconUrl: p.iconUrl || '',
				projectType: p.projectType || 'mod',
				author: p.author || '',
				loaders: p.loaders || [],
				downloads: p.downloads || 0,
			})
		} catch (e) { /* skip */ }
	}))
	return out
}

function pickPrimaryFile(version) {
	if (!version || !version.files || !version.files.length) return null
	return version.files.find(f => f.primary) || version.files[0]
}

async function getCfFile(modId, fileId, apiKey, signal = null) {
	const r = await cfGet(`/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}`, apiKey, 18000, signal)
	return r.data || r
}

async function resolveCfDownloadUrl(file, apiKey) {
	if (file.url) return file.url
	const modId = file.modId
	const fileId = file.fileId || file.id
	const name = file.filename || file.fileName
	const fallbacks = cfDownloadCandidates(modId, fileId, name, '')
	if (fallbacks.length) return fallbacks[0]
	if (!modId || !fileId) throw new Error('У файла CurseForge нет ссылки на скачивание')
	try {
		const r = await cfGet(`/mods/${modId}/files/${fileId}/download-url`, apiKey)
		const url = (r && (r.data || r.url)) || ''
		if (url) return url
	} catch (e) { /* CDN ниже */ }
	throw new Error('CurseForge не отдал ссылку на файл')
}

async function resolveCfFileInfos(fileIds, apiKey) {
	const ids = [...new Set(fileIds.map(n => Number(n)).filter(n => n))]
	if (!ids.length) return []
	const r = await cfPost('/mods/files', apiKey, { fileIds: ids })
	return r.data || []
}

function stripHtml(s) {
	return String(s || '')
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim()
}

module.exports = {
	UA,
	search,
	getProject,
	getVersions,
	getRelated,
	getFtbVersion,
	pickPrimaryFile,
	resolveCfDownloadUrl,
	resolveCfFileInfos,
	getCfFile,
	cfDownloadCandidates,
	headers,
	ftbTargets,
	stripHtml,
}
