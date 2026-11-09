import {
  type Banner,
  type BannerRef,
  bannerDismissMs,
  bannerId,
  bannerOrder,
  type DaemonEvent,
  type RaiseBanner,
} from '@ted/protocol'
import { RequestError } from './errors.ts'
import type { TedStore } from './store/index.ts'

export type BannerHandler = (banner: Banner) => Promise<void>

export interface Banners {
  raise(problem: RaiseBanner): Banner
  raiseUnsaved(problem: RaiseBanner): Banner
  clear(ref: BannerRef): void
  list(): Banner[]
  dismiss(id: string): Banner
  act(id: string): Promise<void>
  onAction(problem: string, handler: BannerHandler): void
}

export function createBanners({
  store,
  emit = () => undefined,
}: {
  store: TedStore
  emit?: (event: DaemonEvent) => void
}): Banners {
  const handlers = new Map<string, BannerHandler>()
  const unsaved = new Map<string, Banner>()

  function find(id: string): Banner {
    const banner = unsaved.get(id) ?? store.getBanner(id)
    if (!banner) throw new RequestError(404, 'no such banner')
    return banner
  }

  return {
    raise(input) {
      const { subject: _, ...banner } = input
      return store.raiseBanner({ ...banner, id: bannerId(input) })
    },
    raiseUnsaved(input) {
      const { subject: _, factoryId, action, ...rest } = input
      const id = bannerId(input)
      const current = unsaved.get(id)
      const banner: Banner = {
        ...rest,
        id,
        ...(factoryId !== undefined && { factoryId }),
        ...(action !== undefined && { action }),
        raisedAt: current?.raisedAt ?? new Date().toISOString(),
      }
      unsaved.set(id, banner)
      emit({ type: current ? 'banner-updated' : 'banner-raised', banner })
      return banner
    },
    clear(ref) {
      const id = bannerId(ref)
      if (unsaved.delete(id)) emit({ type: 'banner-cleared', id })
      else store.clearBanner(id)
    },
    list: () => [...store.listBanners(), ...unsaved.values()].sort(bannerOrder),
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
