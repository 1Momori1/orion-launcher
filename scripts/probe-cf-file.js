const catalog = require('../src/main/catalog')

async function main() {
	const info = await catalog.getCfFile(238222, 5816234, '') // JEI-ish sample if ids wrong, fallback below
	console.log('sample', info && { id: info.id, fileName: info.fileName, downloadUrl: info.downloadUrl, len: info.fileLength })
	const pack = await catalog.getCfFile(1250591, 7617489, '')
	console.log('pack', pack && { fileName: pack.fileName, downloadUrl: pack.downloadUrl })
	const listed = {
		urls: catalog.cfDownloadCandidates(pack.modId, pack.id, pack.fileName, pack.downloadUrl),
	}
	console.log('pack urls', listed.urls)
}

main().catch((e) => { console.error(e); process.exit(1) })
