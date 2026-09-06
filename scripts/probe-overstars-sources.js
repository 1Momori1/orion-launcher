const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const { spawnSync } = require('child_process')
const catalog = require('../src/main/catalog')
const { candidates } = require('../src/main/mirrors')
const { downloadFile } = require('../src/main/net')

function headOrGet(url, method, extraHeaders = {}) {
	return new Promise((resolve) => {
		const req = https.request(url, {
			method,
			timeout: 15000,
			headers: { 'User-Agent': 'OrionLauncher/probe', ...extraHeaders },
		}, (res) => {
			resolve({ status: res.statusCode, cl: res.headers['content-length'] || '', cr: res.headers['content-range'] || '' })
			req.destroy()
		})
		req.on('error', (e) => resolve({ status: 0, err: e.message }))
		req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }) })
		req.end()
	})
}

function hostOf(u) {
	try { return new URL(u).host } catch (e) { return '?' }
}

async function main() {
	const names = ['Over Stars-v5.6.zip', 'Foo+Bar.jar', 'A&B#C.jar', 'Мод (dev).jar']
	console.log('encodeCfSeg samples:')
	for (const n of names) {
		const urls = catalog.cfDownloadCandidates(1, 7617489, n, '')
		console.log(' ', n, '→', urls[0])
	}

	const constructed = catalog.cfDownloadCandidates(1250591, 7617489, 'Over Stars-v5.6.zip', '')
	console.log('CDN-first order:', constructed.map(hostOf))
	console.log('candidates(edge) first:', candidates(constructed[0]).map(hostOf))

	const edge = constructed[0]
	const full = await headOrGet(edge, 'GET')
	const ranged = await headOrGet(edge, 'GET', { Range: 'bytes=0-2047' })
	console.log('GET full', full)
	console.log('GET Range 0-2047', ranged)

	const zip = path.join(os.tmpdir(), 'Over Stars-v5.6.zip')
	const part = zip + '.part'
	const info = await catalog.getCfFile(1250591, 7617489, '')
	console.log('pack', info.fileName, info.fileLength, info.downloadUrl, 'sha1', (info.hashes || []).find((h) => Number(h.algo) === 1)?.value || '-')
	if (!fs.existsSync(zip) || fs.statSync(zip).size !== info.fileLength) {
		try { fs.unlinkSync(part) } catch (e) {}
		console.log('downloading pack zip via downloadFile')
		await downloadFile(info.downloadUrl || constructed[0], zip, {
			expectedSize: info.fileLength,
			expectedSha1: (info.hashes || []).find((h) => Number(h.algo) === 1)?.value || null,
		})
	}
	console.log('zip ok', fs.statSync(zip).size)

	const tmp = path.join(os.tmpdir(), 'overstars-man')
	fs.rmSync(tmp, { recursive: true, force: true })
	fs.mkdirSync(tmp, { recursive: true })
	const tar = process.platform === 'win32'
		? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
		: 'tar'
	const ex = spawnSync(tar, ['-xf', zip, '-C', tmp, 'manifest.json'], { windowsHide: true })
	if (ex.status !== 0) throw new Error('extract manifest failed: ' + (ex.stderr || '').toString())
	const man = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
	const wanted = (man.files || []).filter((f) => f.required !== false)
	console.log('manifest files', wanted.length)

	const listed = []
	let i = 0
	for (const entry of wanted) {
		const modId = entry.projectID || entry.projectId
		const fileId = entry.fileID || entry.fileId
		let file = null
		try { file = await catalog.getCfFile(modId, fileId, '') } catch (e) {}
		if (file && (file.fileName || file.downloadUrl)) {
			const blocked = !file.downloadUrl
			const urls = blocked
				? []
				: catalog.cfDownloadCandidates(file.modId, file.id, file.fileName, file.downloadUrl)
			listed.push({
				name: file.fileName,
				blocked,
				sha1: (file.hashes || []).some((h) => Number(h.algo) === 1),
				first: urls[0] || '',
				hosts: urls.map(hostOf),
			})
		} else {
			const urls = catalog.cfDownloadCandidates(modId, fileId, '', '')
			listed.push({ name: `${modId}/${fileId}`, blocked: false, sha1: false, first: urls[0] || '', hosts: urls.map(hostOf) })
		}
		i++
		if (i % 40 === 0) console.log('resolved', i, '/', wanted.length)
	}

	const blocked = listed.filter((x) => x.blocked)
	const firstHosts = {}
	const secondHosts = {}
	for (const x of listed) {
		firstHosts[hostOf(x.first) || '(none)'] = (firstHosts[hostOf(x.first) || '(none)'] || 0) + 1
		if (x.hosts[1]) secondHosts[x.hosts[1]] = (secondHosts[x.hosts[1]] || 0) + 1
	}
	console.log('first-url hosts', firstHosts)
	console.log('second-url hosts', secondHosts)
	console.log('blocked (no official downloadUrl)', blocked.length)
	if (blocked.length) console.log('blocked names', blocked.map((x) => x.name))
	console.log('with sha1', listed.filter((x) => x.sha1).length, '/', listed.length)

	const special = listed.filter((x) => /[+&#()А-Яа-яЁё ]/.test(x.name || ''))
	console.log('names needing encode', special.length)
	for (const x of special.slice(0, 8)) console.log(' ', x.name, '→', x.first)

	const sample = listed.filter((x) => x.first).slice(0, 15)
	for (const x of sample) {
		const st = await headOrGet(x.first, 'HEAD')
		console.log('HEAD', st.status, hostOf(x.first), x.name)
	}
}

main().catch((e) => { console.error(e); process.exit(1) })
