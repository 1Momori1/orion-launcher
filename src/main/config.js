const fs = require('fs')
const path = require('path')
const os = require('os')
const { app } = require('electron')
const { PUBLIC_URL, isPrivateServerUrl } = require('./hosts')

function defaultDataRoot() {
	if (process.platform === 'win32') {
		const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
		return path.join(local, 'OrionLauncher')
	}
	return path.join(os.homedir(), '.orion-launcher')
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'settings.json')

const DEFAULTS = {
	dataRoot: defaultDataRoot(),
	username: '',
	memoryMB: 6144,
	width: 1280,
	height: 720,
	javaPath: '',
	token: '',
	serverUrl: PUBLIC_URL,
	lastModpack: '',
	curseforgeApiKey: '',
	theme: 'orion',
	showGrid: true,
	animateGrid: true,
	onLaunch: 'stay',
	autoCheckUpdates: true,
	catalogSource: 'auto',
	hideOnline: false,
	openAtLogin: false,
	profiles: [],
	activeProfileId: '',
}

let cache = null

function load() {
	if (cache) return cache
	cache = { ...DEFAULTS }
	if (fs.existsSync(CONFIG_PATH)) {
		try {
			Object.assign(cache, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
		} catch (e) { /* ignore */ }
	}
	if (!cache.dataRoot) cache.dataRoot = defaultDataRoot()
	migrateProfiles(cache)
	if (isPrivateServerUrl(cache.serverUrl)) {
		cache.serverUrl = PUBLIC_URL
		persist(cache)
	}
	return cache
}

function persist(cfg) {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function newProfileId() {
	return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function migrateProfiles(cfg) {
	if (!Array.isArray(cfg.profiles)) cfg.profiles = []
	cfg.profiles = cfg.profiles
		.filter((p) => p && p.username)
		.map((p) => ({ id: String(p.id || newProfileId()), username: String(p.username).slice(0, 16) }))
	if (!cfg.profiles.length && cfg.username) {
		cfg.profiles = [{ id: 'p1', username: String(cfg.username).slice(0, 16) }]
		cfg.activeProfileId = 'p1'
	}
	const active = cfg.profiles.find((p) => p.id === cfg.activeProfileId) || cfg.profiles[0]
	if (active) {
		cfg.activeProfileId = active.id
		cfg.username = active.username
	} else {
		cfg.activeProfileId = ''
		cfg.username = cfg.username || ''
	}
	return cfg
}

function addProfile(username) {
	const cfg = load()
	const nick = String(username || '').trim()
	const exists = (cfg.profiles || []).find((p) => p.username.toLowerCase() === nick.toLowerCase())
	if (exists) return selectProfile(exists.id)
	const id = newProfileId()
	cfg.profiles.push({ id, username: nick })
	cfg.activeProfileId = id
	cfg.username = nick
	return save({ profiles: cfg.profiles, activeProfileId: id, username: nick })
}

function removeProfile(id) {
	const cfg = load()
	cfg.profiles = (cfg.profiles || []).filter((p) => p.id !== id)
	if (cfg.activeProfileId === id) {
		const next = cfg.profiles[0]
		cfg.activeProfileId = next ? next.id : ''
		cfg.username = next ? next.username : ''
	}
	return save({ profiles: cfg.profiles, activeProfileId: cfg.activeProfileId, username: cfg.username })
}

function selectProfile(id) {
	const cfg = load()
	const p = (cfg.profiles || []).find((x) => x.id === id)
	if (!p) return cfg
	return save({ activeProfileId: p.id, username: p.username })
}

function save(patch = {}) {
	const cfg = Object.assign(load(), patch)
	persist(cfg)
	return cfg
}

function paths() {
	const root = load().dataRoot
	return {
		root,
		games: path.join(root, 'games'),
		libraries: path.join(root, 'libraries'),
		assets: path.join(root, 'assets'),
		assetObjects: path.join(root, 'assets', 'objects'),
		assetIndexes: path.join(root, 'assets', 'indexes'),
		runtime: path.join(root, 'runtime'),
		cache: path.join(root, 'cache'),
		versions: path.join(root, 'versions'),
		natives: path.join(root, 'natives'),
	}
}

function ensureDirs() {
	const p = paths()
	for (const dir of [p.root, p.games, p.libraries, p.assets, p.assetObjects, p.assetIndexes, p.runtime, p.cache, p.versions, p.natives]) {
		fs.mkdirSync(dir, { recursive: true })
	}
	return p
}

function setDataRoot(newRoot) {
	fs.mkdirSync(newRoot, { recursive: true })
	const probe = path.join(newRoot, '.orion-write-test')
	fs.writeFileSync(probe, 'ok')
	fs.unlinkSync(probe)
	save({ dataRoot: newRoot })
	return ensureDirs()
}

function freeSpace(dir) {
	try {
		const stat = fs.statfsSync(dir)
		return stat.bavail * stat.bsize
	} catch (e) {
		return null
	}
}

module.exports = {
	load, save, paths, ensureDirs, setDataRoot, defaultDataRoot, freeSpace,
	CONFIG_PATH, DEFAULTS, addProfile, removeProfile, selectProfile, migrateProfiles,
}
