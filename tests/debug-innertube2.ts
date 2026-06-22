/**
 * Deep debug of Innertube resolveViaInnerTube failures
 *
 * Usage: npx tsx tests/debug-innertube2.ts
 */
import { Innertube } from 'youtubei.js'

async function test() {
  console.log('Creating Innertube instance...')
  const t0 = Date.now()
  const yt = await Innertube.create({ enable_safety_mode: false })
  console.log(`Created in ${Date.now() - t0}ms\n`)

  const videoId = 'dQw4w9WgXcQ'
  console.log(`Calling yt.getBasicInfo("${videoId}")...`)
  
  try {
    const t1 = Date.now()
    const info = await yt.getBasicInfo(videoId)
    const elapsed = Date.now() - t1
    console.log(`getBasicInfo returned in ${elapsed}ms`)
    
    console.log('\n--- basic_info ---')
    console.log('  id:', info.basic_info?.id)
    console.log('  title:', info.basic_info?.title)
    console.log('  duration:', info.basic_info?.duration)
    console.log('  thumbnail:', info.basic_info?.thumbnail?.[0]?.url?.substring(0,60))
    
    console.log('\n--- chooseFormat ---')
    try {
      const format = info.chooseFormat({
        type: 'audio',
        quality: 'best',
      })
      console.log('  format:', format ? 'found' : 'undefined')
      if (format) {
        console.log('  url:', format.url ? format.url.substring(0, 80) : 'NO URL')
        console.log('  mime_type:', format.mime_type)
        console.log('  itag:', format.itag)
        console.log('  bitrate:', format.bitrate)
      }
    } catch (formatErr: any) {
      console.log('  chooseFormat ERROR:', formatErr.message)
      
      // Try alternate: list all formats
      console.log('\n--- streaming_data ---')
      if (info.streaming_data) {
        console.log('  expires:', info.streaming_data.expires)
        console.log('  formats count:', info.streaming_data.formats?.length ?? 0)
        if (info.streaming_data.formats && info.streaming_data.formats.length > 0) {
          for (const f of info.streaming_data.formats.slice(0, 3)) {
            console.log(`    itag=${f.itag} mime=${f.mime_type} hasUrl=${!!f.url} bitrate=${f.bitrate}`)
          }
        }
        console.log('  adaptive_formats count:', info.streaming_data.adaptive_formats?.length ?? 0)
        if (info.streaming_data.adaptive_formats && info.streaming_data.adaptive_formats.length > 0) {
          for (const f of info.streaming_data.adaptive_formats.slice(0, 5)) {
            console.log(`    itag=${f.itag} mime=${f.mime_type} hasUrl=${!!f.url} bitrate=${f.bitrate}`)
          }
        }
      } else {
        console.log('  NO streaming_data available')
      }
    }
  } catch (err: any) {
    console.log('getBasicInfo ERROR:', err.message)
    console.log('Stack:', err.stack?.substring(0, 500))
  }
  
  console.log('\nDone')
}

test().catch((err) => { console.error('FATAL:', err); process.exit(1) })
