const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'test')
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.test.js')).map((n) => path.join('test', n))
if (!files.length) {
	console.error('no tests')
	process.exit(1)
}
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: path.join(__dirname, '..'), stdio: 'inherit' })
process.exit(r.status || 0)
