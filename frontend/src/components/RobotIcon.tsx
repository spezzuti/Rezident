import type { CSSProperties, SVGProps } from 'react'

/* shared stroke style for limbs/antennae */
const S: SVGProps<SVGPathElement> = { stroke: 'currentColor', fill: 'none', strokeWidth: 1.4, strokeLinecap: 'round' }

const glow: CSSProperties = { filter: 'drop-shadow(0 0 6px var(--wl-phos-g-glow))' }

export function RobotIcon({ kind, size = 36 }: { kind: string; size?: number }) {
  const svgProps = { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', style: glow }

  switch (kind) {
    case 'securitron':
      return (
        <svg {...svgProps}>
          <rect x={7} y={2.5} width={10} height={8} rx={1.5} />
          <rect x={9} y={4.5} width={6} height={3.4} rx={0.6} fill="#0a1810" />
          <path d="M8 11 L16 11 L17.5 17.5 L6.5 17.5 Z" />
          <path {...S} d="M7 12.5 Q4.5 13.5 5 16" />
          <path {...S} d="M17 12.5 Q19.5 13.5 19 16" />
          <circle cx={12} cy={19.8} r={2.4} />
        </svg>
      )
    case 'handy':
      return (
        <svg {...svgProps}>
          <circle cx={12} cy={11.5} r={4.6} />
          <path {...S} d="M10.5 7.5 L9 3.5" />
          <circle cx={8.7} cy={3} r={1.1} />
          <path {...S} d="M13.5 7.5 L15 3.5" />
          <circle cx={15.3} cy={3} r={1.1} />
          <path {...S} d="M7.6 13 Q4 14.5 4.5 18" />
          <path {...S} d="M16.4 13 Q20 14.5 19.5 18" />
          <path d="M10.6 15.7 L13.4 15.7 L12 20.5 Z" />
        </svg>
      )
    case 'eyebot':
      return (
        <svg {...svgProps}>
          <ellipse cx={12} cy={12.5} rx={6.2} ry={4.8} />
          <circle cx={12} cy={12.5} r={1.7} fill="#0a1810" />
          <path {...S} d="M8.5 8.5 L5 3.5" />
          <circle cx={4.7} cy={3.1} r={0.9} />
          <path {...S} d="M15.5 8.5 L19 3.5" />
          <circle cx={19.3} cy={3.1} r={0.9} />
          <path d="M9 17 L11 17 L10 20 Z" />
          <path d="M13 17 L15 17 L14 20 Z" />
        </svg>
      )
    case 'curie':
      return (
        <svg {...svgProps}>
          <circle cx={12} cy={11.5} r={4.6} />
          <path {...S} d="M12 6.9 L12 3.2" />
          <circle cx={12} cy={2.8} r={1.1} />
          <path {...S} d="M9.5 7.7 L7.5 4.5" />
          <circle cx={7.2} cy={4} r={0.9} />
          <path {...S} d="M14.5 7.7 L16.5 4.5" />
          <circle cx={16.8} cy={4} r={0.9} />
          <path {...S} d="M7.6 13 Q4.5 15 5.5 18.5" />
          <path {...S} d="M16.4 13 Q19.5 15 18.5 18.5" />
          <path d="M10.6 15.7 L13.4 15.7 L12 20.5 Z" />
        </svg>
      )
    case 'prime':
      return (
        <svg {...svgProps}>
          <rect x={9.6} y={1.5} width={4.8} height={3.6} rx={0.8} />
          <path d="M7 5.8 L17 5.8 L16 14 L8 14 Z" />
          <rect x={4.2} y={6.2} width={2.2} height={7.5} rx={1} />
          <rect x={17.6} y={6.2} width={2.2} height={7.5} rx={1} />
          <rect x={8.3} y={14} width={2.8} height={8} rx={0.8} />
          <rect x={12.9} y={14} width={2.8} height={8} rx={0.8} />
        </svg>
      )
    case 'zax': // pre-war mainframe: cabinet, twin tape reels, switch rows
      return (
        <svg {...svgProps}>
          <rect x={5.5} y={2} width={13} height={19} rx={1.2} />
          <circle cx={9.3} cy={6.4} r={2.1} fill="#0a1810" />
          <circle cx={14.7} cy={6.4} r={2.1} fill="#0a1810" />
          <circle cx={9.3} cy={6.4} r={0.7} />
          <circle cx={14.7} cy={6.4} r={0.7} />
          <rect x={7.5} y={10.6} width={9} height={1.6} rx={0.5} fill="#0a1810" />
          <rect x={7.5} y={13.6} width={9} height={1.6} rx={0.5} fill="#0a1810" />
          <rect x={7.5} y={16.8} width={5} height={1.6} rx={0.5} fill="#0a1810" />
        </svg>
      )
    case 'robobrain': // dome brain on a tracked chassis
      return (
        <svg {...svgProps}>
          <path d="M6.8 10.5 L6.8 8.8 A5.2 5.2 0 0 1 17.2 8.8 L17.2 10.5 Z" />
          <ellipse cx={12} cy={8.4} rx={3.3} ry={2.3} fill="#0a1810" />
          <path {...S} strokeWidth={1} d="M9.6 8.9 Q10.4 7.3 11.3 8.4 Q12.1 9.3 12.9 7.9 Q13.6 7 14.4 8.5" />
          <rect x={9} y={10.5} width={6} height={4.4} rx={0.8} />
          <path {...S} d="M8.9 12 Q5.8 13 6.2 16" />
          <path {...S} d="M15.1 12 Q18.2 13 17.8 16" />
          <rect x={6} y={15.6} width={12} height={4.6} rx={2.3} />
          <circle cx={9} cy={17.9} r={1.2} fill="#0a1810" />
          <circle cx={15} cy={17.9} r={1.2} fill="#0a1810" />
        </svg>
      )
    case 'ede': // ED-E — eyebot chassis, spark antennae, twin emitters
      return (
        <svg {...svgProps}>
          <ellipse cx={12} cy={13} rx={6} ry={4.6} />
          <circle cx={12} cy={13} r={1.6} fill="#0a1810" />
          <path {...S} d="M9 9.2 L6.8 5.8 L8.2 5.2 L6.4 2.6" />
          <path {...S} d="M15 9.2 L17.2 5.8 L15.8 5.2 L17.6 2.6" />
          <path d="M9.2 17.3 L11 17.3 L10.1 20 Z" />
          <path d="M13 17.3 L14.8 17.3 L13.9 20 Z" />
        </svg>
      )
    default:
      return null
  }
}
