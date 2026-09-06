const fs = require('fs')
const path = require('path')
const validate = require('../src/main/installvalidate')
const catalog = require('../src/main/catalog')

const packs = [
	{ id: 'os-park', mc: '1.20.1', forge: '47.4.16', versionId: '1.20.1-forge-47.4.16' },
]

function fail(msg) {
	console.error('SMOKE FAIL', msg)
	process.exit(1)
}

for (const pack of packs) {
	const fixture = path.join(__dirname, '..', 'test', 'fixtures', pack.versionId + '.json')
	if (!fs.existsSync(fixture)) fail('нет фикстуры ' + pack.versionId)
	const profile = JSON.parse(fs.readFileSync(fixture, 'utf8'))
	if (validate.expectedClientJarName(profile) !== pack.versionId + '.jar') {
		fail('ожидаемое имя jar не совпало для ' + pack.id)
	}
	const urls = catalog.cfDownloadCandidates(1250591, 7617489, 'Over Stars-v5.6.zip', '')
	if (!urls[0] || !urls[0].includes('edge.forgecdn.net')) fail('CDN не первый для Over Stars')
	console.log('smoke', pack.id, 'ok', validate.expectedClientJarName(profile))
}

console.log('SMOKE PASS')
