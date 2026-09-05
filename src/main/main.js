const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } = require('electron')
const path = require('path')
const fs = require('fs')

protocol.registerSchemesAsPrivileged([
	{ scheme: 'orionimg', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
])

const config = require('./config')
const { Updater } = require('./updater')
const { Launcher, validateNickname } = require('./launcher')
const { Network } = require('./network')
const { findJava, installJava } = require('./java')
const { allHosts, PUBLIC_URL } = require('./hosts')

let win = null
let updater = null
let game = null
let net = null
let heartbeatTimer = null

const send = (channel, payload) => {
	if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow() {
	win = new BrowserWindow({
		width: 1240,
		height: 780,
		minWidth: 980,
		minHeight: 660,
		frame: false,
		backgroundColor: '#0a0a0a',
		show: false,
		icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
		},
	})

	win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
	win.webContents.on('will-navigate', (e) => e.preventDefault())
	win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
	win.once('ready-to-show', () => win.show())
	if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' })

	win.on('maximize', () => send('window:state', { maximized: true }))
	win.on('unmaximize', () => send('window:state', { maximized: false }))
	win.on('closed', () => { win = null })
}

function bootServices() {
	const cfg = config.load()
	const paths = config.ensureDirs()
	updater = new Updater(cfg.serverUrl, paths)
	if (cfg.token) updater.setToken(cfg.token)
	game = new Launcher(paths)
	net = new Network(cfg.serverUrl)
}

function applyServerUrl(url, { save = false } = {}) {
	const u = String(url || '').replace(/\/$/, '')
	if (!u) return u
	if (updater) updater.serverUrl = u
	if (net) net.setServerUrl(u)
	if (save && config.load().serverUrl !== u) config.save({ serverUrl: u })
	return u
}

async function pinReachableServer() {
	if (!net) return
	const preferred = config.load().serverUrl
	for (const host of allHosts(preferred)) {
		const r = await net.probeServer(host)
		if (r.reachable) {
			applyServerUrl(host, { save: host !== preferred })
			return host
		}
	}
	return preferred
}

function reloadPaths() {
	const paths = config.ensureDirs()
	updater.setPaths(paths)
	game.setPaths(paths)
	return paths
}

if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on('second-instance', () => {
		if (win) { if (win.isMinimized()) win.restore(); win.focus() }
	})

	app.whenReady().then(async () => {
		Menu.setApplicationMenu(null)
		protocol.registerFileProtocol('orionimg', (request, callback) => {
			try {
				const { fileForRequest } = require('./imgcache')
				const p = fileForRequest(request.url)
				if (p && fs.existsSync(p)) callback({ path: p })
				else callback({ error: -6 })
			} catch (e) {
				callback({ error: -2 })
			}
		})
		bootServices()
		await pinReachableServer()
		const bootCfg = config.load()
		app.setLoginItemSettings({ openAtLogin: !!bootCfg.openAtLogin })
		createWindow()
		scheduleUpdateProbe(0)
	})
}

const UPDATE_RETRY_MS = [1500, 4000, 10000, 20000]

function scheduleUpdateProbe(attempt) {
	const wait = UPDATE_RETRY_MS[Math.min(attempt, UPDATE_RETRY_MS.length - 1)]
	setTimeout(async () => {
		try {
			const cfg = config.load()
			if (cfg.autoCheckUpdates === false) return
			const { probeUpdate } = require('./selfupdate')
			const r = await probeUpdate(cfg.serverUrl)
			if (r && r.ok) {
				send('launcher:update', r)
				return
			}
		} catch (_) { /* offline */ }
		if (attempt + 1 < UPDATE_RETRY_MS.length) scheduleUpdateProbe(attempt + 1)
	}, wait)
}

function applyLaunchWindow(cfg) {
	if (!win || win.isDestroyed()) return
	const mode = cfg.onLaunch || (cfg.minimizeOnLaunch ? 'minimize' : 'stay')
	if (mode === 'minimize') win.minimize()
	if (mode === 'hide') win.hide()
}

function restoreLaunchWindow() {
	if (!win || win.isDestroyed()) return
	if (!win.isVisible()) win.show()
	if (win.isMinimized()) win.restore()
}

app.on('window-all-closed', () => { app.quit() })

let quitting = false
app.on('before-quit', (e) => {
	if (quitting) return
	const cfg = config.load()
	if (heartbeatTimer) clearInterval(heartbeatTimer)
	if (!cfg.username) return
	quitting = true
	e.preventDefault()
	const done = () => app.quit()
	updater.goOffline(cfg.username).catch(() => {}).then(done)
	setTimeout(done, 1500)
})

const ok = (data) => ({ ok: true, ...data })
const fail = (e) => ({ ok: false, error: typeof e === 'string' ? e : (e && e.message) || 'Неизвестная ошибка' })

ipcMain.handle('settings:get', () => {
	const cfg = config.load()
	const p = config.paths()
	return ok({
		settings: {
			...cfg,
			token: undefined,
			loggedIn: !!cfg.token,
			openAtLogin: app.getLoginItemSettings().openAtLogin,
		},
		paths: p,
		freeSpace: config.freeSpace(p.root),
	})
})

const THEMES = ['orion', 'ember', 'frost', 'moss', 'dusk', 'sand']
const CATALOG_SOURCES = ['auto', 'modrinth', 'curseforge', 'ftb']
const ON_LAUNCH = ['stay', 'minimize', 'hide']

ipcMain.handle('settings:save', (e, patch) => {
	const safe = { ...patch }
	delete safe.token
	if (safe.serverUrl) {
		const { isHttpUrl, norm } = require('./hosts')
		const u = norm(safe.serverUrl)
		if (!isHttpUrl(u)) delete safe.serverUrl
		else safe.serverUrl = u
	}
	if (safe.memoryMB) safe.memoryMB = Math.max(2048, Math.min(32768, Number(safe.memoryMB) || 6144))
	if (safe.width != null) safe.width = Math.max(800, Math.min(7680, Number(safe.width) || 1280))
	if (safe.height != null) safe.height = Math.max(480, Math.min(4320, Number(safe.height) || 720))
	if (safe.curseforgeApiKey != null) safe.curseforgeApiKey = String(safe.curseforgeApiKey).trim()
	if (safe.theme && !THEMES.includes(safe.theme)) delete safe.theme
	if (safe.catalogSource && !CATALOG_SOURCES.includes(safe.catalogSource)) delete safe.catalogSource
	if (safe.onLaunch && !ON_LAUNCH.includes(safe.onLaunch)) delete safe.onLaunch
	for (const k of ['showGrid', 'animateGrid', 'autoCheckUpdates', 'hideOnline', 'openAtLogin']) {
		if (safe[k] != null) safe[k] = !!safe[k]
	}
	config.save(safe)
	const cfg = config.load()
	if (safe.serverUrl && updater) {
		updater.serverUrl = String(cfg.serverUrl).replace(/\/$/, '')
		if (net) net.setServerUrl(cfg.serverUrl)
	}
	if (safe.openAtLogin != null) {
		app.setLoginItemSettings({ openAtLogin: !!cfg.openAtLogin })
	}
	return ok({ settings: { ...cfg, token: undefined } })
})

ipcMain.handle('settings:choose-data-root', async () => {
	const r = await dialog.showOpenDialog(win, {
		title: 'Где хранить игры',
		properties: ['openDirectory', 'createDirectory'],
		defaultPath: config.load().dataRoot,
	})
	if (r.canceled || !r.filePaths[0]) return ok({ changed: false })
	try {
		const chosen = path.basename(r.filePaths[0]) === 'OrionLauncher'
			? r.filePaths[0]
			: path.join(r.filePaths[0], 'OrionLauncher')
		config.setDataRoot(chosen)
		const p = reloadPaths()
		return ok({ changed: true, paths: p, freeSpace: config.freeSpace(p.root) })
	} catch (err) { return fail(err) }
})

ipcMain.handle('settings:validate-nick', (e, nick) => {
	const err = validateNickname(nick)
	return err ? fail(err) : ok({})
})

ipcMain.handle('profiles:add', (e, username) => {
	const err = validateNickname(username)
	if (err) return fail(err)
	try {
		const cfg = config.addProfile(username)
		return ok({ settings: { ...cfg, token: undefined } })
	} catch (err) { return fail(err) }
})

ipcMain.handle('profiles:remove', (e, id) => {
	try {
		const cfg = config.removeProfile(id)
		return ok({ settings: { ...cfg, token: undefined } })
	} catch (err) { return fail(err) }
})

ipcMain.handle('profiles:select', (e, id) => {
	try {
		const cfg = config.selectProfile(id)
		return ok({ settings: { ...cfg, token: undefined } })
	} catch (err) { return fail(err) }
})

ipcMain.handle('net:status', async () => {
	try {
		const st = await net.status()
		if (st.server && st.server.reachable && st.server.url) {
			applyServerUrl(st.server.url, { save: !!st.server.fallbackUsed })
		}
		return ok(st)
	} catch (e) { return fail(e) }
})

ipcMain.handle('packs:list', async () => {
	try {
		const r = await updater.listModpacks()
		const installed = {}
		for (const m of r.modpacks) {
			const dir = updater.instanceDir(m.name)
			const state = updater._readLocalManifest(dir)
			installed[m.name] = state ? { version: state.version, build: state.build } : null
		}
		return ok({ modpacks: r.modpacks, installed })
	} catch (e) { return fail(e) }
})

ipcMain.handle('packs:icon', async (e, pack) => {
	try {
		if (!pack || !pack.icon) return ok({ dataUrl: null })
		const { fetchBuffer } = require('./net')
		const base = (config.load().serverUrl || PUBLIC_URL).replace(/\/$/, '')
		const url = base + pack.icon + (pack.build ? ('?b=' + pack.build) : '')
		const r = await fetchBuffer(url, { timeout: 12000 })
		const mime = (r.headers['content-type'] || 'image/png').split(';')[0]
		return ok({ dataUrl: `data:${mime};base64,${r.buffer.toString('base64')}` })
	} catch (err) {
		return ok({ dataUrl: null })
	}
})

function safePackId(name) {
	const s = String(name || '')
	if (!s || s.includes('..') || /[\\/]/.test(s) || s.includes('\0')) throw new Error('Некорректное имя сборки')
	return s
}

ipcMain.handle('packs:plan', async (e, name) => {
	try { return ok({ plan: await updater.plan(safePackId(name)) }) } catch (err) { return fail(err) }
})

ipcMain.handle('packs:install', async (e, name, mode) => {
	try {
		name = safePackId(name)
		const r = await updater.install(name, (p) => send('install:progress', p), mode || 'resume')
		config.save({ lastModpack: name })
		return ok(r)
	} catch (err) {
		if (err.cancelled) return fail('Установка отменена')
		return fail(err)
	}
})

ipcMain.on('packs:cancel', () => {
	if (updater) updater.cancel()
	try { require('./cataloginstall').cancel() } catch (e) {}
})

ipcMain.handle('packs:open-folder', (e, name) => {
	try {
		const dir = name ? updater.instanceDir(safePackId(name)) : config.paths().root
		if (fs.existsSync(dir)) shell.openPath(dir)
		return ok({})
	} catch (err) { return fail(err) }
})

ipcMain.handle('java:detect', async () => {
	const cfg = config.load()
	const info = await findJava(config.paths(), cfg.javaPath)
	return ok({ java: info })
})

ipcMain.handle('java:install', async (e, major) => {
	try {
		const ver = Number(major) === 21 ? 21 : 17
		const info = await installJava(config.paths(), (p) => send('install:progress', {
			stage: 'java', stageLabel: 'Java ' + ver, detail: p.stage === 'java-extract' ? 'Распаковка' : 'Скачивание',
			bytesDone: p.bytes || 0, bytesTotal: 0, percent: null,
		}), updater.signal, ver)
		config.save({ javaPath: info.path })
		return ok({ java: info })
	} catch (e) { return fail(e) }
})

ipcMain.handle('java:pick', async () => {
	const r = await dialog.showOpenDialog(win, {
		title: 'Выберите javaw.exe или java.exe',
		properties: ['openFile'],
		filters: [{ name: 'Java', extensions: ['exe'] }],
	})
	if (r.canceled || !r.filePaths[0]) return ok({ changed: false })
	const { probeJava } = require('./java')
	const info = await probeJava(r.filePaths[0])
	if (!info) return fail('Это не похоже на Java')
	if (info.major < 17) return fail(`Нужна Java 17 или новее, а выбрана ${info.major}`)
	config.save({ javaPath: info.path })
	return ok({ changed: true, java: info })
})

ipcMain.handle('game:launch', async (e, name, extra) => {
	const cfg = config.load()
	const join = extra && typeof extra === 'object' ? extra : {}
	try {
		name = safePackId(name)
		const r = await game.launch(name, {
			username: cfg.username,
			memoryMB: cfg.memoryMB,
			width: cfg.width,
			height: cfg.height,
			javaPath: cfg.javaPath,
			serverUrl: PUBLIC_URL,
			joinHost: join.host || '',
			joinPort: join.port || '',
		}, (ev) => {
			send('game:status', ev)
			if (ev.stage === 'exited' || ev.stage === 'crashed' || ev.stage === 'error') {
				restoreLaunchWindow()
				if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
				updater.goOffline(cfg.username).catch(() => {})
			}
			if (ev.stage === 'crashed' || ev.stage === 'error') {
				uploadCrashReport(name, cfg, ev).catch(() => {})
			}
		})
		if (r.error) return fail(r.error)

		applyLaunchWindow(cfg)
		updater.heartbeat(cfg.username, name).catch(() => {})
		if (heartbeatTimer) clearInterval(heartbeatTimer)
		heartbeatTimer = setInterval(() => {
			updater.heartbeat(cfg.username, name).catch(() => {})
		}, 30000)

		return ok(r)
	} catch (err) { return fail(err) }
})

async function uploadCrashReport(modpack, cfg, ev) {
	const { request } = require('./net')
	const { app: electronApp } = require('electron')
	let logText = ''
	try {
		if (ev.logPath && fs.existsSync(ev.logPath)) {
			logText = fs.readFileSync(ev.logPath, 'utf8').slice(-80000)
		}
	} catch (_) {}
	const body = JSON.stringify({
		username: cfg.username || 'unknown',
		modpack,
		code: ev.code ?? null,
		launcherVersion: electronApp.getVersion(),
		message: ev.error || '',
		hint: ev.hint || '',
		logPath: ev.logPath || '',
		tail: ev.tail || [],
		logText,
	})
	await request('POST', `${String(cfg.serverUrl).replace(/\/$/, '')}/api/modpacks/crash-reports`, {
		headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
		body,
		timeout: 15000,
	})
}

ipcMain.handle('game:stop', () => ok({ stopped: game.stop() }))
ipcMain.handle('game:running', () => ok({ running: game.isRunning }))

ipcMain.handle('game:open-log', (e, name) => {
	const p = path.join(updater.instanceDir(name), 'logs', 'orion-latest.log')
	if (fs.existsSync(p)) shell.openPath(p)
	return ok({})
})

ipcMain.handle('servers:list', async () => {
	try {
		const cfg = config.load()
		const r = await updater.listPublicServers(cfg.username || '')
		return ok(r && typeof r === 'object' ? r : { servers: [] })
	} catch (e) { return fail(e) }
})

ipcMain.handle('servers:install-client', async (e, client) => {
	try {
		const cfg = config.load()
		if (!client || !client.type) return fail('Нет клиентской сборки для этого сервера')
		if (client.type === 'orion') {
			const name = client.pack || client.instance
			if (!name) return fail('Не указана сборка Orion')
			const r = await updater.install(name, (p) => send('install:progress', p), 'resume')
			return ok({ id: name, ...r })
		}
		const { installClient } = require('./cataloginstall')
		const r = await installClient({
			paths: config.paths(),
			client,
			apiKey: cfg.curseforgeApiKey || '',
			javaPath: cfg.javaPath,
			onProgress: (p) => send('install:progress', p),
		})
		if (r && r.id) config.save({ lastModpack: r.id })
		return ok(r)
	} catch (err) {
		if (err.cancelled) return fail('Установка отменена')
		return fail(err)
	}
})

ipcMain.handle('servers:vote', async (e, serverId) => {
	try {
		const cfg = config.load()
		if (!cfg.username) return fail('Сначала укажите ник')
		return ok(await updater.votePublicServer(serverId, cfg.username))
	} catch (e) { return fail(e) }
})

ipcMain.handle('online:list', async () => {
	try { return ok(await updater.getOnline()) } catch (e) { return fail(e) }
})

ipcMain.handle('skins:list', async () => {
	try {
		const r = await updater.listSkins()
		return ok({ skins: (r.skins || []).map(s => ({ ...s, fullUrl: updater.skinUrl(s.username) })) })
	} catch (e) { return fail(e) }
})

ipcMain.handle('skins:upload', async () => {
	const cfg = config.load()
	if (!cfg.username) return fail('Сначала укажите ник')
	const r = await dialog.showOpenDialog(win, {
		title: 'Выберите скин (PNG 64×64)',
		properties: ['openFile'],
		filters: [{ name: 'Скин', extensions: ['png'] }],
	})
	if (r.canceled || !r.filePaths[0]) return ok({ changed: false })
	try {
		await updater.uploadSkin(cfg.username, r.filePaths[0])
		return ok({ changed: true, url: updater.skinUrl(cfg.username) + `?t=${Date.now()}` })
	} catch (e) { return fail(e) }
})

ipcMain.handle('skins:my-url', () => {
	const cfg = config.load()
	if (!cfg.username) return ok({ url: null })
	return ok({ url: `${PUBLIC_URL}/api/modpacks/skins/${encodeURIComponent(cfg.username)}?t=${Date.now()}` })
})

ipcMain.handle('auth:login', async (e, username, password) => {
	try {
		const r = await updater.login(username, password)
		if (r && r.access_token) {
			config.save({ token: r.access_token })
			updater.setToken(r.access_token)
			return ok({ loggedIn: true })
		}
		return fail('Неверный логин или пароль')
	} catch (err) { return fail(err) }
})

ipcMain.handle('auth:logout', () => {
	config.save({ token: '' })
	updater.setToken(null)
	return ok({ loggedIn: false })
})

ipcMain.handle('catalog:search', async (e, opts) => {
	try {
		const catalog = require('./catalog')
		const apiKey = config.load().curseforgeApiKey || ''
		return ok(await catalog.search({ ...opts, apiKey }))
	} catch (err) { return fail(err) }
})

ipcMain.handle('catalog:project', async (e, source, projectId) => {
	try {
		const catalog = require('./catalog')
		const apiKey = config.load().curseforgeApiKey || ''
		return ok({ project: await catalog.getProject({ source, projectId, apiKey }) })
	} catch (err) { return fail(err) }
})

ipcMain.handle('catalog:versions', async (e, source, projectId) => {
	try {
		const catalog = require('./catalog')
		const apiKey = config.load().curseforgeApiKey || ''
		return ok({ versions: await catalog.getVersions({ source, projectId, apiKey }) })
	} catch (err) { return fail(err) }
})

ipcMain.handle('catalog:related', async (e, source, projectId) => {
	try {
		const catalog = require('./catalog')
		const apiKey = config.load().curseforgeApiKey || ''
		return ok(await catalog.getRelated({ source, projectId, apiKey }))
	} catch (err) { return fail(err) }
})

ipcMain.handle('catalog:instances', () => {
	try {
		const { listInstances, listOrionPacks } = require('./cataloginstall')
		const p = config.paths()
		return ok({ instances: listInstances(p), orionPacks: listOrionPacks(p) })
	} catch (err) { return fail(err) }
})

ipcMain.handle('catalog:install-pack', async (e, payload) => {
	try {
		const { installPack } = require('./cataloginstall')
		const cfg = config.load()
		const r = await installPack({
			paths: config.paths(),
			source: payload.source,
			projectId: payload.projectId,
			versionId: payload.versionId,
			apiKey: cfg.curseforgeApiKey || '',
			javaPath: cfg.javaPath,
			onProgress: (p) => send('install:progress', p),
		})
		config.save({ lastModpack: r.id })
		return ok(r)
	} catch (err) {
		if (err.cancelled) return fail('Установка отменена')
		return fail(err)
	}
})

ipcMain.handle('catalog:install-mod', async (e, payload) => {
	try {
		const { installMod } = require('./cataloginstall')
		const cfg = config.load()
		const r = await installMod({
			paths: config.paths(),
			source: payload.source,
			projectId: payload.projectId,
			versionId: payload.versionId,
			instanceId: payload.instanceId,
			apiKey: cfg.curseforgeApiKey || '',
			kind: payload.kind || 'mod',
			onProgress: (p) => send('install:progress', p),
		})
		return ok(r)
	} catch (err) {
		if (err.cancelled) return fail('Установка отменена')
		return fail(err)
	}
})

ipcMain.handle('catalog:mods', (e, instanceId) => {
	try {
		const { listMods } = require('./cataloginstall')
		return ok({ mods: listMods(config.paths(), instanceId) })
	} catch (err) { return fail(err) }
})

ipcMain.handle('catalog:remove-mod', (e, instanceId, filename) => {
	try {
		const { removeMod } = require('./cataloginstall')
		removeMod(config.paths(), instanceId, filename)
		return ok({})
	} catch (err) { return fail(err) }
})

ipcMain.handle('catalog:uninstall', (e, id) => {
	try {
		const { uninstallInstance } = require('./cataloginstall')
		uninstallInstance(config.paths(), id)
		return ok({})
	} catch (err) { return fail(err) }
})

ipcMain.on('catalog:cancel', () => {
	try { require('./cataloginstall').cancel() } catch (e) {}
})

ipcMain.on('window:minimize', () => win && win.minimize())
ipcMain.on('window:maximize', () => {
	if (!win) return
	win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('window:close', () => win && win.close())
ipcMain.on('open:external', (e, url) => {
	if (/^https?:\/\//.test(url)) shell.openExternal(url)
})

ipcMain.handle('launcher:check-update', async () => {
	try {
		const { probeUpdate } = require('./selfupdate')
		return ok(await probeUpdate(config.load().serverUrl))
	} catch (e) { return fail(e) }
})

ipcMain.handle('launcher:install-update', async () => {
	try {
		const { probeUpdate, installUpdate } = require('./selfupdate')
		const r = await probeUpdate(config.load().serverUrl)
		if (!r.ok) return fail(r.error || 'Нет связи')
		if (r.upToDate) return ok({ upToDate: true })
		return await installUpdate(r.info, r.current)
	} catch (e) { return fail(e) }
})

ipcMain.handle('launcher:version', () => ok({ version: app.getVersion() }))

function builtinNews() {
	return [
		{
			id: 'v1.8.6',
			kind: 'launcher',
			version: '1.8.6',
			date: '2026-09-05',
			title: '1.8.6 — широкая карточка сборки',
			body: 'Окно мода в каталоге больше не узкая полоска: описание и кнопки на всю ширину.',
		},
		{
			id: 'v1.8.5',
			kind: 'launcher',
			version: '1.8.5',
			date: '2026-09-05',
			title: '1.8.5 — сайт и защита',
			body: 'Появился сайт Orion. Регистрация игрока не даёт доступ к панели. Скин только со своего аккаунта. Обновления лаунчера проверяются по контрольной сумме.',
		},
		{
			id: 'v1.8.4',
			kind: 'launcher',
			version: '1.8.4',
			date: '2026-09-05',
			title: '1.8.4 — выбор сборки и скины',
			body: 'Сборку для запуска выбираешь снизу. Скин виден всем на сервере, кому тоже поставили Orion — Tailscale для этого не нужен.',
		},
		{
			id: 'v1.8.3',
			kind: 'launcher',
			version: '1.8.3',
			date: '2026-09-05',
			title: '1.8.3 — установка сборок',
			body: 'Forge больше не падает на 88%. Каталог сразу показывает «Установить», загрузки не зависают на мёртвых зеркалах.',
		},
		{
			id: 'v1.8.2',
			kind: 'launcher',
			version: '1.8.2',
			date: '2026-09-05',
			title: '1.8.2 — скачать сборку сервера',
			body: 'На плашке «Наши сервера» можно скачать нужный модпак и сразу зайти. Без сборки на сервер не пустит.',
		},
		{
			id: 'v1.8.1',
			kind: 'launcher',
			version: '1.8.1',
			date: '2026-09-04',
			title: '1.8.1 — один сервер на всех',
			body: 'Один адрес PlayIt. Голосуйте, на какой сборке играть: если никого нет, текущий сервер гасится и поднимается выбранный.',
		},
		{
			id: 'v1.8.0',
			kind: 'launcher',
			version: '1.8.0',
			date: '2026-09-04',
			title: '1.8.0 — наши сервера',
			body: 'На главной появилась плашка серверов. Адрес копируется, Tailscale для входа больше не нужен.',
		},
		{
			id: 'v1.7.1',
			kind: 'launcher',
			version: '1.7.1',
			date: '2026-09-04',
			title: '1.7.1 — обновления без Tailscale',
			body: 'Лаунчер и сборка качаются через обычный интернет. Tailscale друзьям больше не обязателен.',
		},
		{
			id: 'v1.7.0',
			kind: 'launcher',
			version: '1.7.0',
			date: '2026-09-04',
			title: '1.7.0 — кэш и загрузки',
			body: 'Картинки и поиск больше не качаются заново при каждом клике. CurseForge ставится по запасным ссылкам, отмена реагирует сразу. В фильтрах можно выбрать несколько типов сразу (магия + квесты + техника). В каталоге — ресурсы, шейдеры и датапаки. Карточка мода больше, описание видно сразу. Снизу — панель запуска.',
		},
		{
			id: 'v1.6.0',
			kind: 'launcher',
			version: '1.6.0',
			title: '1.6.0 — главная и профили',
			body: 'Стартовый экран вместо сразу открытой сборки. Несколько ников, каталог сразу с Modrinth, CurseForge и FTB. Скины видят только те, кто зашёл через Orion.',
		},
		{
			id: 'v1.5.0',
			kind: 'launcher',
			version: '1.5.0',
			title: '1.5.0 — настройки',
			body: 'Полноценная страница настроек: темы, память, разрешение, Java, автопроверка обновлений, запуск с Windows, папка данных.',
		},
		{
			id: 'v1.4.1',
			kind: 'launcher',
			version: '1.4.1',
			title: '1.4.1 — зеркала и ваниль',
			body: 'Каталог через зеркала из России. Сборки FTB и чистый Minecraft без модов.',
		},
		{
			id: 'v1.4.0',
			kind: 'launcher',
			version: '1.4.0',
			title: '1.4.0 — каталог',
			body: 'Поиск и установка сборок и модов с Modrinth и CurseForge прямо из лаунчера.',
		},
		{
			id: 'skins',
			kind: 'info',
			title: 'Скины',
			body: 'Загруженный скин виден тем, кто тоже зашёл через Orion. С чужого лаунчера его не будет — это не лицензия Mojang.',
			date: '2026-09-04',
		},
		{
			id: 'dc',
			kind: 'pack',
			title: 'DeceasedCraft',
			body: 'Наша сборка — слева в списке. Обновления приходят с сервера Orion, миры не трогает.',
			pack: 'DeceasedCraft_Beta_DH_Edition-5.10.17',
			date: '2026-09-04',
		},
	]
}

function mergeNews(remote) {
	const local = builtinNews()
	const seen = new Set()
	const out = []
	for (const n of [].concat(remote || [], local)) {
		const k = String(n.id || n.version || n.title || '')
		if (!k || seen.has(k)) continue
		seen.add(k)
		out.push(n)
	}
	return out
}

ipcMain.handle('launcher:news', async () => {
	const { fetchJson } = require('./net')
	const cfg = config.load()
	const hosts = allHosts(cfg.serverUrl)
	for (const host of hosts) {
		for (const path of ['/api/launcher/news', '/api/launcher/version']) {
			try {
				const data = await fetchJson(host + path, { timeout: 5000 })
				if (data && Array.isArray(data.items) && data.items.length) return ok({ items: mergeNews(data.items) })
				if (data && Array.isArray(data.news) && data.news.length) return ok({ items: mergeNews(data.news) })
			} catch (_) { /* следующий хост */ }
		}
	}
	return ok({ items: builtinNews() })
})
