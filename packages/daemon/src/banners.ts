import {
  type Banner,
  type BannerRef,
  bannerDismissMs,
  bannerId,
  type RaiseBanner,
} from '@ted/protocol'
import { RequestError } from './errors.ts'
import type { TedStore } from './store/index.ts'

export type BannerHandler = (banner: Banner) => Promise<void>

export interface Banners {
  raise(problem: RaiseBanner): Banner
  clear(ref: BannerRef): void
  list(): Banner[]
  dismiss(id: string): Banner
  act(id: string): Promise<void>
  onAction(problem: string, handler: BannerHandler): void
}

export function createBanners({ store }: { store: TedStore }): Banners {
  const handlers = new Map<string, BannerHandler>()

  function find(id: string): Banner {
    const banner = store.getBanner(id)
    if (!banner) throw new RequestError(404, 'no such banner')
    return banner
  }

  return {
    raise(input) {
      const { subject: _, ...banner } = input
      return store.raiseBanner({ ...banner, id: bannerId(input) })
    },
    clear(ref) {
      store.clearBanner(bannerId(ref))
    },
    list: () => store.listBanners(),
    dismiss(id) {
      if (find(id).severity === 'stops-work') {
        throw new RequestError(409, 'a problem that stops work can’t be dismissed')
      }
      const until = new Date(Date.now() + bannerDismissMs).toISOString()
      return store.dismissBanner(id, until) ?? find(id)
    },
    async act(id) {
      const banner = find(id)
      const handler = banner.action?.opens ? undefined : handlers.get(banner.problem)
      if (!banner.action || !handler)
        throw new RequestError(409, 'this banner has no action to run')
      await handler(banner)
    },
    onAction(problem, handler) {
      handlers.set(problem, handler)
    },
  }
}
