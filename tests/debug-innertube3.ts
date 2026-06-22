/**
 * Deep debug of streaming_data in Innertube getBasicInfo
 *
 * Usage: npx tsx tests/debug-innertube3.ts
 */
import { Innertube } from 'youtubei.js'

async function test() {
  console.log('Creating Innertube instance...')
  const yt = await Innertube.create({ enable_safety_mode: false })
  console.log('Ready\n')

  const videoId = 'dQw4w9WgXcQ'
  console.log(`getBasicInfo("${videoId}")...`)
  const info = await yt.getBasicInfo(videoId)
  
  console.log('\n--- streaming_data ---')
  const sd = info.streaming_data
  if (!sd) {
    console.log('NO streaming_data available')
  } else {
    console.log('expires:', sd.expires)
    
    // Try to decipher the URL
    console.log('\n--- Attempting stream URL via download() ---')
    try {
      // The key insight: youtubei.js v17 may not expose URLs directly.
      // We need to use the stream/download approach.
      console.log('info.streams available via info.download/stream methods')
    } catch (e: any) {
      console.log('Stream approach failed:', e.message)
    }
  }
  
  console.log('\n--- Check what methods info has ---')
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(info))
    .filter(m => !m.startsWith('_'))
  console.log('info methods:', methods)
  
  // Check streams property
  if ((info as any).streams) {
    console.log('\n--- info.streams ---')
    const s = (info as any).streams
    console.log(typeof s, Array.isArray(s) ? `array of ${s.length}` : Object.keys(s).slice(0,10))
  }

  // Try to get a playable URL through different approaches
  console.log('\n--- Attempt to get stream via different approaches ---')
  
  // Approach 1: Use the format's url if available
  const f1 = info.chooseFormat({ type: 'audio', quality: 'best' })
  console.log('chooseFormat audio:', { 
    itag: f1?.itag, 
    hasUrl: !!f1?.url, 
    mime: f1?.mime_type,
    hasSignatureCipher: !!(f1 as any)?.signatureCipher,
    hasCipher: !!(f1 as any)?.cipher,
  })
  
  // Approach 2: Check first streaming_data format
  if (sd?.formats && sd.formats.length > 0) {
    const f = sd.formats[0]
    console.log('streaming format 0:', { 
      itag: f.itag, 
      hasUrl: !!f.url, 
      mime: f.mime_type,
      hasSignatureCipher: !!(f as any)?.signatureCipher,
    })
  }
  
  if (sd?.adaptive_formats && sd.adaptive_formats.length > 0) {
    const f = sd.adaptive_formats[0]
    console.log('streaming adaptive 0:', { 
      itag: f.itag, 
      hasUrl: !!f.url, 
      mime: f.mime_type,
      hasSignatureCipher: !!(f as any)?.signatureCipher,
    })
    // Search for an audio-only format
    const audioF = sd.adaptive_formats.find((af: any) => af.mime_type?.includes('audio'))
    if (audioF) {
      console.log('best audio format:', { 
        itag: audioF.itag, 
        hasUrl: !!audioF.url, 
        mime: audioF.mime_type,
        bitrate: audioF.bitrate,
      })
      if (audioF.url) {
        console.log('audio URL:', audioF.url.substring(0, 100))
      }
    }
  }

  // Approach 3: Try getStreamingInfo
  console.log('\n--- DecipherUrl via streamingInfo ---')
  try {
    const streamingInfo = await info.getStreamingInfo() 
    console.log('streamingInfo:', typeof streamingInfo, streamingInfo ? 'available' : 'null')
    if (streamingInfo) {
      console.log('keys:', Object.keys(streamingInfo))
    }
  } catch (e: any) {
    console.log('getStreamingInfo failed:', e.message)
  }
  
  console.log('\nDone')
}

test().catch((err) => { console.error('FATAL:', err); process.exit(1) })
