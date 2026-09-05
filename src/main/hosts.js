const PUBLIC_URL = ''

function norm(u) {
	return String(u || '').replace(/\/$/, '')
}

function isHttpUrl(u) {
	return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(norm(u))
}

function allHosts(preferred) {
	const out = []
	const add = (u) => {
		const n = norm(u)
		if (n && !out.includes(n)) out.push(n)
	}
	add(preferred)
	add(PUBLIC_URL)
	return out
}

function isPrivateServerUrl(u) {
	return !norm(u)
}

module.exports = { PUBLIC_URL, allHosts, isPrivateServerUrl, isHttpUrl, norm }
