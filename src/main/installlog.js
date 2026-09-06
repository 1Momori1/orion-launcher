const fs = require('fs')
const path = require('path')

function logPath(instanceDir, name = 'orion-install.log') {
	return path.join(instanceDir, 'logs', name)
}

function openLog(instanceDir, name = 'orion-install.log') {
	const file = logPath(instanceDir, name)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const stream = fs.createWriteStream(file, { flags: 'a' })
	const write = (event, extra = {}) => {
		const row = {
			t: new Date().toISOString(),
			event,
			...extra,
		}
		const line = JSON.stringify(row)
		try { stream.write(line + '\n') } catch (e) { /* ignore */ }
		return row
	}
	return {
		file,
		write,
		close() { try { stream.end() } catch (e) { /* ignore */ } },
	}
}

function appendLaunchLog(file, text) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.appendFileSync(file, text)
	} catch (e) { /* ignore */ }
}

module.exports = { logPath, openLog, appendLaunchLog }
