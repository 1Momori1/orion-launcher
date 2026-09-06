const https = require('https')
const http = require('http')

function req(url, method = 'HEAD') {
	return new Promise((resolve) => {
		const lib = url.startsWith('https') ? https : http
		const r = lib.request(url, { method, timeout: 15000, headers: { 'User-Agent': 'OrionLauncher/probe' } }, (res) => {
			res.resume()
			resolve({ url, status: res.statusCode, loc: res.headers.location || '', cl: res.headers['content-length'] || '' })
		})
		r.on('error', (e) => resolve({ url, error: e.message }))
		r.on('timeout', () => { r.destroy(); resolve({ url, error: 'timeout' }) })
		r.end()
	})
}

function getJson(url) {
	return new Promise((resolve, reject) => {
		https.get(url, { headers: { 'User-Agent': 'OrionLauncher/probe', Accept: 'application/json' }, timeout: 20000 }, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => {
				const t = Buffer.concat(chunks).toString('utf8')
				try { resolve({ status: res.statusCode, json: JSON.parse(t) }) } catch (e) { resolve({ status: res.statusCode, text: t.slice(0, 200) }) }
			})
		}).on('error', reject)
	})
}

async function main() {
	const file = await getJson('https://mod.mcimirror.top/curseforge/v1/mods/1250591/files/7617489')
	const d = (file.json && file.json.data) || file.json || {}
	console.log('pack file', file.status, d.fileName, d.fileLength, d.downloadUrl)

	const packUrls = [
		d.downloadUrl,
		'https://mod.mcimirror.top/curseforge/v1/mods/1250591/files/7617489/download',
		'https://api.curse.tools/v1/cf/mods/1250591/files/7617489/download',
	].filter(Boolean)
	for (const u of packUrls) console.log('PACK', await req(u))

	const files = await getJson('https://mod.mcimirror.top/curseforge/v1/mods/1250591/files/7617489')
	console.log('keys', Object.keys(d))

	// typical first mods from over stars — fetch file list via search if possible
	const dl = 'https://mod.mcimirror.top/curseforge/v1/mods/1250591/files/7617489/download'
	console.log('GET-like HEAD download', await req(dl, 'GET'))
}

main().catch((e) => { console.error(e); process.exit(1) })
