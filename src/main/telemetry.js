const { request } = require('./net')
const { allHosts } = require('./hosts')

function launcherVersion() {
	try { return require('electron').app.getVersion() } catch (e) { return 'dev' }
}

function configuredServer() {
	try { return require('./config').load().serverUrl } catch (e) { return '' }
}

async function report(serverUrl, event, extra = {}) {
	const body = JSON.stringify({
		event: String(event || '').slice(0, 64),
		launcher: launcherVersion(),
		t: new Date().toISOString(),
		...extra,
	})
	const hosts = allHosts(serverUrl || configuredServer())
	for (const host of hosts) {
		try {
			await request('POST', `${host}/api/launcher/telemetry`, {
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body,
				timeout: 4000,
			})
			return
		} catch (e) { /* следующий хост */ }
	}
}

function reportQuiet(serverUrl, event, extra) {
	report(serverUrl, event, extra).catch(() => {})
}

module.exports = { report, reportQuiet, launcherVersion }
