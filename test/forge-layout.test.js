const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const validate = require('../src/main/installvalidate')
const { resolveClientJar } = require('../src/main/mclaunch')

const FIXTURE = path.join(__dirname, 'fixtures', '1.20.1-forge-47.4.16.json')

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'orion-forge-'))
}

function writeProfile(root, id, src) {
	const dir = path.join(root, 'versions', id)
	fs.mkdirSync(dir, { recursive: true })
	fs.copyFileSync(src, path.join(dir, id + '.json'))
}

function writeJar(p, bytes = 4096) {
	fs.mkdirSync(path.dirname(p), { recursive: true })
	fs.writeFileSync(p, Buffer.alloc(bytes, 1))
}

test('47.4.16: имя клиента берётся из version.json id, не из шаблона MC+forge', () => {
	const profile = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
	assert.equal(validate.expectedClientJarName(profile), '1.20.1-forge-47.4.16.jar')
	const ignore = validate.resolvedIgnoreList(profile)
	assert.ok(ignore.includes('1.20.1-forge-47.4.16.jar'))
	assert.equal(ignore.some((x) => x.includes('${version_name}')), false)
})

test('47.4.16: ванильный 1.20.1.jar на диске без forge-имени — ошибка раскладки', () => {
	const root = tmpRoot()
	const dataPaths = { versions: path.join(root, 'versions') }
	writeProfile(root, '1.20.1-forge-47.4.16', FIXTURE)
	writeJar(path.join(root, 'versions', '1.20.1', '1.20.1.jar'))
	const report = validate.forgeLayoutReport(dataPaths, '1.20.1-forge-47.4.16', '1.20.1')
	assert.equal(report.ok, false)
	assert.ok(report.issues.some((i) => i.code === 'wrong-jar-name' || i.code === 'ignore-mismatch'))
	assert.equal(report.expectedJar, '1.20.1-forge-47.4.16.jar')
	assert.equal(report.actualName, '1.20.1.jar')
	fs.rmSync(root, { recursive: true, force: true })
})

test('47.4.16: resolveClientJar копирует клиент под имя из профиля', () => {
	const root = tmpRoot()
	const dataPaths = { versions: path.join(root, 'versions') }
	writeProfile(root, '1.20.1-forge-47.4.16', FIXTURE)
	writeJar(path.join(root, 'versions', '1.20.1', '1.20.1.jar'), 8000)
	const resolved = resolveClientJar({ id: '1.20.1-forge-47.4.16' }, dataPaths, '1.20.1')
	assert.equal(path.basename(resolved.path), '1.20.1-forge-47.4.16.jar')
	assert.ok(fs.existsSync(path.join(root, 'versions', '1.20.1-forge-47.4.16', '1.20.1-forge-47.4.16.jar')))
	const report = validate.forgeLayoutReport(dataPaths, '1.20.1-forge-47.4.16', '1.20.1')
	assert.equal(report.ok, true, JSON.stringify(report.issues))
	fs.rmSync(root, { recursive: true, force: true })
})

test('ORION_NO_SYMLINK копирует, а не линкует', () => {
	const prev = process.env.ORION_NO_SYMLINK
	process.env.ORION_NO_SYMLINK = '1'
	const root = tmpRoot()
	const dataPaths = { versions: path.join(root, 'versions') }
	writeProfile(root, '1.20.1-forge-47.4.16', FIXTURE)
	writeJar(path.join(root, 'versions', '1.20.1', '1.20.1.jar'), 8000)
	const resolved = resolveClientJar({ id: '1.20.1-forge-47.4.16' }, dataPaths, '1.20.1')
	assert.equal(resolved.method, 'copy')
	assert.ok(fs.existsSync(resolved.path))
	fs.rmSync(root, { recursive: true, force: true })
	if (prev == null) delete process.env.ORION_NO_SYMLINK
	else process.env.ORION_NO_SYMLINK = prev
})

test('preflight падает с текстом Orion, не Forge', async () => {
	const root = tmpRoot()
	const dataPaths = { versions: path.join(root, 'versions') }
	const instance = path.join(root, 'instance')
	fs.mkdirSync(instance, { recursive: true })
	writeProfile(root, '1.20.1-forge-47.4.16', FIXTURE)
	writeJar(path.join(root, 'versions', '1.20.1', '1.20.1.jar'))
	await assert.rejects(
		() => validate.preflightLaunch(dataPaths, { versionId: '1.20.1-forge-47.4.16', minecraft: '1.20.1' }, instance),
		(e) => e.preflight && /Orion не запускает Forge/.test(e.message) && /1\.20\.1-forge-47\.4\.16\.jar/.test(e.message),
	)
	fs.rmSync(root, { recursive: true, force: true })
})
