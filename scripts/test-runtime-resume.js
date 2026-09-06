const fs = require('fs')
const os = require('os')
const path = require('path')
const { downloadFile, fetchJson, hashFile } = require('../src/main/net')

const BASE = process.argv[2]
if (!BASE) {
	console.error('usage: node scripts/test-runtime-resume.js <server-url>')
	process.exit(1)
}
const dest = path.join(os.tmpdir(), 'orion-runtime-resume-test.zip')

async function main() {
	const info = await fetchJson(`${BASE}/api/modpacks/_runtime/archive/info`)
	const url = `${BASE}/api/modpacks/_runtime/archive`
	const expected = String(info.sha256).toLowerCase()
	console.log('info', info.size, expected)

	for (const p of [dest, dest + '.part']) {
		try { fs.unlinkSync(p) } catch (e) {}
	}

	console.log('full download')
	await downloadFile(url, dest, { expectedSize: info.size, expectedSha256: expected })
	const fullHash = await hashFile(dest, 'sha256')
	if (fullHash !== expected) throw new Error('full hash mismatch: ' + fullHash)
	console.log('full ok', fs.statSync(dest).size)

	const slice = 40 * 1024 * 1024
	const buf = Buffer.alloc(slice)
	const fd = fs.openSync(dest, 'r')
	fs.readSync(fd, buf, 0, slice, 0)
	fs.closeSync(fd)
	fs.unlinkSync(dest)
	fs.writeFileSync(dest + '.part', buf)
	console.log('simulated kill at', slice, 'part', fs.statSync(dest + '.part').size)

	console.log('resume')
	await downloadFile(url, dest, { expectedSize: info.size, expectedSha256: expected, resume: true })
	const resumeHash = await hashFile(dest, 'sha256')
	if (resumeHash !== expected) throw new Error('resume hash mismatch: ' + resumeHash)
	if (fs.statSync(dest).size !== info.size) throw new Error('resume size mismatch')
	console.log('resume ok', fs.statSync(dest).size, resumeHash)

	fs.unlinkSync(dest)
	console.log('PASS')
}

main().catch((e) => {
	console.error('FAIL', e)
	process.exit(1)
})
