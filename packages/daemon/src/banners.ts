import {
  type Banner,
  type BannerActionInput,
  type BannerRef,
  bannerDismissMs,
  bannerId,
  bannerOrder,
  type DaemonEvent,
  dismissClears,
  type RaiseBanner,
} from '@ted/protocol'
import { RequestError } from './errors.ts'
import type { TedStore } from './store/index.ts'

export type BannerHandler = (banner: Banner, input: BannerActionInput) => Promise<void>

export interface Banners {
  raise(problem: RaiseBanner): Banner
  raiseUnsaved(problem: RaiseBanner): Banner
  clear(ref: BannerRef): void
  clearFactory(factoryId: string): void
  list(): Banner[]
  dismiss(id: string, raisedAt?: string): Banner
  dismissProblem(id: string, raisedAt: string): Promise<void>
  act(id: string, input?: BannerActionInput): Promise<void>
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

  function dismissProblem(id: string, raisedAt: string): Banner {
    const banner = find(id)
    if (banner.severity !== 'stops-work' || banner.raisedAt !== raisedAt) {
      throw new RequestError(409, 'This problem has changed. Refresh and try again.')
    }
    if (banner.dismissed) return banner
    if (!unsaved.has(id)) return store.dismissProblem(id, raisedAt)
    const dismissed = { ...banner, dismissed: true }
    unsaved.set(id, dismissed)
    emit({ type: 'banner-updated', banner: dismissed })
    return dismissed
  }

  return {
    async dismissProblem(id, raisedAt) {
      const saved = !unsaved.has(id)
      dismissProblem(id, raisedAt)
      if (saved) await store.persisted()
    },
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
        ...(current?.dismissed && { dismissed: true }),
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
    clearFactory(factoryId) {
      for (const banner of [...unsaved.values()]) {
        if (banner.factoryId !== factoryId) continue
        unsaved.delete(banner.id)
        emit({ type: 'banner-cleared', id: banner.id })
      }
      for (const banner of store.listBanners()) {
        if (banner.factoryId === factoryId) store.clearBanner(banner.id)
      }
    },
    list: () => [...store.listBanners(), ...unsaved.values()].sort(bannerOrder),
    dismiss(id, raisedAt) {
      const banner = find(id)
      if (banner.severity === 'stops-work') {
        if (raisedAt === undefined)
          throw new RequestError(409, 'The problem’s start time is required.')
        return dismissProblem(id, raisedAt)
      }
      if (raisedAt !== undefined && banner.raisedAt !== raisedAt) {
        throw new RequestError(409, 'This notice has changed. Refresh and try again.')
      }
      if (dismissClears(banner)) {
        if (unsaved.delete(id)) emit({ type: 'banner-cleared', id })
        else store.clearBanner(id)
        return banner
      }
      const until = new Date(Date.now() + bannerDismissMs).toISOString()
      return store.dismissBanner(id, until) ?? find(id)
    },
    async act(id, input = {}) {
      const banner = find(id)
      const handler = banner.action?.opens ? undefined : handlers.get(banner.problem)
      if (!banner.action || !handler)
        throw new RequestError(409, 'this banner has no action to run')
      await handler(banner, input)
    },
    onAction(problem, handler) {
      handlers.set(problem, handler)
    },
  }
}
