export const factoryIconColors = [
  'gray',
  'blue',
  'sky',
  'teal',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
] as const

export type FactoryIconColor = (typeof factoryIconColors)[number]

export const factoryIconSymbolGroups = [
  {
    name: 'Building',
    symbols: [
      'box',
      'package',
      'boxes',
      'layers',
      'blocks',
      'puzzle',
      'component',
      'factory',
      'building',
      'house',
      'store',
      'warehouse',
      'hammer',
      'wrench',
      'cog',
    ],
  },
  {
    name: 'Code and systems',
    symbols: [
      'code',
      'terminal',
      'braces',
      'bug',
      'git-branch',
      'git-merge',
      'cpu',
      'server',
      'database',
      'cloud',
      'globe',
      'network',
      'shield',
      'lock',
      'key',
    ],
  },
  {
    name: 'Ideas and science',
    symbols: [
      'rocket',
      'zap',
      'flame',
      'sparkles',
      'star',
      'wand',
      'lightbulb',
      'atom',
      'flask',
      'microscope',
      'target',
      'trophy',
      'flag',
      'compass',
      'map',
    ],
  },
  {
    name: 'Nature',
    symbols: [
      'mountain',
      'trees',
      'leaf',
      'sprout',
      'flower',
      'sun',
      'moon',
      'cloud-sun',
      'snowflake',
      'droplet',
      'waves',
      'anchor',
    ],
  },
  {
    name: 'Work and media',
    symbols: [
      'book',
      'book-open',
      'notebook',
      'file-text',
      'newspaper',
      'pencil',
      'palette',
      'brush',
      'pen-tool',
      'camera',
      'image',
      'film',
      'music',
      'headphones',
      'gamepad',
      'briefcase',
      'wallet',
      'shopping-cart',
      'credit-card',
      'chart-line',
      'chart-pie',
      'calendar',
      'clock',
      'bell',
      'mail',
      'message-circle',
      'phone',
      'smartphone',
      'laptop',
      'monitor',
    ],
  },
  {
    name: 'People and travel',
    symbols: ['heart', 'smile', 'users', 'user', 'truck', 'plane', 'ship', 'car', 'bike'],
  },
] as const

export type FactoryIconSymbol = (typeof factoryIconSymbolGroups)[number]['symbols'][number]

export const factoryIconSymbols: readonly FactoryIconSymbol[] = factoryIconSymbolGroups.flatMap(
  (group) => group.symbols,
)

export interface FactoryIconEmoji {
  emoji: string
  words: string
}

export const factoryIconEmojiGroups: readonly { name: string; emoji: FactoryIconEmoji[] }[] = [
  {
    name: 'Objects',
    emoji: [
      { emoji: '📦', words: 'box package parcel' },
      { emoji: '🧰', words: 'toolbox tools kit' },
      { emoji: '🛠️', words: 'tools hammer wrench build' },
      { emoji: '⚙️', words: 'gear cog settings' },
      { emoji: '🔧', words: 'wrench fix tool' },
      { emoji: '🔨', words: 'hammer build tool' },
      { emoji: '🧪', words: 'test tube lab science experiment' },
      { emoji: '🔬', words: 'microscope science lab' },
      { emoji: '🧲', words: 'magnet' },
      { emoji: '💡', words: 'light bulb idea' },
      { emoji: '🔑', words: 'key access' },
      { emoji: '🔒', words: 'lock secure security' },
      { emoji: '🧭', words: 'compass direction' },
      { emoji: '🗺️', words: 'map world' },
      { emoji: '📌', words: 'pin pushpin' },
      { emoji: '🗂️', words: 'folders dividers files' },
      { emoji: '📁', words: 'folder files' },
      { emoji: '📓', words: 'notebook notes' },
      { emoji: '📚', words: 'books library docs' },
      { emoji: '📝', words: 'memo note write' },
      { emoji: '✏️', words: 'pencil write edit' },
      { emoji: '🎨', words: 'art palette design paint' },
      { emoji: '📷', words: 'camera photo' },
      { emoji: '🎬', words: 'film clapper movie video' },
      { emoji: '🎧', words: 'headphones music audio' },
      { emoji: '🎮', words: 'game controller play' },
      { emoji: '💻', words: 'laptop computer code' },
      { emoji: '🖥️', words: 'desktop computer monitor' },
      { emoji: '📱', words: 'phone mobile app' },
      { emoji: '🤖', words: 'robot bot ai' },
    ],
  },
  {
    name: 'Places and travel',
    emoji: [
      { emoji: '🏭', words: 'factory industry' },
      { emoji: '🏠', words: 'house home' },
      { emoji: '🏢', words: 'office building company' },
      { emoji: '🏪', words: 'store shop' },
      { emoji: '🏗️', words: 'construction crane build' },
      { emoji: '🏰', words: 'castle' },
      { emoji: '🌉', words: 'bridge' },
      { emoji: '🚀', words: 'rocket launch ship' },
      { emoji: '✈️', words: 'plane airplane travel' },
      { emoji: '🚂', words: 'train locomotive' },
      { emoji: '🚗', words: 'car' },
      { emoji: '🚲', words: 'bike bicycle' },
      { emoji: '⛵', words: 'boat sailboat' },
      { emoji: '🛰️', words: 'satellite space' },
      { emoji: '🌍', words: 'globe world earth' },
    ],
  },
  {
    name: 'Nature',
    emoji: [
      { emoji: '🌱', words: 'seedling sprout plant grow' },
      { emoji: '🌿', words: 'herb leaf plant' },
      { emoji: '🍀', words: 'clover luck' },
      { emoji: '🌳', words: 'tree' },
      { emoji: '🌵', words: 'cactus' },
      { emoji: '🌸', words: 'blossom flower' },
      { emoji: '🌻', words: 'sunflower flower' },
      { emoji: '🍄', words: 'mushroom' },
      { emoji: '🌊', words: 'wave water ocean sea' },
      { emoji: '🔥', words: 'fire flame hot' },
      { emoji: '⚡', words: 'lightning zap fast' },
      { emoji: '❄️', words: 'snowflake cold ice' },
      { emoji: '☀️', words: 'sun sunny' },
      { emoji: '🌙', words: 'moon night' },
      { emoji: '⭐', words: 'star' },
      { emoji: '🌈', words: 'rainbow' },
      { emoji: '☁️', words: 'cloud' },
      { emoji: '🐝', words: 'bee' },
      { emoji: '🦊', words: 'fox' },
      { emoji: '🐙', words: 'octopus' },
      { emoji: '🐢', words: 'turtle slow' },
      { emoji: '🦉', words: 'owl' },
      { emoji: '🐳', words: 'whale' },
      { emoji: '🦋', words: 'butterfly' },
      { emoji: '🐱', words: 'cat' },
      { emoji: '🐶', words: 'dog' },
    ],
  },
  {
    name: 'Food',
    emoji: [
      { emoji: '🍎', words: 'apple fruit' },
      { emoji: '🍋', words: 'lemon fruit' },
      { emoji: '🍉', words: 'watermelon fruit' },
      { emoji: '🥑', words: 'avocado' },
      { emoji: '🍕', words: 'pizza' },
      { emoji: '🍩', words: 'doughnut donut' },
      { emoji: '🍪', words: 'cookie' },
      { emoji: '☕', words: 'coffee hot drink' },
      { emoji: '🍵', words: 'tea' },
      { emoji: '🧁', words: 'cupcake cake' },
    ],
  },
  {
    name: 'Symbols',
    emoji: [
      { emoji: '❤️', words: 'red heart love' },
      { emoji: '💜', words: 'purple heart' },
      { emoji: '💙', words: 'blue heart' },
      { emoji: '💚', words: 'green heart' },
      { emoji: '💛', words: 'yellow heart' },
      { emoji: '🧡', words: 'orange heart' },
      { emoji: '✅', words: 'check done' },
      { emoji: '🎯', words: 'target bullseye goal' },
      { emoji: '🏆', words: 'trophy win' },
      { emoji: '🚩', words: 'flag' },
      { emoji: '💎', words: 'gem diamond' },
      { emoji: '🔮', words: 'crystal ball' },
      { emoji: '♻️', words: 'recycle' },
      { emoji: '🧩', words: 'puzzle piece' },
      { emoji: '🎲', words: 'dice game' },
      { emoji: '✨', words: 'sparkles magic' },
    ],
  },
]

export const factoryIconEmoji: readonly string[] = factoryIconEmojiGroups.flatMap((group) =>
  group.emoji.map((entry) => entry.emoji),
)

export const factoryIconImageSide = 64
export const factoryIconImageMaxBytes = 32 * 1024
export const factoryIconUploadMaxBytes = 1024 * 1024
export const factoryIconUploadTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const factoryIconImagePrefix = 'data:image/png;base64,'

export type FactoryIcon =
  | { kind: 'letter'; color: FactoryIconColor }
  | { kind: 'symbol'; name: FactoryIconSymbol; color: FactoryIconColor }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'image'; dataUrl: string }

export interface SetFactoryIconRequest {
  icon: FactoryIcon | null
}

export function factoryIconEmojiOf(icon: FactoryIcon | undefined): string | undefined {
  return icon?.kind === 'emoji' ? icon.emoji : undefined
}

const automaticFactoryColors: readonly FactoryIconColor[] = [
  'blue',
  'orange',
  'teal',
  'pink',
  'green',
  'purple',
  'yellow',
  'red',
  'sky',
]

export function ownColor(icon: FactoryIcon | undefined): FactoryIconColor | undefined {
  return icon?.kind === 'letter' || icon?.kind === 'symbol' ? icon.color : undefined
}

export function factoryColors(
  factories: readonly { id: string; icon?: FactoryIcon | undefined }[],
): ReadonlyMap<string, FactoryIconColor> {
  const taken = new Set(factories.flatMap((f) => ownColor(f.icon) ?? []))
  const free = automaticFactoryColors.filter((color) => !taken.has(color))
  const pool = free.length > 0 ? free : automaticFactoryColors
  let next = 0
  return new Map(
    factories.map((f) => {
      const own = ownColor(f.icon)
      if (own !== undefined) return [f.id, own]
      const color = pool[next % pool.length] ?? 'blue'
      next += 1
      return [f.id, color]
    }),
  )
}
