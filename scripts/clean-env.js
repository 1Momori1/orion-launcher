const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const mode = (process.argv.includes('--no-admin') || process.env.ORION_NO_SYMLINK === '1')
	? 'no-admin'
	: 'clean'

const root = process.argv.includes('--root')
	? process.argv[process.argv.indexOf('--root') + 1]
	: path.join(os.tmpdir(), 'orion-clean-env')

function wipe(dir) {
	fs.rmSync(dir, { recursive: true, force: true })
	fs.mkdirSync(path.join(dir, 'games'), { recursive: true })
	fs.mkdirSync(path.join(dir, 'versions'), { recursive: true })
	fs.mkdirSync(path.join(dir, 'cache'), { recursive: true })
	fs.mkdirSync(path.join(dir, 'libraries'), { recursive: true })
}

wipe(root)
for (const leftover of ['.part', 'ignoreList']) {
	const probe = path.join(root, leftover)
	if (fs.existsSync(probe)) fs.rmSync(probe, { recursive: true, force: true })
}

const env = {
	...process.env,
	ORION_DATA_ROOT: root,
	ORION_CLEAN_ENV: '1',
}
if (mode === 'no-admin') env.ORION_NO_SYMLINK = '1'

console.log(JSON.stringify({
	root,
	mode,
	noSymlink: env.ORION_NO_SYMLINK === '1',
	note: mode === 'no-admin'
		? 'Симуляция Windows без прав администратора и без Developer Mode: только copy, без hardlink/symlink.'
		: 'Пустой каталог без профилей, .part и правок ignoreList.',
}, null, 2))

if (process.argv.includes('--test')) {
		const r = spawnSync(process.execPath, ['scripts/run-tests.js'], {
		cwd: path.join(__dirname, '..'),
		env,
		stdio: 'inherit',
	})
	process.exit(r.status || 0)
}
