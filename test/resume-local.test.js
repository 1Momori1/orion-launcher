const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { downloadFile, hashFile } = require('../src/main/net')

function serve(buf, { dropAfter = null, hangRange = false } = {}) {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
			if (hangRange && range) {
				res.writeHead(404)
				res.end()
				return
			}
			if (range) {
				const start = parseInt(range[1], 10)
				const end = range[2] ? parseInt(range[2], 10) : buf.length - 1
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end}/${buf.length}`,
					'Content-Length': String(end - start + 1),
					'Accept-Ranges': 'bytes',
				})
				res.end(buf.subarray(start, end + 1))
				return
			}
			if (dropAfter != null && dropAfter < buf.length && !range) {
				res.writeHead(200, { 'Content-Length': String(buf.length) })
				res.write(buf.subarray(0, dropAfter))
				req.socket.destroy()
				return
			}
			res.writeHead(200, { 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' })
			res.end(buf)
		})
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			resolve({ server, url: `http://127.0.0.1:${port}/file.bin` })
		})
	})
}

test('докачка после убитого процесса: .part → тот же sha256', async () => {
	const payload = crypto.randomBytes(2 * 1024 * 1024)
	const sha = crypto.createHash('sha256').update(payload).digest('hex')
	const { server, url } = await serve(payload)
	const dest = path.join(os.tmpdir(), 'orion-resume-kill.bin')
	for (const p of [dest, dest + '.part']) try { fs.unlinkSync(p) } catch (e) {}
	fs.writeFileSync(dest + '.part', payload.subarray(0, 600 * 1024))
	await downloadFile(url, dest, { expectedSize: payload.length, expectedSha256: sha, resume: true, forceSingle: true })
	assert.equal(await hashFile(dest, 'sha256'), sha)
	fs.unlinkSync(dest)
	server.close()
})

test('докачка после обрыва сети: повтор с .part', async () => {
	const payload = crypto.randomBytes(512 * 1024)
	const sha = crypto.createHash('sha256').update(payload).digest('hex')
	const dest = path.join(os.tmpdir(), 'orion-resume-net.bin')
	for (const p of [dest, dest + '.part']) try { fs.unlinkSync(p) } catch (e) {}

	const broken = await serve(payload, { dropAfter: 80 * 1024 })
	await assert.rejects(() => downloadFile(broken.url, dest, {
		expectedSize: payload.length,
		expectedSha256: sha,
		resume: true,
		forceSingle: true,
		attempts: 1,
	}))
	broken.server.close()

	const ok = await serve(payload)
	await downloadFile(ok.url, dest, { expectedSize: payload.length, expectedSha256: sha, resume: true, forceSingle: true })
	assert.equal(fs.statSync(dest).size, payload.length)
	assert.equal(await hashFile(dest, 'sha256'), sha)
	fs.unlinkSync(dest)
	ok.server.close()
})

test('Range 404 на CDN → откат на полный GET', async () => {
	const payload = crypto.randomBytes(64 * 1024)
	const sha = crypto.createHash('sha256').update(payload).digest('hex')
	const { server, url } = await serve(payload, { hangRange: true })
	const dest = path.join(os.tmpdir(), 'orion-range-404.bin')
	for (const p of [dest, dest + '.part']) try { fs.unlinkSync(p) } catch (e) {}
	fs.writeFileSync(dest + '.part', payload.subarray(0, 1024))
	await downloadFile(url, dest, { expectedSize: payload.length, expectedSha256: sha, resume: true })
	assert.equal(await hashFile(dest, 'sha256'), sha)
	fs.unlinkSync(dest)
	server.close()
})
