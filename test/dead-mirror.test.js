const test = require('node:test')
const assert = require('node:assert/strict')
const catalog = require('../src/main/catalog')
const { candidates } = require('../src/main/mirrors')

function hosts(urls) {
	return urls.map((u) => { try { return new URL(u).host } catch (e) { return u } })
}

test('CF кандидаты: официальный CDN первым, mcimirror последним', () => {
	const urls = catalog.cfDownloadCandidates(1250591, 7617489, 'Over Stars-v5.6.zip', '')
	const h = hosts(urls)
	assert.equal(h[0], 'edge.forgecdn.net')
	assert.equal(h[h.length - 1], 'mod.mcimirror.top')
	assert.ok(h.indexOf('edge.forgecdn.net') < h.indexOf('mod.mcimirror.top'))
})

test('encodeURIComponent по сегментам: +, &, #, скобки, кириллица', () => {
	const urls = catalog.cfDownloadCandidates(1, 7617489, 'Мод (dev)+A&B#C.jar', '')
	const last = urls[0].split('/').pop()
	assert.ok(last.includes('%D0%9C'))
	assert.ok(last.includes('%28') && last.includes('%29'))
	assert.ok(last.includes('%2B'))
	assert.ok(last.includes('%26'))
	assert.ok(last.includes('%23'))
	assert.equal(urls[0].includes('https://edge.forgecdn.net/files/7617/489/'), true)
})

test('forgecdn в MIRROR_MAP — fallback, не mirror-first', () => {
	const edge = 'https://edge.forgecdn.net/files/7617/489/Over%20Stars-v5.6.zip'
	const list = candidates(edge)
	assert.equal(new URL(list[0]).host, 'edge.forgecdn.net')
	assert.ok(list.some((u) => new URL(u).host === 'mod.mcimirror.top'))
})
