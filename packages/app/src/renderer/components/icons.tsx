import type { ReactNode } from 'react'
import styles from './icons.module.css'

interface IconProps {
  className?: string | undefined
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="5" y="5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M9 5V3.5A1.5 1.5 0 0 0 7.5 2h-4A1.5 1.5 0 0 0 2 3.5v4A1.5 1.5 0 0 0 3.5 9H5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}

export function BellOffIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M3.5 9.6V6.3a3.5 3.5 0 0 1 7 0v3.3l1 1.3h-9l1-1.3ZM5.8 12.2a1.3 1.3 0 0 0 2.4 0M2.2 2.2l9.6 9.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M10.25 6C10.25 8.34721 8.34721 10.25 6 10.25C3.65279 10.25 1.75 8.34721 1.75 6C1.75 3.65279 3.65279 1.75 6 1.75C8.34721 1.75 10.25 3.65279 10.25 6Z"
        strokeWidth="1.5"
        stroke="currentColor"
      />
      <path d="M9.2 9.2L12.5 12.5" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" />
    </svg>
  )
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 2.5V7M7 7V11.5M7 7H2.5M7 7H11.5"
        strokeWidth="1.5"
        strokeLinecap="round"
        stroke="currentColor"
      />
    </svg>
  )
}

export function ChevronIcon({ open, className }: IconProps & { open: boolean }) {
  return (
    <svg className={className} width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d={open ? 'M2.5 4L5 6.5L7.5 4' : 'M4 2.5L6.5 5L4 7.5'}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  )
}

export function DotIcon({ size = 6, className }: IconProps & { size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 6 6" aria-hidden>
      <circle cx="3" cy="3" r="3" fill="currentColor" />
    </svg>
  )
}

export function WarningIcon({ className }: IconProps) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M6 1.2L11.2 10.4H0.8L6 1.2Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <path
        className={styles.glyph}
        d="M6.6 4.9C6.6 4.56863 6.33137 4.3 6 4.3C5.66863 4.3 5.4 4.56863 5.4 4.9V7.1C5.4 7.43137 5.66863 7.7 6 7.7C6.33137 7.7 6.6 7.43137 6.6 7.1V4.9Z"
      />
      <path
        className={styles.glyph}
        d="M6 9.6C6.3866 9.6 6.7 9.2866 6.7 8.9C6.7 8.5134 6.3866 8.2 6 8.2C5.6134 8.2 5.3 8.5134 5.3 8.9C5.3 9.2866 5.6134 9.6 6 9.6Z"
      />
    </svg>
  )
}

export function ClaudeCodeMark({ size, className }: IconProps & { size: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      <path
        fill="currentColor"
        d="M7.21004 1.47542H5.68013L8.47013 8.52458H10L7.21004 1.47542ZM2.78996 1.47542L1.19209e-07 8.52458H1.56008L2.13063 7.04429H5.04946L5.62 8.52463H7.18008L4.39012 1.47538L2.78996 1.47542ZM2.63529 5.73508L3.59004 3.25775L4.54479 5.73508H2.63529Z"
      />
    </svg>
  )
}

export function CodexMark({ size, className }: IconProps & { size: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      <path
        fill="currentColor"
        d="M9.28412 4.09213C9.39594 3.75541 9.43461 3.39871 9.39755 3.04585C9.3605 2.69299 9.24857 2.3521 9.06925 2.04596C8.8034 1.58322 8.39747 1.21686 7.90999 0.999691C7.42251 0.782525 6.87865 0.725776 6.35683 0.837625C6.06038 0.507859 5.68237 0.261905 5.26077 0.124463C4.83918 -0.0129779 4.38884 -0.0370668 3.95499 0.0546161C3.52114 0.146299 3.11905 0.350526 2.78911 0.646785C2.45917 0.943044 2.21299 1.3209 2.07529 1.74242C1.72765 1.8137 1.39923 1.95837 1.11198 2.16675C0.824729 2.37512 0.585262 2.64241 0.409583 2.95075C0.140848 3.41272 0.0259921 3.94818 0.0816213 4.47972C0.13725 5.01127 0.360482 5.51135 0.719042 5.90767C0.606819 6.24422 0.56776 6.60086 0.604479 6.95373C0.641198 7.3066 0.752847 7.64755 0.931958 7.95379C1.19814 8.4167 1.60442 8.78315 2.09225 9.00031C2.58008 9.21748 3.12427 9.27415 3.64638 9.16217C3.8819 9.4274 4.1713 9.63933 4.49525 9.78381C4.81921 9.92829 5.17025 10.002 5.52496 10C6.05981 10.0005 6.58098 9.83102 7.01324 9.51604C7.4455 9.20106 7.76649 8.75687 7.92988 8.24758C8.27747 8.17617 8.60584 8.03145 8.89308 7.82308C9.18032 7.61471 9.41981 7.34747 9.59558 7.03921C9.86114 6.57792 9.97402 6.04447 9.91808 5.51515C9.86214 4.98583 9.64024 4.48771 9.28412 4.09213ZM5.52496 9.3455C5.08692 9.34619 4.66263 9.19266 4.32646 8.91183L4.38558 8.87833L6.37654 7.72908C6.42609 7.70002 6.46723 7.65857 6.49592 7.6088C6.52461 7.55903 6.53986 7.50265 6.54017 7.44521V4.63817L7.38183 5.12508C7.38599 5.12719 7.3896 5.13025 7.39235 5.13402C7.3951 5.13778 7.39692 5.14215 7.39767 5.14675V7.47283C7.39661 7.96918 7.19897 8.44489 6.84799 8.79586C6.49702 9.14682 6.0213 9.34445 5.52496 9.3455ZM1.49967 7.62658C1.27999 7.24726 1.20111 6.80262 1.27692 6.37088L1.33608 6.40638L3.329 7.55562C3.37831 7.58456 3.43445 7.59982 3.49163 7.59982C3.5488 7.59982 3.60494 7.58456 3.65425 7.55562L6.08875 6.15208V7.12392C6.08852 7.12895 6.08716 7.13387 6.08476 7.13831C6.08237 7.14275 6.079 7.14659 6.07492 7.14954L4.05833 8.31258C3.62797 8.5605 3.11681 8.62751 2.63709 8.49889C2.15736 8.37028 1.74828 8.05655 1.49967 7.62658ZM0.975333 3.28983C1.19653 2.90807 1.54568 2.61689 1.96096 2.46783V4.83333C1.96021 4.89048 1.97481 4.94678 2.00324 4.99636C2.03167 5.04594 2.07288 5.08699 2.12258 5.11521L4.54525 6.51283L3.70354 6.99971C3.69899 7.00213 3.69391 7.00339 3.68875 7.00339C3.68359 7.00339 3.67851 7.00213 3.67396 6.99971L1.66133 5.83867C1.23178 5.58967 0.918395 5.1806 0.789819 4.70103C0.661243 4.22146 0.727951 3.71049 0.975333 3.28V3.28983ZM7.89046 4.89642L5.45992 3.485L6.29967 3C6.30422 2.99758 6.3093 2.99632 6.31446 2.99632C6.31962 2.99632 6.32469 2.99758 6.32925 3L8.34188 4.16304C8.6496 4.34061 8.90047 4.60205 9.06519 4.91684C9.22991 5.23163 9.30168 5.58678 9.27213 5.94083C9.24257 6.29489 9.11291 6.63323 8.89828 6.91635C8.68365 7.19948 8.39291 7.41571 8.06 7.53979V5.17429C8.05825 5.11724 8.0417 5.06162 8.01197 5.0129C7.98224 4.96418 7.94039 4.92406 7.89046 4.89642ZM8.72825 3.63679L8.66908 3.60129L6.68013 2.44221C6.63051 2.41309 6.57403 2.39774 6.5165 2.39774C6.45897 2.39774 6.40249 2.41309 6.35288 2.44221L3.92042 3.84571V2.87392C3.9199 2.86898 3.92072 2.86399 3.92281 2.85948C3.92489 2.85497 3.92815 2.8511 3.93225 2.84829L5.94488 1.68721C6.25334 1.50951 6.60602 1.42331 6.96168 1.43869C7.31733 1.45407 7.66126 1.5704 7.95322 1.77408C8.24519 1.97775 8.47313 2.26034 8.61039 2.5888C8.74764 2.91727 8.78854 3.27802 8.72829 3.62888L8.72825 3.63679ZM3.46104 5.35958L2.61937 4.87467C2.61516 4.87213 2.61156 4.8687 2.60883 4.86462C2.60609 4.86053 2.60429 4.8559 2.60354 4.85104V2.53092C2.604 2.17499 2.70578 1.82655 2.89698 1.52633C3.08818 1.22612 3.36089 0.986536 3.68323 0.8356C4.00557 0.684663 4.36421 0.628609 4.71724 0.673991C5.07026 0.719374 5.40307 0.864317 5.67675 1.09188L5.61758 1.12542L3.62667 2.27458C3.57711 2.30365 3.53597 2.3451 3.50729 2.39487C3.4786 2.44464 3.46335 2.50101 3.46304 2.55846L3.46104 5.35958ZM3.91838 4.374L5.00254 3.74908L6.08875 4.374V5.62375L5.0065 6.24863L3.92038 5.62375L3.91838 4.374Z"
      />
    </svg>
  )
}

export function CloseIcon({ size = 14, className }: IconProps & { size?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
    >
      <path
        d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5"
        strokeWidth="1.4"
        strokeLinecap="round"
        stroke="currentColor"
      />
    </svg>
  )
}

export function PaperclipIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M11.6 6.6L7.1 11.1C5.9 12.3 4 12.3 2.8 11.1C1.6 9.9 1.6 8 2.8 6.8L7.6 2C8.4 1.2 9.6 1.2 10.4 2C11.2 2.8 11.2 4 10.4 4.8L5.7 9.5C5.3 9.9 4.7 9.9 4.3 9.5C3.9 9.1 3.9 8.5 4.3 8.1L8.4 4"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  )
}

export function FileIcon({ className }: IconProps) {
  return (
    <svg className={className} width="20" height="24" viewBox="0 0 20 24" fill="none" aria-hidden>
      <path
        d="M3 1.5H12L17 6.5V22.5H3Z M12 1.5V6.5H17"
        strokeWidth="1.3"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  )
}

export function RestartIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M11.5 7A4.5 4.5 0 1 1 9.9 3.55"
        strokeWidth="1.5"
        strokeLinecap="round"
        stroke="currentColor"
      />
      <path
        d="M10.2 1.6V3.9H7.9"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  )
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" fill="currentColor" />
    </svg>
  )
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="4.75" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M6 3.5V6l1.6 1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function OpenIcon({ className }: IconProps) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M4 2.75H9.25V8M9.25 2.75L2.75 9.25"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  )
}

export function CameraIcon({ className }: IconProps) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M1.75 4.25C1.75 3.70 2.20 3.25 2.75 3.25H4L4.75 2.25H7.25L8 3.25H9.25C9.80 3.25 10.25 3.70 10.25 4.25V8.75C10.25 9.30 9.80 9.75 9.25 9.75H2.75C2.20 9.75 1.75 9.30 1.75 8.75V4.25Z"
        strokeWidth="1.2"
        strokeLinejoin="round"
        stroke="currentColor"
      />
      <circle cx="6" cy="6.5" r="1.75" strokeWidth="1.2" stroke="currentColor" />
    </svg>
  )
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M4.5 3.2V10.8L10.8 7L4.5 3.2Z" fill="currentColor" />
    </svg>
  )
}

function TabIcon({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function DetailsIcon({ className }: IconProps) {
  return (
    <TabIcon className={className}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 7.25v3.5" />
      <path d="M8 5.1v.05" />
    </TabIcon>
  )
}

export function BranchIcon({ className }: IconProps) {
  return (
    <TabIcon className={className}>
      <circle cx="4.5" cy="3.75" r="1.75" />
      <circle cx="4.5" cy="12.25" r="1.75" />
      <circle cx="11.5" cy="5.75" r="1.75" />
      <path d="M4.5 5.5v5" />
      <path d="M11.5 7.5c0 2-2.5 2.5-7 3" />
    </TabIcon>
  )
}

export function SubAgentsIcon({ className }: IconProps) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 4.8v2.7m0 0L3.5 11M8 7.5l4.5 3.5M8 7.5V11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="3" r="1.8" fill="currentColor" />
      <circle cx="3.2" cy="12.6" r="1.5" fill="currentColor" />
      <circle cx="8" cy="12.6" r="1.5" fill="currentColor" />
      <circle cx="12.8" cy="12.6" r="1.5" fill="currentColor" />
    </svg>
  )
}

export function ChangesIcon({ className }: IconProps) {
  return (
    <TabIcon className={className}>
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5" />
      <path d="M8 4.75v3.5" />
      <path d="M6.25 6.5h3.5" />
      <path d="M6.25 11h3.5" />
    </TabIcon>
  )
}

export function FolderIcon({ className }: IconProps) {
  return (
    <TabIcon className={className}>
      <path d="M1.75 4.5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.75h5.4a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" />
    </TabIcon>
  )
}

export function PulseIcon({ className }: IconProps) {
  return (
    <TabIcon className={className}>
      <path d="M1.5 8.5h2.6l1.7-4.75 3.1 8.5 1.9-3.75h3.7" />
    </TabIcon>
  )
}

export function WindowIcon({ className }: IconProps) {
  return (
    <TabIcon className={className}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M1.75 6h12.5" />
      <path d="M4 4.4v.05" />
      <path d="M6 4.4v.05" />
    </TabIcon>
  )
}
