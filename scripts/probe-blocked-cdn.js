const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const { spawnSync } = require('child_process')
const catalog = require('../src/main/catalog')

const BLOCKED = new Set([
	'ImprovedCrosshair.zip',
	'ModernArmourBar.zip',
	'totw_modded-forge-1.20.1-1.0.6.jar',
	'CentralCrosshair.zip',
	'servercore-forge-1.5.2+1.20.1.jar',
	'fastboot-1.20.x-1.2.jar',
	'eco_stack_manager-forge-1.20.1-1.4.1.jar',
	'entityculling-forge-1.9.5-mc1.20.1.jar',
	'waveycapes-forge-1.8.1-mc1.20.1.jar',
	'enhanced_boss_bars-1.20.1-1.0.0.jar',
	'FreshAnimations_v1.10.3.zip',
	'BetterBubbles.zip',
	'X-Crosshair.zip',
	'immersivefixes-1.0.3-all.jar',
	'notenoughanimations-forge-1.10.6-mc1.20.1.jar',
	'FreshXFaithless.zip',
])

function req(url, method = 'HEAD') {
	return new Promise((resolve) => {
		const r = https.request(url, {
			method,
			timeout: 12000,
			headers: { 'User-Agent': 'OrionLauncher/probe' },
		}, (res) => {
			resolve({ status: res.statusCode, loc: res.headers.location || '', cl: res.headers['content-length'] || '' })
			r.destroy()
		})
		r.on('error', (e) => resolve({ status: 0, err: e.message }))
		r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'timeout' }) })
		r.end()
	})
}

async function main() {
	const zip = path.join(os.tmpdir(), 'Over Stars-v5.6.zip')
	const tmp = path.join(os.tmpdir(), 'overstars-man')
	fs.mkdirSync(tmp, { recursive: true })
	const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
	spawnSync(tar, ['-xf', zip, '-C', tmp, 'manifest.json'], { windowsHide: true })
	const man = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))

	for (const entry of man.files || []) {
		const info = await catalog.getCfFile(entry.projectID, entry.fileID, '')
		if (!info || !BLOCKED.has(info.fileName)) continue
		const urls = catalog.cfDownloadCandidates(info.modId, info.id, info.fileName, '', { includeMirrors: true })
		const first = urls[0]
		const st = await req(first, 'GET')
		let follow = null
		if (st.status >= 300 && st.status < 400 && st.loc) follow = await req(new URL(st.loc, first).toString(), 'GET')
		console.log(JSON.stringify({
			name: info.fileName,
			downloadUrl: info.downloadUrl,
			cdn: first,
			status: st.status,
			loc: st.loc,
			follow: follow && follow.status,
			followCl: follow && follow.cl,
		}))
	}
}

main().catch((e) => { console.error(e); process.exit(1) })
