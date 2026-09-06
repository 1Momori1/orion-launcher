const fs = require('fs')
const path = require('path')

function noSymlinkMode() {
	const v = String(process.env.ORION_NO_SYMLINK || '').toLowerCase()
	return v === '1' || v === 'true' || v === 'yes'
}

function isFatJar(p) {
	try { return fs.existsSync(p) && fs.statSync(p).size > 1000 } catch (e) { return false }
}

function linkOrCopy(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true })
	if (noSymlinkMode()) {
		fs.copyFileSync(src, dest)
		return { method: 'copy', reason: 'ORION_NO_SYMLINK' }
	}
	try {
		fs.linkSync(src, dest)
		return { method: 'hardlink' }
	} catch (e) {
		fs.copyFileSync(src, dest)
		return { method: 'copy', reason: e.message || 'link-failed' }
	}
}

function hostOf(url) {
	try { return new URL(String(url)).host } catch (e) { return '' }
}

function sourceKind(url) {
	const h = hostOf(url)
	if (!h) return 'unknown'
	if (/forgecdn\.net$/i.test(h) || h === 'edge.forgecdn.net') return 'cdn'
	if (/mcimirror/i.test(h)) return 'mirror'
	if (/curse\.tools/i.test(h)) return 'fallback'
	if (/modrinth\.com|bmclapi/i.test(h)) return 'mirror'
	return 'other'
}

module.exports = { noSymlinkMode, isFatJar, linkOrCopy, hostOf, sourceKind }
