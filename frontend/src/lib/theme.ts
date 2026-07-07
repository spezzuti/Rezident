// CRT phosphor colour for the theme's CRT screens (comms, active agents, boot/login
// CRTs). Independent of the theme knob; set from Settings › Interface. It tints only
// the .wl-crt panels via `data-skin`, not the whole UI. '' = the theme default (green).

export const CRT_SKINS: { value: string; label: string }[] = [
  { value: '', label: 'GREEN' },
  { value: 'crt-amber', label: 'AMBER' },
]

export function getCrtSkin(): string {
  return localStorage.getItem('agentos_skin') || ''
}

export function setCrtSkin(skin: string) {
  if (skin) document.documentElement.dataset.skin = skin
  else delete document.documentElement.dataset.skin
  localStorage.setItem('agentos_skin', skin)
}
