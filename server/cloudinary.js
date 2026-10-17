import { v2 as cloudinary } from 'cloudinary'
import { demand } from './schema.js'

export function cloudinaryMedia(url) {
  if (!url) return undefined
  const config = new URL(url)
  demand(config.protocol === 'cloudinary:' && config.username && config.password && config.hostname, 500, 'Cloudinary configuration is invalid')
  cloudinary.config({ cloud_name: config.hostname, api_key: decodeURIComponent(config.username), api_secret: decodeURIComponent(config.password), secure: true })
  return {
    async upload(buffer, public_id) {
      await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ public_id, type: 'authenticated', resource_type: 'image', format: 'webp', overwrite: false, timeout: 60000 }, (error, result) => error ? reject(error) : resolve(result))
        stream.end(buffer)
      })
    },
    async destroy(public_id) {
      const result = await cloudinary.uploader.destroy(public_id, { type: 'authenticated', resource_type: 'image', invalidate: true, timeout: 60000 })
      demand(['ok', 'not found'].includes(result.result), 503, 'Image deletion could not be confirmed')
    },
    async download(public_id) {
      const url = cloudinary.utils.private_download_url(public_id, 'webp', { type: 'authenticated', resource_type: 'image', expires_at: Math.floor(Date.now() / 1000) + 60, attachment: false })
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' })
      demand(response.ok && response.body, 503, 'Image temporarily unavailable')
      const chunks = []; let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.length
        demand(bytes <= 5 * 1024 * 1024, 503, 'Stored image exceeded its size limit')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    },
  }
}