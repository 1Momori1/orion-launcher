const { contextBridge, ipcRenderer } = require('electron')

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args)
const on = (ch, cb) => {
	const handler = (_e, payload) => cb(payload)
	ipcRenderer.on(ch, handler)
	return () => ipcRenderer.removeListener(ch, handler)
}

contextBridge.exposeInMainWorld('orion', {
	settings: {
		get: () => invoke('settings:get'),
		save: (patch) => invoke('settings:save', patch),
		chooseDataRoot: () => invoke('settings:choose-data-root'),
		validateNick: (nick) => invoke('settings:validate-nick', nick),
	},

	net: {
		status: () => invoke('net:status'),
	},

	packs: {
		list: () => invoke('packs:list'),
		plan: (name) => invoke('packs:plan', name),
		install: (name, mode) => invoke('packs:install', name, mode),
		cancel: () => ipcRenderer.send('packs:cancel'),
		openFolder: (name) => invoke('packs:open-folder', name),
		icon: (pack) => invoke('packs:icon', pack),
		onProgress: (cb) => on('install:progress', cb),
	},

	catalog: {
		search: (opts) => invoke('catalog:search', opts),
		project: (source, id) => invoke('catalog:project', source, id),
		versions: (source, id) => invoke('catalog:versions', source, id),
		related: (source, id) => invoke('catalog:related', source, id),
		instances: () => invoke('catalog:instances'),
		installPack: (payload) => invoke('catalog:install-pack', payload),
		installMod: (payload) => invoke('catalog:install-mod', payload),
		mods: (id) => invoke('catalog:mods', id),
		removeMod: (id, filename) => invoke('catalog:remove-mod', id, filename),
		uninstall: (id) => invoke('catalog:uninstall', id),
		cancel: () => ipcRenderer.send('catalog:cancel'),
	},

	launcher: {
		version: () => invoke('launcher:version'),
		checkUpdate: () => invoke('launcher:check-update'),
		installUpdate: () => invoke('launcher:install-update'),
		news: () => invoke('launcher:news'),
		onUpdate: (cb) => on('launcher:update', cb),
	},

	java: {
		detect: () => invoke('java:detect'),
		install: (major) => invoke('java:install', major),
		pick: () => invoke('java:pick'),
	},

	game: {
		launch: (name, extra) => invoke('game:launch', name, extra),
		stop: () => invoke('game:stop'),
		running: () => invoke('game:running'),
		openLog: (name) => invoke('game:open-log', name),
		onStatus: (cb) => on('game:status', cb),
	},

	servers: {
		list: () => invoke('servers:list'),
		vote: (serverId) => invoke('servers:vote', serverId),
		installClient: (client) => invoke('servers:install-client', client),
	},

	online: {
		list: () => invoke('online:list'),
	},

	skins: {
		list: () => invoke('skins:list'),
		upload: () => invoke('skins:upload'),
		myUrl: () => invoke('skins:my-url'),
	},

	profiles: {
		add: (username) => invoke('profiles:add', username),
		remove: (id) => invoke('profiles:remove', id),
		select: (id) => invoke('profiles:select', id),
	},

	auth: {
		login: (u, p) => invoke('auth:login', u, p),
		logout: () => invoke('auth:logout'),
	},

	window: {
		minimize: () => ipcRenderer.send('window:minimize'),
		maximize: () => ipcRenderer.send('window:maximize'),
		close: () => ipcRenderer.send('window:close'),
		onState: (cb) => on('window:state', cb),
	},

	openExternal: (url) => ipcRenderer.send('open:external', url),
})
