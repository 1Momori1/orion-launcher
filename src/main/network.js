const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')
const { request } = require('./net')
const { allHosts } = require('./hosts')

function execFileAsync(cmd, args, timeout = 4000) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
			resolve({ err, out: `${stdout || ''}${stderr || ''}` })
		})
	})
}

class Network {
	constructor(serverUrl) {
		this.serverUrl = (serverUrl || '').replace(/\/$/, '')
		this._tsPath = undefined
		this._tsPathCheckedAt = 0
	}

	setServerUrl(u) { this.serverUrl = (u || '').replace(/\/$/, '') }

	_findTailscale() {
		const now = Date.now()
		if (this._tsPath !== undefined && (now - this._tsPathCheckedAt < 30000)) {
			return this._tsPath
		}
		this._tsPathCheckedAt = now
		const candidates = [
			'C:\\Program Files\\Tailscale\\tailscale.exe',
			'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
			'/usr/bin/tailscale',
			'/usr/local/bin/tailscale',
		]
		this._tsPath = candidates.find(p => { try { fs.accessSync(p); return true } catch (e) { return false } }) || null
		return this._tsPath
	}

	// Читаем сетевые адаптеры ОС (Radmin, Tailscale, LAN)
	getAdaptersInfo() {
		const ifaces = os.networkInterfaces()
		let radmin = null
		let tailscale = null
		const lan = []

		for (const [name, addrs] of Object.entries(ifaces)) {
			if (!addrs) continue
			const lowerName = name.toLowerCase()
			for (const a of addrs) {
				if (a.internal || a.family !== 'IPv4') continue
				const ip = a.address

				// Radmin VPN подсеть 26.0.0.0/8 или имя интерфейса
				if (lowerName.includes('radmin') || ip.startsWith('26.')) {
					radmin = { name, ip, netmask: a.netmask }
				}
				// Tailscale подсеть 100.64.0.0/10 или имя интерфейса
				else if (lowerName.includes('tailscale') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) {
					tailscale = { name, ip, netmask: a.netmask }
				}
				// LAN подсети (192.168.x, 10.x, 172.16-31.x)
				else if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
					lan.push({ name, ip })
				}
			}
		}
		return { radmin, tailscale, lan }
	}

	// Проверка Radmin VPN
	async radminInfo() {
		const adapters = this.getAdaptersInfo()
		const radminExeCandidates = [
			'C:\\Program Files (x86)\\Radmin VPN\\RvpnGui.exe',
			'C:\\Program Files\\Radmin VPN\\RvpnGui.exe',
		]
		const installed = radminExeCandidates.some(p => {
			try { fs.accessSync(p); return true } catch (e) { return false }
		}) || !!adapters.radmin

		if (adapters.radmin) {
			return {
				installed: true,
				running: true,
				ip: adapters.radmin.ip,
				name: adapters.radmin.name,
			}
		}
		return {
			installed,
			running: false,
			ip: null,
			name: null,
		}
	}

	// Проверка Tailscale
	async tailscaleInfo() {
		const adapters = this.getAdaptersInfo()
		const ts = this._findTailscale()

		if (ts) {
			const { err, out } = await execFileAsync(ts, ['status', '--json'])
			if (!err && out.trim()) {
				try {
					const st = JSON.parse(out)
					return {
						installed: true,
						running: st.BackendState === 'Running',
						state: st.BackendState,
						ip: (st.Self && st.Self.TailscaleIPs && st.Self.TailscaleIPs[0]) || (adapters.tailscale && adapters.tailscale.ip) || null,
						name: (st.Self && st.Self.HostName) || null,
					}
				} catch (e) {}
			}
		}

		if (adapters.tailscale) {
			return {
				installed: true,
				running: true,
				state: 'Running',
				ip: adapters.tailscale.ip,
				name: adapters.tailscale.name,
			}
		}

		return {
			installed: !!ts,
			running: false,
			ip: null,
			name: null,
		}
	}

	// Проверка доступности сервера
	async probeServer(targetUrl = null) {
		const url = (targetUrl || this.serverUrl).replace(/\/$/, '')
		const t0 = Date.now()
		try {
			await request('GET', `${url}/api/modpacks/health`, { timeout: 4500 })
			return { reachable: true, ms: Date.now() - t0, url }
		} catch (e) {
			return { reachable: false, error: e.message, url }
		}
	}

	// Проверка сервера с автоматическим поиском запасных адресов (LAN / Tailscale / Radmin)
	async probeServerWithFallbacks() {
		const main = await this.probeServer(this.serverUrl)
		if (main.reachable) return main

		const candidates = allHosts(this.serverUrl).filter((u) => u !== this.serverUrl)

		for (const alt of candidates) {
			const res = await this.probeServer(alt)
			if (res.reachable) {
				return { ...res, fallbackUsed: true, originalError: main.error }
			}
		}
		return main
	}

	// Сводка для интерфейса
	async status() {
		const [server, ts, radmin] = await Promise.all([
			this.probeServerWithFallbacks(),
			this.tailscaleInfo(),
			this.radminInfo(),
		])

		let label
		let level

		// Определяем, через что подключен клиент
		const vpnTypes = []
		if (radmin.running) vpnTypes.push('Radmin')
		if (ts.running) vpnTypes.push('Tailscale')
		const vpnLabel = vpnTypes.length ? vpnTypes.join('+') : 'LAN'

		const viaPublic = !!(server.url && String(server.url).startsWith('https://'))
		if (server.reachable) {
			label = viaPublic
				? `Сервер доступен · ${server.ms} мс`
				: `Сервер доступен (${vpnLabel}) · ${server.ms} мс`
			level = 'ok'
		} else if (radmin.running && !ts.running) {
			label = `Сервер недоступен · Radmin активен (${radmin.ip})`
			level = 'error'
		} else if (ts.running && !radmin.running) {
			label = `Сервер недоступен · Tailscale активен (${ts.ip})`
			level = 'error'
		} else if (ts.installed && !ts.running && !radmin.running) {
			label = 'Tailscale выключен'
			level = 'error'
		} else if (radmin.installed && !radmin.running && !ts.running) {
			label = 'Radmin VPN выключен'
			level = 'error'
		} else {
			label = 'Нет связи с сервером'
			level = 'error'
		}

		return {
			online: server.reachable,
			level,
			label,
			server,
			tailscale: ts,
			radmin,
			vpnLabel,
		}
	}
}

module.exports = { Network }

