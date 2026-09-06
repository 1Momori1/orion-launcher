const $ = (id) => document.getElementById(id)

const NAMES = {
	'DeceasedCraft_Beta_DH_Edition-5.10.17': 'DeceasedCraft',
}

let current = null
let currentKind = 'orion' // orion | catalog
let plan = null
let installing = false
let ready = false
let settings = {}
let catalogType = 'modpack'
let catalogOffset = 0
let catalogHits = []
let catalogSelected = null
let catalogInstances = []
let catalogCats = new Set()
let catalogUiCache = new Map()
let launchTarget = { kind: '', id: '', name: '', icon: '' }
let installGen = 0
let newsItems = []
let newsIndex = 0
let newsTimer = null
let launcherVersion = ''
const THEMES = ['orion', 'ember', 'frost', 'moss', 'dusk', 'sand']
const FOLDER_TYPES = new Set(['mod', 'resourcepack', 'shader', 'datapack'])
const CLIENT_FALLBACK = {
	prominence: {
		type: 'catalog',
		source: 'modrinth',
		project: 'prominence-2-fabric',
		version: '9r2hKvJH',
		instance: 'catalog-mr-prominence-2-fabric',
	},
	vanilla: {
		type: 'recipe',
		instance: 'catalog-orion-vanilla',
		name: 'Orion Vanilla',
		minecraft: '1.21.11',
		loader: 'forge',
		loaderVersion: '61.1.0',
		mods: [
			{ source: 'modrinth', project: 'carry-on', version: 'wmEciYen' },
			{ source: 'modrinth', project: 'simple-voice-chat', version: 'btHl53yO' },
		],
	},
	'os-park': {
		type: 'catalog',
		source: 'curseforge',
		project: '1250591',
		version: '7617489',
		instance: 'catalog-cf-over-stars',
	},
}
const CATALOG_TABS = {
	'tab-packs': 'modpack',
	'tab-mods': 'mod',
	'tab-res': 'resourcepack',
	'tab-shaders': 'shader',
	'tab-data': 'datapack',
	'tab-vanilla': 'vanilla',
}

function displayName(name) {
	return NAMES[name] || name.replace(/_/g, ' ')
}

function fmtBytes(n) {
	if (!n && n !== 0) return '—'
	const u = ['Б', 'КБ', 'МБ', 'ГБ']
	let i = 0
	let v = n
	while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
	return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i]
}

function fmtTime(sec) {
	if (!sec && sec !== 0) return '—'
	if (sec < 60) return Math.round(sec) + ' с'
	return Math.floor(sec / 60) + ' мин ' + Math.round(sec % 60) + ' с'
}

function show(id, on) {
	const el = $(id)
	if (!el) return
	el.classList.toggle('hidden', !on)
}

function setStatus(text, cls) {
	const el = $('pack-status')
	el.textContent = text
	el.className = 'status-pill' + (cls ? ' ' + cls : '')
}

async function init() {
	$('btn-close').onclick = () => window.orion.window.close()
	$('btn-minimize').onclick = () => window.orion.window.minimize()
	$('btn-maximize').onclick = () => window.orion.window.maximize()
	$('nav-settings').onclick = () => openSettings(true)
	$('nav-home').onclick = () => openHome()
	$('dock-profile').onclick = () => openProfiles(true)
	$('dock-pack').onclick = (e) => {
		e.stopPropagation()
		toggleDockPackMenu()
	}
	document.addEventListener('click', (e) => {
		const wrap = $('dock-pack-wrap')
		if (wrap && !wrap.contains(e.target)) toggleDockPackMenu(false)
	})
	$('dock-play').onclick = play
	$('dock-settings').onclick = () => openSettings(true)
	$('dock-mods').onclick = () => {
		setCatalogType('mod')
		openCatalog()
	}
	$('btn-profile-close').onclick = () => openProfiles(false)
	$('profile-modal').onclick = (e) => {
		if (e.target.id === 'profile-modal') openProfiles(false)
	}
	$('btn-profile-add').onclick = addProfileFromUi
	$('btn-profile-skin').onclick = uploadSkin
	$('btn-retry').onclick = boot
	$('btn-install').onclick = () => install('resume')
	$('btn-resume').onclick = () => install('resume')
	$('btn-reinstall').onclick = () => install('restart')
	$('btn-cancel').onclick = () => {
		installing = false
		window.orion.packs.cancel()
	}
	$('btn-play').onclick = play
	$('btn-folder').onclick = () => current && window.orion.packs.openFolder(current)
	if ($('btn-folder-catalog')) $('btn-folder-catalog').onclick = () => current && window.orion.packs.openFolder(current)
	$('btn-skin').onclick = uploadSkin
	$('nav-catalog-browse').onclick = () => openCatalog()
	Object.keys(CATALOG_TABS).forEach((id) => {
		if ($(id)) $(id).onclick = () => setCatalogType(CATALOG_TABS[id])
	})
	$('catalog-q').addEventListener('input', debounce(runCatalogSearch, 400))
	$('catalog-source').onchange = () => runCatalogSearch(true)
	$('catalog-loader').onchange = () => runCatalogSearch(true)
	bindCatalogChips()
	$('opt-catalog-compat').onchange = () => runCatalogSearch(true)
	$('catalog-addon-for').addEventListener('input', debounce(() => runCatalogSearch(true), 400))
	$('btn-catalog-more').onclick = () => runCatalogSearch(false)
	$('btn-catalog-cancel').onclick = cancelCatalogInstall
	if ($('btn-home-cancel')) $('btn-home-cancel').onclick = cancelHomeClientInstall
	if ($('news-prev')) $('news-prev').onclick = () => stepNews(-1)
	if ($('news-next')) $('news-next').onclick = () => stepNews(1)
	$('btn-add-mods').onclick = () => {
		setCatalogType('mod')
		if (current) $('catalog-mod-target').value = current
		openCatalog()
	}
	$('btn-uninstall-catalog').onclick = uninstallCatalog
	$('catalog-modal').onclick = (e) => {
		if (e.target.id === 'catalog-modal') closeCatalogModal()
	}
	$('username').addEventListener('change', saveNick)
	$('username').addEventListener('blur', saveNick)

	window.orion.packs.onProgress(onProgress)
	window.orion.game.onStatus(onGame)
	window.orion.launcher.onUpdate((info) => showUpdateBanner(info))
	$('btn-update-now').onclick = () => installLauncherUpdate('banner')
	bindSettings()

	await boot()
	setInterval(loadOnline, 20000)
	setInterval(refreshNet, 15000)
}

async function boot() {
	const cfg = await window.orion.settings.get()
	settings = (cfg && cfg.settings) || {}
	if (settings.username) $('username').value = settings.username
	fillSettingsFromState(cfg)
	applyChrome()
	await paintLauncherVersion()
	if (settings.autoCheckUpdates !== false) checkUpdates(false)
	applyProfileToUi()

	const net = await window.orion.net.status()
	paintNet(net)
	const orionOnline = !!(net && net.ok && net.online)

	show('connect-screen', false)

	let packs = []
	let installed = {}
	if (orionOnline) {
		const list = await window.orion.packs.list()
		if (list.ok) {
			packs = list.modpacks || []
			installed = list.installed || {}
		}
	}

	await refreshCatalogSidebar()
	renderPacks(packs, installed)
	window.__installed = installed
	restoreLaunchTarget()
	openHome()
	paintOrionServers()
	if (window.__serverTimer) clearInterval(window.__serverTimer)
	window.__serverTimer = setInterval(() => { paintOrionServers() }, 12000)

	if (orionOnline) await loadOnline()
	await loadSkin()
	await refreshJava()
}

function paintNet(net) {
	const el = $('net-status')
	if (!net || !net.ok) {
		el.textContent = 'Нет связи'
		el.className = 'net-pill error'
		return
	}
	el.textContent = net.label
	el.className = 'net-pill ' + (net.level === 'ok' ? 'ok' : 'error')
}

async function refreshNet() {
	paintNet(await window.orion.net.status())
}

function renderPacks(packs, installed) {
	const box = $('pack-list')
	box.innerHTML = ''
	window.__packs = packs
	if (!packs.length) {
		box.innerHTML = '<div class="muted">Сервер Orion недоступен</div>'
		return
	}
	packs.forEach(async (p) => {
		const el = document.createElement('div')
		el.className = 'nav-item' + (p.name === current && currentKind === 'orion' ? ' active' : '')
		el.dataset.name = p.name
		const local = installed[p.name]
		const title = p.displayName || displayName(p.name)
		el.innerHTML =
			`<img class="pack-icon" src="logo.png" alt="">` +
			`<div class="pack-text"><div>${escapeHtml(title)}</div>` +
			`<div class="sub">${local ? 'установлено · v' + local.version : 'не установлено'}</div></div>`
		el.onclick = () => selectPack(p.name)
		box.appendChild(el)
		const icon = await resolvePackIcon(p)
		const img = el.querySelector('.pack-icon')
		if (img && icon) img.src = icon
	})
}

async function refreshCatalogSidebar() {
	const r = await window.orion.catalog.instances()
	catalogInstances = (r && r.ok && r.instances) || []
	window.__orionPacks = (r && r.ok && r.orionPacks) || []
	const box = $('catalog-installed')
	box.innerHTML = ''
	catalogInstances.forEach((inst) => {
		const el = document.createElement('div')
		el.className = 'nav-item' + (inst.id === current && currentKind === 'catalog' ? ' active' : '')
		el.dataset.name = inst.id
		el.innerHTML =
			`<img class="pack-icon" src="${escapeHtml(inst.iconUrl || 'logo.png')}" alt="" onerror="this.src='logo.png'">` +
			`<div class="pack-text"><div>${escapeHtml(inst.name || inst.id)}</div>` +
			`<div class="sub">${escapeHtml((inst.loader || '') + ' ' + (inst.minecraft || ''))}</div></div>`
		el.onclick = () => selectCatalogInstance(inst.id)
		box.appendChild(el)
	})
	fillModTargets()
	if ($('dock-pack-menu') && !$('dock-pack-menu').classList.contains('hidden')) paintDockPackMenu()
}

function fillModTargets() {
	const sel = $('catalog-mod-target')
	if (!sel) return
	const prev = sel.value
	const opts = ['<option value="">Куда поставить мод</option>']
	catalogInstances.forEach((inst) => {
		opts.push(`<option value="${escapeHtml(inst.id)}">${escapeHtml(inst.name || inst.id)}</option>`)
	})
	;(window.__orionPacks || []).forEach((p) => {
		opts.push(`<option value="${escapeHtml(p.id)}">${escapeHtml(displayName(p.name))} (наша — на свой страх)</option>`)
	})
	sel.innerHTML = opts.join('')
	if (prev) sel.value = prev
}

const iconCache = {}

async function resolvePackIcon(p) {
	if (!p) return 'logo.png'
	if (!p.icon) return 'logo.png'
	const key = p.name + ':' + (p.build || '')
	if (iconCache[key]) return iconCache[key]
	try {
		const r = await window.orion.packs.icon(p)
		if (r && r.ok && r.dataUrl) {
			iconCache[key] = r.dataUrl
			return r.dataUrl
		}
	} catch (_) { /* fallback */ }
	return 'logo.png'
}

function packIconUrl(p) {
	return 'logo.png'
}

async function selectPack(name) {
	current = name
	currentKind = 'orion'
	document.querySelectorAll('#pack-list .nav-item, #catalog-installed .nav-item').forEach((el) => {
		el.classList.toggle('active', el.dataset.name === name)
	})
	$('nav-catalog-browse').classList.remove('active')
	$('nav-settings').classList.remove('active')
	$('nav-home').classList.remove('active')
	show('connect-screen', false)
	show('home-screen', false)
	show('catalog-screen', false)
	show('settings-screen', false)
	show('pack-screen', true)
	show('install-actions', true)
	show('catalog-actions', false)
	show('mod-list', false)
	const p = (window.__packs || []).find(x => x.name === name)
	const title = (p && p.displayName) || displayName(name)
	$('pack-name').textContent = title
	const hero = $('pack-hero-icon')
	if (hero) {
		hero.src = 'logo.png'
		resolvePackIcon(p).then((src) => {
			hero.src = src || 'logo.png'
			if (launchTarget.id === name) {
				launchTarget.icon = src || 'logo.png'
				syncDock()
			}
		})
	}
	setLaunchTarget('orion', name, title, (hero && hero.src) || 'logo.png')
	await refreshPlan()
}

async function selectCatalogInstance(id) {
	current = id
	currentKind = 'catalog'
	ready = true
	document.querySelectorAll('#pack-list .nav-item, #catalog-installed .nav-item').forEach((el) => {
		el.classList.toggle('active', el.dataset.name === id)
	})
	$('nav-catalog-browse').classList.remove('active')
	$('nav-settings').classList.remove('active')
	$('nav-home').classList.remove('active')
	show('connect-screen', false)
	show('home-screen', false)
	show('catalog-screen', false)
	show('settings-screen', false)
	show('pack-screen', true)
	show('install-actions', false)
	show('catalog-actions', true)
	show('progress-wrap', false)
	const inst = catalogInstances.find(x => x.id === id)
	$('pack-name').textContent = (inst && inst.name) || id
	$('pack-meta').textContent = ((inst && inst.loader) || '') + ' ' + ((inst && inst.minecraft) || '') + (inst && inst.packVersion ? ' · ' + inst.packVersion : '')
	const hero = $('pack-hero-icon')
	if (hero) hero.src = (inst && inst.iconUrl) || 'logo.png'
	setStatus('Готово', 'ready')
	$('plan-text').textContent = 'Сборка из каталога. Обновления Orion на неё не влияют. Моды можно добавить отдельно.'
	$('launch-hint').textContent = 'Ник сохранится. Потом можно просто нажать «Играть».'
	$('btn-play').disabled = !$('username').value.trim()
	setLaunchTarget('catalog', id, (inst && inst.name) || id, (inst && inst.iconUrl) || 'logo.png')
	await renderModList(id)
}

async function renderModList(id) {
	const box = $('mod-list')
	const r = await window.orion.catalog.mods(id)
	if (!r.ok) {
		box.classList.add('hidden')
		return
	}
	const mods = r.mods || []
	if (!mods.length) {
		box.classList.add('hidden')
		box.innerHTML = ''
		return
	}
	box.classList.remove('hidden')
	box.innerHTML = mods.map((m) =>
		`<div class="mod-row"><span>${escapeHtml(m.filename)}</span>` +
		`<button type="button" class="orion-btn" data-mod="${escapeHtml(m.filename)}">Убрать</button></div>`
	).join('')
	box.querySelectorAll('button[data-mod]').forEach((btn) => {
		btn.onclick = async () => {
			await window.orion.catalog.removeMod(id, btn.dataset.mod)
			await renderModList(id)
		}
	})
}

async function refreshPlan() {
	if (!current) return
	if (currentKind === 'catalog') {
		await selectCatalogInstance(current)
		return
	}
	ready = false
	setStatus('Проверка')
	$('plan-text').textContent = 'Сверяю файлы со сервером…'
	setPlayEnabled(false)
	show('btn-resume', false)
	show('btn-reinstall', false)
	show('progress-wrap', false)

	const r = await window.orion.packs.plan(current)
	if (!r.ok) {
		setStatus('Ошибка')
		$('plan-text').textContent = r.error || 'Не удалось проверить сборку'
		return
	}
	plan = r.plan
	$('pack-meta').textContent = 'v' + (plan.version || '') + (plan.localVersion ? ' · локально ' + plan.localVersion : '')

	if (plan.ready) {
		ready = true
		setStatus('Готово', 'ready')
		$('btn-install').textContent = 'Проверить файлы'
		setPlayEnabled(!!$('username').value.trim())
		$('launch-hint').textContent = 'Ник сохранится. Потом можно просто нажать «Играть» снизу.'
		$('plan-text').textContent = 'Сборка установлена. «Обновить» подтянет только изменения. «Переустановить» скачает заново — миры и настройки не пропадут.'
		show('btn-reinstall', true)
	} else {
		setStatus(plan.localVersion ? 'Обновление' : 'Не установлено', 'warn')
		const parts = (plan.steps || []).map((s) => s.label + (s.bytes ? ' · ' + fmtBytes(s.bytes) : ''))
		$('plan-text').textContent = parts.length
			? 'Нужно скачать: ' + parts.join('; ') + '. Всего ~' + fmtBytes(plan.totalBytes) + (plan.localVersion ? '. Миры и настройки останутся.' : '')
			: 'Нужно что-то докачать.'
		$('btn-install').textContent = plan.localVersion ? 'Обновить' : 'Установить'
		setPlayEnabled(false)
		$('launch-hint').textContent = plan.localVersion ? 'Нажмите «Обновить» — миры не тронет.' : 'Сначала установите сборку.'
		show('btn-reinstall', !!plan.localVersion)
	}
}

async function install(mode) {
	if (!current || installing) return
	if (currentKind === 'catalog') return
	const nick = $('username').value.trim()
	if (nick) await saveNick()

	installing = true
	show('progress-wrap', true)
	show('btn-cancel', true)
	show('btn-resume', false)
	$('btn-install').disabled = true
	setPlayEnabled(false)
	$('progress-fill').style.width = '0%'
	$('progress-pct').textContent = '0%'
	$('progress-speed').textContent = '—'
	$('progress-eta').textContent = '—'
	$('progress-detail').textContent = mode === 'restart' ? 'Переустановка…' : 'Начинаю загрузку…'
	setStatus('Загрузка', 'warn')

	const r = await window.orion.packs.install(current, mode)
	installing = false
	show('btn-cancel', false)
	$('btn-install').disabled = false

	if (!r.ok) {
		$('progress-detail').textContent = r.error || 'Сбой загрузки'
		$('plan-text').textContent = 'Можно продолжить с того места, где остановились, или поставить заново.'
		show('btn-resume', true)
		show('btn-reinstall', true)
		setStatus('Прервано')
		return
	}

	$('progress-fill').style.width = '100%'
	$('progress-pct').textContent = '100%'
	$('progress-detail').textContent = 'Готово'
	await refreshPlan()
	await bootListOnly()
}

async function bootListOnly() {
	const list = await window.orion.packs.list()
	if (list.ok) renderPacks(list.modpacks || [], list.installed || {})
	else renderPacks([], {})
	await refreshCatalogSidebar()
}

function paintProgress(p, prefix) {
	const fill = $(prefix + 'progress-fill')
	if (!fill) return
	const pct = Math.max(0, Math.min(100, p.percent || 0))
	fill.style.width = pct.toFixed(1) + '%'
	const pctEl = $(prefix + 'progress-pct')
	const speedEl = $(prefix + 'progress-speed')
	const etaEl = $(prefix + 'progress-eta')
	const detailEl = $(prefix + 'progress-detail')
	if (pctEl) pctEl.textContent = Math.round(pct) + '%'
	if (speedEl) speedEl.textContent = p.bps ? (p.bps / (1024 * 1024)).toFixed(1) + ' МБ/с' : '—'
	if (etaEl) etaEl.textContent = p.etaSec ? fmtTime(p.etaSec) : '—'
	const size = fmtBytes(p.bytesDone) + ' / ' + fmtBytes(p.bytesTotal)
	if (detailEl) detailEl.textContent = (p.stageLabel || '') + (p.detail ? ' · ' + p.detail : '') + ' · ' + size
}

function onProgress(p) {
	if (!p) return
	paintProgress(p, '')
	paintProgress(p, 'cat-')
	paintProgress(p, 'home-')
}

async function saveNick() {
	const nick = $('username').value.trim()
	const v = await window.orion.settings.validateNick(nick)
	if (!v.ok) {
		$('nick-hint').textContent = v.error
		setPlayEnabled(false)
		return
	}
	$('nick-hint').textContent = 'Это активный профиль. Несколько аккаунтов — снизу слева.'
	const profiles = (settings.profiles || []).map((p) =>
		p.id === settings.activeProfileId ? { ...p, username: nick } : p
	)
	const patch = { username: nick }
	if (settings.activeProfileId && profiles.length) patch.profiles = profiles
	await window.orion.settings.save(patch)
	settings.username = nick
	if (patch.profiles) settings.profiles = patch.profiles
	applyProfileToUi()
	if (ready) setPlayEnabled(true)
	await loadSkin()
}

async function play() {
	await saveNick()
	const nick = $('username').value.trim()
	if (!nick) {
		$('launch-hint').textContent = 'Сначала введите ник.'
		return
	}
	const targetId = (currentKind === 'home' ? launchTarget.id : current) || launchTarget.id
	if (!targetId) {
		$('launch-hint').textContent = 'Сначала выберите сборку слева.'
		return
	}
	setPlayEnabled(false)
	$('launch-hint').textContent = 'Запускаю Minecraft…'
	const r = await window.orion.game.launch(targetId)
	if (!r.ok) {
		$('launch-hint').textContent = r.error
		setPlayEnabled(true)
		return
	}
	const mode = settings.onLaunch || 'stay'
	if (mode === 'minimize') $('launch-hint').textContent = 'Игра запущена. Лаунчер свёрнут.'
	else if (mode === 'hide') $('launch-hint').textContent = 'Игра запущена. Лаунчер скрыт, пока не закроете Minecraft.'
	else $('launch-hint').textContent = 'Игра запущена. Лаунчер можно свернуть.'
}

function onGame(ev) {
	if (!ev) return
	if (ev.stage === 'starting') $('launch-hint').textContent = 'Java: ' + (ev.java || 'запуск')
	if (ev.stage === 'running') $('launch-hint').textContent = 'Игра запущена'
	if (ev.stage === 'error' || ev.stage === 'crashed') {
		$('launch-hint').textContent = ev.error || ev.hint || ('Игра закрылась' + (ev.code ? ' (' + ev.code + ')' : ''))
		$('btn-play').disabled = false
		setPlayEnabled(true)
	}
	if (ev.stage === 'exited') {
		$('launch-hint').textContent = 'Игра закрыта'
		setPlayEnabled(!!(ready || launchTarget.id))
	}
}

function showUpdateBanner(info) {
	paintUpdateStatus(info)
	if (info && info.ok && !info.upToDate) {
		show('update-banner', true)
		$('update-text').textContent = `Доступен Orion Launcher ${info.remote} (сейчас ${info.current})`
		$('btn-update-now').disabled = false
		show('btn-install-update', true)
		return
	}
	show('update-banner', false)
	show('btn-install-update', false)
}

async function loadOnline() {
	const r = await window.orion.online.list()
	const box = $('online-list')
	if (!r.ok) {
		box.innerHTML = '<div class="muted">—</div>'
		return
	}
	const players = r.players || []
	if (!players.length) {
		box.innerHTML = '<div class="muted">Никого нет</div>'
		return
	}
	box.innerHTML = players.map((p) =>
		`<div class="nav-item"><span class="player-dot"></span>${escapeHtml(p.username)}</div>`
	).join('')
}

async function loadSkin() {
	const r = await window.orion.skins.myUrl()
	const img = $('skin-preview')
	const dock = $('dock-skin')
	if (!r.ok || !r.url) {
		if (img) img.hidden = true
		if (dock) dock.hidden = true
		return
	}
	img.onload = () => { img.hidden = false }
	img.onerror = () => { img.hidden = true }
	img.src = r.url
	if (dock) {
		dock.onload = () => { dock.hidden = false }
		dock.onerror = () => { dock.hidden = true }
		dock.src = r.url
	}
}

async function uploadSkin() {
	await saveNick()
	const r = await window.orion.skins.upload()
	if (!r.ok) {
		$('nick-hint').textContent = r.error || 'Скин не загрузился'
		return
	}
	if (r.changed && r.url) {
		$('skin-preview').src = r.url
		$('skin-preview').hidden = false
		if ($('dock-skin')) {
			$('dock-skin').src = r.url
			$('dock-skin').hidden = false
		}
		$('nick-hint').textContent = 'Скин на сервере. Его увидят игроки с Orion Launcher.'
		if ($('profile-msg')) $('profile-msg').textContent = 'Скин загружен. С чужого лаунчера его не видно.'
	}
}

async function openSettings(on) {
	if (!on) {
		show('settings-screen', false)
		$('nav-settings').classList.remove('active')
		return
	}
	show('connect-screen', false)
	show('pack-screen', false)
	show('catalog-screen', false)
	show('home-screen', false)
	show('settings-screen', true)
	$('nav-settings').classList.add('active')
	$('nav-home').classList.remove('active')
	$('nav-catalog-browse').classList.remove('active')
	document.querySelectorAll('#pack-list .nav-item, #catalog-installed .nav-item').forEach((el) => {
		el.classList.remove('active')
	})
	syncDock()
	const cfg = await window.orion.settings.get()
	if (cfg && cfg.settings) settings = cfg.settings
	fillSettingsFromState(cfg)
	applyChrome()
	refreshJava()
	checkUpdates(false)
}

function switchSettingsPane(name) {
	document.querySelectorAll('#settings-nav .orion-btn').forEach((btn) => {
		btn.classList.toggle('active', btn.dataset.pane === name)
	})
	document.querySelectorAll('.settings-pane').forEach((pane) => {
		pane.classList.toggle('hidden', pane.dataset.pane !== name)
	})
}

function applyChrome() {
	const theme = THEMES.includes(settings.theme) ? settings.theme : 'orion'
	document.documentElement.setAttribute('data-theme', theme)
	document.body.classList.toggle('no-grid', settings.showGrid === false)
	document.body.classList.toggle('no-grid-anim', settings.animateGrid === false)
	const online = $('online-block')
	if (online) online.classList.toggle('hidden', !!settings.hideOnline)
	document.querySelectorAll('.theme-card').forEach((card) => {
		card.classList.toggle('active', card.dataset.theme === theme)
	})
}

function fillSettingsFromState(cfg) {
	if (settings.memoryMB && $('memory')) {
		$('memory').value = settings.memoryMB
		$('memory').dispatchEvent(new Event('input'))
	}
	if ($('game-width')) $('game-width').value = settings.width || 1280
	if ($('game-height')) $('game-height').value = settings.height || 720
	if ($('server-url') && settings.serverUrl) $('server-url').value = settings.serverUrl
	if ($('cf-key')) $('cf-key').value = settings.curseforgeApiKey || ''
	if (cfg && cfg.paths && $('data-root')) $('data-root').textContent = cfg.paths.root
	if (cfg && cfg.freeSpace != null && $('data-free')) {
		$('data-free').textContent = 'Свободно: ' + fmtBytes(cfg.freeSpace)
	}
	if ($('opt-grid')) $('opt-grid').checked = settings.showGrid !== false
	if ($('opt-grid-anim')) $('opt-grid-anim').checked = settings.animateGrid !== false
	if ($('opt-auto-update')) $('opt-auto-update').checked = settings.autoCheckUpdates !== false
	if ($('opt-update-channel')) $('opt-update-channel').value = settings.updateChannel === 'staff' ? 'staff' : 'stable'
	if ($('opt-start-windows')) $('opt-start-windows').checked = !!settings.openAtLogin
	if ($('opt-hide-online')) $('opt-hide-online').checked = !!settings.hideOnline
	if ($('opt-on-launch')) $('opt-on-launch').value = settings.onLaunch || 'stay'
	const src = settings.catalogSource || 'auto'
	if ($('opt-catalog-source')) $('opt-catalog-source').value = src
	if ($('catalog-source')) $('catalog-source').value = src
}

async function patchSettings(patch) {
	const r = await window.orion.settings.save(patch)
	if (r.ok && r.settings) settings = r.settings
	else Object.assign(settings, patch)
	applyChrome()
	return r
}

function bindSettings() {
	document.querySelectorAll('#settings-nav .orion-btn').forEach((btn) => {
		btn.onclick = () => switchSettingsPane(btn.dataset.pane)
	})
	document.querySelectorAll('.theme-card').forEach((card) => {
		card.onclick = () => patchSettings({ theme: card.dataset.theme })
	})
	$('opt-grid').onchange = () => patchSettings({ showGrid: $('opt-grid').checked })
	$('opt-grid-anim').onchange = () => patchSettings({ animateGrid: $('opt-grid-anim').checked })
	$('opt-auto-update').onchange = () => patchSettings({ autoCheckUpdates: $('opt-auto-update').checked })
	if ($('opt-update-channel')) $('opt-update-channel').onchange = () => patchSettings({ updateChannel: $('opt-update-channel').value })
	$('opt-start-windows').onchange = () => patchSettings({ openAtLogin: $('opt-start-windows').checked })
	$('opt-hide-online').onchange = () => patchSettings({ hideOnline: $('opt-hide-online').checked })
	$('opt-on-launch').onchange = () => patchSettings({ onLaunch: $('opt-on-launch').value })
	$('opt-catalog-source').onchange = async () => {
		const catalogSource = $('opt-catalog-source').value
		await patchSettings({ catalogSource })
		if ($('catalog-source')) $('catalog-source').value = catalogSource
	}
	$('btn-reset-appear').onclick = async () => {
		$('opt-grid').checked = true
		$('opt-grid-anim').checked = true
		await patchSettings({ theme: 'orion', showGrid: true, animateGrid: true })
	}
	$('memory').oninput = () => {
		const mb = Number($('memory').value)
		$('memory-label').textContent = (mb / 1024).toFixed(1).replace('.0', '') + ' ГБ'
	}
	$('memory').onchange = () => patchSettings({ memoryMB: Number($('memory').value) })
	$('game-width').onchange = () => patchSettings({ width: Number($('game-width').value) })
	$('game-height').onchange = () => patchSettings({ height: Number($('game-height').value) })
	$('server-url').addEventListener('change', async () => {
		const v = $('server-url').value.trim().replace(/\/$/, '')
		if (!v) return
		await patchSettings({ serverUrl: v })
		$('settings-net-msg').textContent = 'Адрес сохранён.'
		await refreshNet()
	})
	$('cf-key').addEventListener('change', async () => {
		await patchSettings({ curseforgeApiKey: $('cf-key').value.trim() })
		$('settings-msg').textContent = 'Ключ CurseForge сохранён.'
	})
	$('btn-retry-net').onclick = async () => {
		$('settings-net-msg').textContent = 'Проверяю…'
		await refreshNet()
		const net = await window.orion.net.status()
		$('settings-net-msg').textContent = net && net.ok
			? ('Связь есть: ' + (net.label || 'онлайн'))
			: (net && net.error) || 'Нет связи с сервером Orion.'
	}
	$('btn-data-root').onclick = async () => {
		const r = await window.orion.settings.chooseDataRoot()
		if (r.ok && r.changed) {
			$('data-root').textContent = r.paths.root
			if (r.freeSpace != null) $('data-free').textContent = 'Свободно: ' + fmtBytes(r.freeSpace)
			await refreshPlan()
		}
	}
	$('btn-open-data').onclick = () => window.orion.packs.openFolder('')
	$('btn-check-update').onclick = () => checkUpdates(true)
	$('btn-install-update').onclick = () => installLauncherUpdate('settings')
	$('btn-java-detect').onclick = refreshJava
	$('btn-java-install').onclick = async () => {
		$('java-info').textContent = 'Скачиваю Java 17…'
		const r = await window.orion.java.install(17)
		$('java-info').textContent = r.ok ? r.java.raw : (r.error || 'Не удалось установить Java')
	}
	$('btn-java-install-21').onclick = async () => {
		$('java-info').textContent = 'Скачиваю Java 21…'
		const r = await window.orion.java.install(21)
		$('java-info').textContent = r.ok ? r.java.raw : (r.error || 'Не удалось установить Java 21')
	}
	$('btn-java-pick').onclick = async () => {
		const r = await window.orion.java.pick()
		if (r.ok && r.java) $('java-info').textContent = r.java.raw
		else if (r.error) $('java-info').textContent = r.error
	}
}

async function paintLauncherVersion() {
	const r = await window.orion.launcher.version()
	launcherVersion = (r && r.version) || ''
	if ($('titlebar-ver')) $('titlebar-ver').textContent = launcherVersion ? 'v' + launcherVersion : ''
	if ($('sidebar-ver')) $('sidebar-ver').textContent = launcherVersion ? 'v' + launcherVersion : 'лаунчер'
	if ($('launcher-ver-line')) $('launcher-ver-line').textContent = launcherVersion
		? ('Сейчас установлена версия ' + launcherVersion)
		: 'Версия неизвестна'
	if ($('settings-hero-meta') && launcherVersion) {
		$('settings-hero-meta').textContent = 'Orion Launcher ' + launcherVersion + ' — вид, игра, Java, каталог и обновления.'
	}
}

function paintUpdateStatus(info) {
	const el = $('update-status')
	if (!el) return
	if (!info) {
		el.textContent = 'Нажмите «Проверить обновление», если баннер не появился.'
		return
	}
	if (!info.ok) {
		el.textContent = 'Нет связи с сервером обновлений. Проверьте интернет или адрес в «Сеть». '
			+ (info.error ? '(' + info.error + ')' : '')
		return
	}
	if (info.upToDate) {
		el.textContent = 'У вас актуальная версия ' + (info.current || launcherVersion) + '.'
		return
	}
	el.textContent = 'Доступна ' + info.remote + '. Сейчас ' + info.current + '. Можно установить сразу.'
}

async function checkUpdates(manual) {
	const status = $('update-status')
	if (status) status.textContent = 'Проверяю сервер…'
	const r = await window.orion.launcher.checkUpdate()
	showUpdateBanner(r)
	if (manual && status && r && r.ok && !r.upToDate) {
		status.textContent = 'Есть ' + r.remote + '. Сейчас ' + r.current + '. Нажмите «Установить обновление».'
	}
	return r
}

async function installLauncherUpdate(from) {
	if (from === 'banner') {
		$('update-text').textContent = 'Скачиваю обновление…'
		$('btn-update-now').disabled = true
	}
	if ($('update-status')) $('update-status').textContent = 'Скачиваю установщик…'
	show('btn-install-update', false)
	const r = await window.orion.launcher.installUpdate()
	if (!r.ok) {
		const msg = r.error || 'Не удалось обновить'
		$('update-text').textContent = msg
		$('btn-update-now').disabled = false
		if ($('update-status')) $('update-status').textContent = msg
		show('btn-install-update', true)
	}
}

async function refreshJava() {
	const r = await window.orion.java.detect()
	$('java-info').textContent = r.ok && r.java
		? r.java.raw
		: 'Java 17 не найдена. Можно поставить автоматически. Для Minecraft 1.21+ нужна Java 21.'
}

function debounce(fn, ms) {
	let t = null
	return () => {
		clearTimeout(t)
		t = setTimeout(fn, ms)
	}
}

function isFolderType(type) {
	return FOLDER_TYPES.has(type || catalogType)
}

function selectedCats() {
	return [...catalogCats]
}

function bindCatalogChips() {
	const box = $('catalog-cats')
	if (!box) return
	box.querySelectorAll('.chip').forEach((btn) => {
		btn.onclick = () => {
			const cat = btn.dataset.cat
			if (catalogCats.has(cat)) catalogCats.delete(cat)
			else catalogCats.add(cat)
			btn.classList.toggle('on', catalogCats.has(cat))
			show('catalog-addon-for', catalogType === 'mod' && catalogCats.has('addon'))
			if (catalogType !== 'vanilla') runCatalogSearch(true)
		}
	})
}

function catalogUiKey() {
	return [
		catalogType,
		catalogSource(),
		catalogSearchQuery(),
		selectedCats().slice().sort().join(','),
		$('catalog-loader') ? $('catalog-loader').value : '',
		$('opt-catalog-compat') && $('opt-catalog-compat').checked ? '1' : '0',
		$('catalog-mod-target') ? $('catalog-mod-target').value : '',
	].join('|')
}

function restoreCatalogUi(cached) {
	catalogHits = cached.hits
	catalogOffset = cached.offset
	renderCatalogHits()
	show('btn-catalog-more', !!cached.more)
}

function cancelHomeClientInstall() {
	installGen++
	installing = false
	window.orion.catalog.cancel()
	window.orion.packs.cancel()
	show('home-progress-wrap', false)
	if ($('home-progress-detail')) $('home-progress-detail').textContent = 'Отменено'
	paintOrionServers()
}

function cancelCatalogInstall() {
	installGen++
	installing = false
	window.orion.catalog.cancel()
	window.orion.packs.cancel()
	show('cat-progress-wrap', false)
	const el = $('catalog-install-msg')
	if (el) el.textContent = 'Отменено'
}

function setPlayEnabled(on) {
	if ($('btn-play')) $('btn-play').disabled = !on
	if ($('dock-play')) $('dock-play').disabled = !on
}

function restoreLaunchTarget() {
	const last = settings.lastModpack || ''
	if (!last) return
	const pack = (window.__packs || []).find((p) => p.name === last)
	if (pack) {
		launchTarget = { kind: 'orion', id: pack.name, name: pack.displayName || displayName(pack.name), icon: 'logo.png' }
		resolvePackIcon(pack).then((src) => {
			if (launchTarget.id === pack.name) launchTarget.icon = src || 'logo.png'
			syncDock()
		})
		return
	}
	const inst = catalogInstances.find((x) => x.id === last)
	if (inst) {
		launchTarget = { kind: 'catalog', id: inst.id, name: inst.name || inst.id, icon: inst.iconUrl || 'logo.png' }
	}
}

function setLaunchTarget(kind, id, name, icon) {
	launchTarget = { kind, id, name: name || id, icon: icon || 'logo.png' }
	if (id) window.orion.settings.save({ lastModpack: id }).catch(() => {})
	syncDock()
}

function openLaunchTarget() {
	if (!launchTarget.id) return
	if (launchTarget.kind === 'catalog') selectCatalogInstance(launchTarget.id)
	else selectPack(launchTarget.id)
}

function toggleDockPackMenu(force) {
	const menu = $('dock-pack-menu')
	if (!menu) return
	const open = force === true ? true : force === false ? false : menu.classList.contains('hidden')
	if (open) paintDockPackMenu()
	menu.classList.toggle('hidden', !open)
}

function paintDockPackMenu() {
	const menu = $('dock-pack-menu')
	if (!menu) return
	const items = []
	for (const p of window.__packs || []) {
		const local = window.__installed && window.__installed[p.name]
		if (!local) continue
		const key = p.name + ':' + (p.build || '')
		items.push({
			kind: 'orion',
			id: p.name,
			name: p.displayName || displayName(p.name),
			icon: iconCache[key] || 'logo.png',
			sub: 'Orion · v' + local.version,
		})
	}
	for (const inst of catalogInstances || []) {
		items.push({
			kind: 'catalog',
			id: inst.id,
			name: inst.name || inst.id,
			icon: inst.iconUrl || 'logo.png',
			sub: ((inst.loader || '') + ' ' + (inst.minecraft || '')).trim() || 'каталог',
		})
	}
	if (!items.length) {
		menu.innerHTML = '<div class="dock-pack-empty">Пока нет установленных сборок</div>'
		return
	}
	menu.innerHTML = items.map((it) =>
		`<button type="button" class="dock-pack-item${it.id === launchTarget.id ? ' active' : ''}" data-kind="${escapeHtml(it.kind)}" data-id="${escapeHtml(it.id)}">` +
		`<img src="${escapeHtml(it.icon)}" alt="" onerror="this.src='logo.png'">` +
		`<span><strong>${escapeHtml(it.name)}</strong><small>${escapeHtml(it.sub)}</small></span></button>`
	).join('')
	menu.querySelectorAll('.dock-pack-item').forEach((btn) => {
		btn.onclick = (e) => {
			e.stopPropagation()
			if (btn.dataset.kind === 'catalog') selectCatalogInstance(btn.dataset.id)
			else selectPack(btn.dataset.id)
			toggleDockPackMenu(false)
		}
	})
}

function dockVisible() {
	return currentKind === 'home' || currentKind === 'orion' || currentKind === 'catalog'
}

function syncDock() {
	const dock = $('launch-dock')
	if (dock) dock.classList.toggle('hidden', !dockVisible())
	if ($('dock-pack-name')) $('dock-pack-name').textContent = launchTarget.name || 'Сборка не выбрана'
	if ($('dock-pack-icon')) $('dock-pack-icon').src = launchTarget.icon || 'logo.png'
	const canPlay = !!(launchTarget.id && (settings.username || ($('username') && $('username').value.trim())) && (ready || launchTarget.kind === 'catalog' || currentKind === 'home'))
	if (currentKind === 'orion') setPlayEnabled(ready && !!$('username').value.trim())
	else if (currentKind === 'catalog') setPlayEnabled(!!$('username').value.trim())
	else if (currentKind === 'home') setPlayEnabled(!!(launchTarget.id && $('username').value.trim() && (launchTarget.kind === 'catalog' || ready || (window.__installed && window.__installed[launchTarget.id]))))
	void canPlay
}

function setCatalogType(type) {
	catalogType = Object.values(CATALOG_TABS).includes(type) ? type : 'modpack'
	Object.keys(CATALOG_TABS).forEach((id) => {
		if ($(id)) $(id).classList.toggle('active', CATALOG_TABS[id] === catalogType)
	})
	const folder = isFolderType(catalogType)
	show('catalog-mod-target', folder)
	show('catalog-source', catalogType !== 'vanilla')
	show('catalog-loader', catalogType !== 'vanilla' && catalogType !== 'resourcepack' && catalogType !== 'datapack')
	if ($('catalog-cats')) $('catalog-cats').classList.toggle('hidden', catalogType === 'vanilla')
	show('catalog-addon-for', catalogType === 'mod' && catalogCats.has('addon'))
	show('catalog-compat-wrap', catalogType !== 'vanilla')
	$('catalog-q').placeholder = catalogType === 'vanilla' ? 'Версия, например 1.20.1' : 'Поиск…'
	if ($('catalog-mod-target') && $('catalog-mod-target').options[0]) {
		const labels = { mod: 'Куда поставить мод', resourcepack: 'Куда поставить ресурс', shader: 'Куда поставить шейдер', datapack: 'Куда поставить датапак' }
		$('catalog-mod-target').options[0].textContent = labels[catalogType] || 'Куда поставить'
	}
	runCatalogSearch(true)
}

function catalogSource() {
	if (catalogType === 'vanilla') return 'vanilla'
	return $('catalog-source').value || 'auto'
}

function onCatalogFilters() {
	show('catalog-addon-for', catalogType === 'mod' && catalogCats.has('addon'))
	if (catalogType !== 'vanilla') runCatalogSearch(true)
}

function compatQuery() {
	if (!$('opt-catalog-compat') || !$('opt-catalog-compat').checked) return { gameVersion: '', loader: '' }
	const target = $('catalog-mod-target') && $('catalog-mod-target').value
	const inst = catalogInstances.find((x) => x.id === target) || (currentKind === 'catalog' ? catalogInstances.find((x) => x.id === current) : null)
	if (inst) return { gameVersion: inst.minecraft || '', loader: (inst.loader || '').toLowerCase() }
	if (currentKind === 'orion' || (window.__packs || []).length) return { gameVersion: '1.20.1', loader: 'forge' }
	return { gameVersion: '', loader: '' }
}

function catalogSearchQuery() {
	let q = $('catalog-q').value.trim()
	const addonFor = $('catalog-addon-for') && !$('catalog-addon-for').classList.contains('hidden')
		? $('catalog-addon-for').value.trim()
		: ''
	if (addonFor) q = (q ? q + ' ' : '') + addonFor
	return q
}

function closeCatalogModal() {
	show('catalog-modal', false)
	catalogSelected = null
}

function formatDesc(text) {
	const s = String(text || '').replace(/\r\n/g, '\n').trim()
	if (!s) return 'Описания пока нет — если площадка отдаст полный текст, он появится здесь.'
	return s.length > 8000 ? s.slice(0, 8000) + '…' : s
}

function openCatalog() {
	currentKind = 'browse'
	show('connect-screen', false)
	show('pack-screen', false)
	show('settings-screen', false)
	show('home-screen', false)
	show('catalog-screen', true)
	$('nav-settings').classList.remove('active')
	$('nav-home').classList.remove('active')
	$('nav-catalog-browse').classList.add('active')
	document.querySelectorAll('#pack-list .nav-item, #catalog-installed .nav-item').forEach((el) => {
		el.classList.remove('active')
	})
	fillModTargets()
	syncDock()
	const key = catalogUiKey()
	const cached = catalogUiCache.get(key)
	if (cached && Date.now() - cached.at < 10 * 60 * 1000 && cached.hits.length) {
		restoreCatalogUi(cached)
		return
	}
	if (!catalogHits.length) runCatalogSearch(true)
}

async function runCatalogSearch(reset) {
	const key = catalogUiKey()
	if (reset !== false) {
		const cached = catalogUiCache.get(key)
		if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
			catalogSelected = null
			closeCatalogModal()
			restoreCatalogUi(cached)
			return
		}
		catalogOffset = 0
		catalogHits = []
		catalogSelected = null
		closeCatalogModal()
		$('catalog-results').innerHTML = '<div class="muted">Ищу…</div>'
	}
	const source = catalogSource()
	if (source === 'ftb' && catalogType !== 'modpack') {
		$('catalog-results').innerHTML = '<div class="muted">FTB — только готовые сборки. Для остального оставьте «Авто» или Modrinth / CurseForge.</div>'
		show('btn-catalog-more', false)
		return
	}
	const compat = catalogType === 'vanilla' ? {} : compatQuery()
	const r = await window.orion.catalog.search({
		source,
		type: catalogType,
		query: catalogSearchQuery(),
		offset: catalogOffset,
		limit: 20,
		loader: catalogType === 'vanilla' ? '' : ($('catalog-loader').value || compat.loader || ''),
		category: catalogType === 'vanilla' ? [] : selectedCats(),
		gameVersion: compat.gameVersion || '',
	})
	if (!r.ok) {
		$('catalog-results').innerHTML = `<div class="muted">${escapeHtml(r.error || 'Поиск не удался')}</div>`
		show('btn-catalog-more', false)
		return
	}
	const hits = r.hits || []
	catalogHits = reset === false ? catalogHits.concat(hits) : hits
	catalogOffset = catalogHits.length
	renderCatalogHits()
	const more = catalogHits.length < (r.total || 0)
	show('btn-catalog-more', more)
	catalogUiCache.set(key, { hits: catalogHits.slice(), offset: catalogOffset, more, at: Date.now() })
}

function renderCatalogHits() {
	const box = $('catalog-results')
	if (!catalogHits.length) {
		box.innerHTML = '<div class="muted">Ничего не нашлось</div>'
		return
	}
	box.innerHTML = ''
	catalogHits.forEach((h) => {
		const el = document.createElement('div')
		el.className = 'catalog-card' + (catalogSelected && catalogSelected.projectId === h.projectId && catalogSelected.source === h.source ? ' active' : '')
		const dl = h.downloads >= 1000000 ? (h.downloads / 1000000).toFixed(1) + 'M' : (h.downloads >= 1000 ? Math.round(h.downloads / 1000) + 'K' : String(h.downloads || 0))
		const loaders = (h.loaders || []).slice(0, 3).join(', ')
		const srcs = (h.sources && h.sources.length ? h.sources : [{ source: h.source }])
			.map((s) => `<span class="badge">${escapeHtml(sourceLabel(s.source))}</span>`)
			.join('')
		el.innerHTML =
			`<img src="${escapeHtml(h.iconUrl || 'logo.png')}" alt="" onerror="this.src='logo.png'">` +
			`<div><div class="title">${escapeHtml(h.title)}</div>` +
			`<div class="sub">${escapeHtml(dl + ' · ' + (loaders || h.author || ''))}</div>` +
			`<div class="source-badges">${srcs}</div></div>`
		el.onclick = () => openCatalogDetail(h)
		box.appendChild(el)
	})
}

async function openCatalogDetail(hit) {
	catalogSelected = hit
	const isVanilla = hit.source === 'vanilla' || catalogType === 'vanilla'
	const isPack = catalogType === 'modpack' || catalogType === 'vanilla' || hit.projectType === 'modpack' || isVanilla
	const folder = !isPack && (isFolderType(catalogType) || FOLDER_TYPES.has(hit.projectType))
	const sources = (hit.sources && hit.sources.length)
		? hit.sources
		: [{ source: hit.primarySource || hit.source, projectId: hit.projectId, downloads: hit.downloads }]
	let active = pickBestSource(sources)
	show('catalog-modal', true)
	const box = $('catalog-modal-panel')
	const labels = {
		mod: 'Добавить мод',
		resourcepack: 'Добавить ресурс',
		shader: 'Добавить шейдер',
		datapack: 'Добавить датапак',
	}
	const installLabel = folder ? (labels[catalogType] || 'Добавить') : (isVanilla ? 'Установить Minecraft' : 'Установить сборку')

	function sourceOptions(sel) {
		const autoVal = 'auto:' + (pickBestSource(sources).source)
		return `<option value="${escapeHtml(autoVal)}">Авто — ${escapeHtml(sourceLabel(pickBestSource(sources).source))}, больше загрузок</option>` +
			sources.map((s) =>
				`<option value="${escapeHtml(s.source + ':' + s.projectId)}"${s.source === sel.source && String(s.projectId) === String(sel.projectId) ? ' selected' : ''}>${escapeHtml(sourceLabel(s.source))}${(s.downloads ? ' · ' + fmtCompact(s.downloads) : '')}</option>`
			).join('')
	}

	function paintInstall(src, optsHtml, versionsHint) {
		const body = $('catalog-detail-body')
		if (!body) return
		body.innerHTML =
			`<label class="field"><span>Версия на ${escapeHtml(sourceLabel(src.source))}</span>` +
			`<select id="catalog-version">${optsHtml || '<option value="">Последняя подходящая</option>'}</select></label>` +
			`<div class="row wrap" style="margin-top:12px">` +
			`<button type="button" class="orion-btn play" id="btn-catalog-install">${installLabel}</button>` +
			`</div>` +
			`<p id="catalog-install-msg" class="field-hint">${escapeHtml(versionsHint || '')}</p>`
		const btn = $('btn-catalog-install')
		if (btn) {
			btn.onclick = () => {
				const use = { ...hit, source: src.source, projectId: src.projectId, projectType: isPack ? 'modpack' : (hit.projectType || catalogType) }
				installFromCatalog(use, $('catalog-version').value, folder)
			}
		}
	}

	box.innerHTML =
		`<div class="drawer-head"><h2 class="font-orbitron">${escapeHtml(hit.title)}</h2>` +
		`<button type="button" class="win-btn" id="btn-catalog-modal-close">✕</button></div>` +
		`<div class="catalog-modal-hero">` +
		`<img src="${escapeHtml(hit.iconUrl || 'logo.png')}" alt="" onerror="this.src='logo.png'">` +
		`<div><p class="lead">${escapeHtml(hit.description || 'Описание подгрузится ниже.')}</p>` +
		`<p class="field-hint">${escapeHtml((hit.author ? hit.author + ' · ' : '') + ((hit.loaders || []).join(', ') || ''))}</p></div></div>` +
		(isVanilla ? '' : `<label class="field"><span>Откуда качать</span><select id="catalog-detail-source">${sourceOptions(active)}</select></label>`) +
		`<div class="catalog-gallery hidden" id="catalog-gallery"></div>` +
		`<div class="catalog-desc" id="catalog-desc-body">${escapeHtml(formatDesc(hit.description))}</div>` +
		`<div id="catalog-detail-body"></div>` +
		`<div id="catalog-related-body"></div>`
	$('btn-catalog-modal-close').onclick = closeCatalogModal
	paintInstall(active, '', 'Версии подгружаются, можно ставить сразу.')

	async function loadFor(src) {
		active = src
		paintInstall(src, '', 'Версии с ' + sourceLabel(src.source) + '…')
		const projP = window.orion.catalog.project(src.source, src.projectId)
		const versP = window.orion.catalog.versions(src.source, src.projectId)
		const [proj, vers] = await Promise.all([projP, versP])
		if (catalogSelected !== hit) return
		const desc = formatDesc((proj.ok && proj.project && (proj.project.body || proj.project.description)) || hit.description)
		const descEl = $('catalog-desc-body')
		if (descEl) descEl.textContent = desc
		const gallery = (proj.ok && proj.project && proj.project.gallery) || []
		paintGallery(gallery.length ? gallery : (hit.iconUrl ? [{ url: hit.iconUrl, title: hit.title }] : []))
		if (proj.ok && proj.project && proj.project.iconUrl) {
			const heroImg = box.querySelector('.catalog-modal-hero img')
			if (heroImg) heroImg.src = proj.project.iconUrl
		}
		if (!vers.ok) {
			paintInstall(src, '', vers.error || 'Не удалось получить версии. Поставлю последнюю.')
			return
		}
		const versions = filterCompatibleVersions(vers.versions || [])
		const opts = versions.slice(0, 40).map((v) => {
			const label = (v.versionNumber || v.name) + ' · ' + (v.gameVersions || []).slice(0, 3).join(', ') + ' ' + (v.loaders || []).join(',')
			return `<option value="${escapeHtml(String(v.id))}">${escapeHtml(label)}</option>`
		}).join('')
		paintInstall(src, opts, versions.length ? '' : 'Нет списка версий, поставлю последнюю.')
		if (folder) {
			window.orion.catalog.related(src.source, src.projectId).then((related) => {
				if (catalogSelected !== hit) return
				const rel = related && related.ok ? related : { required: [], optional: [], incompatible: [] }
				const relBox = $('catalog-related-body')
				if (relBox) relBox.innerHTML = paintRelatedHtml(rel)
				bindRelatedClicks(rel, folder)
			})
		}
	}

	const srcSel = $('catalog-detail-source')
	if (srcSel) {
		srcSel.onchange = () => {
			const [source, projectId] = srcSel.value.replace(/^auto:/, '').split(':')
			const found = sources.find((s) => s.source === source && String(s.projectId) === String(projectId))
				|| sources.find((s) => s.source === source)
				|| pickBestSource(sources)
			loadFor(found)
		}
	}
	await loadFor(active)
}

function pickBestSource(sources) {
	return (sources || []).slice().sort((a, b) => (b.downloads || 0) - (a.downloads || 0))[0] || { source: 'modrinth', projectId: '' }
}

function sourceLabel(s) {
	return { modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB', vanilla: 'Mojang', auto: 'Авто' }[s] || s || ''
}

function fmtCompact(n) {
	if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
	if (n >= 1000) return Math.round(n / 1000) + 'K'
	return String(n || 0)
}

function filterCompatibleVersions(versions) {
	const compat = compatQuery()
	if (!compat.gameVersion && !compat.loader) return versions
	const filtered = versions.filter((v) => {
		const gv = v.gameVersions || []
		const ld = (v.loaders || []).map((x) => String(x).toLowerCase())
		if (compat.gameVersion && gv.length && !gv.some((g) => String(g) === compat.gameVersion)) return false
		if (compat.loader && ld.length && !ld.includes(compat.loader)) return false
		return true
	})
	return filtered.length ? filtered : versions
}

function paintGallery(gallery) {
	const el = $('catalog-gallery')
	if (!el) return
	if (!gallery.length) {
		el.classList.add('hidden')
		el.innerHTML = ''
		return
	}
	el.classList.remove('hidden')
	el.innerHTML = gallery.slice(0, 8).map((g) =>
		`<img src="${escapeHtml(g.url)}" alt="${escapeHtml(g.title || '')}" title="${escapeHtml(g.title || '')}">`
	).join('')
	el.querySelectorAll('img').forEach((img) => {
		img.onclick = () => window.orion.openExternal(img.src)
	})
}

function paintRelatedHtml(rel) {
	const blocks = []
	const pack = (title, list, cls) => {
		if (!list || !list.length) return
		blocks.push(`<div class="related-block"><div class="card-label">${title}</div>` +
			list.map((m) =>
				`<div class="related-row" data-rel="${escapeHtml(m.source + ':' + m.projectId)}">` +
				`<img src="${escapeHtml(m.iconUrl || 'logo.png')}" alt="" onerror="this.src='logo.png'">` +
				`<div><div class="title">${escapeHtml(m.title)}</div><div class="sub">${escapeHtml(cls)}</div></div></div>`
			).join('') + '</div>')
	}
	pack('Нужно вместе', rel.required, 'обязательно')
	pack('Дополнения и связки', rel.optional, 'можно поставить рядом')
	pack('Несовместимо', rel.incompatible, 'лучше не ставить вместе')
	return blocks.join('')
}

function bindRelatedClicks(rel, isMod) {
	const all = [].concat(rel.required || [], rel.optional || [], rel.incompatible || [])
	document.querySelectorAll('.related-row[data-rel]').forEach((row) => {
		row.onclick = () => {
			const [source, projectId] = row.dataset.rel.split(':')
			const found = all.find((m) => m.source === source && String(m.projectId) === String(projectId))
			if (found) {
				if (isMod) catalogType = 'mod'
				openCatalogDetail({
					...found,
					sources: [{ source: found.source, projectId: found.projectId, downloads: found.downloads }],
				})
			}
		}
	})
}

async function installFromCatalog(hit, versionId, isMod) {
	if (installing) return
	const msg = () => $('catalog-install-msg')
	if (isMod) {
		const target = $('catalog-mod-target').value
		if (!target) {
			if (msg()) msg().textContent = 'Выберите сборку, куда поставить.'
			return
		}
		if (!String(target).startsWith('catalog-') && !confirm('Файл попадёт в нашу сборку Orion. Обновление DeceasedCraft его не удалит, но совместимость не гарантируется. Продолжить?')) {
			return
		}
	}
	const my = ++installGen
	installing = true
	show('cat-progress-wrap', true)
	$('cat-progress-fill').style.width = '0%'
	if (msg()) msg().textContent = 'Качаю…'
	const payload = { source: hit.source, projectId: hit.projectId, versionId, kind: catalogType }
	const r = isMod
		? await window.orion.catalog.installMod({ ...payload, instanceId: $('catalog-mod-target').value })
		: await window.orion.catalog.installPack(payload)
	if (my !== installGen) return
	installing = false
	if (!r.ok) {
		if (msg()) msg().textContent = r.error || 'Не удалось установить'
		return
	}
	$('cat-progress-fill').style.width = '100%'
	if (msg()) msg().textContent = 'Готово'
	closeCatalogModal()
	show('cat-progress-wrap', false)
	await refreshCatalogSidebar()
	if (!isMod && r.id) await selectCatalogInstance(r.id)
	else if (isMod) {
		const t = $('catalog-mod-target').value
		if (t && String(t).startsWith('catalog-')) await selectCatalogInstance(t)
	}
}

async function uninstallCatalog() {
	if (!current || currentKind !== 'catalog') return
	if (!confirm('Удалить сборку с диска? Миры в этой папке тоже удалятся.')) return
	const r = await window.orion.catalog.uninstall(current)
	if (!r.ok) {
		$('launch-hint').textContent = r.error || 'Не удалось удалить'
		return
	}
	current = null
	await refreshCatalogSidebar()
	openCatalog()
}

function applyProfileToUi() {
	const nick = (settings.username || '').trim()
	if ($('username') && nick && $('username').value !== nick) $('username').value = nick
	if ($('dock-nick')) $('dock-nick').textContent = nick || 'Нет профиля'
	syncDock()
}

function openProfiles(on) {
	show('profile-modal', on)
	if (on) {
		paintProfileList()
		$('profile-msg').textContent = ''
		$('profile-new-nick').value = ''
	}
}

function paintProfileList() {
	const box = $('profile-list')
	const list = settings.profiles || []
	if (!list.length) {
		box.innerHTML = '<div class="muted">Пока один слот пуст. Введите ник ниже.</div>'
		return
	}
	box.innerHTML = list.map((p) =>
		`<div class="profile-row${p.id === settings.activeProfileId ? ' active' : ''}">` +
		`<div class="grow">${escapeHtml(p.username)}</div>` +
		`<button type="button" class="orion-btn" data-sel="${escapeHtml(p.id)}">Выбрать</button>` +
		`<button type="button" class="orion-btn" data-del="${escapeHtml(p.id)}">Удалить</button>` +
		`</div>`
	).join('')
	box.querySelectorAll('[data-sel]').forEach((btn) => {
		btn.onclick = async () => {
			const r = await window.orion.profiles.select(btn.dataset.sel)
			if (r.ok && r.settings) settings = r.settings
			applyProfileToUi()
			paintProfileList()
			await loadSkin()
		}
	})
	box.querySelectorAll('[data-del]').forEach((btn) => {
		btn.onclick = async () => {
			const r = await window.orion.profiles.remove(btn.dataset.del)
			if (r.ok && r.settings) settings = r.settings
			applyProfileToUi()
			paintProfileList()
			await loadSkin()
		}
	})
}

async function addProfileFromUi() {
	const nick = $('profile-new-nick').value.trim()
	const v = await window.orion.settings.validateNick(nick)
	if (!v.ok) {
		$('profile-msg').textContent = v.error
		return
	}
	const r = await window.orion.profiles.add(nick)
	if (!r.ok) {
		$('profile-msg').textContent = r.error || 'Не удалось добавить'
		return
	}
	settings = r.settings
	$('profile-new-nick').value = ''
	$('profile-msg').textContent = 'Профиль добавлен.'
	applyProfileToUi()
	paintProfileList()
	await loadSkin()
}

function openHome() {
	currentKind = 'home'
	show('connect-screen', false)
	show('pack-screen', false)
	show('catalog-screen', false)
	show('settings-screen', false)
	show('home-screen', true)
	$('nav-home').classList.add('active')
	$('nav-settings').classList.remove('active')
	$('nav-catalog-browse').classList.remove('active')
	document.querySelectorAll('#pack-list .nav-item, #catalog-installed .nav-item').forEach((el) => {
		el.classList.remove('active')
	})
	applyProfileToUi()
	syncDock()
	paintHome()
}

async function paintHome() {
	const newsBox = $('home-news')
	const feat = $('home-featured')
	if (feat) {
		const packs = window.__packs || []
		const p = packs[0]
		const installed = window.__installed || {}
		if (p) {
			const local = installed[p.name]
			feat.innerHTML =
				`<p class="lead">${escapeHtml(p.displayName || displayName(p.name))}</p>` +
				`<p class="field-hint">${local ? 'установлено · v' + local.version : 'ещё не установлена'}</p>` +
				`<div class="row wrap" style="margin-top:10px"><button type="button" class="orion-btn primary" id="btn-home-pack">Открыть сборку</button></div>`
			const btn = $('btn-home-pack')
			if (btn) btn.onclick = () => selectPack(p.name)
		} else {
			feat.innerHTML = '<p class="lead">Сервер Orion сейчас не отвечает. Каталог слева всё равно можно открыть.</p>'
		}
	}
	paintOrionServers()
	if (!newsBox) return
	const r = await window.orion.launcher.news()
	newsItems = (r && r.items) || []
	newsIndex = 0
	paintNewsSlide()
	startNewsTimer()
}

function parseJoinAddress(address) {
	const raw = String(address || '').trim()
	if (!raw) return { host: '', port: '' }
	const idx = raw.lastIndexOf(':')
	if (idx > 0) {
		const port = raw.slice(idx + 1)
		if (/^\d+$/.test(port)) return { host: raw.slice(0, idx), port }
	}
	return { host: raw, port: '' }
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch (_) {
		return false
	}
}

function clientSpec(s) {
	if (s && s.client && s.client.type) return s.client
	return CLIENT_FALLBACK[s && s.id] || null
}

function clientReady(s) {
	const spec = clientSpec(s)
	if (!spec) return false
	const id = spec.instance || spec.pack || s.clientPack
	if (!id) return false
	if (spec.type === 'orion') return !!(window.__installed && window.__installed[id])
	return !!(catalogInstances || []).some((x) => x.id === id)
}

function clientLabel(s) {
	const spec = clientSpec(s)
	if (!spec) return ''
	if (spec.type === 'orion') return 'нужна наша сборка'
	if (clientReady(s)) return 'сборка стоит'
	return 'сборка не установлена'
}

function serverCardHtml(s, lobby) {
	const online = !!s.online
	const mine = lobby && lobby.my_vote === s.id
	const votes = s.votes || 0
	const players = online ? `${s.players_online || 0}/${s.max_players || '?'}` : 'выкл'
	const ready = clientReady(s)
	const spec = clientSpec(s)
	const badge = online ? 'сейчас играет' : (mine ? 'ваш голос' : '')
	const packHint = clientLabel(s)
	const actions = []
	if (online && ready) actions.push(`<button type="button" class="orion-btn primary" data-join>Зайти</button>`)
	if (spec && !ready) actions.push(`<button type="button" class="orion-btn primary" data-install>Скачать сборку</button>`)
	if (online && ready) actions.push(`<button type="button" class="orion-btn" data-copy>IP</button>`)
	if (!online) actions.push(`<button type="button" class="orion-btn${mine || !ready ? '' : ' primary'}" data-vote>${mine ? 'Голос учтён' : 'Хочу сюда'}</button>`)
	return (
		`<div class="orion-server-card${online ? ' is-active' : ''}${mine ? ' is-voted' : ''}" data-id="${escapeHtml(s.id || '')}">` +
			`<div class="orion-server-top">` +
				`<span class="orion-server-dot ${online ? 'on' : 'off'}"></span>` +
				`<strong>${escapeHtml(s.name || s.id)}</strong>` +
				`<span class="orion-server-stat">${votes} голос.</span>` +
				`<span class="orion-server-stat">${players}</span>` +
			`</div>` +
			`<div class="field-hint">${escapeHtml(s.description || ((s.modloader || '') + ' ' + (s.version || '')))}${badge ? ' · ' + badge : ''}${packHint ? ' · ' + packHint : ''}</div>` +
			`<div class="row wrap orion-server-actions">${actions.join('')}</div>` +
		`</div>`
	)
}

async function joinPublicServer(s, lobby, btn) {
	const addr = (lobby && lobby.address) || s.address || ''
	if (!addr) {
		if (btn) btn.textContent = 'Нет адреса'
		return
	}
	const nick = ($('username') && $('username').value.trim()) || (settings.username || '').trim()
	if (!nick) {
		if (btn) btn.textContent = 'Сначала ник'
		setTimeout(() => { if (btn) btn.textContent = 'Зайти' }, 2200)
		return
	}
	await copyText(addr)
	const spec = clientSpec(s)
	const packName = (spec && (spec.instance || spec.pack)) || s.clientPack
	if (!packName || !clientReady(s)) {
		if (btn) btn.textContent = 'Сначала сборка'
		setTimeout(() => { if (btn) btn.textContent = 'Зайти' }, 2200)
		return
	}
	const parsed = parseJoinAddress(addr)
	const title = s.name || packName
	setLaunchTarget(spec && spec.type === 'orion' ? 'orion' : 'catalog', packName, title, 'logo.png')
	const r = await window.orion.game.launch(packName, { host: parsed.host, port: parsed.port })
	if (!r.ok) {
		if (btn) btn.textContent = r.error || 'Не вышло'
		setTimeout(() => { if (btn) btn.textContent = 'Зайти' }, 2800)
		return
	}
	if (btn) btn.textContent = 'Запускаю…'
	setTimeout(() => { if (btn) btn.textContent = 'Зайти' }, 2200)
}

async function installPublicClient(s, lobby, btn) {
	const spec = clientSpec(s)
	if (!spec) return
	if (installing) return
	const my = ++installGen
	installing = true
	if (btn) {
		btn.disabled = true
		btn.textContent = 'Качаю…'
	}
	show('home-progress-wrap', true)
	if ($('home-progress-fill')) $('home-progress-fill').style.width = '0%'
	if ($('home-progress-detail')) $('home-progress-detail').textContent = 'Качаю сборку для ' + (s.name || s.id)
	const r = await window.orion.servers.installClient(spec)
	if (my !== installGen) return
	installing = false
	if (btn) btn.disabled = false
	if (!r || !r.ok) {
		if ($('home-progress-detail')) $('home-progress-detail').textContent = (r && r.error) || 'Не удалось скачать сборку'
		if (btn) btn.textContent = 'Повторить'
		return
	}
	if ($('home-progress-fill')) $('home-progress-fill').style.width = '100%'
	if ($('home-progress-detail')) $('home-progress-detail').textContent = 'Сборка готова'
	show('home-progress-wrap', false)
	await bootListOnly()
	const id = r.id || spec.instance || spec.pack
	setLaunchTarget(spec.type === 'orion' ? 'orion' : 'catalog', id, s.name || id, 'logo.png')
	await paintOrionServers()
	if (s.online) {
		const card = document.querySelector(`.orion-server-card[data-id="${CSS.escape(s.id)}"] [data-join]`)
		if (card) await joinPublicServer(s, lobby, card)
	}
}

function bindServerCard(el, s, lobby) {
	const addr = (lobby && lobby.address) || s.address || ''
	const joinBtn = el.querySelector('[data-join]')
	const voteBtn = el.querySelector('[data-vote]')
	const installBtn = el.querySelector('[data-install]')
	const copyBtn = el.querySelector('[data-copy]')
	if (joinBtn) joinBtn.onclick = () => joinPublicServer(s, lobby, joinBtn)
	if (installBtn) installBtn.onclick = () => installPublicClient(s, lobby, installBtn)
	if (copyBtn) copyBtn.onclick = async () => {
		const ok = addr && await copyText(addr)
		copyBtn.textContent = ok ? 'Скопировано' : 'Нет адреса'
		setTimeout(() => { copyBtn.textContent = 'IP' }, 1600)
	}
	if (voteBtn) voteBtn.onclick = async () => {
		voteBtn.disabled = true
		const r = await window.orion.servers.vote(s.id)
		if (!r || !r.ok) {
			voteBtn.disabled = false
			voteBtn.textContent = (r && r.error) || 'Сначала укажите ник'
			setTimeout(() => { voteBtn.textContent = 'Хочу сюда'; voteBtn.disabled = false }, 2200)
			return
		}
		await paintOrionServers()
	}
}

async function paintOrionServers() {
	const home = $('home-servers')
	const nav = $('server-nav')
	let lobby = {}
	let servers = []
	try {
		const r = await window.orion.servers.list()
		if (r && r.ok) {
			lobby = r
			servers = r.servers || []
		}
	} catch (_) { servers = [] }
	window.__lobby = lobby

	if (nav) {
		if (!servers.length) {
			nav.innerHTML = '<div class="muted">Пока пусто</div>'
		} else {
			nav.innerHTML = servers.map((s) => {
				const on = s.online ? 'on' : 'off'
				const sub = s.online ? 'онлайн' : ((s.votes || 0) + ' голос.')
				return `<div class="nav-item server-nav-item" data-id="${escapeHtml(s.id || '')}">` +
					`<span class="orion-server-dot ${on}"></span>` +
					`<div class="pack-text"><div>${escapeHtml(s.name || s.id)}</div>` +
					`<div class="sub">${sub}</div></div></div>`
			}).join('')
			nav.querySelectorAll('.server-nav-item').forEach((el) => {
				el.onclick = () => openHome()
			})
		}
	}

	if (!home) return
	if (!servers.length) {
		home.innerHTML = '<p class="lead">Серверы ещё не видны. Если лаунчер только что обновился — проверьте сеть.</p>'
		return
	}
	const addr = lobby.address || ''
	const activeName = lobby.active && lobby.active.name
	const statusLine = lobby.switching
		? (lobby.message || 'Переключаем сервер…')
		: (activeName
			? `Сейчас: ${activeName}` + (lobby.players_online ? ` · ${lobby.players_online} в игре` : ' · никого нет, можно сменить')
			: 'Сейчас никто не запущен — голос поднимет сборку')
	home.innerHTML =
		`<div class="orion-slot-head">` +
			`<div class="orion-server-addr">${escapeHtml(addr || 'адрес появится после PlayIt')}</div>` +
			`<button type="button" class="orion-btn" data-copy-ip ${addr ? '' : 'disabled'}>Копировать IP</button>` +
		`</div>` +
		`<p class="field-hint">${escapeHtml(statusLine)}</p>` +
		servers.map((s) => serverCardHtml(s, lobby)).join('')
	const copyBtn = home.querySelector('[data-copy-ip]')
	if (copyBtn) copyBtn.onclick = async () => {
		const ok = addr && await copyText(addr)
		copyBtn.textContent = ok ? 'Скопировано' : 'Нет адреса'
		setTimeout(() => { copyBtn.textContent = 'Копировать IP' }, 1600)
	}
	home.querySelectorAll('.orion-server-card').forEach((el, i) => bindServerCard(el, servers[i], lobby))
}

function paintNewsSlide() {
	const newsBox = $('home-news')
	const dots = $('news-dots')
	if (!newsBox) return
	if (!newsItems.length) {
		newsBox.innerHTML = '<div class="muted">Новостей нет</div>'
		if (dots) dots.innerHTML = ''
		return
	}
	if (newsIndex < 0) newsIndex = newsItems.length - 1
	if (newsIndex >= newsItems.length) newsIndex = 0
	const n = newsItems[newsIndex]
	newsBox.innerHTML =
		`<div class="news-item${n.kind === 'pack' || n.pack ? ' kind-pack' : ''}" data-pack="${escapeHtml(n.pack || '')}">` +
		(n.date ? `<div class="news-date">${escapeHtml(String(n.date).slice(0, 10))}</div>` : '') +
		`<h3>${escapeHtml(n.title || '')}</h3>` +
		`<p>${escapeHtml(n.body || '')}</p></div>`
	newsBox.querySelectorAll('.kind-pack').forEach((el) => {
		el.onclick = () => {
			const name = el.dataset.pack
			if (name) selectPack(name)
		}
	})
	if (dots) {
		dots.innerHTML = newsItems.map((_, i) => `<span class="${i === newsIndex ? 'on' : ''}" data-i="${i}"></span>`).join('')
		dots.querySelectorAll('span').forEach((el) => {
			el.onclick = () => {
				newsIndex = Number(el.dataset.i)
				paintNewsSlide()
				startNewsTimer()
			}
		})
	}
}

function stepNews(dir) {
	newsIndex += dir
	paintNewsSlide()
	startNewsTimer()
}

function startNewsTimer() {
	if (newsTimer) clearInterval(newsTimer)
	if (newsItems.length < 2) return
	newsTimer = setInterval(() => {
		newsIndex++
		paintNewsSlide()
	}, 8000)
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

init().catch((e) => {
	show('home-screen', false)
	show('connect-screen', true)
	$('connect-detail').textContent = e.message || String(e)
})
