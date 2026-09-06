const { fetchJson, downloadWithRetry } = require('./net')
const { hostOf, sourceKind } = require('./fsutil')

let appVersion = '1.7.0'
try { appVersion = require('electron').app.getVersion() } catch (_) {}
const UA = `OrionLauncher/${appVersion} (private; catalog)`

const MIRROR_MAP = [
	['https://api.modrinth.com', 'https://mod.mcimirror.top/modrinth', 'mirror'],
	['https://cdn.modrinth.com', 'https://mod.mcimirror.top', 'mirror'],
	['https://api.curseforge.com', 'https://mod.mcimirror.top/curseforge', 'mirror'],
	['https://edge.forgecdn.net', 'https://mod.mcimirror.top', 'fallback'],
	['https://mediafilez.forgecdn.net', 'https://mod.mcimirror.top', 'fallback'],
	['https://media.forgecdn.net', 'https://mod.mcimirror.top', 'fallback'],
	['https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com', 'fallback'],
	['https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com', 'fallback'],
	['https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com', 'fallback'],
	['https://launcher.mojang.com', 'https://bmclapi2.bangbang93.com', 'fallback'],
	['https://libraries.minecraft.net', 'https://bmclapi2.bangbang93.com/maven', 'fallback'],
	['https://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/assets', 'fallback'],
	['https://maven.minecraftforge.net', 'https://bmclapi2.bangbang93.com/maven', 'fallback'],
	['https://files.minecraftforge.net/maven', 'https://bmclapi2.bangbang93.com/maven', 'fallback'],
	['https://maven.fabricmc.net', 'https://bmclapi2.bangbang93.com/maven', 'fallback'],
	['https://meta.fabricmc.net', 'https://bmclapi2.bangbang93.com/fabric-meta', 'fallback'],
	['https://meta.quiltmc.org', 'https://bmclapi2.bangbang93.com/quilt-meta', 'fallback'],
	['https://maven.neoforged.net/releases', 'https://bmclapi2.bangbang93.com/maven', 'fallback'],
	['https://maven.neoforged.net', 'https://bmclapi2.bangbang93.com/maven', 'fallback'],
]

function headers(extra = {}) {
	return { 'User-Agent': UA, Accept: 'application/json', ...extra }
}

function unique(list) {
	const seen = new Set()
	const out = []
	for (const u of list) {
		if (!u || seen.has(u)) continue
		seen.add(u)
		out.push(u)
	}
	return out
}

function candidates(url) {
	const src = String(url || '')
	if (!src) return []
	const mirrored = []
	let mirrorFirst = false
	for (const [from, to, mode] of MIRROR_MAP) {
		if (src.startsWith(from)) {
			mirrored.push(to + src.slice(from.length))
			if (mode === 'mirror') mirrorFirst = true
		}
	}
	if (mirrorFirst) return unique([...mirrored, src])
	return unique([src, ...mirrored])
}

function preferMirror(url) {
	const list = candidates(url)
	return list[0] || url
}

async function fetchJsonMirrored(url, opts = {}) {
	const list = candidates(url)
	let last = null
	for (const u of list) {
		try {
			return await fetchJson(u, { timeout: 15000, ...opts, headers: { ...headers(), ...(opts.headers || {}) } })
		} catch (e) {
			if (e && e.cancelled) throw e
			last = e
		}
	}
	throw last || new Error('Нет ответа: ' + url)
}

async function downloadWithRetryMirrored(url, destPath, opts = {}) {
	const extra = opts.urls || []
	// Если вызывающий уже собрал явный список (CF CDN → зеркала), не дописываем
	// path-rewrite mcimirror — у него другой путь и он только растягивает 404.
	const list = extra.length
		? unique([...extra, url].filter(Boolean))
		: unique([...candidates(url), url].filter(Boolean))
	let last = null
	for (const u of list) {
		try {
			await downloadWithRetry(u, destPath, {
				...opts,
				attempts: opts.attempts || 2,
				stallMs: opts.stallMs || 15000,
				headers: { ...headers(opts.headers || {}) },
			})
			const used = { usedUrl: u, host: hostOf(u), kind: sourceKind(u) }
			if (opts.onSource) opts.onSource(used)
			return used
		} catch (e) {
			if (e && e.cancelled) throw e
			last = e
			if (opts.onSourceFail) opts.onSourceFail({ url: u, host: hostOf(u), kind: sourceKind(u), error: e.message })
		}
	}
	throw last || new Error('Не удалось скачать: ' + url)
}

async function fetchFirst(bases, path, opts = {}) {
	let last = null
	for (const base of bases) {
		if (opts.signal && opts.signal.cancelled) {
			throw Object.assign(new Error('Отменено пользователем'), { cancelled: true })
		}
		try {
			const r = await fetchJson(String(base).replace(/\/$/, '') + path, {
				timeout: 15000,
				...opts,
				headers: { ...headers(), ...(opts.headers || {}) },
			})
			return r
		} catch (e) {
			if (e && e.cancelled) throw e
			last = e
		}
	}
	throw last || new Error('Источники не ответили')
}

module.exports = {
	UA,
	headers,
	candidates,
	preferMirror,
	fetchJsonMirrored,
	downloadWithRetryMirrored,
	fetchFirst,
	MIRROR_MAP,
}
