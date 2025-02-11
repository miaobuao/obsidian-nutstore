import { objectHash } from 'ohash'
import path, { basename } from 'path'
import { createClient, WebDAVClient } from 'webdav'
import { getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { DAV_API } from '~/consts'
import { StatModel } from '~/model/stat.model'
import { deltaCacheKV } from '~/storage'
import { traverseWebDAV } from '~/utils/traverse-webdav'
import NutStorePlugin from '..'
import IFileSystem from './fs.interface'

export class NutstoreFileSystem implements IFileSystem {
	private webdav: WebDAVClient

	constructor(
		private options: {
			plugin: NutStorePlugin
			token: string
			remoteBaseDir: string
		},
	) {
		this.webdav = createClient(DAV_API, {
			headers: {
				Authorization: `Basic ${this.options.token}`,
			},
		})
	}

	async walk() {
		const kvKey = objectHash({
			remoteBaseDir: this.options.remoteBaseDir,
			vaultName: this.options.plugin.app.vault.getName(),
		})
		let deltaCache = await deltaCacheKV.get(kvKey)
		const normRemoteBaseDir = normalizeRemotePath(this.options.remoteBaseDir)
		if (deltaCache) {
			let cursor = deltaCache.deltas.at(-1)?.cursor ?? deltaCache.originCursor
			while (true) {
				const events = await getDelta({
					token: this.options.token,
					cursor,
					folderName: this.options.remoteBaseDir,
				})
				if (events.response.cursor === cursor) {
					break
				}
				if (events.response.reset) {
					deltaCache.deltas = []
					deltaCache.files = await traverseWebDAV(
						this.webdav,
						normRemoteBaseDir,
					)
					cursor = await getLatestDeltaCursor({
						token: this.options.token,
						folderName: this.options.remoteBaseDir,
					}).then((d) => d?.response?.cursor)
				} else if (events.response.delta.entry.length > 0) {
					deltaCache.deltas.push(events.response)
					if (events.response.hasMore) {
						cursor = events.response.cursor
					} else {
						break
					}
				} else {
					break
				}
			}
		} else {
			const files = await await traverseWebDAV(this.webdav, normRemoteBaseDir)
			const {
				response: { cursor: originCursor },
			} = await getLatestDeltaCursor({
				token: this.options.token,
				folderName: this.options.remoteBaseDir,
			})
			deltaCache = {
				files,
				originCursor,
				deltas: [],
			}
		}
		await deltaCacheKV.set(kvKey, deltaCache)
		const deltasMap = new Map(
			deltaCache.deltas.flatMap((d) => d.delta.entry.map((d) => [d.path, d])),
		)
		const filesMap = new Map<string, StatModel>(
			deltaCache.files.map((d) => [d.path, d]),
		)
		for (const delta of deltasMap.values()) {
			if (delta.isDeleted) {
				filesMap.delete(delta.path)
			} else {
				filesMap.set(delta.path, {
					path: delta.path,
					basename: basename(delta.path),
					isDir: delta.isDir,
					mtime: new Date(delta.modified).valueOf(),
				})
			}
		}
		const contents = [...filesMap.values()]
		for (const item of contents) {
			if (path.isAbsolute(item.path)) {
				item.path = path.relative(this.options.remoteBaseDir, item.path)
			}
		}
		return contents
	}
}

export function normalizeRemotePath(remoteBaseDir: string) {
	if (remoteBaseDir.startsWith('/')) {
		return path.resolve(remoteBaseDir)
	}
	return `/${remoteBaseDir}`
}
