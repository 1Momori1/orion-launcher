const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const validate = require('../src/main/installvalidate')

test('манифест модов: отсутствует файл и неверный хеш', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-mods-'))
	const good = crypto.randomBytes(128)
	fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
	fs.writeFileSync(path.join(dir, 'mods', 'ok.jar'), good)
	const sha1 = crypto.createHash('sha1').update(good).digest('hex')
	const man = {
		files: [
			{ path: 'mods/ok.jar', size: good.length, sha1 },
			{ path: 'mods/missing.jar', size: 10, sha1: 'aa' },
		],
	}
	const r = await validate.validateInstanceFiles(dir, man)
	assert.equal(r.ok, false)
	assert.ok(r.issues.some((i) => i.code === 'missing-mod'))
	fs.rmSync(dir, { recursive: true, force: true })
})

test('манифест модов: верный размер и sha1', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-mods-'))
	const good = crypto.randomBytes(256)
	fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
	fs.writeFileSync(path.join(dir, 'mods', 'ok.jar'), good)
	const sha1 = crypto.createHash('sha1').update(good).digest('hex')
	validate.writeFileManifest(dir, [{ path: 'mods/ok.jar', size: good.length, hashes: { sha1 } }])
	const r = await validate.validateInstanceFiles(dir, validate.readFileManifest(dir))
	assert.equal(r.ok, true, JSON.stringify(r.issues))
	assert.equal(r.hashed, 1)
	fs.rmSync(dir, { recursive: true, force: true })
})
