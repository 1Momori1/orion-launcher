const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { findJava } = require('./java')

// Тот же алгоритм, что у Minecraft в offline-режиме:
// UUID v3 от строки "OfflinePlayer:<ник>"
function offlineUUID(username) {
	const md5 = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
	md5[6] = (md5[6] & 0x0f) | 0x30
	md5[8] = (md5[8] & 0x3f) | 0x80
	const h = md5.toString('hex')
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/

function validateNickname(name) {
	if (!name) return 'Введите ник'
	if (!NICK_RE.test(name)) return 'Ник: 3–16 символов, только латиница, цифры и _'
	return null
}

class Launcher {
	constructor(dataPaths) {
		this.paths = dataPaths
		this.current = null // { proc, modpack, username, startedAt }
	}

	setPaths(p) { this.paths = p }
	get isRunning() { return !!(this.current && this.current.proc && this.current.proc.exitCode === null) }

	instanceDir(name) { return path.join(this.paths.games, name) }

	readCatalogMeta(name) {
		const { readMeta } = require('./mclaunch')
		return readMeta(this.instanceDir(name))
	}

	// Готовит аргументы из шаблона сборки
	buildArgs(modpackName, { username, memoryMB, width, height }) {
		const dir = this.instanceDir(modpackName)
		const tplPath = path.join(dir, 'launch_args.template.txt')
		if (!fs.existsSync(tplPath)) {
			throw new Error('В сборке нет launch_args.template.txt — переустановите сборку')
		}

		const subs = {
			INSTANCE: dir,
			MC_ROOT: this.paths.root,
			USERNAME: username,
			UUID: offlineUUID(username),
			ACCESS_TOKEN: '0',
			WIDTH: String(width || 1280),
			HEIGHT: String(height || 720),
			MEMORY: String(memoryMB || 6144),
		}

		const raw = fs.readFileSync(tplPath, 'utf8')
		const args = raw.split(/\r?\n/)
			.map(l => l.replace(/\$\{(\w+)\}/g, (m, k) => (k in subs ? subs[k] : m)))
			.filter(l => l.length > 0)

		const unresolved = args.filter(a => /\$\{\w+\}/.test(a))
		if (unresolved.length) {
			throw new Error(`В шаблоне запуска остались неизвестные переменные: ${unresolved.join(', ').slice(0, 200)}`)
		}
		return args
	}

	// Проверки перед стартом, чтобы не ловить непонятный краш
	preflight(modpackName) {
		const dir = this.instanceDir(modpackName)
		const problems = []
		if (!fs.existsSync(dir)) problems.push('Сборка не установлена')
		if (!fs.existsSync(path.join(dir, 'launch_args.template.txt'))) problems.push('Нет файла запуска — переустановите сборку')
		if (!fs.existsSync(path.join(dir, 'mods'))) problems.push('Нет папки mods')
		if (!fs.existsSync(path.join(dir, 'natives'))) problems.push('Нет папки natives')
		if (!fs.existsSync(this.paths.libraries)) problems.push('Не скачаны библиотеки Forge')
		if (!fs.existsSync(path.join(this.paths.assetIndexes, '5.json'))) problems.push('Нет индекса ресурсов')
		return problems
	}

	async launch(modpackName, opts, onEvent) {
		if (this.isRunning) return { error: 'Игра уже запущена' }

		const nickError = validateNickname(opts.username)
		if (nickError) return { error: nickError }

		const { ensureSkinLoader } = require('./skinsync')
		ensureSkinLoader(this.instanceDir(modpackName), opts.serverUrl, this.paths.games)

		const catalogMeta = this.readCatalogMeta(modpackName)
		if (catalogMeta) {
			const { launchCatalog } = require('./mclaunch')
			return launchCatalog(this, { ...catalogMeta, id: modpackName }, opts, onEvent)
		}

		const problems = this.preflight(modpackName)
		if (problems.length) return { error: problems.join('. ') }

		const java = await findJava(this.paths, opts.javaPath)
		if (!java) return { error: 'Java 17 не найдена. Нажмите «Установить Java» в настройках.' }

		let args
		try { args = this.buildArgs(modpackName, opts) }
		catch (e) { return { error: e.message } }
		try {
			const { appendJoinArgs } = require('./mclaunch')
			appendJoinArgs(args, opts)
		} catch (_) { /* skip */ }

		const dir = this.instanceDir(modpackName)
		fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
		const logPath = path.join(dir, 'logs', 'orion-latest.log')
		const logStream = fs.createWriteStream(logPath, { flags: 'w' })
		logStream.write(`[orion] java: ${java.path} (${java.raw})\n[orion] ник: ${opts.username}\n\n`)

		onEvent({ stage: 'starting', java: java.path })

		const proc = spawn(java.path, args, { cwd: dir, windowsHide: false })
		this.current = { proc, modpack: modpackName, username: opts.username, startedAt: Date.now() }

		// Последние строки нужны, чтобы показать причину падения
		const tail = []
		const keepTail = (buf) => {
			const text = buf.toString()
			logStream.write(text)
			for (const line of text.split('\n')) {
				if (line.trim()) tail.push(line.trim())
			}
			while (tail.length > 40) tail.shift()
		}
		proc.stdout.on('data', keepTail)
		proc.stderr.on('data', keepTail)

		// Окно игры появляется не сразу — сообщаем, что процесс жив
		let windowTimer = setTimeout(() => {
			if (this.isRunning) onEvent({ stage: 'running', pid: proc.pid })
		}, 4000)

		proc.on('error', (err) => {
			clearTimeout(windowTimer)
			logStream.end()
			this.current = null
			onEvent({ stage: 'error', error: `Не удалось запустить Java: ${err.message}` })
		})

		proc.on('exit', (code) => {
			clearTimeout(windowTimer)
			logStream.end()
			const elapsed = Date.now() - (this.current ? this.current.startedAt : Date.now())
			this.current = null
			if (code === 0) {
				onEvent({ stage: 'exited', code, elapsed })
			} else {
				onEvent({
					stage: 'crashed',
					code,
					elapsed,
					logPath,
					tail: tail.slice(-15),
					hint: elapsed < 20000
						? 'Игра закрылась сразу — обычно это нехватка памяти или повреждённые файлы сборки.'
						: null,
				})
			}
		})

		return { success: true, pid: proc.pid, java: java.path, logPath }
	}

	stop() {
		if (this.current && this.current.proc) {
			this.current.proc.kill()
			return true
		}
		return false
	}
}

module.exports = { Launcher, offlineUUID, validateNickname }
