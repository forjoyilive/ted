import type { Factory } from '@ted/protocol'
import type {
  FactoryIconColor,
  FactoryIconSymbol,
  FactoryIcon as Icon,
} from '@ted/protocol/factory-icon'
import {
  Anchor,
  Atom,
  Bell,
  Bike,
  Blocks,
  Book,
  BookOpen,
  Box,
  Boxes,
  Braces,
  Briefcase,
  Brush,
  Bug,
  Building2,
  Calendar,
  Camera,
  Car,
  ChartLine,
  ChartPie,
  Clock,
  Cloud,
  CloudSun,
  Code,
  Cog,
  Compass,
  Component,
  Cpu,
  CreditCard,
  Database,
  Droplet,
  Factory as FactoryBuilding,
  FileText,
  Film,
  Flag,
  Flame,
  FlaskConical,
  Flower2,
  Gamepad2,
  GitBranch,
  GitMerge,
  Globe,
  Hammer,
  Headphones,
  Heart,
  House,
  Image,
  Key,
  Laptop,
  Layers,
  Leaf,
  Lightbulb,
  Lock,
  type LucideIcon,
  Mail,
  Map as MapIcon,
  MessageCircle,
  Microscope,
  Monitor,
  Moon,
  Mountain,
  Music,
  Network,
  Newspaper,
  NotebookPen,
  Package,
  Palette,
  Pencil,
  PenTool,
  Phone,
  Plane,
  Puzzle,
  Rocket,
  Server,
  Shield,
  Ship,
  ShoppingCart,
  Smartphone,
  Smile,
  Snowflake,
  Sparkles,
  Sprout,
  Star,
  Store,
  Sun,
  Target,
  Terminal,
  Trees,
  Trophy,
  Truck,
  User,
  Users,
  Wallet,
  WandSparkles,
  Warehouse,
  Waves,
  Wrench,
  Zap,
} from 'lucide-react'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { factoryColors, ownColor } from '../factory-colors.ts'
import styles from './FactoryIcon.module.css'

const FactoryColors = createContext<ReadonlyMap<string, FactoryIconColor>>(new Map())

export function FactoryColorsProvider({
  factories,
  children,
}: {
  factories: readonly Factory[]
  children: ReactNode
}) {
  const colors = useMemo(() => factoryColors(factories), [factories])
  return <FactoryColors value={colors}>{children}</FactoryColors>
}

export function useFactoryColors(): (
  factory: Pick<Factory, 'id' | 'icon'> | undefined,
) => FactoryIconColor {
  const colors = useContext(FactoryColors)
  return (factory) =>
    factory === undefined ? 'gray' : (ownColor(factory.icon) ?? colors.get(factory.id) ?? 'blue')
}

export const factoryIconSymbolShapes: Record<FactoryIconSymbol, LucideIcon> = {
  box: Box,
  package: Package,
  boxes: Boxes,
  layers: Layers,
  blocks: Blocks,
  puzzle: Puzzle,
  component: Component,
  factory: FactoryBuilding,
  building: Building2,
  house: House,
  store: Store,
  warehouse: Warehouse,
  hammer: Hammer,
  wrench: Wrench,
  cog: Cog,
  code: Code,
  terminal: Terminal,
  braces: Braces,
  bug: Bug,
  'git-branch': GitBranch,
  'git-merge': GitMerge,
  cpu: Cpu,
  server: Server,
  database: Database,
  cloud: Cloud,
  globe: Globe,
  network: Network,
  shield: Shield,
  lock: Lock,
  key: Key,
  rocket: Rocket,
  zap: Zap,
  flame: Flame,
  sparkles: Sparkles,
  star: Star,
  wand: WandSparkles,
  lightbulb: Lightbulb,
  atom: Atom,
  flask: FlaskConical,
  microscope: Microscope,
  target: Target,
  trophy: Trophy,
  flag: Flag,
  compass: Compass,
  map: MapIcon,
  mountain: Mountain,
  trees: Trees,
  leaf: Leaf,
  sprout: Sprout,
  flower: Flower2,
  sun: Sun,
  moon: Moon,
  'cloud-sun': CloudSun,
  snowflake: Snowflake,
  droplet: Droplet,
  waves: Waves,
  anchor: Anchor,
  book: Book,
  'book-open': BookOpen,
  notebook: NotebookPen,
  'file-text': FileText,
  newspaper: Newspaper,
  pencil: Pencil,
  palette: Palette,
  brush: Brush,
  'pen-tool': PenTool,
  camera: Camera,
  image: Image,
  film: Film,
  music: Music,
  headphones: Headphones,
  gamepad: Gamepad2,
  briefcase: Briefcase,
  wallet: Wallet,
  'shopping-cart': ShoppingCart,
  'credit-card': CreditCard,
  'chart-line': ChartLine,
  'chart-pie': ChartPie,
  calendar: Calendar,
  clock: Clock,
  bell: Bell,
  mail: Mail,
  'message-circle': MessageCircle,
  phone: Phone,
  smartphone: Smartphone,
  laptop: Laptop,
  monitor: Monitor,
  heart: Heart,
  smile: Smile,
  users: Users,
  user: User,
  truck: Truck,
  plane: Plane,
  ship: Ship,
  car: Car,
  bike: Bike,
}

export function iconColorStyle(color: FactoryIconColor | undefined) {
  if (color === undefined) return undefined
  return {
    color: `var(--factory-icon-${color}-fg)`,
    background: `var(--factory-icon-${color}-bg)`,
  }
}

export function FactoryIcon({
  factory,
  size = 18,
  className,
}: {
  factory: Pick<Factory, 'id' | 'name' | 'icon'>
  size?: number
  className?: string | undefined
}) {
  const color = useFactoryColors()(factory)
  return (
    <IconMark
      icon={factory.icon ?? { kind: 'letter', color }}
      name={factory.name}
      size={size}
      className={className}
    />
  )
}

export function IconMark({
  icon,
  name,
  size = 18,
  className,
}: {
  icon: Icon | undefined
  name: string
  size?: number
  className?: string | undefined
}) {
  const box = { width: size, height: size, fontSize: Math.round(size * 0.65) }
  const classes = (kind: string) => [styles.icon, styles[kind], className].filter(Boolean).join(' ')
  if (icon?.kind === 'symbol') {
    const Shape = factoryIconSymbolShapes[icon.name]
    return (
      <span
        className={classes('symbol')}
        style={{ ...box, ...iconColorStyle(icon.color) }}
        aria-hidden="true"
      >
        <Shape size={Math.round(size * 0.72)} strokeWidth={2} />
      </span>
    )
  }
  if (icon?.kind === 'emoji') {
    return (
      <span
        className={classes('emoji')}
        style={{ ...box, fontSize: Math.round(size * 0.85) }}
        data-glyph={icon.emoji}
        aria-hidden="true"
      />
    )
  }
  if (icon?.kind === 'image') {
    return (
      <span className={classes('image')} style={box} aria-hidden="true">
        <img src={icon.dataUrl} alt="" draggable={false} />
      </span>
    )
  }
  return (
    <span
      className={classes('letter')}
      style={{ ...box, ...iconColorStyle(icon?.color) }}
      data-glyph={Array.from(name)[0]}
      aria-hidden="true"
    />
  )
}

export function FactoryName({
  factories,
  factoryId,
}: {
  factories: readonly Factory[]
  factoryId: string
}) {
  const factory = factories.find((f) => f.id === factoryId)
  if (factory === undefined) return 'No Factory'
  return (
    <span className={styles.named}>
      <FactoryIcon factory={factory} size={14} />
      <span className={styles.namedText} title={factory.name}>
        {factory.name}
      </span>
    </span>
  )
}
