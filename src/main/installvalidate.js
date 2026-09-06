const fs = require('fs')
const path = require('path')
const { hashFile } = require('./net')
const { isFatJar } = require('./fsutil')

const FILES_NAME = 'orion-files.json'

class PreflightError extends Error {
	constructor(message, issues = []) {
		super(message)
		this.name = 'PreflightError'
		this.issues = issues
		this.preflight = true
	}
}

function versionJsonPath(versionsDir, id) {
	return path.join(versionsDir, id, id + '.json')
}

function readVersionProfile(versionsDir, versionId) {
	const p = versionJsonPath(versionsDir, versionId)
	if (!fs.existsSync(p)) return null
	try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

function jvmStrings(profile) {
	const jvm = (profile && profile.arguments && profile.arguments.jvm) || []
	const out = []
	for (const item of jvm) {
		if (typeof item === 'string') out.push(item)
		else if (item && typeof item.value === 'string') out.push(item.value)
		else if (item && Array.isArray(item.value)) out.push(...item.value)
	}
	return out
}

function ignoreListFromProfile(profile) {
	for (const a of jvmStrings(profile)) {
		if (String(a).startsWith('-DignoreList=')) {
			return String(a).slice('-DignoreList='.length).split(',').map((s) => s.trim()).filter(Boolean)
		}
	}
	return []
}

function expectedClientJarName(profile) {
	const id = String((profile && profile.id) || '').trim()
	if (!id) return null
	return id + '.jar'
}

function resolvedIgnoreList(profile) {
	const id = String((profile && profile.id) || '').trim()
	return ignoreListFromProfile(profile).map((item) => item.replace(/\$\{version_name\}/g, id))
}

function ignoreListCovers(ignoreItems, jarName) {
	const base = path.basename(jarName)
	return ignoreItems.some((item) => item === base || (item && !item.includes('${') && base.startsWith(item)))
}

function forgeLayoutReport(dataPaths, versionId, mcVersion) {
	const profile = readVersionProfile(dataPaths.versions, versionId)
	const issues = []
	if (!profile) {
		issues.push({
			code: 'no-profile',
			message: `Нет профиля версии ${versionId} (version.json).`,
		})
		return { ok: false, issues, profile: null, expectedJar: null, actualJar: null, ignoreList: [] }
	}
	const expectedJar = expectedClientJarName(profile)
	const expectedPath = expectedJar
		? path.join(dataPaths.versions, profile.id, expectedJar)
		: null
	const vanillaPath = mcVersion
		? path.join(dataPaths.versions, mcVersion, mcVersion + '.jar')
		: null
	const ignoreList = resolvedIgnoreList(profile)
	const hasExpected = expectedPath && isFatJar(expectedPath)
	const hasVanilla = vanillaPath && isFatJar(vanillaPath)
	const actualJar = hasExpected ? expectedPath : (hasVanilla ? vanillaPath : null)
	const actualName = actualJar ? path.basename(actualJar) : null

	if (!expectedJar) {
		issues.push({ code: 'no-id', message: 'В version.json нет поля id — нельзя понять имя клиента, которое ждёт Forge.' })
	}
	if (expectedPath && !hasExpected && hasVanilla) {
		issues.push({
			code: 'wrong-jar-name',
			message: `Forge ждёт ${expectedJar} (из version.json id=${profile.id}), на диске есть только ${path.basename(vanillaPath)}. Сырой ${path.basename(vanillaPath)} на classpath даёт модуль _1._20._1 и ломает запуск.`,
			expected: expectedJar,
			actual: path.basename(vanillaPath),
		})
	}
	if (!hasExpected && !hasVanilla) {
		issues.push({
			code: 'no-client-jar',
			message: `Нет клиента Minecraft: ни ${expectedJar || '(имя из профиля)'}, ни ${mcVersion ? mcVersion + '.jar' : 'ванильный jar'}.`,
		})
	}
	if (actualName && ignoreList.length && !ignoreListCovers(ignoreList, actualName)) {
		issues.push({
			code: 'ignore-mismatch',
			message: `ignoreList не покрывает ${actualName}. Сейчас: ${ignoreList.join(', ')}. Forge подхватит jar как отдельный JPMS-модуль.`,
			expected: expectedJar,
			actual: actualName,
			ignoreList,
		})
	}
	return {
		ok: issues.length === 0,
		issues,
		profile,
		versionId: profile.id,
		expectedJar,
		expectedPath,
		actualJar,
		actualName,
		ignoreList,
		hasExpected,
		hasVanilla,
	}
}

function writeFileManifest(instanceDir, files) {
	const list = (files || []).map((f) => ({
		path: f.path,
		size: f.size || 0,
		sha1: (f.hashes && f.hashes.sha1) || null,
		sha512: (f.hashes && f.hashes.sha512) || null,
	}))
	const dest = path.join(instanceDir, FILES_NAME)
	fs.writeFileSync(dest, JSON.stringify({ files: list, writtenAt: new Date().toISOString() }, null, 2))
	return dest
}

function readFileManifest(instanceDir) {
	const p = path.join(instanceDir, FILES_NAME)
	if (!fs.existsSync(p)) return null
	try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

async function validateInstanceFiles(instanceDir, manifest) {
	const issues = []
	const files = (manifest && manifest.files) || []
	let checked = 0
	let hashed = 0
	for (const f of files) {
		if (!f.path) continue
		const full = path.join(instanceDir, f.path)
		checked++
		if (!fs.existsSync(full)) {
			issues.push({ code: 'missing-mod', message: `Нет файла из манифеста: ${f.path}` })
			continue
		}
		if (f.size && fs.statSync(full).size !== f.size) {
			issues.push({ code: 'size-mismatch', message: `Неверный размер: ${f.path}` })
			continue
		}
		if (f.sha1) {
			hashed++
			const actual = await hashFile(full, 'sha1')
			if (actual !== String(f.sha1).toLowerCase()) {
				issues.push({ code: 'hash-mismatch', message: `Неверный SHA1: ${f.path}` })
			}
		} else if (f.sha512) {
			hashed++
			const actual = await hashFile(full, 'sha512')
			if (actual !== String(f.sha512).toLowerCase()) {
				issues.push({ code: 'hash-mismatch', message: `Неверный SHA512: ${f.path}` })
			}
		}
	}
	return { ok: issues.length === 0, issues, checked, hashed }
}

function formatIssues(issues) {
	if (!issues.length) return ''
	return issues.map((i) => i.message).join('\n')
}

function preflightError(issues) {
	const text = formatIssues(issues)
	return new PreflightError(
		'Orion не запускает Forge: сначала нужно починить установку.\n' + text,
		issues,
	)
}

async function validateInstall({ dataPaths, instanceDir, versionId, minecraft, files }) {
	const layout = forgeLayoutReport(dataPaths, versionId, minecraft)
	let fileReport = { ok: true, issues: [], checked: 0, hashed: 0 }
	if (files && files.length) {
		writeFileManifest(instanceDir, files)
		fileReport = await validateInstanceFiles(instanceDir, { files: files.map((f) => ({
			path: f.path,
			size: f.size || 0,
			sha1: f.hashes && f.hashes.sha1,
			sha512: f.hashes && f.hashes.sha512,
		})) })
	}
	const issues = [...layout.issues, ...fileReport.issues]
	return { ok: issues.length === 0, issues, layout, fileReport }
}

async function preflightLaunch(dataPaths, meta, instanceDir) {
	const versionId = meta && meta.versionId
	const minecraft = meta && meta.minecraft
	const layout = forgeLayoutReport(dataPaths, versionId, minecraft)
	const issues = [...layout.issues]
	const man = readFileManifest(instanceDir)
	let fileReport = null
	if (man && man.files && man.files.length) {
		fileReport = await validateInstanceFiles(instanceDir, man)
		issues.push(...fileReport.issues)
	}
	if (issues.length) throw preflightError(issues)
	return { ok: true, layout, fileReport }
}

module.exports = {
	FILES_NAME,
	PreflightError,
	versionJsonPath,
	readVersionProfile,
	ignoreListFromProfile,
	expectedClientJarName,
	resolvedIgnoreList,
	ignoreListCovers,
	forgeLayoutReport,
	writeFileManifest,
	readFileManifest,
	validateInstanceFiles,
	validateInstall,
	preflightLaunch,
	formatIssues,
}
