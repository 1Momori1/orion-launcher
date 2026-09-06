const fs = require('fs')
const path = require('path')
const { app, dialog, shell } = require('electron')
const { downloadWithRetry, fetchJson } = require('./net')
const { allHosts } = require('./hosts')

async function probeUpdate(serverUrl, channel) {
	const current = app.getVersion()
	const hosts = allHosts(serverUrl)
	let ch = channel
	if (!ch) {
		try { ch = require('./config').load().updateChannel } catch (e) { ch = 'stable' }
	}
	ch = ch === 'staff' ? 'staff' : 'stable'

	let lastErr = null
	for (const host of hosts) {
		try {
			const q = `channel=${encodeURIComponent(ch)}&current=${encodeURIComponent(current)}`
			const info = await fetchJson(`${host}/api/launcher/version?${q}`, { timeout: 6000 })
			if (!info || !info.version) continue
			return {
				ok: true,
				current,
				remote: info.version,
				channel: ch,
				upToDate: !isNewer(info.version, current),
				info: { ...info, _base: host, _channel: ch },
			}
		} catch (e) {
			lastErr = e
		}
	}
	return { ok: false, reason: 'offline', error: lastErr && lastErr.message, current }
}

async function checkLauncherUpdate(serverUrl, { silent = true, forceDialog = false } = {}) {
	const probed = await probeUpdate(serverUrl)
	if (!probed.ok) {
		if (!silent) throw new Error(probed.error || 'offline')
		return probed
	}
	if (probed.upToDate) return { ok: true, upToDate: true, current: probed.current, remote: probed.remote }

	const info = probed.info
	const win = BrowserWindowSafe()

	if (!forceDialog && silent) {
		// UI сам покажет баннер; диалог — только по кнопке
		return {
			ok: true,
			available: true,
			current: probed.current,
			remote: probed.remote,
			info,
		}
	}

	const choice = await dialog.showMessageBox(win || undefined, {
		type: 'info',
		title: 'Обновление Orion Launcher',
		message: `Доступна версия ${info.version}`,
		detail: `Сейчас у вас ${probed.current}. Обновить? Сборки и миры останутся.`,
		buttons: ['Обновить', 'Позже'],
		defaultId: 0,
		cancelId: 1,
	})
	if (choice.response !== 0) return { ok: true, skipped: true, available: true, current: probed.current, remote: probed.remote }

	return installUpdate(info, probed.current)
}

async function installUpdate(info, current) {
	const dest = path.join(app.getPath('temp'), `OrionLauncherSetup-${info.version}.exe`)
	const base = (info._base || '').replace(/\/$/, '')
	let downloadPath = '/api/launcher/download'
	if (info.url) {
		try {
			const parsed = new URL(info.url)
			downloadPath = parsed.pathname
		} catch (_) {}
	}
	if (info._channel && info._channel !== 'stable') {
		downloadPath += (downloadPath.includes('?') ? '&' : '?') + 'channel=' + encodeURIComponent(info._channel)
	}
	const url = base ? `${base}${downloadPath}` : (info.url || `${base}/api/launcher/download`)

	if (!info.sha256 || String(info.sha256).length < 64) {
		throw new Error('Обновление без контрольной суммы отклонено')
	}
	const allowed = new Set(allHosts(base).map((h) => h.replace(/\/$/, '')))
	let parsed
	try { parsed = new URL(url) } catch (e) { throw new Error('Некорректная ссылка обновления') }
	if (!allowed.has(`${parsed.protocol}//${parsed.host}`)) {
		throw new Error('Обновление с чужого адреса отклонено')
	}
	await downloadWithRetry(url, dest, {
		expectedSha256: String(info.sha256),
		expectedSize: info.size || null,
	})

	const { spawn } = require('child_process')
	// NSIS silent per-user install
	spawn(dest, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
	app.quit()
	return { ok: true, updating: true, current, remote: info.version }
}

function isNewer(remote, local) {
	const a = String(remote).split('.').map(n => parseInt(n, 10) || 0)
	const b = String(local).split('.').map(n => parseInt(n, 10) || 0)
	const len = Math.max(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const x = a[i] || 0, y = b[i] || 0
		if (x > y) return true
		if (x < y) return false
	}
	return false
}

function BrowserWindowSafe() {
	try {
		const { BrowserWindow } = require('electron')
		const all = BrowserWindow.getAllWindows()
		return all[0] || null
	} catch (e) { return null }
}

module.exports = { checkLauncherUpdate, installUpdate, probeUpdate, isNewer }
