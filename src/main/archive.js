const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

function tarBinary() {
	if (process.platform === 'win32') {
		const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
		return fs.existsSync(sys) ? sys : 'tar'
	}
	return 'tar'
}

function extractZip(zipPath, dest, { onEntry = null, signal = null } = {}) {
	return new Promise((resolve, reject) => {
		fs.mkdirSync(dest, { recursive: true })
		const args = ['-xvf', zipPath, '-C', dest]
		const proc = spawn(tarBinary(), args, { windowsHide: true })

		let count = 0
		let stderrTail = ''
		// bsdtar печатает список распакованного в stderr
		let buf = ''
		const onData = (chunk) => {
			buf += chunk.toString()
			const lines = buf.split('\n')
			buf = lines.pop()
			for (const line of lines) {
				const t = line.trim()
				if (!t) continue
				if (t.startsWith('x ')) {
					count++
					if (onEntry) onEntry(t.slice(2), count)
				} else {
					stderrTail = (stderrTail + '\n' + t).slice(-2000)
				}
			}
		}
		proc.stderr.on('data', onData)
		proc.stdout.on('data', onData)

		let killed = false
		const cancelCheck = signal ? setInterval(() => {
			if (signal.cancelled && !killed) { killed = true; proc.kill() }
		}, 500) : null

		proc.on('error', (e) => {
			if (cancelCheck) clearInterval(cancelCheck)
			reject(new Error(`Не удалось запустить распаковку: ${e.message}`))
		})
		proc.on('close', (code) => {
			if (cancelCheck) clearInterval(cancelCheck)
			if (killed) return reject(Object.assign(new Error('Отменено пользователем'), { cancelled: true }))
			if (code !== 0) return reject(new Error(`Распаковка завершилась с кодом ${code}. ${stderrTail}`))
			resolve(count)
		})
	})
}

module.exports = { extractZip }
