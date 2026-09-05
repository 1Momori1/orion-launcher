const fs = require('fs')
const path = require('path')
const { runPool, hashFile, SpeedMeter } = require('./net')
const { downloadWithRetryMirrored } = require('./mirrors')

const CDN = 'https://resources.download.minecraft.net'
const CONCURRENCY = 16

function objectPath(assetObjectsDir, hash) {
	return path.join(assetObjectsDir, hash.slice(0, 2), hash)
}

function planAssets(dataPaths, indexName) {
	const indexPath = path.join(dataPaths.assetIndexes, `${indexName}.json`)
	if (!fs.existsSync(indexPath)) {
		throw new Error(`Индекс ассетов ${indexName}.json не найден — сначала нужно скачать runtime`)
	}
	const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
	const objects = index.objects || {}

	const missing = []
	let totalBytes = 0
	let haveBytes = 0
	for (const name of Object.keys(objects)) {
		const { hash, size } = objects[name]
		totalBytes += size
		const dest = objectPath(dataPaths.assetObjects, hash)
		let ok = false
		try { ok = fs.statSync(dest).size === size } catch (e) { ok = false }
		if (ok) haveBytes += size
		else missing.push({ name, hash, size })
	}

	return {
		indexName,
		total: Object.keys(objects).length,
		missing,
		missingBytes: missing.reduce((s, o) => s + o.size, 0),
		totalBytes,
		haveBytes,
	}
}

async function downloadAssets(dataPaths, indexName, onProgress, signal) {
	const plan = planAssets(dataPaths, indexName)
	if (!plan.missing.length) return { downloaded: 0, ...plan }

	const meter = new SpeedMeter()
	let doneFiles = 0
	let doneBytes = 0
	let lastReport = 0

	const report = (force = false) => {
		const now = Date.now()
		if (!force && now - lastReport < 400) return
		lastReport = now
		const bps = meter.bps
		const remaining = plan.missingBytes - doneBytes
		if (onProgress) {
			onProgress({
				stage: 'assets',
				current: doneFiles,
				total: plan.missing.length,
				bytesDone: doneBytes,
				bytesTotal: plan.missingBytes,
				percent: plan.missingBytes ? Math.min(100, (doneBytes / plan.missingBytes) * 100) : 100,
				bps,
				etaSec: bps > 1024 ? Math.round(remaining / bps) : null,
			})
		}
	}

	await runPool(plan.missing, CONCURRENCY, async (obj) => {
		const dest = objectPath(dataPaths.assetObjects, obj.hash)
		const url = `${CDN}/${obj.hash.slice(0, 2)}/${obj.hash}`
		await downloadWithRetryMirrored(url, dest, {
			expectedSize: obj.size,
			signal,
			resume: false, // объекты мелкие, проще перекачать целиком
			onChunk: (n) => { meter.add(n); doneBytes += n; report() },
		})
		doneFiles++
		report()
	}, { signal })

	report(true)
	return { downloaded: plan.missing.length, ...plan }
}

module.exports = { planAssets, downloadAssets, objectPath }
