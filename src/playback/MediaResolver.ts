/**
 * MediaResolver — resolves a track to a playable stream URL.
 *
 * In production, this delegates to src/main/services/media-resolver.ts
 * which uses yt-dlp + the local HTTP proxy.
 * In tests, this module is entirely replaced by vi.mock().
 *
 * @see src/main/services/media-resolver.ts for the real implementation.
 */

export interface MediaResolverInterface {
  resolve(videoId: string): Promise<string>
}

export const MediaResolver: MediaResolverInterface = {
  async resolve(_videoId: string): Promise<string> {
    // Production: delegate to the real media-resolver service
    // Test: mocked via vi.mock()
    throw new Error(
      'MediaResolver.resolve() is not available outside the main process. ' +
      'Use vi.mock() in tests to provide a mock implementation.'
    )
  },
}
