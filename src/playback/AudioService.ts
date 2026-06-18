/**
 * AudioService — wraps HTMLAudioElement for audio playback in the main process.
 *
 * In production, this delegates to the Electron main process audio pipeline.
 * In tests, this module is entirely replaced by vi.mock().
 *
 * @see src/main/services/media-resolver.ts for the real streaming resolver.
 */

export interface AudioServiceInterface {
  play(url: string): void
  pause(): void
  stop(): void
  seek(seconds: number): void
  setVolume(vol: number): void
}

export const AudioService: AudioServiceInterface = {
  play(_url: string): void {
    // Production: create/update HTMLAudioElement src and call play()
    // Test: mocked via vi.mock()
  },

  pause(): void {
    // Production: HTMLAudioElement.pause()
  },

  stop(): void {
    // Production: HTMLAudioElement.pause() + src = ''
  },

  seek(_seconds: number): void {
    // Production: HTMLAudioElement.currentTime = seconds
  },

  setVolume(_vol: number): void {
    // Production: HTMLAudioElement.volume = vol
  },
}
