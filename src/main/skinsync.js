const fs = require('fs')
const path = require('path')
const { PUBLIC_URL, norm } = require('./hosts')

const CSL_JAR = 'CustomSkinLoader_Universal-15.0.1.jar'

function skinUrlTemplate(serverUrl) {
	return String(serverUrl || '').replace(/\/$/, '') + '/api/modpacks/skins/{USERNAME}'
}

function bundledCsl() {
	const roots = [
		path.join(__dirname, '..', '..', 'assets'),
		process.resourcesPath ? path.join(process.resourcesPath, 'assets') : '',
	]
	for (const root of roots) {
		if (!root) continue
		const p = path.join(root, CSL_JAR)
		if (fs.existsSync(p)) return p
	}
	return null
}

function hasCslJar(instanceDir) {
	const mods = path.join(instanceDir, 'mods')
	if (!fs.existsSync(mods)) return false
	try {
		return fs.readdirSync(mods).some((f) => /customskinloader/i.test(f) && /\.jar$/i.test(f))
	} catch (e) {
		return false
	}
}

function findCslJar(gamesRoot) {
	const bundled = bundledCsl()
	if (bundled) return bundled
	if (!gamesRoot || !fs.existsSync(gamesRoot)) return null
	let dirs = []
	try { dirs = fs.readdirSync(gamesRoot) } catch (e) { return null }
	for (const name of dirs) {
		const mods = path.join(gamesRoot, name, 'mods')
		if (!fs.existsSync(mods)) continue
		let files = []
		try { files = fs.readdirSync(mods) } catch (e) { continue }
		const jar = files.find((f) => /customskinloader/i.test(f) && /\.jar$/i.test(f))
		if (jar) return path.join(mods, jar)
	}
	return null
}

function writeCslConfig(instanceDir, serverUrl) {
	const dir = path.join(instanceDir, 'CustomSkinLoader')
	fs.mkdirSync(dir, { recursive: true })
	const file = path.join(dir, 'CustomSkinLoader.json')
	let cfg = {
		version: '15.0.1',
		enable: true,
		enableCape: true,
		enableTransparentSkin: true,
		forceLoadAllTextures: true,
		cacheExpiry: 1,
		enableCacheAutoClean: true,
		forceDisableCache: false,
		loadlist: [],
	}
	if (fs.existsSync(file)) {
		try { Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8'))) } catch (e) { /* свой файл */ }
	}
	const sources = [serverUrl, PUBLIC_URL].map(norm).filter(Boolean)
	const seen = new Set()
	const orion = []
	sources.forEach((host, i) => {
		if (seen.has(host)) return
		seen.add(host)
		orion.push({
			name: i === 0 ? 'Orion' : 'Orion-' + (i + 1),
			type: 'Legacy',
			skin: skinUrlTemplate(host),
			model: 'auto',
		})
	})
	cfg.loadlist = Array.isArray(cfg.loadlist) ? cfg.loadlist : []
	cfg.loadlist = cfg.loadlist.filter((x) => x && x.name !== 'Orion' && !(x.skin && String(x.skin).includes('/api/modpacks/skins')))
	cfg.loadlist = orion.concat(cfg.loadlist)
	cfg.enable = true
	cfg.cacheExpiry = 1
	fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}

function ensureSkinLoader(instanceDir, serverUrl, gamesRoot) {
	if (!instanceDir) return
	fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
	if (!hasCslJar(instanceDir)) {
		const src = findCslJar(gamesRoot)
		if (src) {
			const dest = path.join(instanceDir, 'mods', path.basename(src))
			try { fs.copyFileSync(src, dest) } catch (e) { /* skip */ }
		}
	}
	if (hasCslJar(instanceDir)) writeCslConfig(instanceDir, serverUrl)
}

module.exports = { ensureSkinLoader, writeCslConfig, hasCslJar }
