const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { downloadWithRetry } = require('./net')
const { extractZip } = require('./archive')

const REQUIRED_MAJOR = 17
const ADOPTIUM = {
	17: 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse',
	21: 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse',
}

function exeName() { return process.platform === 'win32' ? 'java.exe' : 'java' }

function probeJava(javaPath) {
	return new Promise((resolve) => {
		execFile(javaPath, ['-version'], { timeout: 8000 }, (err, stdout, stderr) => {
			const out = `${stdout || ''}${stderr || ''}`
			const m = out.match(/version "(\d+)(?:\.(\d+))?[^"]*"/)
			if (!m) return resolve(null)
			// 1.8.0_xxx -> major 8, 17.0.9 -> major 17
			const major = m[1] === '1' ? parseInt(m[2] || '0', 10) : parseInt(m[1], 10)
			resolve({ path: javaPath, major, raw: out.split('\n')[0].trim() })
		})
	})
}

function candidatePaths(dataPaths) {
	const list = []

	// 1. Java, которую поставил сам лаунчер
	if (dataPaths) {
		const own = path.join(dataPaths.runtime, 'jre17', 'bin', exeName())
		list.push(own)
		// Adoptium распаковывается в подпапку с версией — заглянем внутрь
		const rt = dataPaths.runtime
		if (fs.existsSync(rt)) {
			for (const d of fs.readdirSync(rt)) {
				list.push(path.join(rt, d, 'bin', exeName()))
			}
		}
	}

	if (process.platform !== 'win32') {
		list.push('/usr/bin/java', '/usr/lib/jvm/default/bin/java')
		return list
	}

	// 2. Стандартные места установки JDK/JRE
	const roots = [
		'C:\\Program Files\\Eclipse Adoptium',
		'C:\\Program Files\\Java',
		'C:\\Program Files\\Microsoft',
		'C:\\Program Files\\Zulu',
		'C:\\Program Files\\BellSoft',
		'C:\\Program Files\\Amazon Corretto',
		'C:\\Program Files (x86)\\Java',
	]
	for (const root of roots) {
		if (!fs.existsSync(root)) continue
		let entries
		try { entries = fs.readdirSync(root) } catch (e) { continue }
		for (const d of entries) list.push(path.join(root, d, 'bin', exeName()))
	}

	// 3. Java от официального лаунчера Minecraft
	const mcRuntimes = [
		path.join(process.env.APPDATA || '', '.minecraft', 'runtime'),
		'C:\\Program Files (x86)\\Minecraft Launcher\\runtime',
		'D:\\Minecraft\\runtime',
	]
	for (const rt of mcRuntimes) {
		if (!fs.existsSync(rt)) continue
		try {
			for (const flavour of fs.readdirSync(rt)) {
				const inner = path.join(rt, flavour)
				if (!fs.statSync(inner).isDirectory()) continue
				for (const arch of fs.readdirSync(inner)) {
					list.push(path.join(inner, arch, 'bin', exeName()))
					// иногда есть ещё уровень с именем пакета
					const deeper = path.join(inner, arch)
					try {
						for (const sub of fs.readdirSync(deeper)) {
							list.push(path.join(deeper, sub, 'bin', exeName()))
						}
					} catch (e) {}
				}
			}
		} catch (e) {}
	}

	// 4. JAVA_HOME и PATH
	if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, 'bin', exeName()))
	list.push(exeName())

	return list
}

async function findJava(dataPaths, preferredPath = '', opts = {}) {
	const minMajor = opts.minMajor || REQUIRED_MAJOR
	const preferMajor = opts.preferMajor != null ? opts.preferMajor : (minMajor <= 17 ? 17 : minMajor)

	if (preferredPath && fs.existsSync(preferredPath)) {
		const info = await probeJava(preferredPath)
		if (info && info.major >= minMajor) {
			if (preferMajor && info.major !== preferMajor) {
				// предпочтительный путь подходит по минимуму — запомним, но поищем лучше
			} else {
				return info
			}
		}
	}

	const seen = new Set()
	const found = []
	for (const c of candidatePaths(dataPaths)) {
		if (seen.has(c)) continue
		seen.add(c)
		if (c !== exeName() && !fs.existsSync(c)) continue
		const info = await probeJava(c)
		if (info && info.major >= minMajor) found.push(info)
	}
	if (preferredPath && fs.existsSync(preferredPath)) {
		const info = await probeJava(preferredPath)
		if (info && info.major >= minMajor && !found.some(f => f.path === info.path)) found.push(info)
	}
	if (!found.length) return null
	found.sort((a, b) => {
		if (a.major === preferMajor && b.major !== preferMajor) return -1
		if (b.major === preferMajor && a.major !== preferMajor) return 1
		return a.major - b.major
	})
	return found[0]
}

async function installJava(dataPaths, onProgress, signal, major = 17) {
	const ver = Number(major) === 21 ? 21 : 17
	const url = ADOPTIUM[ver]
	if (process.platform !== 'win32') {
		throw new Error(`Автоустановка Java поддерживается только на Windows. Установите Java ${ver} вручную.`)
	}
	if (!url) throw new Error('Неизвестная версия Java: ' + ver)
	fs.mkdirSync(dataPaths.runtime, { recursive: true })
	const zipPath = path.join(dataPaths.cache, `jre${ver}.zip`)
	fs.mkdirSync(dataPaths.cache, { recursive: true })

	let got = 0
	await downloadWithRetry(url, zipPath, {
		signal,
		onChunk: (n) => {
			got += n
			if (onProgress) onProgress({ stage: 'java-download', bytes: got })
		},
	})

	if (onProgress) onProgress({ stage: 'java-extract' })

	const target = path.join(dataPaths.runtime, `jre${ver}`)
	fs.rmSync(target, { recursive: true, force: true })
	const tmp = path.join(dataPaths.cache, `jre${ver}-extract`)
	fs.rmSync(tmp, { recursive: true, force: true })
	await extractZip(zipPath, tmp)

	const entries = fs.readdirSync(tmp)
	const inner = entries.length === 1 ? path.join(tmp, entries[0]) : tmp
	fs.renameSync(inner, target)
	fs.rmSync(tmp, { recursive: true, force: true })
	fs.rmSync(zipPath, { force: true })

	const javaPath = path.join(target, 'bin', exeName())
	const info = await probeJava(javaPath)
	if (!info) throw new Error('Java установилась, но не запускается')
	return info
}

module.exports = { findJava, installJava, probeJava, REQUIRED_MAJOR }
